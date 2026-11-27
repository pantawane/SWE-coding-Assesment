import type { Express } from 'express';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { config } from './config.js';
import { getRedis } from './redis.js';

type User = { sub: string; name: string; workspaces: { id: string; role: 'admin' | 'agent' }[] };
const SESSION_COOKIE = 'switchboard_session';
const token = () => randomBytes(32).toString('base64url');
const cookieValue = (header: string | undefined, name: string) =>
  header?.split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1);
const provider = async (path: string, options?: RequestInit) => {
  const res = await fetch(new URL(path, config.oidc.issuer), { ...options, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Identity provider returned ' + res.status);
  return res.json();
};

export async function session(header?: string): Promise<User | null> {
  const key = cookieValue(header, SESSION_COOKIE);
  if (!key || !/^[\w-]{43}$/.test(key)) return null;
  const raw = await getRedis().get('switchboard:session:' + key);
  return raw ? JSON.parse(raw) : null;
}

export function canAccess(user: User, workspace: string) {
  return user.workspaces.some(member => member.id === workspace);
}

export function addAuth(app: Express) {
  app.get('/auth/login', async (_req, res) => {
    try {
      const state = token();
      const verifier = token();
      const nonce = token();
      await getRedis().set('switchboard:login:' + state, JSON.stringify({ verifier, nonce }), 'EX', 300);
      res.cookie('switchboard_login', state, { httpOnly: true, sameSite: 'lax', maxAge: 300_000, secure: config.oidc.redirectUri.startsWith('https:') });
      const url = new URL('/authorize', config.oidc.issuer);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: config.oidc.clientId, redirect_uri: config.oidc.redirectUri,
        scope: 'openid profile email', state, nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      }).toString();
      res.redirect(url.href);
    } catch {
      res.sendStatus(502);
    }
  });

  app.get('/auth/callback', async (req, res) => {
    const { state, code } = req.query;
    if (typeof state !== 'string' || typeof code !== 'string' ||
        state !== cookieValue(req.headers.cookie, 'switchboard_login')) return res.sendStatus(400);
    try {
      const pending = await getRedis().getdel('switchboard:login:' + state);
      if (!pending) return res.sendStatus(400);
      const { verifier, nonce } = JSON.parse(pending);
      const credentials = await provider('/token', {
        method: 'POST', body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: config.oidc.clientId, client_secret: config.oidc.clientSecret,
          redirect_uri: config.oidc.redirectUri, code, code_verifier: verifier,
        }),
      });
      const [head, body, signature, extra] = String(credentials.id_token).split('.');
      if (!head || !body || !signature || extra !== undefined) return res.sendStatus(401);
      const header = JSON.parse(Buffer.from(head, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      const { keys } = await provider('/jwks');
      const jwk = keys.find((key: { kid: string }) => key.kid === header.kid);
      if (header.alg !== 'RS256' || !jwk || !verify('RSA-SHA256', Buffer.from(head + '.' + body),
        createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url')) ||
        claims.iss !== config.oidc.issuer || claims.aud !== config.oidc.clientId || claims.nonce !== nonce ||
        typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000 ||
        typeof claims.sub !== 'string' || !Array.isArray(claims.workspaces)) return res.sendStatus(401);
      const user: User = {
        sub: claims.sub, name: typeof claims.name === 'string' ? claims.name : claims.sub,
        workspaces: claims.workspaces.filter((item: User['workspaces'][number]) =>
          item && typeof item.id === 'string' && (item.role === 'admin' || item.role === 'agent')),
      };
      const key = token();
      await getRedis().set('switchboard:session:' + key, JSON.stringify(user), 'EX', 3600);
      res.clearCookie('switchboard_login');
      res.cookie(SESSION_COOKIE, key, { httpOnly: true, sameSite: 'lax', maxAge: 3600_000, secure: config.oidc.redirectUri.startsWith('https:') });
      return res.redirect(config.webOrigin);
    } catch {
      return res.sendStatus(502);
    }
  });

  app.post('/auth/logout', async (req, res) => {
    try {
      const key = cookieValue(req.headers.cookie, SESSION_COOKIE);
      if (key) await getRedis().del('switchboard:session:' + key);
      res.clearCookie(SESSION_COOKIE).sendStatus(204);
    } catch {
      res.sendStatus(502);
    }
  });
}

import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { advance, change, contactFor, emit, order, read, reset } from './store.js';
import { startSender } from './sender.js';
import { addAuth, canAccess, session } from './auth.js';
import { attachSockets } from './sockets.js';

const app = express();
const server = createServer(app);
const keys = Object.keys(config.pigeon.apiKeys);
const known = (id: unknown): id is string => typeof id === 'string' && keys.includes(id);
const string = (input: unknown): input is string => typeof input === 'string' && input.trim().length > 0;
const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res).catch(next); };

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/webhooks/pigeon', express.raw({ type: () => true }), route(async (req, res) => {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/i.exec(req.get('x-pigeon-signature') ?? '');
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300) return res.sendStatus(401);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const expected = createHmac('sha256', config.pigeon.webhookSecret).update(match[1] + '.').update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) return res.sendStatus(401);
  let event;
  try { event = JSON.parse(body.toString()); } catch { return res.sendStatus(400); }
  if (!event || typeof event !== 'object' || !string(event.type)) return res.sendStatus(400);
  const { type, workspace, data } = event;
  if (!known(workspace) || !['message.inbound', 'message.status'].includes(type)) return res.sendStatus(204);
  if (!data || !string(event.id)) return res.sendStatus(400);
  if (type === 'message.inbound') {
    if (!string(data.message_id) || !string(data.from) || typeof data.text !== 'string' ||
        typeof event.occurred_at !== 'string' || !Number.isFinite(Date.parse(event.occurred_at))) return res.sendStatus(400);
    const at = new Date(event.occurred_at).toISOString();
    await change(workspace, state => {
      if (state.seen.includes(event.id) || state.messages.some(m => m.direction === 'in' && m.id === data.message_id)) {
        return { dirty: false, value: undefined };
      }
      state.seen.push(event.id);
      contactFor(state, data.from, at);
      state.messages.push({ id: data.message_id, contact: data.from, text: data.text, at, direction: 'in' });
      emit(state, type, data.from, { message_id: data.message_id });
      return { dirty: true, value: undefined };
    });
  } else {
    if (!string(data.client_ref) || !['sent', 'delivered', 'failed'].includes(data.status)) return res.sendStatus(400);
    await change(workspace, state => {
      const message = state.messages.find(m => m.direction === 'out' && m.id === data.client_ref);
      if (!message || state.seen.includes(event.id)) return { dirty: false, value: undefined };
      state.seen.push(event.id);
      advance(state, message, data.status);
      return { dirty: true, value: undefined };
    });
  }
  res.sendStatus(204);
}));

app.use(express.json());
app.use('/__grader', (req, res, next) => {
  if (!config.graderToken || req.get('x-grader-token') !== config.graderToken) return res.sendStatus(401);
  next();
});
app.post('/__grader/reset', route(async (_req, res) => {
  await reset();
  res.sendStatus(200);
}));
app.get('/__grader/snapshot', route(async (_req, res) => {
  const workspaces = await Promise.all(keys.map(async id => {
    const state = await read(id);
    const contacts = Object.fromEntries(state.contacts.map(c => [c.contact, {
      assignee: c.assignee,
      inbound: state.messages.filter(m => m.direction === 'in' && m.contact === c.contact).sort(order).map(m => m.id),
    }]));
    const outbound = Object.fromEntries(state.messages.filter(m => m.direction === 'out').map(m => [m.id, m.status]));
    return [id, { contacts, outbound }];
  }));
  res.json({ workspaces: Object.fromEntries(workspaces) });
}));

async function reply(workspace: string, contact: string, text: string, ref: string) {
  return change(workspace, state => {
    if (state.messages.some(m => m.direction === 'out' && m.id === ref)) return { dirty: false, value: undefined };
    const at = new Date().toISOString();
    contactFor(state, contact, at);
    state.messages.push({ id: ref, direction: 'out', contact, text, at, status: 'queued' });
    emit(state, 'message.status', contact, { client_ref: ref, status: 'queued' });
    return { dirty: true, value: undefined };
  });
}

async function claim(workspace: string, contact: string, agent: string) {
  return change(workspace, state => {
    const existing = state.contacts.find(c => c.contact === contact);
    if (existing?.assignee) return { dirty: false, value: existing.assignee === agent };
    const current = existing ?? contactFor(state, contact, new Date().toISOString());
    current.assignee = agent;
    emit(state, 'conversation.assigned', contact, { assignee: agent });
    return { dirty: true, value: true };
  });
}

app.post('/__grader/reply', route(async (req, res) => {
  const { workspace, contact, text, client_ref } = req.body ?? {};
  if (!known(workspace) || !string(contact) || !string(text) || !string(client_ref)) return res.sendStatus(400);
  await reply(workspace, contact, text, client_ref);
  res.sendStatus(202);
}));
app.post('/__grader/claim', route(async (req, res) => {
  const { workspace, contact, agent } = req.body ?? {};
  if (!known(workspace) || !string(contact) || !string(agent)) return res.sendStatus(400);
  res.sendStatus(await claim(workspace, contact, agent) ? 200 : 409);
}));

addAuth(app);
app.get('/api/me', route(async (req, res) => {
  const user = await session(req.headers.cookie);
  if (!user) return res.sendStatus(401);
  res.json(user);
}));

const tenant = (handle: (req: Request, res: Response, workspace: string, sub: string) => Promise<unknown>) =>
  route(async (req, res) => {
    const user = await session(req.headers.cookie);
    if (!user) return res.sendStatus(401);
    const workspace = req.query.workspace;
    if (!known(workspace)) return res.sendStatus(400);
    if (!canAccess(user, workspace)) return res.sendStatus(403);
    const origin = req.get('origin');
    if (req.method !== 'GET' && origin && origin !== config.webOrigin) return res.sendStatus(403);
    return handle(req, res, workspace, user.sub);
  });

app.get('/api/conversations', tenant(async (req, res, workspace) => {
  const { contacts } = await read(workspace);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return res.sendStatus(400);
  const sorted = contacts.sort((a, b) => b.activity.localeCompare(a.activity) || a.contact.localeCompare(b.contact));
  res.json({ conversations: sorted.slice(offset, offset + 30), nextOffset: offset + 30 < sorted.length ? offset + 30 : null });
}));

app.get('/api/conversations/:contact', tenant(async (req, res, workspace) => {
  const state = await read(workspace);
  const conversation = state.contacts.find(c => c.contact === req.params.contact);
  if (!conversation) return res.sendStatus(404);
  const messages = state.messages.filter(m => m.contact === conversation.contact).sort(order);
  res.json({ conversation, messages: messages.map(({ id, at, text, direction, status }) => ({ id, at, text, direction, status })) });
}));

app.post('/api/conversations/:contact/reply', tenant(async (req, res, workspace) => {
  const { text, client_ref } = req.body ?? {};
  if (!string(text) || text.length > 4000 || !string(client_ref) || client_ref.length > 128) return res.sendStatus(400);
  await reply(workspace, req.params.contact, text, client_ref);
  res.sendStatus(202);
}));

app.post('/api/conversations/:contact/claim', tenant(async (req, res, workspace, sub) => {
  res.sendStatus(await claim(workspace, req.params.contact, sub) ? 200 : 409);
}));

app.patch('/api/conversations/:contact', tenant(async (req, res, workspace) => {
  const { closed } = req.body ?? {};
  if (typeof closed !== 'boolean') return res.sendStatus(400);
  const result = await change(workspace, state => {
    const contact = state.contacts.find(c => c.contact === req.params.contact);
    if (!contact) return { dirty: false, value: false };
    if (contact.closed === closed) return { dirty: false, value: true };
    contact.closed = closed;
    emit(state, 'conversation.updated', contact.contact, { closed });
    return { dirty: true, value: true };
  });
  res.sendStatus(result ? 204 : 404);
}));

attachSockets(server);

app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (!error.status || error.status >= 500) console.error(error);
  res.sendStatus(error.status ?? 500);
});

await (await getDb()).command({ ping: 1 });
await getRedis().ping();
server.listen(config.port, () => console.log('Switchboard listening on port ' + config.port));
startSender();


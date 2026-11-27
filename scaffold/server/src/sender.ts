import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { advance, change, read } from './store.js';

async function send(workspace: string) {
  const now = Date.now();
  const current = await read(workspace);
  if (current.nextSend > now || !current.messages.some(m => m.status === 'queued' && (m.due ?? 0) <= now)) return;
  const lease = randomUUID();
  const message = await change(workspace, state => {
    const job = state.messages.find(m => m.status === 'queued' && (m.due ?? 0) <= now);
    if (state.nextSend > now || !job) return { dirty: false, value: undefined };
    state.nextSend = now + 260;
    job.lease = lease;
    job.due = now + 18_000;
    job.attempts = (job.attempts ?? 0) + 1;
    return { dirty: true, value: job };
  });
  if (!message) return;
  let response: Response | undefined;
  try {
    response = await fetch(new URL('/v1/messages', config.pigeon.url), {
      method: 'POST',
      signal: AbortSignal.timeout(4_000),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + config.pigeon.apiKeys[workspace],
        'idempotency-key': workspace + ':' + message.id,
      },
      body: JSON.stringify({ to: message.contact, text: message.text, client_ref: message.id }),
    });
    await response.body?.cancel();
  } catch {
    // The provider may already have accepted this send. Retry with the same key.
  }
  const retryAt = Date.now() + Math.max(1, Number(response?.headers.get('retry-after')) || 1) * 1000;
  await change(workspace, state => {
    const job = state.messages.find(m => m.direction === 'out' && m.id === message.id && m.lease === lease);
    if (!job) return { dirty: false, value: undefined };
    if (response?.status === 429) state.nextSend = Math.max(state.nextSend, retryAt);
    if (response?.ok) advance(state, job, 'sent');
    else if (response && response.status >= 400 && response.status < 500 && response.status !== 429) advance(state, job, 'failed');
    else job.due = response?.status === 429 ? retryAt : Date.now() + Math.min(5000, 300 * 2 ** Math.min(job.attempts ?? 1, 5));
    delete job.lease;
    return { dirty: true, value: undefined };
  });
}

export function startSender() {
  const pending = new Set<string>();
  setInterval(() => {
    for (const workspace of Object.keys(config.pigeon.apiKeys)) {
      if (pending.has(workspace)) continue;
      pending.add(workspace);
      void send(workspace).catch(error => console.error('Outbox:', error)).finally(() => pending.delete(workspace));
    }
  }, 90);
}

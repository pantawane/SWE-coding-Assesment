import assert from 'node:assert/strict';
import test from 'node:test';
import { advance, order, type Message, type Workspace } from '../src/store.js';
import { decryptNote, encryptNote, generateWorkspaceKey, importWorkspaceKey } from '../../web/src/note-crypto.js';

const message = (id: string, at: string): Message => ({ id, at, contact: '+1', text: id, direction: 'in' });

test('inbound messages sort by provider time with a stable ID tie-breaker', () => {
  const late = '2026-11-27T12:01:00.000Z';
  const early = '2026-11-27T12:00:00.000Z';
  assert.deepEqual([message('c', late), message('b', early), message('a', early)].sort(order).map(item => item.id), ['a', 'b', 'c']);
});

test('late and repeated status events preserve the terminal state and sequence', () => {
  const state: Workspace = { _id: 'ws_acme', version: '0', contacts: [], seen: [], messages: [], frames: [], nextSend: 0 };
  const outgoing = { ...message('reply', '2026-11-27T12:00:00.000Z'), direction: 'out' as const, status: 'queued' as const };
  advance(state, outgoing, 'delivered');
  advance(state, outgoing, 'sent');
  advance(state, outgoing, 'delivered');
  assert.equal(outgoing.status, 'delivered');
  assert.deepEqual(state.frames, [
    { seq: 1, type: 'message.status', contact: '+1', client_ref: 'reply', status: 'delivered' },
  ]);
});

test('encrypted notes require the workspace key and the original conversation context', async () => {
  const shared = generateWorkspaceKey();
  const author = await importWorkspaceKey(shared);
  const reader = await importWorkspaceKey(shared);
  const otherKey = await importWorkspaceKey(generateWorkspaceKey());
  const note = await encryptNote(author, 'ws_acme', '+14155550101', 'Follow up tomorrow');
  assert.equal(await decryptNote(reader, 'ws_acme', '+14155550101', note), 'Follow up tomorrow');
  await assert.rejects(decryptNote(otherKey, 'ws_acme', '+14155550101', note));
  await assert.rejects(decryptNote(reader, 'ws_globex', '+14155550101', note));
  await assert.rejects(decryptNote(reader, 'ws_acme', '+14155550102', note));
});

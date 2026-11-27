import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export type Status = 'queued' | 'sent' | 'delivered' | 'failed';
export type Message = {
  id: string; contact: string; text: string; at: string; direction: 'in' | 'out';
  status?: Status; due?: number; lease?: string; attempts?: number;
};
export type Contact = { contact: string; assignee: string | null; closed: boolean; activity: string };
export type Note = { id: string; contact: string; author: string; at: string; iv: string; ciphertext: string };
type Frame = { seq: number; type: string; contact: string; [key: string]: unknown };
export type Workspace = {
  _id: string; version: string; contacts: Contact[]; messages: Message[];
  seen: string[]; frames: Frame[]; nextSend: number; notes?: Note[];
};
const collection = async () => (await getDb()).collection<Workspace>('workspaces');
const blank = (id: string): Workspace => ({
  _id: id, version: randomUUID(), contacts: [], messages: [], seen: [], frames: [], nextSend: 0,
});

export async function read(id: string) {
  return (await (await collection()).findOne({ _id: id })) ?? blank(id);
}

type Mutation<T> = (state: Workspace) => { value: T; dirty: boolean };
type PendingMutation = {
  apply: Mutation<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const pending = new Map<string, PendingMutation[]>();

export function change<T>(id: string, apply: Mutation<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const entry: PendingMutation = { apply, resolve: value => resolve(value as T), reject };
    const queue = pending.get(id);
    if (queue) {
      queue.push(entry);
    } else {
      pending.set(id, [entry]);
      setTimeout(() => void drain(id), 5);
    }
  });
}

async function drain(id: string) {
  const queue = pending.get(id);
  if (!queue) return;
  while (queue.length) {
    const batch = queue.splice(0, 128);
    try {
      const results = await persist(id, batch);
      batch.forEach(({ resolve }, index) => resolve(results[index]));
    } catch (error) {
      batch.forEach(({ reject }) => reject(error));
    }
  }
  pending.delete(id);
}

const durable = { writeConcern: { w: 1, j: true } } as const;

async function persist(id: string, batch: PendingMutation[]) {
  const workspaces = await collection();
  for (;;) {
    const original = await workspaces.findOne({ _id: id });
    const state = original ?? blank(id);
    const previousVersion = state.version;
    const results = batch.map(entry => entry.apply(state));
    const values = results.map(result => result.value);
    if (!results.some(result => result.dirty)) return values;

    state.version = randomUUID();
    if (original) {
      const result = await workspaces.replaceOne({ _id: id, version: previousVersion }, state, durable);
      if (result.matchedCount) return values;
    } else {
      try {
        await workspaces.insertOne(state, durable);
        return values;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
      }
    }
  }
}

export async function reset() {
  await (await collection()).deleteMany({});
}

export function contactFor(state: Workspace, contact: string, at: string) {
  let current = state.contacts.find(item => item.contact === contact);
  if (!current) {
    current = { contact, assignee: null, closed: false, activity: at };
    state.contacts.push(current);
  }
  if (at > current.activity) current.activity = at;
  return current;
}

export function emit(state: Workspace, type: string, contact: string, fields = {}) {
  state.frames.push({ seq: state.frames.length + 1, type, contact, ...fields });
}

export function order(a: Message, b: Message) {
  return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
}

export function advance(state: Workspace, message: Message, status: Status) {
  const rank = { queued: 0, sent: 1, failed: 2, delivered: 2 };
  if (rank[status] <= rank[message.status ?? 'queued']) return;
  message.status = status;
  emit(state, 'message.status', message.contact, { client_ref: message.id, status });
}

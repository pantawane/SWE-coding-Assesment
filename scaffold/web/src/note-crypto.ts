const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const context = (workspace: string, contact: string) => encoder.encode(JSON.stringify(['switchboard-note-v1', workspace, contact]));

export function generateWorkspaceKey() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function importWorkspaceKey(value: string) {
  const text = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error('Enter a valid workspace key.');
  return crypto.subtle.importKey('raw', decode(text), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptNote(key: CryptoKey, workspace: string, contact: string, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(workspace, contact) }, key, encoder.encode(text));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function decryptNote(key: CryptoKey, workspace: string, contact: string, note: { iv: string; ciphertext: string }) {
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(note.iv), additionalData: context(workspace, contact) }, key, decode(note.ciphertext));
  return decoder.decode(clear);
}

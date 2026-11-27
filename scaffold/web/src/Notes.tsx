import { useEffect, useState, type FormEvent } from 'react';
import { decryptNote, encryptNote, generateWorkspaceKey, importWorkspaceKey } from './note-crypto';

export type Note = { id: string; author: string; at: string; iv: string; ciphertext: string };

export function Notes({ workspace, contact, notes, save }: {
  workspace: string; contact: string; notes: Note[]; save: (payload: { iv: string; ciphertext: string }) => Promise<boolean>;
}) {
  const [keyText, setKeyText] = useState('');
  const [key, setKey] = useState<CryptoKey>();
  const [draft, setDraft] = useState('');
  const [clear, setClear] = useState<{ id: string; text: string }[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stale = false;
    if (key) {
      void Promise.all(notes.map(async note => {
        try { return { id: note.id, text: await decryptNote(key, workspace, contact, note) }; }
        catch { return { id: note.id, text: 'This note could not be decrypted with the active key.' }; }
      })).then(result => { if (!stale) setClear(result); });
    }
    return () => { stale = true; };
  }, [workspace, contact, key, notes]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    try { setKey(await importWorkspaceKey(keyText)); setKeyText(''); setError(''); }
    catch (err) { setError((err as Error).message); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!key || !draft.trim() || saving) return;
    setSaving(true);
    try {
      const encrypted = await encryptNote(key, workspace, contact, draft.trim());
      if (await save(encrypted)) setDraft('');
    } catch {
      setError('Could not encrypt the note.');
    } finally {
      setSaving(false);
    }
  }

  return <details className="notes">
    <summary>Private notes ({notes.length})</summary>
    {error && <p role="alert">{error}</p>}
    {!key ? <form onSubmit={unlock}>
      <label htmlFor="notes-key">Workspace key</label>
      <div className="note-controls">
        <input id="notes-key" autoComplete="off" value={keyText} onChange={event => setKeyText(event.target.value)} />
        <button disabled={!keyText.trim()}>Unlock</button>
        <button type="button" onClick={() => setKeyText(generateWorkspaceKey())}>Generate key</button>
      </div>
      <small>Share a generated key with workspace members through a trusted channel and keep a copy.</small>
    </form> : <>
      <button onClick={() => { setKey(undefined); setDraft(''); setClear([]); }}>Lock notes</button>
      <ul>{notes.map(note => <li key={note.id}>
        <small>{note.author} · {new Date(note.at).toLocaleString()}</small>
        <p>{clear.find(item => item.id === note.id)?.text ?? 'Decrypting…'}</p>
      </li>)}</ul>
      <form onSubmit={submit}>
        <label htmlFor="note-text">New private note</label>
        <div className="note-controls">
          <textarea id="note-text" value={draft} maxLength={4000} onChange={event => setDraft(event.target.value)} />
          <button disabled={saving || !draft.trim()}>Save note</button>
        </div>
      </form>
    </>}
  </details>;
}

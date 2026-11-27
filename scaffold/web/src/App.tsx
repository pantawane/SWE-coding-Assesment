import { useEffect, useRef, useState, type FormEvent } from 'react';
import './inbox.css';

type User = { sub: string; name: string; workspaces: { id: string; role: string }[] };
type Conversation = { contact: string; assignee: string | null; closed: boolean; activity: string };
type Message = { id: string; at: string; direction: 'in' | 'out'; text: string; status?: string };
type Thread = { conversation: Conversation; messages: Message[] };
type Page = { conversations: Conversation[]; nextOffset: number | null };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(response.status === 409 ? 'Another agent already claimed this conversation.' : 'Request failed (' + response.status + ').');
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : undefined as T;
}

const workspaceName = (id: string) => ({ ws_acme: 'Acme', ws_globex: 'Globex' }[id] ?? id);
const time = (date: string) => new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function App() {
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/me').then(response => {
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('Could not reach Switchboard.');
      return response.json();
    }).then(setUser).catch(err => setError(err.message));
  }, []);
  if (user) return <Inbox user={user} />;
  return <main className="welcome">
    <section>
      <div className="brand"><span className="mark">S</span> Switchboard</div>
      <h1>Team inbox</h1>
      <p>Sign in to see and reply to customer conversations in your workspace.</p>
      {error ? <p role="alert">{error} <button onClick={() => location.reload()}>Try again</button></p> :
        user === null ? <a className="primary" href="/auth/login">Sign in</a> : <p role="status">Loading…</p>}
    </section>
  </main>;
}

function Inbox({ user }: { user: User }) {
  const [workspace, setWorkspace] = useState(user.workspaces[0]?.id ?? '');
  const [contact, setContact] = useState('');
  const [list, setList] = useState<Page>({ conversations: [], nextOffset: null });
  const [thread, setThread] = useState<Thread | null>(null);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [offset, setOffset] = useState(0);
  const history = useRef<HTMLDivElement>(null);
  const retry = useRef<{ scope: string; text: string; ref: string } | null>(null);
  const query = '?workspace=' + encodeURIComponent(workspace);
  const path = '/api/conversations/' + encodeURIComponent(contact);

  useEffect(() => {
    if (!workspace) return;
    let socket: WebSocket;
    let stopped = false;
    let reconnect: ReturnType<typeof setTimeout>;
    let refresh: ReturnType<typeof setTimeout>;
    let cursor = 0;
    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(protocol + '//' + location.host + '/ws' + query + '&after=' + cursor);
      socket.onopen = () => { setLive(true); setRevision(v => v + 1); };
      socket.onmessage = event => {
        cursor = Math.max(cursor, JSON.parse(event.data).seq);
        clearTimeout(refresh);
        refresh = setTimeout(() => setRevision(v => v + 1), 100);
      };
      socket.onclose = () => {
        if (stopped) return;
        setLive(false);
        reconnect = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(reconnect); clearTimeout(refresh); socket?.close(); };
  }, [workspace, query]);

  useEffect(() => {
    if (!workspace) return;
    const abort = new AbortController();
    request<Page>('/api/conversations' + query + '&offset=' + offset, { signal: abort.signal })
      .then(page => { if (!abort.signal.aborted) setList(page); })
      .catch(err => { if (!abort.signal.aborted) setError(err.message); });
    return () => abort.abort();
  }, [workspace, query, offset, revision]);

  useEffect(() => {
    if (!workspace || !contact) return;
    const abort = new AbortController();
    request<Thread>(path + query, { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setThread(result); })
      .catch(err => { if (!abort.signal.aborted) setError(err.message); });
    return () => abort.abort();
  }, [workspace, contact, path, query, revision]);

  useEffect(() => { if (history.current) history.current.scrollTop = history.current.scrollHeight; }, [contact, thread?.messages.length]);

  async function action(suffix: string, method: string, body?: object) {
    setPending(true);
    setError('');
    try {
      await request(path + suffix + query, {
        method, headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      setRevision(v => v + 1);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    const scope = workspace + ':' + contact;
    const ref = retry.current?.scope === scope && retry.current.text === text ? retry.current.ref : crypto.randomUUID();
    retry.current = { scope, text, ref };
    if (await action('/reply', 'POST', { client_ref: ref, text })) {
      setDraft('');
      retry.current = null;
    }
  }

  async function logOut() {
    try { await request('/auth/logout', { method: 'POST' }); location.reload(); }
    catch (err) { setError((err as Error).message); }
  }

  const open = thread?.conversation;
  return <main className="desk">
    <header className="topbar">
      <div className="brand"><span className="mark">S</span> Switchboard</div>
      <div className="account"><span>{user.name}</span><button onClick={() => void logOut()}>Sign out</button></div>
    </header>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="panels">
      <aside className="inbox">
        <div className="inbox-head">
          <label htmlFor="workspace">Workspace</label>
          <select id="workspace" value={workspace} disabled={pending} onChange={event => {
            setWorkspace(event.target.value); setContact(''); setThread(null); setOffset(0);
            setList({ conversations: [], nextOffset: null }); setLive(false); setDraft(''); setError('');
          }}>
            {user.workspaces.map(member => <option key={member.id} value={member.id}>{workspaceName(member.id)}</option>)}
          </select>
          <div className="inbox-title"><h1>Inbox</h1><small className={live ? 'live' : ''}>{live ? 'Live' : 'Reconnecting'}</small></div>
        </div>
        <div className="contacts">
          {list.conversations.map(item => <button className="contact" key={item.contact} disabled={pending} aria-pressed={contact === item.contact}
            onClick={() => {
              if (item.contact === contact) return;
              setContact(item.contact); setThread(null); setDraft(''); setError('');
            }}>
            <strong>{item.contact}</strong><time>{time(item.activity)}</time>
            <small>{item.closed ? 'Closed' : item.assignee === user.sub ? 'Assigned to you' : item.assignee ? 'Assigned' : 'Unassigned'}</small>
          </button>)}
          {list.conversations.length === 0 && <p className="muted">No conversations yet.</p>}
        </div>
        {(offset > 0 || list.nextOffset !== null) && <div className="pagination">
          <button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>
          <button disabled={list.nextOffset === null} onClick={() => setOffset(list.nextOffset ?? offset)}>Next</button>
        </div>}
      </aside>
      <section className="thread" aria-label="Conversation">
        {!open ? <div className="empty">{contact ? 'Loading conversation…' : 'Select a conversation'}</div> : <>
          <header className="thread-head"><div><h2>{open.contact}</h2>
            <small>{open.closed ? 'Closed' : open.assignee === user.sub ? 'Assigned to you' : open.assignee ? 'Assigned to ' + open.assignee : 'Unassigned'}</small>
          </div><div className="actions">
            {!open.assignee && <button disabled={pending} onClick={() => void action('/claim', 'POST')}>Claim</button>}
            <button disabled={pending} onClick={() => void action('', 'PATCH', { closed: !open.closed })}>{open.closed ? 'Reopen' : 'Close'}</button>
          </div></header>
          <div className="history" ref={history}>
            {thread.messages.map(m => <div className={'message ' + m.direction} key={m.direction + m.id}>
              <p>{m.text}</p><small>{time(m.at)}{m.status && ' · ' + m.status}</small>
            </div>)}
            {!thread.messages.length && <p className="muted">No messages yet.</p>}
          </div>
          <form className="composer" onSubmit={send}>
            <label htmlFor="reply">Reply to customer</label>
            <div><textarea id="reply" maxLength={4000} value={draft} disabled={pending} onChange={e => setDraft(e.target.value)} rows={2} />
              <button className="primary" disabled={pending || !draft.trim()}>Send reply</button></div>
          </form>
        </>}
      </section>
    </div>
  </main>;
}


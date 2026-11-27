import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { canAccess, session } from './auth.js';
import { read } from './store.js';

export function attachSockets(server: Server) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const refuse = (status: string) => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n');
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return refuse('404 Not Found');
      const user = await session(req.headers.cookie);
      if (!user) return refuse('401 Unauthorized');
      const workspace = url.searchParams.get('workspace') ?? '';
      if (!canAccess(user, workspace)) return refuse('403 Forbidden');
      const after = url.searchParams.get('after');
      if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) {
        return refuse('400 Bad Request');
      }
      let cursor = after === null ? (await read(workspace)).frames.length : Number(after);
      if (socket.destroyed) return;
      sockets.handleUpgrade(req, socket, head, ws => {
        let running = false;
        let ticks = 0;
        const poll = async () => {
          if (running || ws.readyState !== WebSocket.OPEN) return;
          running = true;
          try {
            if (++ticks % 100 === 0 && !await session(req.headers.cookie)) return ws.close(1008, 'Session expired');
            const { frames } = await read(workspace);
            if (ws.bufferedAmount > 1_000_000) return ws.close(1013, 'Reconnect to replay changes');
            for (const frame of frames.slice(cursor)) {
              ws.send(JSON.stringify(frame));
              cursor = frame.seq;
            }
          } catch {
            ws.close(1011, 'Event replay unavailable');
          } finally {
            running = false;
          }
        };
        const timer = setInterval(() => void poll(), 180);
        ws.once('close', () => clearInterval(timer));
        ws.on('error', () => ws.terminate());
        void poll();
      });
    })().catch(() => refuse('503 Service Unavailable'));
  });
}

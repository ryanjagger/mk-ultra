/**
 * HTTP + WebSocket server: serves the built client and relays game messages.
 * All inbound messages are Zod-validated before touching room logic (NFR-16).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { parseClientMsg, type ServerMsg } from '@mk/shared';
import { GameLobby, type PlayerCtx } from './rooms.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function hereDir(): string {
  // CJS (esbuild bundle) has __dirname; ESM (dev/tests) has import.meta.url
  if (typeof __dirname === 'string') return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}

function resolveClientDist(): string | null {
  const here = hereDir();
  const candidates = [
    process.env.CLIENT_DIST,
    join(here, 'public'), // docker image layout
    join(here, '../../client/dist'), // repo layout from src/ or dist/
    join(here, '../../../client/dist'),
    join(process.cwd(), 'packages/client/dist'),
  ];
  for (const c of candidates) {
    if (c && existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

export interface GameServer {
  port: number;
  close(): Promise<void>;
}

export function createGameServer(port: number): Promise<GameServer> {
  const lobby = new GameLobby();
  const clientDist = resolveClientDist();
  if (clientDist) console.log(`serving client from ${clientDist}`);
  else console.warn('no client build found — API/WS only');

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!clientDist || req.method !== 'GET') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let filePath = normalize(join(clientDist, url === '/' ? 'index.html' : url));
    if (!filePath.startsWith(clientDist) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      filePath = join(clientDist, 'index.html'); // SPA fallback
    }
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': filePath.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const ctx: PlayerCtx = {
      name: 'player',
      room: null,
      conn: {
        send(msg: ServerMsg) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        },
      },
    };
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 15000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = parseClientMsg(data.toString());
      if (!msg) {
        ctx.conn.send({ t: 'error', message: 'Invalid message' });
        return;
      }
      try {
        lobby.handleMessage(ctx, msg);
      } catch (err) {
        console.error('handleMessage error', err);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      lobby.handleDisconnect(ctx);
    });
    ws.on('error', () => ws.terminate());
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

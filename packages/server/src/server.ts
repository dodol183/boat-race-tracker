// HTTP and WebSocket around the regatta hubs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { RegattaHub, type Role } from './hub.ts';
import { openStore, type Store } from './store.ts';
import { parseClientMessage, type ServerMessage } from './protocol.ts';

export interface ServerOptions {
  port: number;
  /** SQLite file (':memory:' for tests) */
  dbPath: string;
  /** Needed to create regattas (until accounts come back) */
  adminToken: string;
  now?: () => number;
  /** How often time-driven events (the start gun) are checked */
  tickMs?: number;
  /** The built app (packages/app/dist), served at / with index.html for any other page */
  staticDir?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Wrong-PIN limit per address and regatta: PINs are short */
const PIN_WINDOW_MS = 15 * 60_000;
const PIN_MAX_FAILURES = 10;

export async function startServer(opts: ServerOptions) {
  const now = opts.now ?? Date.now;
  const store: Store = openStore(opts.dbPath);
  const hubs = new Map<string, RegattaHub>();
  const pinFailures = new Map<string, { count: number; first: number }>();

  const hubFor = (id: string): RegattaHub | undefined => {
    let hub = hubs.get(id);
    if (!hub && store.getRegatta(id)) {
      hub = new RegattaHub(id, store, now);
      hubs.set(id, hub);
    }
    return hub;
  };

  const timer = setInterval(() => {
    for (const hub of hubs.values()) hub.tick();
  }, opts.tickMs ?? 250);

  // ---------------------------------------------------------------------------------------- HTTP

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  const isAdmin = (req: http.IncomingMessage) => {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(opts.adminToken);
    return opts.adminToken.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, serverTime: now() });

      if (req.method === 'POST' && url.pathname === '/api/regattas') {
        if (!isAdmin(req)) return json(res, 401, { error: 'An admin token is needed to create a regatta.' });
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 120) return json(res, 400, { error: 'Give the regatta a name (up to 120 characters).' });
        return json(res, 201, store.createRegatta(name, now()));
      }

      const m = url.pathname.match(/^\/api\/regattas\/([A-Za-z0-9]+)$/);
      if (req.method === 'GET' && m) {
        const hub = hubFor(m[1]!.toUpperCase());
        if (!hub) return json(res, 404, { error: 'No regatta with that code.' });
        hub.tick();
        const r = store.getRegatta(hub.regattaId)!;
        // Public: what spectators see. PINs never leave the server this way.
        return json(res, 200, { id: r.id, name: r.name, seq: hub.seq, serverTime: now(), state: hub.state });
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && opts.staticDir && !url.pathname.startsWith('/api/')) {
        return serveStatic(opts.staticDir, url.pathname, req, res);
      }

      json(res, 404, { error: 'Not found.' });
    } catch {
      json(res, 400, { error: 'Bad request.' });
    }
  });

  // ----------------------------------------------------------------------------------- WebSocket

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    const address = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
    let hub: RegattaHub | undefined;
    let role: Role = 'SPECTATOR';
    let unsubscribe: (() => void) | undefined;
    const send = (m: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };

    ws.on('message', (raw) => {
      const msg = parseClientMessage(raw.toString());
      if (!msg) return send({ t: 'error', code: 'BAD_MESSAGE', message: 'Message not understood.' });

      if (msg.t === 'ping') return send({ t: 'pong', clientTime: msg.clientTime, serverTime: now() });

      if (msg.t === 'hello') {
        const target = hubFor(msg.regattaId);
        if (!target) return send({ t: 'error', code: 'NO_SUCH_REGATTA', message: 'No regatta with that code.' });
        const r = store.getRegatta(target.regattaId)!;
        let nextRole: Role = 'SPECTATOR';
        if (msg.pin) {
          const key = `${address}|${r.id}`;
          const f = pinFailures.get(key);
          const locked = f && now() - f.first < PIN_WINDOW_MS && f.count >= PIN_MAX_FAILURES;
          if (locked) return send({ t: 'error', code: 'TOO_MANY_PIN_TRIES', message: 'Too many wrong PINs. Try again in 15 minutes.' });
          if (msg.pin === r.officerPin) nextRole = 'OFFICER';
          else if (msg.pin === r.skipperPin) nextRole = 'SKIPPER';
          else {
            const fresh = !f || now() - f.first >= PIN_WINDOW_MS;
            pinFailures.set(key, { count: fresh ? 1 : f!.count + 1, first: fresh ? now() : f!.first });
            return send({ t: 'error', code: 'WRONG_PIN', message: 'That PIN is not right for this regatta.' });
          }
        }
        unsubscribe?.();
        hub = target;
        role = nextRole;
        hub.tick();
        // Only the events after what the device has, when it says what it has and that is still valid
        const catchUp = msg.lastSeq !== undefined && msg.lastSeq > 0 && msg.lastSeq <= hub.seq;
        send({
          t: 'welcome',
          regattaId: r.id,
          name: r.name,
          role,
          ...(role === 'OFFICER' ? { skipperPin: r.skipperPin } : {}),
          seq: hub.seq,
          serverTime: now(),
          ...(catchUp ? { events: hub.eventsSince(msg.lastSeq!) } : { state: hub.state }),
        });
        unsubscribe = hub.subscribe({ events: (events) => send({ t: 'events', events }) });
        return;
      }

      if (!hub) return send({ t: 'error', code: 'NOT_JOINED', message: 'Join a regatta first.' });

      if (msg.t === 'resync') {
        const r = store.getRegatta(hub.regattaId)!;
        return send({ t: 'welcome', regattaId: r.id, name: r.name, role, ...(role === 'OFFICER' ? { skipperPin: r.skipperPin } : {}), seq: hub.seq, serverTime: now(), state: hub.state });
      }

      if (msg.t === 'command') {
        let result;
        try {
          result = hub.handle(role, msg.id, msg.command);
        } catch {
          // A command with the right type but a malformed body; nothing was stored
          result = { ok: false as const, error: { code: 'BAD_COMMAND', message: 'That command could not be read.' } };
        }
        return send({ t: 'result', id: msg.id, ...result } as ServerMessage);
      }
    });

    ws.on('close', () => unsubscribe?.());
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    port,
    store,
    hubFor,
    async close() {
      clearInterval(timer);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

/** A file from the app build; any path that isn't a file gets index.html (the app routes itself) */
function serveStatic(root: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const base = path.resolve(root);
  let file = path.resolve(base, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(base + path.sep) && file !== base) file = base;
  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    // A missing asset is a real 404; a page address is the app
    if (pathname.startsWith('/assets/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    file = path.join(base, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('The app has not been built (npm run build).');
    }
  }
  // Built assets have a hash in their name and never change; index.html must always be fresh
  const immutable = file.startsWith(path.join(base, 'assets') + path.sep);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

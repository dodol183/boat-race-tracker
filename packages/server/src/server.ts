// HTTP and WebSocket around the regatta hubs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { RegattaHub, type Role } from './hub.ts';
import { openStore, type Store } from './store.ts';
import { MAX_FIXES_PER_MESSAGE, parseClientMessage, type ServerMessage } from './protocol.ts';

export interface ServerOptions {
  /** A port number, or what the host gives: 'passenger' (cPanel's app runner) or a socket path */
  port: number | string;
  /** SQLite file (':memory:' for tests) */
  dbPath: string;
  /** Needed to create regattas (until accounts come back) */
  adminToken: string;
  now?: () => number;
  /** How often time-driven events (the start gun) are checked */
  tickMs?: number;
  /** The built app (packages/app/dist), served at / with index.html for any other page */
  staticDir?: string;
  /** Where the daily database copies go (seven, one per weekday) */
  backupDir?: string;
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
/** Open sockets per address (a club's wifi puts many phones behind one address) */
const MAX_SOCKETS_PER_ADDRESS = 200;
/** Messages per socket in 10 s; a phone sends a few, a busy relay a few dozen */
const MAX_MESSAGES_PER_10S = 300;

/**
 * The client's address. Behind cPanel's web server the socket is local, so the address comes from
 * X-Forwarded-For; only its last entry is trustworthy (added by our proxy): a client can write any
 * entries before it.
 */
function clientAddress(req: http.IncomingMessage): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded?.at(-1) || req.socket.remoteAddress || '?';
}

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

  /** The role a PIN gives (none: spectator), with a limit on wrong PINs per address and regatta */
  const checkPin = (address: string, r: { id: string; officerPin: string; skipperPin: string }, pin: string): Role | 'WRONG' | 'LOCKED' => {
    if (!pin) return 'SPECTATOR';
    const key = `${address}|${r.id}`;
    const f = pinFailures.get(key);
    if (f && now() - f.first < PIN_WINDOW_MS && f.count >= PIN_MAX_FAILURES) return 'LOCKED';
    if (pin === r.officerPin) return 'OFFICER';
    if (pin === r.skipperPin) return 'SKIPPER';
    const fresh = !f || now() - f.first >= PIN_WINDOW_MS;
    pinFailures.set(key, { count: fresh ? 1 : f!.count + 1, first: fresh ? now() : f!.first });
    return 'WRONG';
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
    // x-admin-token as well: some cPanel web servers drop the Authorization header before Node
    const raw = (req.headers['x-admin-token'] as string | undefined) ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const given = Buffer.from(raw.trim());
    const want = Buffer.from(opts.adminToken);
    return opts.adminToken.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        // What a deploy check needs: running, which build, which Node (node:sqlite needs 22.13+)
        return json(res, 200, { ok: true, serverTime: now(), version: process.env.BRT_VERSION ?? 'dev', node: process.version });
      }

      if (req.method === 'POST' && url.pathname === '/api/regattas') {
        if (!isAdmin(req)) return json(res, 401, { error: 'An admin token is needed to create a regatta.' });
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 120) return json(res, 400, { error: 'Give the regatta a name (up to 120 characters).' });
        return json(res, 201, store.createRegatta(name, now()));
      }

      const pm = url.pathname.match(/^\/api\/regattas\/([A-Za-z0-9]+)\/positions$/);
      if (req.method === 'POST' && pm) {
        const hub = hubFor(pm[1]!.toUpperCase());
        if (!hub) return json(res, 404, { error: 'No regatta with that code.' });
        const r = store.getRegatta(hub.regattaId)!;
        const address = clientAddress(req);
        const role = checkPin(address, r, String(req.headers['x-regatta-pin'] ?? ''));
        if (role === 'LOCKED') return json(res, 429, { error: 'Too many wrong PINs. Try again in 15 minutes.' });
        if (role === 'WRONG' || role === 'SPECTATOR') return json(res, 401, { error: 'That PIN is not right for this regatta.' });
        const body = await readJson(req);
        if (typeof body.trackerId !== 'string' || !Array.isArray(body.fixes) || body.fixes.length > MAX_FIXES_PER_MESSAGE) return json(res, 400, { error: 'Send trackerId and up to 500 fixes.' });
        hub.tick();
        const out = hub.acceptPositions(role, body.trackerId, body.fixes);
        return out.ok ? json(res, 200, { accepted: out.accepted, ...(out.unbound ? { unbound: true } : {}) }) : json(res, 400, { error: out.error.message, code: out.error.code });
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

  const socketsPerAddress = new Map<string, number>();

  wss.on('connection', (ws, req) => {
    const address = clientAddress(req);
    const open = (socketsPerAddress.get(address) ?? 0) + 1;
    if (open > MAX_SOCKETS_PER_ADDRESS) {
      ws.close(1008, 'Too many connections from this address');
      return;
    }
    socketsPerAddress.set(address, open);
    let windowStart = now();
    let messages = 0;
    let hub: RegattaHub | undefined;
    let role: Role = 'SPECTATOR';
    let unsubscribe: (() => void) | undefined;
    const send = (m: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };

    ws.on('message', (raw) => {
      // A device sending far more than any real one is closed
      if (now() - windowStart > 10_000) {
        windowStart = now();
        messages = 0;
      }
      if (++messages > MAX_MESSAGES_PER_10S) {
        ws.close(1008, 'Too many messages');
        return;
      }
      try {
        onMessage(raw.toString());
      } catch (err) {
        // Whatever went wrong with one message, the server and the other devices carry on
        console.error('Message failed:', err);
        send({ t: 'error', code: 'SERVER_ERROR', message: 'Something went wrong on the server with that message.' });
      }
    });

    const onMessage = (text: string) => {
      const msg = parseClientMessage(text);
      if (!msg) return send({ t: 'error', code: 'BAD_MESSAGE', message: 'Message not understood.' });

      if (msg.t === 'ping') return send({ t: 'pong', clientTime: msg.clientTime, serverTime: now() });

      if (msg.t === 'hello') {
        const target = hubFor(msg.regattaId);
        if (!target) return send({ t: 'error', code: 'NO_SUCH_REGATTA', message: 'No regatta with that code.' });
        const r = store.getRegatta(target.regattaId)!;
        const checked = checkPin(address, r, msg.pin ?? '');
        if (checked === 'LOCKED') return send({ t: 'error', code: 'TOO_MANY_PIN_TRIES', message: 'Too many wrong PINs. Try again in 15 minutes.' });
        if (checked === 'WRONG') return send({ t: 'error', code: 'WRONG_PIN', message: 'That PIN is not right for this regatta.' });
        const nextRole: Role = checked;
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
        const officer = role === 'OFFICER';
        unsubscribe = hub.subscribe({
          events: (events) => send({ t: 'events', events }),
          positions: (u) => send({ t: 'positions', ...u }),
          ...(officer
            ? { suggestions: (sg) => send({ t: 'suggestions', ...sg }), heard: (trackers) => send({ t: 'heard', trackers }) }
            : {}),
        });
        send({ t: 'positions', ...hub.positionsSnapshot() });
        if (officer) {
          send({ t: 'suggestions', ...hub.suggestions() });
          send({ t: 'heard', trackers: hub.heardList() });
        }
        return;
      }

      if (!hub) return send({ t: 'error', code: 'NOT_JOINED', message: 'Join a regatta first.' });

      if (msg.t === 'resync') {
        const r = store.getRegatta(hub.regattaId)!;
        return send({ t: 'welcome', regattaId: r.id, name: r.name, role, ...(role === 'OFFICER' ? { skipperPin: r.skipperPin } : {}), seq: hub.seq, serverTime: now(), state: hub.state });
      }

      if (msg.t === 'positions') {
        const r = hub.acceptPositions(role, msg.trackerId, msg.fixes);
        return send(r.ok ? { t: 'positionsAck', id: msg.id, accepted: r.accepted, ...(r.unbound ? { unbound: true } : {}) } : { t: 'positionsAck', id: msg.id, accepted: 0, error: r.error });
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
    };

    ws.on('close', () => {
      unsubscribe?.();
      const left = (socketsPerAddress.get(address) ?? 1) - 1;
      if (left > 0) socketsPerAddress.set(address, left);
      else socketsPerAddress.delete(address);
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  const address = server.address();
  const port: number | string = typeof address === 'object' && address ? address.port : (address ?? opts.port);

  // A copy of the database once a day, one per weekday, so a bad day can be undone
  let backupTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.backupDir) {
    const dir = opts.backupDir;
    const backup = () => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const day = new Date(now()).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
        store.backup(path.join(dir, `regattas-${day}.db`));
      } catch (err) {
        console.error('Database backup failed:', err);
      }
    };
    backup();
    backupTimer = setInterval(backup, 24 * 60 * 60_000);
    backupTimer.unref();
  }

  return {
    port,
    store,
    hubFor,
    async close() {
      clearInterval(timer);
      if (backupTimer) clearInterval(backupTimer);
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

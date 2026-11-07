// The server end to end: real HTTP and WebSocket, two race officers and a spectator.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { apply, MINUTE, type RegattaState } from '@brt/engine';
import { startServer } from '../src/server.ts';
import type { ServerMessage } from '../src/protocol.ts';

const T0 = Date.UTC(2026, 10, 7, 2, 0, 0);
const ADMIN = 'test-admin-token-1234567890';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brt-server-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A device: keeps its own copy of the state from what the server sends, as the app will */
class Device {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  state?: RegattaState;
  seq = 0;
  /** Problems seen in the message handler, reported by the test (a throw there would escape it) */
  problems: string[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMessage;
      if (m.t === 'welcome') {
        if (m.state) this.state = m.state;
        for (const e of m.events ?? []) this.take(e.seq, e.event);
        this.seq = m.seq;
      }
      if (m.t === 'events') for (const e of m.events) this.take(e.seq, e.event);
      this.msgs.push(m);
      const i = this.waiters.findIndex((w) => w.match(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
    });
  }

  private take(seq: number, event: any) {
    if (seq !== this.seq + 1) this.problems.push(`gap: expected event ${this.seq + 1}, got ${seq}`);
    this.state = apply(this.state!, event);
    this.seq = seq;
  }

  open() {
    return new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage['t']>(t: T, match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { t: T }>> {
    const found = this.msgs.find((m) => m.t === t && match(m as any));
    if (found) {
      this.msgs.splice(this.msgs.indexOf(found), 1);
      return Promise.resolve(found as any);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), 3000);
      this.waiters.push({
        match: (m) => m.t === t && match(m as any),
        resolve: (m) => {
          clearTimeout(timer);
          this.msgs.splice(this.msgs.indexOf(m), 1);
          resolve(m as any);
        },
      });
    });
  }
  async hello(regattaId: string, pin?: string, lastSeq?: number) {
    this.send({ t: 'hello', regattaId, ...(pin ? { pin } : {}), ...(lastSeq ? { lastSeq } : {}) });
    return this.next('welcome');
  }
  async command(id: string, command: unknown) {
    this.send({ t: 'command', id, command });
    return this.next('result', (m) => m.id === id);
  }
  /** Waits until this device has caught up to `seq` */
  async at(seq: number) {
    for (let i = 0; i < 100 && this.seq < seq; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(this.problems, []);
    assert.equal(this.seq, seq);
  }
  close() {
    this.ws.close();
  }
}

test('server: regattas, roles, commands, resends, catch-up, the gun and restarts', { timeout: 30_000 }, async () => {
  const dbPath = path.join(dir, 'regattas.db');
  const clock = { now: T0 };
  let server = await startServer({ port: 0, dbPath, adminToken: ADMIN, now: () => clock.now, tickMs: 20 });
  const base = () => `http://127.0.0.1:${server.port}`;

  // Creating a regatta needs the admin token
  assert.equal((await fetch(`${base()}/api/regattas`, { method: 'POST', body: JSON.stringify({ name: 'X' }) })).status, 401);
  const created = await fetch(`${base()}/api/regattas`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Langkawi Test Regatta' }),
  });
  assert.equal(created.status, 201);
  const reg = (await created.json()) as { id: string; officerPin: string; skipperPin: string };

  const officerA = new Device(server.port);
  const officerB = new Device(server.port);
  const spectator = new Device(server.port);
  await Promise.all([officerA.open(), officerB.open(), spectator.open()]);

  // Roles come from the PIN
  assert.equal((await officerA.hello(reg.id, reg.officerPin)).role, 'OFFICER');
  assert.equal((await officerB.hello(reg.id.toLowerCase(), reg.officerPin)).role, 'OFFICER');
  assert.equal((await spectator.hello(reg.id)).role, 'SPECTATOR');
  spectator.send({ t: 'hello', regattaId: reg.id, pin: '9999999' });
  assert.equal((await spectator.next('error')).code, 'WRONG_PIN');

  // Officer A sets up and starts; everyone sees it
  assert.equal((await officerA.command('cls', { type: 'saveClass', class: { id: 'c1', name: 'Class 1', ratingSystem: 'IRC' } })).ok, true);
  await officerA.command('boat-a', { type: 'saveBoat', boat: { id: 'a', classId: 'c1', sailNumber: 'MAS 11', name: 'Alpha', rating: 1 } });
  await officerB.command('boat-b', { type: 'saveBoat', boat: { id: 'b', classId: 'c1', sailNumber: 'MAS 22', name: 'Bravo', rating: 1.1 } });
  const started = await officerA.command('seq-1', { type: 'startSequence', classId: 'c1' });
  assert.deepEqual([started.ok, started.ok && started.seq], [true, 4]);

  // A spectator can't command; a refusal comes back with a message
  const nope = await spectator.command('sneaky', { type: 'abandonRace', raceId: 'c1-R1' });
  assert.equal(nope.ok ? '' : nope.error.code, 'NOT_ALLOWED');
  const refused = await officerB.command('seq-2', { type: 'startSequence', classId: 'c1' });
  assert.equal(refused.ok ? '' : refused.error.code, 'RACE_UNDER_WAY');
  assert.match(refused.ok ? '' : refused.error.message, /still under way/);

  // Resending the same command (a lost reply) changes nothing
  const again = await officerA.command('seq-1', { type: 'startSequence', classId: 'c1' });
  assert.deepEqual([again.ok, again.duplicate], [true, true]);

  // The gun: time passes on the server's clock and every device gets raceStarted
  clock.now = T0 + 5 * MINUTE + 100;
  for (const d of [officerA, officerB, spectator]) await d.at(5);
  assert.equal(officerB.state!.races['c1-R1']!.phase, 'RACING');

  clock.now = T0 + 40 * MINUTE;
  await officerB.command('fin-a', { type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' });
  for (const d of [officerA, officerB, spectator]) await d.at(6);

  // Every device's copy is exactly the server's
  const served = (await (await fetch(`${base()}/api/regattas/${reg.id}`)).json()) as { seq: number; state: RegattaState };
  assert.equal(served.seq, 6);
  for (const d of [officerA, officerB, spectator]) assert.deepEqual(d.state, served.state);
  assert.ok(!JSON.stringify(served).includes(reg.officerPin), 'PINs stay on the server');

  // A device that drops out catches up with only what it missed
  spectator.close();
  clock.now = T0 + 41 * MINUTE;
  await officerA.command('fin-b', { type: 'recordFinish', raceId: 'c1-R1', boatId: 'b' });
  const back = new Device(server.port);
  await back.open();
  back.state = spectator.state;
  back.seq = spectator.seq;
  const w = await back.hello(reg.id, undefined, spectator.seq);
  assert.equal(w.state, undefined);
  assert.deepEqual(w.events!.map((e) => e.seq), [7]);
  assert.deepEqual(back.state, officerA.state);

  // After a restart, the same state from the database
  for (const d of [officerA, officerB, back]) d.close();
  await server.close();
  server = await startServer({ port: 0, dbPath, adminToken: ADMIN, now: () => clock.now, tickMs: 20 });
  const restored = (await (await fetch(`${base()}/api/regattas/${reg.id}`)).json()) as { seq: number; state: RegattaState };
  assert.equal(restored.seq, 7);
  assert.deepEqual(restored.state, officerA.state);
  // and resent commands are still recognised
  const late = new Device(server.port);
  await late.open();
  await late.hello(reg.id, reg.officerPin);
  assert.equal((await late.command('fin-b', { type: 'recordFinish', raceId: 'c1-R1', boatId: 'b' })).duplicate, true);
  late.close();

  // Unknown regatta, malformed messages and commands
  const odd = new Device(server.port);
  await odd.open();
  odd.send({ t: 'hello', regattaId: 'NOPE' });
  assert.equal((await odd.next('error')).code, 'NO_SUCH_REGATTA');
  odd.send({ t: 'command', id: 'x', command: { type: 'saveClass' } });
  assert.equal((await odd.next('error')).code, 'NOT_JOINED');
  await odd.hello(reg.id, reg.officerPin);
  const bad = await odd.command('bad-1', { type: 'saveClass' });
  assert.equal(bad.ok ? '' : bad.error.code, 'BAD_COMMAND');
  odd.ws.send('not json');
  assert.equal((await odd.next('error')).code, 'BAD_MESSAGE');
  odd.send({ t: 'ping', clientTime: 123 });
  const pong = await odd.next('pong');
  assert.deepEqual([pong.clientTime, pong.serverTime], [123, clock.now]);
  odd.close();
  await server.close();
});

test('server: wrong PINs are limited per address and regatta', { timeout: 30_000 }, async () => {
  const server = await startServer({ port: 0, dbPath: ':memory:', adminToken: ADMIN });
  const reg = server.store.createRegatta('PIN test', Date.now());
  const d = new Device(server.port);
  await d.open();
  for (let i = 0; i < 10; i++) {
    d.send({ t: 'hello', regattaId: reg.id, pin: '0000000' });
    assert.equal((await d.next('error')).code, 'WRONG_PIN');
  }
  d.send({ t: 'hello', regattaId: reg.id, pin: reg.officerPin });
  assert.equal((await d.next('error')).code, 'TOO_MANY_PIN_TRIES', 'even the right PIN, once locked');
  d.close();
  await server.close();
});

test('server: serves the app build, with index.html for page addresses and nothing outside it', { timeout: 30_000 }, async () => {
  const site = fs.mkdtempSync(path.join(dir, 'site-'));
  fs.mkdirSync(path.join(site, 'assets'));
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(site, 'assets', 'app-1.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for the web');
  const srv = await startServer({ port: 0, dbPath: ':memory:', adminToken: ADMIN, staticDir: site });
  try {
    const get = (p: string) => fetch(`http://127.0.0.1:${srv.port}${p}`);
    let r = await get('/');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>app/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    r = await get('/assets/app-1.js');
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(r.headers.get('cache-control')!, /immutable/);
    assert.equal((await get('/assets/missing.js')).status, 404);
    assert.match(await (await get('/some/page?r=ABC')).text(), /<title>app/, 'the app handles its own addresses');
    assert.doesNotMatch(await (await get('/..%2fsecret.txt')).text(), /not for the web/);
    assert.doesNotMatch(await (await get('/%2e%2e/secret.txt')).text(), /not for the web/);
    assert.equal((await get('/api/nothing')).status, 404, 'the API stays JSON');
    assert.equal((await get('/api/health')).status, 200);
  } finally {
    await srv.close();
  }
});

test('server: only the race office is told the skipper PIN', { timeout: 30_000 }, async () => {
  const srv = await startServer({ port: 0, dbPath: ':memory:', adminToken: ADMIN });
  try {
    const reg = srv.store.createRegatta('Pins', Date.now());
    const hello = (pin?: string) =>
      new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', regattaId: reg.id, ...(pin ? { pin } : {}) })));
        ws.on('message', (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.t === 'welcome') {
            ws.close();
            resolve(m);
          }
        });
        ws.on('error', reject);
      });
    assert.equal((await hello(reg.officerPin)).skipperPin, reg.skipperPin);
    assert.equal((await hello(reg.skipperPin)).skipperPin, undefined);
    assert.equal((await hello()).skipperPin, undefined);
  } finally {
    await srv.close();
  }
});

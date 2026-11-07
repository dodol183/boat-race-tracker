// The device's connection: copy of the race, gaps, offline queue, clock, reconnects. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, decide, emptyRegatta, type RegattaState } from '@brt/engine';
import { RegattaClient, type SocketLike } from '../src/lib/client.ts';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test side
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  of(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

function harness(storage: Map<string, string> = new Map()) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const clock = { now: 1_000_000 };
  const client = new RegattaClient({
    url: 'ws://x/ws',
    regattaId: 'ABC123',
    pin: '1234',
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) },
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as any);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  /** Runs the reconnect timer (the one that isn't the 15 s ping) */
  const fireReconnect = () => {
    const t = timers.find((x) => x.ms !== 15_000);
    assert.ok(t, 'a reconnect is scheduled');
    timers.splice(timers.indexOf(t), 1);
    t.fn();
  };
  return { client, sockets, timers, clock, storage, fireReconnect, last: () => sockets.at(-1)! };
}

/** A small regatta state built with the real engine, and its events */
function regatta() {
  let s: RegattaState = emptyRegatta();
  const events: any[] = [];
  const run = (cmd: any) => {
    const d = decide(s, cmd, 0);
    assert.ok(d.ok);
    for (const e of d.events) {
      s = apply(s, e);
      events.push({ seq: s.version, at: 0, event: e });
    }
  };
  run({ type: 'saveClass', class: { id: 'c1', name: 'Class 1', ratingSystem: 'IRC' } });
  run({ type: 'saveBoat', boat: { id: 'a', classId: 'c1', sailNumber: 'MAS 11', name: 'Alpha', rating: 1 } });
  return { state: s, events, run, get s() { return s; } };
}

test('joins with the PIN, takes the state from welcome, then applies numbered events', () => {
  const h = harness();
  const r = regatta();
  h.client.connect();
  h.last().open();
  assert.deepEqual(h.last().of('hello')[0], { t: 'hello', regattaId: 'ABC123', pin: '1234' });
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'Test', role: 'OFFICER', seq: 2, serverTime: 1_000_500, state: r.state });
  let snap = h.client.getSnapshot();
  assert.deepEqual([snap.status, snap.role, snap.seq, snap.name], ['live', 'OFFICER', 2, 'Test']);
  r.run({ type: 'saveBoat', boat: { id: 'b', classId: 'c1', sailNumber: 'MAS 22', name: 'Bravo', rating: 1 } });
  h.last().push({ t: 'events', events: [r.events.at(-1)] });
  snap = h.client.getSnapshot();
  assert.equal(snap.seq, 3);
  assert.deepEqual(snap.regatta, r.s);
});

test('a gap in event numbers asks for the whole state again', () => {
  const h = harness();
  const r = regatta();
  h.client.connect();
  h.last().open();
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'T', role: 'SPECTATOR', seq: 2, serverTime: 0, state: r.state });
  h.last().push({ t: 'events', events: [{ seq: 5, at: 0, event: { type: 'classRemoved', classId: 'x' } }] });
  assert.equal(h.client.getSnapshot().seq, 2, 'the event after the gap is not applied');
  assert.equal(h.last().of('resync').length, 1);
});

test('commands wait on the device while offline and go, in order, after reconnecting', async () => {
  const h = harness();
  const r = regatta();
  h.client.connect();
  h.last().open();
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'T', role: 'OFFICER', seq: 2, serverTime: 0, state: r.state });
  h.last().drop();
  assert.equal(h.client.getSnapshot().status, 'offline');

  const p1 = h.client.send({ type: 'startSequence', classId: 'c1' });
  const p2 = h.client.send({ type: 'removeBoat', boatId: 'a' });
  assert.equal(h.client.getSnapshot().pending.length, 2);
  assert.ok(h.storage.get('brt:ABC123')!.includes('startSequence'), 'kept through a reload');

  h.fireReconnect();
  h.last().open();
  assert.equal(h.last().of('hello')[0].lastSeq, 2, 'asks only for what it missed');
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'T', role: 'OFFICER', seq: 2, serverTime: 0, events: [] });
  const sent = h.last().of('command');
  assert.deepEqual(sent.map((c) => c.command.type), ['startSequence', 'removeBoat']);
  assert.notEqual(sent[0].id, sent[1].id);

  h.last().push({ t: 'result', id: sent[0].id, ok: true, seq: 3 });
  h.last().push({ t: 'result', id: sent[1].id, ok: false, error: { code: 'BOAT_RACING', message: 'MAS 11 is in a race under way.' } });
  assert.deepEqual(await p1, { ok: true });
  assert.deepEqual(await p2, { ok: false, code: 'BOAT_RACING', message: 'MAS 11 is in a race under way.' });
  const snap = h.client.getSnapshot();
  assert.deepEqual([snap.pending.length, snap.notice?.message], [0, 'MAS 11 is in a race under way.']);
});

test('a reload while offline keeps the race and the queue', () => {
  const storage = new Map<string, string>();
  const a = harness(storage);
  const r = regatta();
  a.client.connect();
  a.last().open();
  a.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'Club Race', role: 'OFFICER', seq: 2, serverTime: 0, state: r.state });
  a.last().drop();
  void a.client.send({ type: 'startSequence', classId: 'c1' });
  a.client.close();

  const b = harness(storage);
  const snap = b.client.getSnapshot();
  assert.deepEqual([snap.name, snap.seq, snap.pending.length], ['Club Race', 2, 1]);
  assert.deepEqual(snap.regatta, r.state);
  b.client.connect();
  b.last().open();
  b.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'Club Race', role: 'OFFICER', seq: 2, serverTime: 0, events: [] });
  assert.deepEqual(b.last().of('command').map((c) => c.id), [snap.pending[0]!.id], 'resent with its original id');
});

test('server clock: from the quickest ping round trip', () => {
  const h = harness();
  h.client.connect();
  h.last().open();
  const ping = h.last().of('ping')[0];
  h.clock.now += 200; // 200 ms round trip; server clock 5 s ahead
  h.last().push({ t: 'pong', clientTime: ping.clientTime, serverTime: ping.clientTime + 100 + 5000 });
  assert.equal(h.client.serverNow() - h.clock.now, 5000);
  // A slower round trip later doesn't replace the better estimate
  h.last().push({ t: 'pong', clientTime: h.clock.now - 2000, serverTime: h.clock.now + 9000 });
  assert.equal(h.client.serverNow() - h.clock.now, 5000);
});

test('a wrong PIN stops retrying and says why; a lost connection retries with growing pauses', () => {
  const h = harness();
  h.client.connect();
  h.last().open();
  h.last().drop();
  const delays = [] as number[];
  for (let i = 0; i < 3; i++) {
    const t = h.timers.find((x) => x.ms !== 15_000)!;
    delays.push(t.ms);
    h.fireReconnect();
    h.last().open();
    h.last().drop();
  }
  assert.deepEqual(delays, [1000, 2000, 4000]);

  const w = harness();
  w.client.connect();
  w.last().open();
  w.last().push({ t: 'error', code: 'WRONG_PIN', message: 'That PIN is not right for this regatta.' });
  const snap = w.client.getSnapshot();
  assert.deepEqual([snap.status, snap.notice?.message], ['failed', 'That PIN is not right for this regatta.']);
  assert.equal(w.timers.filter((x) => x.ms !== 15_000).length, 0, 'no retry');
});

test('a connection that stops answering is given up at the next ping, and the network coming back retries at once', () => {
  const h = harness();
  const r = regatta();
  h.client.connect();
  h.last().open();
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'T', role: 'OFFICER', seq: 2, serverTime: 0, state: r.state });
  const firePing = () => {
    const t = h.timers.find((x) => x.ms === 15_000)!;
    h.timers.splice(h.timers.indexOf(t), 1);
    t.fn();
  };
  // Answered pings keep it live
  h.clock.now += 15_000;
  const ping = h.last().of('ping').at(-1);
  h.last().push({ t: 'pong', clientTime: ping.clientTime, serverTime: h.clock.now });
  firePing();
  assert.equal(h.client.getSnapshot().status, 'live');
  // The next ping goes unanswered (the socket still says it is open)
  h.clock.now += 15_000;
  firePing();
  assert.equal(h.client.getSnapshot().status, 'offline');
  assert.equal(h.sockets.length, 1);

  h.client.networkBack();
  assert.equal(h.sockets.length, 2, 'reconnects without waiting out the pause');
  assert.equal(h.timers.filter((x) => x.ms !== 15_000).length, 0, 'the pending retry is cancelled');

  h.last().open();
  h.client.networkLost();
  assert.equal(h.client.getSnapshot().status, 'offline');
});

test('positions wait on the device and go in batches, one at a time, each taken once the server says so', () => {
  const storage = new Map<string, string>();
  const h = harness(storage);
  const r = regatta();
  const fix = (t: number) => ({ lat: 1, lng: 1 + t / 1e6, fixTime: t });
  // Shared while offline (the phone had no signal): kept, and kept through a reload
  h.client.shareFixes('phone-abc123', Array.from({ length: 250 }, (_, i) => fix(i)));
  assert.equal(h.client.getSnapshot().fixesWaiting, 250);
  const again = harness(storage);
  assert.equal(again.client.getSnapshot().fixesWaiting, 250);
  assert.equal(again.client.phoneTrackerId, h.client.phoneTrackerId, 'the phone keeps its tracker id');
  assert.match(h.client.phoneTrackerId, /^phone-[a-z0-9]{6,32}$/);

  h.client.connect();
  h.last().open();
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'T', role: 'SKIPPER', seq: 2, serverTime: 0, state: r.state });
  let sent = h.last().of('positions');
  assert.deepEqual(sent.map((m) => m.fixes.length), [200], 'one batch at a time');
  // More arrive meanwhile; they don't join the batch in flight
  h.client.shareFixes('phone-abc123', [fix(300)]);
  h.last().push({ t: 'positionsAck', id: sent[0].id, accepted: 200 });
  sent = h.last().of('positions');
  assert.deepEqual(sent[1].fixes.map((f: any) => f.fixTime), [...Array.from({ length: 50 }, (_, i) => 200 + i)]);
  assert.equal(h.client.getSnapshot().fixesWaiting, 51);

  // A lost connection: the unanswered batch goes again after the reconnect
  h.last().drop();
  h.fireReconnect();
  h.last().open();
  h.last().push({ t: 'welcome', regattaId: 'ABC123', name: 'T', role: 'SKIPPER', seq: 2, serverTime: 0, events: [] });
  const resent = h.last().of('positions')[0];
  assert.equal(resent.fixes.length, 50);
  h.last().push({ t: 'positionsAck', id: resent.id, accepted: 50 });
  const tail = h.last().of('positions')[1];
  assert.deepEqual(tail.fixes.map((f: any) => f.fixTime), [300]);
  h.last().push({ t: 'positionsAck', id: tail.id, accepted: 0, unbound: true });
  const snap = h.client.getSnapshot();
  assert.equal(snap.fixesWaiting, 0);
  assert.match(snap.shareProblem!, /not connected to a boat/);
  assert.equal(storage.has('brt:ABC123:fixes'), false);

  // Tracks from the server: a full set replaces, updates add
  h.last().push({ t: 'positions', full: true, trackers: [{ trackerId: '!a1b2c3d4', fixes: [fix(h.clock.now - 1000)] }] });
  h.last().push({ t: 'positions', trackers: [{ trackerId: '!a1b2c3d4', fixes: [fix(h.clock.now)] }] });
  assert.equal(h.client.getSnapshot().tracks['!a1b2c3d4']!.length, 2);
});

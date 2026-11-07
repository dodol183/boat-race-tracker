// The regatta hub: events stored before they're sent, commands answered once, restarts exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MINUTE } from '@brt/engine';
import { RegattaHub } from '../src/hub.ts';
import { openStore } from '../src/store.ts';
import type { StoredEvent } from '../src/store.ts';

const T0 = Date.UTC(2026, 10, 7, 2, 0, 0);

function setup(dbPath = ':memory:') {
  const clock = { now: T0 };
  const store = openStore(dbPath);
  const reg = store.createRegatta('Test Regatta', T0);
  const hub = new RegattaHub(reg.id, store, () => clock.now);
  const ok = (id: string, command: any) => {
    const r = hub.handle('OFFICER', id, command);
    assert.ok(r.ok, `${id}: ${JSON.stringify(r)}`);
    return r;
  };
  ok('c1', { type: 'saveClass', class: { id: 'c1', name: 'Class 1', ratingSystem: 'IRC' } });
  ok('b1', { type: 'saveBoat', boat: { id: 'a', classId: 'c1', sailNumber: 'MAS 11', name: 'Alpha', rating: 1 } });
  ok('b2', { type: 'saveBoat', boat: { id: 'b', classId: 'c1', sailNumber: 'MAS 22', name: 'Bravo', rating: 1.1 } });
  return { clock, store, reg, hub, ok };
}

test('the gun fires at the start time, through tick, and every subscriber gets the events in order', () => {
  const { clock, hub, ok } = setup();
  const seen: StoredEvent[] = [];
  hub.subscribe({ events: (e) => seen.push(...e) });
  ok('seq', { type: 'startSequence', classId: 'c1' });
  clock.now = T0 + 4 * MINUTE;
  assert.deepEqual(hub.tick(), []);
  clock.now = T0 + 5 * MINUTE + 300;
  const fired = hub.tick();
  assert.deepEqual(fired.map((e) => [e.event.type, e.seq]), [['raceStarted', 5]]);
  assert.equal((fired[0]!.event as any).at, T0 + 5 * MINUTE, 'started at the gun');
  assert.deepEqual(seen.map((e) => e.seq), [4, 5]);
  assert.deepEqual(hub.tick(), [], 'fires once');
});

test('a resent command gets the same answer and changes nothing', () => {
  const { hub, ok } = setup();
  const first = ok('seq', { type: 'startSequence', classId: 'c1' });
  const before = hub.seq;
  const again = hub.handle('OFFICER', 'seq', { type: 'startSequence', classId: 'c1' });
  assert.deepEqual(again, { ...first, duplicate: true });
  assert.equal(hub.seq, before);
});

test('a refusal is remembered too, so a resend is refused the same way', () => {
  const { hub } = setup();
  const r1 = hub.handle('OFFICER', 'x1', { type: 'startSequence', classId: 'nope' });
  assert.equal(r1.ok, false);
  const r2 = hub.handle('OFFICER', 'x1', { type: 'startSequence', classId: 'nope' });
  assert.deepEqual(r2, { ...r1, duplicate: true });
});

test('skippers and spectators can not command; the same id works once unlocked', () => {
  const { hub } = setup();
  for (const role of ['SKIPPER', 'SPECTATOR'] as const) {
    const r = hub.handle(role, 'start', { type: 'startSequence', classId: 'c1' });
    assert.equal(r.ok ? '' : r.error.code, 'NOT_ALLOWED');
  }
  assert.equal(hub.handle('OFFICER', 'start', { type: 'startSequence', classId: 'c1' }).ok, true);
});

test('after a restart the state, the event numbers and the answered commands are all the same', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brt-hub-'));
  const dbPath = path.join(dir, 'r.db');
  try {
    const a = setup(dbPath);
    a.ok('seq', { type: 'startSequence', classId: 'c1' });
    a.clock.now = T0 + 6 * MINUTE;
    a.hub.tick();
    a.ok('fin', { type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' });
    const state = a.hub.state;
    a.store.close();

    const store = openStore(dbPath);
    const hub = new RegattaHub(a.reg.id, store, () => T0 + 7 * MINUTE);
    assert.deepEqual(hub.state, state);
    assert.deepEqual(store.events(a.reg.id).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
    const again = hub.handle('OFFICER', 'fin', { type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' });
    assert.equal(again.duplicate, true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('events since a number come from the record', () => {
  const { hub, ok } = setup();
  ok('seq', { type: 'startSequence', classId: 'c1' });
  assert.deepEqual(hub.eventsSince(2).map((e) => [e.seq, e.event.type]), [[3, 'boatSaved'], [4, 'sequenceStarted']]);
});

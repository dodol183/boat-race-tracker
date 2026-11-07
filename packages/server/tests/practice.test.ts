// Practice boats: a whole race sailed by the server, with GPS suggestions as on the day.
// Positions are made up, near 1°N 1°E.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLineOffset, type Command } from '@brt/engine';
import { openStore } from '../src/store.ts';
import { RegattaHub } from '../src/hub.ts';
import { practiceBoats, practiceFix } from '../src/practice.ts';

const T0 = Date.UTC(2026, 10, 7, 2, 0, 0);
const m = (x: number, y: number) => ({ lat: 1 + y / 111_320, lng: 1 + x / 111_303 });
const COURSE = { startPin: m(-100, 0), startCommittee: m(100, 0), firstMark: m(0, 800) };

function practiceRegatta() {
  const store = openStore(':memory:');
  const reg = store.createRegatta('Practice', T0);
  const clock = { now: T0 };
  const hub = new RegattaHub(reg.id, store, () => clock.now);
  let n = 0;
  const run = (cmd: Command) => {
    const r = hub.handle('OFFICER', `c${n++}`, cmd);
    assert.ok(r.ok, JSON.stringify(r));
  };
  run({ type: 'setCourse', course: COURSE });
  run({ type: 'saveClass', class: { id: 'prac', name: 'Practice', ratingSystem: 'PY', sequenceMinutes: 3 } });
  for (let i = 1; i <= 5; i++) {
    run({ type: 'saveBoat', boat: { id: `p${i}`, classId: 'prac', sailNumber: `PRAC ${i}`, name: `Practice ${i}`, rating: 1100 } });
    run({ type: 'bindTracker', boatId: `p${i}`, trackerId: `sim-${i}` });
  }
  run({ type: 'setOptions', options: { practiceBoatsSail: true } });
  return { store, hub, clock, run };
}

/** Runs the hub's clock forward, ticking as the server's timer would */
function sail(g: ReturnType<typeof practiceRegatta>, untilMs: number) {
  while (g.clock.now < untilMs) {
    g.clock.now += 1000;
    g.hub.tick();
  }
}

test('practice boats wait below the line, one jumps the gun, and GPS says so', () => {
  const g = practiceRegatta();
  g.run({ type: 'startSequence', classId: 'prac' });
  const gun = T0 + 3 * 60_000;
  sail(g, gun - 30_000);
  const boats = practiceBoats(g.hub.state);
  assert.deepEqual(boats.map((b) => b.sailNumber), ['PRAC 1', 'PRAC 2', 'PRAC 3', 'PRAC 4', 'PRAC 5']);
  for (const [i, b] of boats.entries()) {
    const f = practiceFix(g.hub.state, b, i, 5, g.clock.now)!;
    assert.ok(startLineOffset(f, COURSE.startPin, COURSE.startCommittee, COURSE.firstMark)! < 0, `${b.sailNumber} below the line before the gun`);
  }
  sail(g, gun + 20_000);
  assert.deepEqual(g.hub.suggestions().over.map((o) => o.boatId), ['p1'], 'only PRAC 1 was over');
});

test('practice boats sail the course and GPS suggests each finish, in order of speed', () => {
  const g = practiceRegatta();
  g.run({ type: 'startSequence', classId: 'prac' });
  const gun = T0 + 3 * 60_000;
  sail(g, gun + 5000);
  // PRAC 1 is called back and sails below the line again before starting
  g.run({ type: 'individualRecall', raceId: 'prac-R1', boatIds: ['p1'] });
  // About 1.7 km of course at 2.4–3.8 m/s: everyone is home within 15 minutes
  sail(g, gun + 15 * 60_000);
  const finishes = g.hub.suggestions().finishes;
  assert.equal(finishes.length, 5, 'every boat crossed the finish line');
  assert.deepEqual(finishes.map((f) => f.boatId), ['p5', 'p4', 'p3', 'p2', 'p1'], 'fastest first; PRAC 1 last after going back');
  for (const f of finishes) assert.ok(f.gapSec <= 4, 'phones-like 3 s fixes give tight estimates');
  // The track is stored like any tracker's
  assert.ok(g.store.fixesSince(g.hub.regattaId, gun).get('sim-5')!.length > 200);
});

test('practice boats stay put without a course, and only sail while switched on', () => {
  const g = practiceRegatta();
  g.run({ type: 'setOptions', options: { practiceBoatsSail: false } });
  sail(g, T0 + 30_000);
  assert.equal(g.store.fixesSince(g.hub.regattaId, 0).size, 0);
  const noCourse = { ...g.hub.state, course: {} };
  assert.equal(practiceFix(noCourse, practiceBoats(noCourse)[0]!, 0, 5, T0), null);
});

test('two server processes sail the practice boats to the same places', () => {
  const g = practiceRegatta();
  const b = practiceBoats(g.hub.state)[2]!;
  const t = T0 + 123_000;
  assert.deepEqual(practiceFix(g.hub.state, b, 2, 5, t), practiceFix(structuredClone(g.hub.state), b, 2, 5, t));
});

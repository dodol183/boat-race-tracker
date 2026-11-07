// Trackers, the course, and what GPS suggests. Positions are made up, in metres from a point at sea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFixes, gpsSuggestions, mergeTrail, trackerId, type Fix, type LatLng } from '../src/index.ts';
import { fleet, started } from './helpers.ts';

const ORIGIN = { lat: 1, lng: 1 };
/** A point `x` m east and `y` m north of the origin */
const m = (x: number, y: number): LatLng => ({ lat: ORIGIN.lat + y / 111_320, lng: ORIGIN.lng + x / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });
/** Start line 200 m wide running east–west through the origin; the first mark 1 km north */
const COURSE = { startPin: m(-100, 0), startCommittee: m(100, 0), firstMark: m(0, 1000) };
const fix = (t: number, x: number, y: number): Fix => ({ ...m(x, y), fixTime: t });

test('tracker ids: one written form for each radio, phones keep their own', () => {
  assert.equal(trackerId('!A1B2C3D4'), '!a1b2c3d4');
  assert.equal(trackerId('0xa1b2c3d4'), '!a1b2c3d4');
  assert.equal(trackerId('a1b2c3d4'), '!a1b2c3d4');
  assert.equal(trackerId('!b2c3d4'), '!00b2c3d4');
  assert.equal(trackerId(0xa1b2c3d4), '!a1b2c3d4');
  assert.equal(trackerId('12345678'), null, 'a bare number is not read as hex');
  assert.equal(trackerId('phone-AbC123xy'), 'phone-abc123xy');
  assert.equal(trackerId('phone-x'), null);
  assert.equal(trackerId('MAS 11'), null);
});

test('fixes: only real positions, oldest first, a fast clock pulled back', () => {
  const now = 1_000_000_000;
  const got = cleanFixes(
    [
      { lat: 1, lng: 1, fixTime: now - 2000, speedKt: 5.5, headingDeg: 370 },
      { lat: 0, lng: 0, fixTime: now - 1500 }, // no GPS fix yet
      { lat: 95, lng: 1, fixTime: now - 1400 },
      { lat: 1.001, lng: 1, fixTime: now - 3000, speedKt: -1 },
      { lat: 1.002, lng: 1, fixTime: now + 10_000 }, // a phone clock 10 s fast
      { lat: 1.003, lng: 1, fixTime: now + 3_600_000 }, // an hour out: wrong
      { lat: 1, lng: 1, fixTime: 'soon' },
      null,
    ],
    now
  );
  assert.deepEqual(got, [
    { lat: 1.001, lng: 1, fixTime: now - 3000 },
    { lat: 1, lng: 1, fixTime: now - 2000, speedKt: 5.5 },
    { lat: 1.002, lng: 1, fixTime: now },
  ]);
  // A late backlog slots into the trail in time order
  const trail = mergeTrail([fix(10, 0, 0), fix(30, 0, 0)], [fix(20, 1, 1), fix(40, 2, 2)]);
  assert.deepEqual(trail.map((f) => f.fixTime), [10, 20, 30, 40]);
});

test('course: both ends of a line, sensible lengths', () => {
  const g = fleet();
  assert.equal(g.refused({ type: 'setCourse', course: { startPin: m(0, 0) } }), 'HALF_LINE');
  assert.equal(g.refused({ type: 'setCourse', course: { startPin: m(0, 0), startCommittee: m(2, 0) } }), 'BAD_LINE');
  assert.equal(g.refused({ type: 'setCourse', course: { startPin: m(0, 0), startCommittee: { lat: 0, lng: 0 } } }), 'BAD_POSITION');
  g.do({ type: 'setCourse', course: COURSE });
  assert.deepEqual(g.state.course, COURSE);
});

test('skippers connect a tracker only when allowed, only to a boat without one, and can disconnect only their phone', () => {
  const g = fleet();
  assert.equal(g.refused({ type: 'claimTracker', boatId: 'a', trackerId: 'phone-abc123' }), 'CLAIM_OFF');
  g.do({ type: 'setOptions', options: { skippersConnectTrackers: true } });
  g.do({ type: 'claimTracker', boatId: 'a', trackerId: 'phone-ABC123' });
  assert.equal(g.state.boats.a!.trackerId, 'phone-abc123');
  assert.deepEqual(g.do({ type: 'claimTracker', boatId: 'a', trackerId: 'phone-abc123' }), [], 'asking again changes nothing');
  assert.equal(g.refused({ type: 'claimTracker', boatId: 'a', trackerId: '!a1b2c3d4' }), 'BOAT_HAS_TRACKER');
  assert.equal(g.refused({ type: 'claimTracker', boatId: 'b', trackerId: 'phone-abc123' }), 'TRACKER_IN_USE');
  g.do({ type: 'claimTracker', boatId: 'b', trackerId: '!A1B2C3D4' });
  assert.equal(g.refused({ type: 'releaseTracker', boatId: 'b', trackerId: '!a1b2c3d4' }), 'ASK_RACE_OFFICE');
  assert.equal(g.refused({ type: 'releaseTracker', boatId: 'a', trackerId: 'phone-other1' }), 'NOT_YOUR_TRACKER');
  g.do({ type: 'releaseTracker', boatId: 'a', trackerId: 'phone-abc123' });
  assert.equal(g.state.boats.a!.trackerId, undefined);
  assert.equal(g.refused({ type: 'bindTracker', boatId: 'a', trackerId: 'MAS 11' }), 'BAD_TRACKER');
});

test('GPS over the line at the gun: suggested while X may fly, until the race office acts', () => {
  const g = started();
  const gun = g.at(5);
  g.do({ type: 'setCourse', course: COURSE }, gun); // the gun has gone: the race is under way
  const trails = {
    a: [fix(gun - 5000, 0, 2), fix(gun + 5000, 0, 18)], // 10 m over at the gun
    b: [fix(gun - 4000, 50, -30), fix(gun + 6000, 50, -5)], // behind the line
    c: [fix(gun - 60_000, -50, 40)], // a fix a minute old can't say where it was at the gun
  };
  assert.deepEqual(gpsSuggestions(g.state, trails, gun + 10_000).over, [{ raceId: 'c1-R1', boatId: 'a', metres: 10 }]);
  assert.deepEqual(gpsSuggestions(g.state, trails, gun + 5 * 60_000).over, [], 'X can no longer be flown');
  g.do({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['a'] }, gun + 20_000);
  assert.deepEqual(gpsSuggestions(g.state, trails, gun + 30_000).over, []);
});

test('GPS finish: the first crossing after being well up the course, timed between the fixes', () => {
  const g = started();
  const gun = g.at(5);
  g.do({ type: 'setCourse', course: COURSE }, gun); // the finish is the start line
  const s = 1000;
  const trails = {
    // Starts, sails 600 m up the course, comes back through the line: 30 m north at 40:00, 30 m south at 40:30
    a: [fix(gun, 0, -5), fix(gun + 20 * s, 0, 30), fix(gun + 600 * s, 0, 600), fix(gun + 2400 * s, 20, 30), fix(gun + 2430 * s, 20, -30)],
    // Started 3 minutes late from 200 m behind the line: crossing it then is starting, not finishing
    b: [fix(gun, 0, -200), fix(gun + 180 * s, 0, -10), fix(gun + 200 * s, 0, 40), fix(gun + 400 * s, 0, 120)],
    // Crosses well outside the line's ends
    c: [fix(gun, 0, -5), fix(gun + 600 * s, 0, 600), fix(gun + 2400 * s, 400, 30), fix(gun + 2430 * s, 400, -30)],
  };
  const now = gun + 2500 * s;
  assert.deepEqual(gpsSuggestions(g.state, trails, now).finishes, [{ raceId: 'c1-R1', boatId: 'a', at: gun + 2415 * s, gapSec: 30 }]);

  // A separate finish line: being away from it is enough
  g.do({ type: 'setCourse', course: { ...COURSE, finishPin: m(-50, 1000), finishCommittee: m(50, 1000) } }, now);
  const up = { b: [fix(gun + 100 * s, 0, 100), fix(gun + 900 * s, 0, 980), fix(gun + 910 * s, 0, 1010)] };
  assert.deepEqual(gpsSuggestions(g.state, up, now).finishes.map((f) => [f.boatId, f.at]), [['b', gun + 906_667]]);

  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'b', at: gun + 906_667, source: 'GPS' }, now);
  assert.deepEqual(gpsSuggestions(g.state, up, now).finishes, [], 'once recorded it is no longer suggested');
  assert.equal(g.state.races['c1-R1']!.entries.b!.finishSource, 'GPS');
});

test('fixes: to the second, one per second, however fast a device sends them', () => {
  const now = 1_000_000_000;
  const flood = Array.from({ length: 100 }, (_, i) => ({ lat: 1, lng: 1 + i / 1e6, fixTime: now - 5000 + i * 10 }));
  const got = cleanFixes(flood, now);
  assert.deepEqual(got.map((f) => f.fixTime), [now - 5000, now - 4000]);
});

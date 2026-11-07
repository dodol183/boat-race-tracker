// The race rules: setup, start sequence, AP, recalls, finishes, ending a race.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, emptyRegatta, replay, raceIdFor, phaseAt, MINUTE } from '../src/index.ts';
import { fleet, started, Regatta, T0 } from './helpers.ts';

test('setup: classes and boats are checked', () => {
  const g = fleet();
  assert.equal(g.refused({ type: 'saveClass', class: { id: 'x', name: 'class 1', ratingSystem: 'IRC' } }), 'CLASS_NAME_TAKEN');
  assert.equal(g.refused({ type: 'saveBoat', boat: { id: 'z', classId: 'nope', sailNumber: 'X 1', name: '', rating: 1 } }), 'NO_SUCH_CLASS');
  assert.equal(g.refused({ type: 'saveBoat', boat: { id: 'z', classId: 'c1', sailNumber: ' mas  11 ', name: '', rating: 1 } }), 'SAIL_TAKEN');
  assert.equal(g.refused({ type: 'saveBoat', boat: { id: 'z', classId: 'py', sailNumber: 'X 1', name: '', rating: 1.1 } }), 'BAD_RATING', 'a TCC is not a Portsmouth Number');
  assert.equal(g.refused({ type: 'saveBoat', boat: { id: 'z', classId: 'c1', sailNumber: 'X 1', name: '', rating: 1100 } }), 'BAD_RATING');
  assert.equal(g.refused({ type: 'removeClass', classId: 'c1' }), 'CLASS_HAS_BOATS');
  assert.equal(g.state.boats.a!.sailNumber, 'MAS 11');
});

test('trackers: one boat per tracker', () => {
  const g = fleet();
  g.do({ type: 'bindTracker', boatId: 'a', trackerId: '!a1b2c3d4' });
  assert.equal(g.refused({ type: 'bindTracker', boatId: 'b', trackerId: '!a1b2c3d4' }), 'TRACKER_IN_USE');
  // Editing the boat keeps its tracker
  g.do({ type: 'saveBoat', boat: { id: 'a', classId: 'c1', sailNumber: 'MAS 11', name: 'Alpha II', rating: 1.0 } });
  assert.equal(g.state.boats.a!.trackerId, '!a1b2c3d4');
  g.do({ type: 'bindTracker', boatId: 'a', trackerId: null });
  assert.equal(g.state.boats.a!.trackerId, undefined);
});

test('start sequence: 5 minutes from the warning; the gun starts the race with every boat in the class', () => {
  const g = fleet();
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(0));
  const r = g.race('c1-R1');
  assert.deepEqual([r.phase, r.number, r.warningAt, r.startAt], ['SEQUENCE', 1, g.at(0), g.at(5)]);
  assert.equal(phaseAt(r, g.at(4.9)), 'SEQUENCE');
  assert.equal(phaseAt(r, g.at(5)), 'RACING');
  assert.deepEqual(advance(g.state, g.at(4.99)), []);
  const ev = advance(g.state, g.at(5.2));
  assert.deepEqual(ev, [{ type: 'raceStarted', raceId: 'c1-R1', at: g.at(5), boatIds: ['a', 'b', 'c'] }], 'started at the gun, not when noticed');
  assert.equal(g.refused({ type: 'startSequence', classId: 'c1' }), 'RACE_UNDER_WAY');
  // Another class can start meanwhile
  g.do({ type: 'startSequence', classId: 'py' }, g.at(1));
  assert.equal(g.race('py-R1').startAt, g.at(6));
});

test('a command just after the gun acts on the started race', () => {
  const g = started();
  const ev = g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' }, g.at(40));
  assert.deepEqual(ev.map((e) => e.type), ['raceStarted', 'finishRecorded']);
  assert.equal(g.race('c1-R1').entries.a!.finishAt, g.at(40));
});

test('AP: only before the start; lowering it gives a warning 1 minute later and a start 6 minutes later', () => {
  const g = fleet();
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(0));
  g.do({ type: 'postpone', raceId: 'c1-R1' }, g.at(2));
  assert.equal(g.race('c1-R1').phase, 'POSTPONED');
  assert.deepEqual(advance(g.state, g.at(10)), [], 'no gun while AP is up');
  g.do({ type: 'resumeSequence', raceId: 'c1-R1' }, g.at(20));
  assert.deepEqual([g.race('c1-R1').warningAt, g.race('c1-R1').startAt], [g.at(21), g.at(26)]);
  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' }, g.at(60));
  assert.equal(g.refused({ type: 'postpone', raceId: 'c1-R1' }), 'NOT_BEFORE_START');
});

test('general recall: back to waiting, same race number, entries cleared; not once boats have finished', () => {
  const g = started();
  g.do({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['a'] }, g.at(5.5));
  g.do({ type: 'generalRecall', raceId: 'c1-R1' }, g.at(6));
  let r = g.race('c1-R1');
  assert.deepEqual([r.phase, r.generalRecalls, r.xFlag, Object.keys(r.entries).length], ['RECALLED', 1, undefined, 0]);
  g.do({ type: 'resumeSequence', raceId: 'c1-R1' }, g.at(8));
  r = g.race('c1-R1');
  assert.deepEqual([r.number, r.startAt], [1, g.at(14)]);
  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'b' }, g.at(50));
  assert.equal(g.refused({ type: 'generalRecall', raceId: 'c1-R1' }), 'BOATS_FINISHED');
});

test('X flag: within 4 minutes of the start, once; returning clears OCS', () => {
  const g = started();
  assert.equal(g.refused({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['zz'] }, g.at(5.5)), 'NOT_IN_RACE');
  g.do({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['a', 'b', 'a'] }, g.at(5.5));
  const r = g.race('c1-R1');
  assert.deepEqual(r.xFlag?.boatIds, ['a', 'b']);
  assert.deepEqual([r.entries.a!.ocs, r.entries.b!.ocs, r.entries.c!.ocs], [true, true, false]);
  assert.equal(g.refused({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['c'] }, g.at(6)), 'X_ALREADY');
  g.do({ type: 'markReturned', raceId: 'c1-R1', boatId: 'a' }, g.at(6));
  assert.deepEqual([g.race('c1-R1').entries.a!.ocs, g.race('c1-R1').entries.a!.returned], [false, true]);
  assert.equal(g.refused({ type: 'markReturned', raceId: 'c1-R1', boatId: 'a' }), 'NOT_OCS');
  g.do({ type: 'lowerX', raceId: 'c1-R1' }, g.at(9));
  assert.equal(g.refused({ type: 'lowerX', raceId: 'c1-R1' }), 'X_NOT_UP');
});

test('X flag: refused 4 minutes after the start', () => {
  const g = started();
  assert.equal(g.refused({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['a'] }, g.at(9)), 'X_TOO_LATE');
});

test('finishes: timed by the server, checked, and undoable while racing', () => {
  const g = started();
  assert.equal(g.refused({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' }, g.at(4)), 'NOT_RACING');
  assert.equal(g.refused({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a', at: g.at(4) }, g.at(30)), 'BEFORE_START');
  assert.equal(g.refused({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a', at: g.at(31) }, g.at(30)), 'IN_FUTURE');
  // A device clock a second ahead means "now"
  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a', at: g.at(30) + 1000 }, g.at(30));
  assert.equal(g.race('c1-R1').entries.a!.finishAt, g.at(30));
  assert.equal(g.refused({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' }, g.at(31)), 'ALREADY_FINISHED');
  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'b', at: g.at(30.5), source: 'GPS' }, g.at(31));
  assert.equal(g.race('c1-R1').entries.b!.finishSource, 'GPS');
  g.do({ type: 'undoFinish', raceId: 'c1-R1', boatId: 'a' }, g.at(32));
  assert.equal(g.race('c1-R1').entries.a!.finishAt, undefined);
  g.do({ type: 'setPenalty', raceId: 'c1-R1', boatId: 'c', code: 'RET' }, g.at(33));
  assert.equal(g.refused({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'c' }, g.at(34)), 'HAS_PENALTY');
});

test('ending a race: no finish is DNF, still over the line is OCS even with a finish, given codes stand', () => {
  const g = started();
  g.do({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['b'] }, g.at(5.5));
  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'b' }, g.at(30));
  g.do({ type: 'setPenalty', raceId: 'c1-R1', boatId: 'c', code: 'RET' }, g.at(31));
  g.do({ type: 'endRace', raceId: 'c1-R1' }, g.at(60));
  const r = g.race('c1-R1');
  assert.deepEqual([r.phase, r.entries.a!.penalty, r.entries.b!.penalty, r.entries.c!.penalty], ['FINISHED', 'DNF', 'OCS', 'RET']);
  assert.equal(g.refused({ type: 'undoFinish', raceId: 'c1-R1', boatId: 'b' }), 'NOT_RACING');
  // The race office can still correct a code after the race
  g.do({ type: 'setPenalty', raceId: 'c1-R1', boatId: 'c', code: null }, g.at(70));
  assert.equal(g.race('c1-R1').entries.c!.penalty, undefined);
  // The next start is race 2
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(80));
  assert.ok(g.state.races[raceIdFor('c1', 2)]);
});

test('an abandoned race keeps its number, and the next start is the next number', () => {
  const g = started();
  g.do({ type: 'abandonRace', raceId: 'c1-R1' }, g.at(10));
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(20));
  assert.equal(g.race('c1-R2').number, 2);
});

test('boats in a race under way keep their class and stay in the fleet', () => {
  const g = started();
  g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' }, g.at(20));
  assert.equal(g.refused({ type: 'removeBoat', boatId: 'a' }), 'BOAT_RACING');
  assert.equal(g.refused({ type: 'saveBoat', boat: { id: 'a', classId: 'py', sailNumber: 'MAS 11', name: 'Alpha', rating: 1000 } }), 'BOAT_RACING');
});

test('replaying the events rebuilds exactly the same state', () => {
  const g = started();
  g.do({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['c'] }, g.at(5.2));
  g.do({ type: 'markReturned', raceId: 'c1-R1', boatId: 'c' }, g.at(6));
  for (const [id, m] of [['a', 40], ['b', 41], ['c', 42]] as const) g.do({ type: 'recordFinish', raceId: 'c1-R1', boatId: id }, g.at(m));
  g.do({ type: 'endRace', raceId: 'c1-R1' }, g.at(50));
  assert.deepEqual(replay(g.events, emptyRegatta()), g.state);
  assert.equal(g.state.version, g.events.length);
});

test('commands carry no clock of their own: the same command at the same time decides the same way', () => {
  const a = started();
  const b = started();
  const cmd = { type: 'recordFinish', raceId: 'c1-R1', boatId: 'a' } as const;
  assert.deepEqual(a.do(cmd, T0 + 30 * MINUTE), b.do(cmd, T0 + 30 * MINUTE));
  assert.ok(new Regatta().state.version === 0);
});

// Sound signals, the X flag's state, and which side of the start line a boat is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSignal, sequenceSignals, startLineSide, xFlagState, MINUTE } from '../src/index.ts';
import { fleet, started } from './helpers.ts';

test('signals: warning, preparatory, one-minute and start (RRS 26)', () => {
  const g = fleet();
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(0));
  const r = g.race('c1-R1');
  assert.deepEqual(sequenceSignals(r).map((s) => [s.name, (s.at - g.at(0)) / MINUTE]), [
    ['WARNING', 0], ['PREPARATORY', 1], ['ONE_MINUTE', 4], ['START', 5],
  ]);
  assert.equal(nextSignal(r, g.at(2))?.name, 'ONE_MINUTE');
  // After AP, the new sequence's signals
  g.do({ type: 'postpone', raceId: 'c1-R1' }, g.at(2));
  assert.deepEqual(sequenceSignals(g.race('c1-R1')), []);
  g.do({ type: 'resumeSequence', raceId: 'c1-R1' }, g.at(10));
  assert.equal(sequenceSignals(g.race('c1-R1'))[0]!.at, g.at(11));
});

test('signals: a 3-minute sequence still has its preparatory signal a minute after the warning', () => {
  const g = fleet();
  g.do({ type: 'saveClass', class: { id: 'c1', name: 'Class 1', ratingSystem: 'IRC', sequenceMinutes: 3 } });
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(0));
  assert.deepEqual(sequenceSignals(g.race('c1-R1')).map((s) => [s.name, (s.at - g.at(0)) / MINUTE]), [
    ['WARNING', 0], ['PREPARATORY', 1], ['ONE_MINUTE', 2], ['START', 3],
  ]);
});

test('X flag state: time left, boats still over, when to lower', () => {
  const g = started();
  g.do({ type: 'individualRecall', raceId: 'c1-R1', boatIds: ['a', 'b'] }, g.at(5.5));
  let x = xFlagState(g.race('c1-R1'), g.at(6));
  assert.deepEqual([x.up, x.msLeft, x.stillOver, x.shouldLower], [true, 3 * MINUTE, ['a', 'b'], false]);
  g.do({ type: 'markReturned', raceId: 'c1-R1', boatId: 'a' }, g.at(6));
  g.do({ type: 'markReturned', raceId: 'c1-R1', boatId: 'b' }, g.at(6.5));
  x = xFlagState(g.race('c1-R1'), g.at(7));
  assert.deepEqual([x.stillOver, x.shouldLower], [[], true]);
  assert.equal(xFlagState(g.race('c1-R1'), g.at(9.5)).msLeft, 0);
  g.do({ type: 'lowerX', raceId: 'c1-R1' }, g.at(9.5));
  assert.equal(xFlagState(g.race('c1-R1'), g.at(10)).up, false);
});

test('start line: the course side is the side the first mark is on, whatever the line angle', () => {
  const pin = { lat: 10, lng: 20 };
  const rc = { lat: 10, lng: 20.002 };
  const north = { lat: 10.01, lng: 20.001 };
  assert.equal(startLineSide({ lat: 10.0005, lng: 20.001 }, pin, rc, north), 'COURSE');
  assert.equal(startLineSide({ lat: 9.9995, lng: 20.001 }, pin, rc, north), 'PRE_START');
  assert.equal(startLineSide({ lat: 10.000005, lng: 20.001 }, pin, rc, north), null, 'on the line');
  // Course to the south: the same position is now behind the line
  assert.equal(startLineSide({ lat: 10.0005, lng: 20.001 }, pin, rc, { lat: 9.99, lng: 20.001 }), 'PRE_START');
  // A north-south line with the first mark to the east (latitude alone can't tell)
  const p2 = { lat: 10, lng: 20 };
  const r2 = { lat: 10.002, lng: 20 };
  const east = { lat: 10.001, lng: 20.01 };
  assert.equal(startLineSide({ lat: 10.001, lng: 20.0005 }, p2, r2, east), 'COURSE');
  assert.equal(startLineSide({ lat: 10.001, lng: 19.9995 }, p2, r2, east), 'PRE_START');
  assert.equal(startLineSide({ lat: NaN, lng: 20 }, pin, rc, north), null);
});

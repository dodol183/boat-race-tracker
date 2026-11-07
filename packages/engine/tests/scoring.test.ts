// Scoring: corrected time, race points with ties and codes, series with discards and tie-breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctedSeconds, discardsFor, raceResults, seriesStandings } from '../src/index.ts';
import { fleet, type Regatta } from './helpers.ts';

test('corrected time: IRC/ORC multiply by the TCC; Portsmouth divides by the number', () => {
  assert.equal(correctedSeconds(3600, 'IRC', 1.05), 3780);
  assert.equal(correctedSeconds(3600, 'ORC', 0.95), 3420);
  assert.equal(correctedSeconds(3300, 'PY', 1100), 3000);
  assert.equal(correctedSeconds(100, 'PY', 0), 100, 'a bad rating leaves the time alone');
});

/** Runs Class 1 race n with finishes at the given minutes after its start (or a code) */
function race(g: Regatta, startMin: number, finishes: Record<string, number | 'DNF' | 'RET' | 'DSQ' | 'OCS'>) {
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(startMin));
  const start = startMin + 5;
  const raceId = Object.values(g.state.races).find((r) => r.phase === 'SEQUENCE')!.id;
  for (const [boat, f] of Object.entries(finishes)) {
    if (typeof f === 'number') g.do({ type: 'recordFinish', raceId, boatId: boat, at: g.at(start + f) }, g.at(start + 120));
  }
  for (const [boat, f] of Object.entries(finishes)) {
    if (typeof f === 'string') g.do({ type: 'setPenalty', raceId, boatId: boat, code: f }, g.at(start + 120));
  }
  g.do({ type: 'endRace', raceId }, g.at(start + 121));
  return g.race(raceId);
}

test('race results: ranked on corrected time; codes score entries + 1', () => {
  const g = fleet();
  // a 1.0 at 60 min = 3600; b 1.1 at 55 min = 3630; c 0.9 retired
  const r = race(g, 0, { a: 60, b: 55, c: 'RET' });
  const rows = raceResults(g.state, r);
  assert.deepEqual(rows.map((x) => [x.sailNumber, x.place, x.points, x.code]), [
    ['MAS 11', 1, 1, undefined],
    ['MAS 22', 2, 2, undefined],
    ['MAS 33', undefined, 4, 'RET'],
  ]);
  assert.equal(rows[1]!.correctedSec, 3630);
});

test('race results: equal corrected times share the average of the places', () => {
  const g = fleet();
  // a 1.0 at 66 min = 3960; b 1.1 at 60 min = 3960; c 0.9 at 80 min = 4320
  const r = race(g, 0, { a: 66, b: 60, c: 80 });
  assert.deepEqual(raceResults(g.state, r).map((x) => [x.sailNumber, x.place, x.points]), [
    ['MAS 11', 1, 1.5],
    ['MAS 22', 1, 1.5],
    ['MAS 33', 3, 3],
  ]);
});

test('Portsmouth: the slower boat sailing a little slower still wins on corrected time', () => {
  const g = fleet();
  g.do({ type: 'startSequence', classId: 'py' }, g.at(0));
  // Laser PN 1100 at 55 min = 3000 s corrected; Topper PN 1300 at 63 min = 2907.7 s corrected
  g.do({ type: 'recordFinish', raceId: 'py-R1', boatId: 'l1', at: g.at(60) }, g.at(70));
  g.do({ type: 'recordFinish', raceId: 'py-R1', boatId: 'l2', at: g.at(68) }, g.at(70));
  g.do({ type: 'endRace', raceId: 'py-R1' }, g.at(71));
  assert.deepEqual(raceResults(g.state, g.race('py-R1')).map((x) => x.sailNumber), ['MAS 102', 'MAS 101']);
});

test('discards: none until 4 races, then one', () => {
  assert.deepEqual([3, 4, 8].map((n) => discardsFor(n)), [0, 1, 1]);
  assert.equal(discardsFor(6, [{ fromRaces: 4, discards: 1 }, { fromRaces: 6, discards: 2 }]), 2);
});

test('series: totals, the worst score discarded from race 4, a boat that missed a race scores DNC', () => {
  const g = fleet(); // a 1.0, b 1.1, c 0.9
  race(g, 0, { a: 60, b: 70, c: 80 }); // corrected a 60, c 72, b 77 → a1 c2 b3
  race(g, 200, { a: 'DNF', b: 60, c: 70 }); // c 63, b 66 → c1 b2, a DNF = 4
  race(g, 400, { a: 60, b: 'OCS', c: 80 }); // a 60, c 72 → a1 c2, b OCS = 4
  // Delta joins after three races: DNC in those (4 boats in the class + 1 = 5)
  g.do({ type: 'saveBoat', boat: { id: 'd', classId: 'c1', sailNumber: 'MAS 44', name: 'Delta', rating: 1 } }, g.at(590));
  race(g, 600, { a: 60, b: 61, c: 62, d: 50 }); // d 50, c 55.8, a 60, b 67.1 → d1 c2 a3 b4

  const rows = seriesStandings(g.state, 'c1');
  assert.deepEqual(
    rows.map((r) => [r.sailNumber, r.scores.map((s) => (s.discarded ? `[${s.points}]` : `${s.points}`)).join(' '), r.total, r.net, r.rank]),
    [
      // Alpha and Charlie tie on 5; Alpha's kept scores 1,1,3 beat Charlie's 1,2,2 (A8.1)
      ['MAS 11', '1 [4] 1 3', 9, 5, 1],
      ['MAS 33', '[2] 1 2 2', 7, 5, 2],
      // Equal worst scores: the earlier one is discarded
      ['MAS 22', '3 2 [4] 4', 13, 9, 3],
      ['MAS 44', '[5] 5 5 1', 16, 11, 4],
    ]
  );
  assert.deepEqual(rows[3]!.scores.slice(0, 3).map((s) => s.code), ['DNC', 'DNC', 'DNC']);
  assert.deepEqual(rows[2]!.scores.map((s) => s.code ?? ''), ['', '', 'OCS', '']);
});

test('series tie-break: best kept scores first (A8.1), then the last race (A8.2)', () => {
  // A8.1: a scores 1,3 and b 2,2 → both 4; a has the better best score
  const g = fleet();
  race(g, 0, { a: 60, b: 61, c: 'DNF' }); // a1 … b: 61×1.1 = 67.1 → b2
  race(g, 200, { a: 70, b: 55, c: 60 }); // b 60.5, c 54 → c1 b2 a3
  let rows = seriesStandings(g.state, 'c1', []);
  const a = rows.find((r) => r.sailNumber === 'MAS 11')!;
  const b = rows.find((r) => r.sailNumber === 'MAS 22')!;
  assert.deepEqual([a.net, b.net], [4, 4]);
  assert.ok(a.rank < b.rank, 'a (1,3) beats b (2,2)');

  // A8.2: identical sets of scores; the better last race wins
  const h = fleet();
  race(h, 0, { a: 60, b: 70, c: 'DNF' }); // a1 b2
  race(h, 200, { a: 70, b: 55, c: 'DNF' }); // b1 a2
  rows = seriesStandings(h.state, 'c1', []);
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.sailNumber, r.net, r.rank]), [['MAS 22', 3, 1], ['MAS 11', 3, 2]]);
});

test('abandoned races and races under way are left out of the series', () => {
  const g = fleet();
  race(g, 0, { a: 60, b: 70, c: 80 });
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(200));
  g.do({ type: 'abandonRace', raceId: 'c1-R2' }, g.at(210));
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(220));
  assert.equal(seriesStandings(g.state, 'c1')[0]!.scores.length, 1);
});

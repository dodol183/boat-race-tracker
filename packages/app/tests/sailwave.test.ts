// The Sailwave files, from a short series run with the real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, decide, emptyRegatta, type Command, type RegattaState } from '@brt/engine';
import { sailwaveCompetitors, sailwaveResults } from '../src/lib/sailwave.ts';

const T0 = Date.UTC(2026, 10, 7, 2, 0, 0); // 10:00:00 in Kuala Lumpur
function series() {
  let s: RegattaState = emptyRegatta();
  const run = (cmd: Command, at: number) => {
    const d = decide(s, cmd, at);
    assert.ok(d.ok, d.ok ? '' : d.error.message);
    for (const e of d.events) s = apply(s, e);
  };
  run({ type: 'saveClass', class: { id: 'py', name: 'Dinghy, open', ratingSystem: 'PY', sequenceMinutes: 5 } }, T0);
  run({ type: 'saveBoat', boat: { id: 'a', classId: 'py', sailNumber: 'MAS 11', name: 'Alpha "A"', rating: 1100 } }, T0);
  run({ type: 'saveBoat', boat: { id: 'b', classId: 'py', sailNumber: 'MAS 2', name: 'Bravo', rating: 1050 } }, T0);
  run({ type: 'saveBoat', boat: { id: 'c', classId: 'py', sailNumber: 'MAS 33', name: 'Charlie', rating: 1130 } }, T0);
  // Race 1: start 10:05:00; MAS 11 finishes 10:47:30, MAS 2 retires, MAS 33 is OCS and finishes anyway
  run({ type: 'startSequence', classId: 'py' }, T0);
  const gun = T0 + 5 * 60_000;
  run({ type: 'individualRecall', raceId: 'py-R1', boatIds: ['c'] }, gun + 10_000);
  run({ type: 'recordFinish', raceId: 'py-R1', boatId: 'a', at: gun + 42 * 60_000 + 30_000 }, gun + 43 * 60_000);
  run({ type: 'recordFinish', raceId: 'py-R1', boatId: 'c', at: gun + 44 * 60_000 }, gun + 44 * 60_000);
  run({ type: 'setPenalty', raceId: 'py-R1', boatId: 'b', code: 'RET' }, gun + 45 * 60_000);
  run({ type: 'endRace', raceId: 'py-R1' }, gun + 50 * 60_000);
  // Race 2 is abandoned; race 3 is under way: neither goes to Sailwave
  run({ type: 'startSequence', classId: 'py' }, gun + 60 * 60_000);
  run({ type: 'abandonRace', raceId: 'py-R2' }, gun + 61 * 60_000);
  run({ type: 'startSequence', classId: 'py' }, gun + 70 * 60_000);
  return s;
}

test('Sailwave competitors: class, sail number, boat and rating, with commas and quotes escaped', () => {
  assert.equal(
    sailwaveCompetitors(series(), 'py'),
    ['Class,SailNo,Boat,Rating', '"Dinghy, open",MAS 2,Bravo,1050', '"Dinghy, open",MAS 11,"Alpha ""A""",1100', '"Dinghy, open",MAS 33,Charlie,1130', ''].join('\r\n')
  );
});

test('Sailwave results: finished races only, start and finish as local times of day, codes for the rest', () => {
  assert.equal(
    sailwaveResults(series(), 'py', 'Asia/Kuala_Lumpur'),
    [
      'SailNo,Class,RaceNo,Start,Finish,Elapsed,Code',
      'MAS 2,"Dinghy, open",1,,,,RET',
      'MAS 11,"Dinghy, open",1,10:05:00,10:47:30,0:42:30,',
      'MAS 33,"Dinghy, open",1,,,,OCS', // over the line and never back: OCS though it finished (RRS A5.1)
      '',
    ].join('\r\n')
  );
});

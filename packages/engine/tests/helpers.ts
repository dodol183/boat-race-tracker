import assert from 'node:assert/strict';
import { apply, decide, emptyRegatta, MINUTE, type Command, type RegattaEvent, type RegattaState } from '../src/index.ts';

export const T0 = Date.UTC(2026, 10, 7, 2, 0, 0); // 10:00 in Malaysia

/** A regatta that keeps every event, like the server will */
export class Regatta {
  state: RegattaState = emptyRegatta();
  events: RegattaEvent[] = [];
  now = T0;

  /** Runs a command that must be accepted */
  do(cmd: Command, at = this.now): RegattaEvent[] {
    this.now = at;
    const d = decide(this.state, cmd, at);
    if (!d.ok) assert.fail(`${cmd.type} refused: ${d.error.code} ${d.error.message}`);
    for (const e of d.events) this.state = apply(this.state, e);
    this.events.push(...d.events);
    return d.events;
  }

  /** Runs a command that must be refused; returns the refusal code */
  refused(cmd: Command, at = this.now): string {
    const d = decide(this.state, cmd, at);
    assert.equal(d.ok, false, `${cmd.type} should have been refused`);
    return d.ok ? '' : d.error.code;
  }

  at(minutes: number): number {
    return T0 + minutes * MINUTE;
  }

  race(id: string) {
    const r = this.state.races[id];
    assert.ok(r, `race ${id}`);
    return r;
  }
}

/** Class 1 (IRC) with three boats, Lasers (PY) with two */
export function fleet(): Regatta {
  const g = new Regatta();
  g.do({ type: 'saveClass', class: { id: 'c1', name: 'Class 1', ratingSystem: 'IRC' } });
  g.do({ type: 'saveClass', class: { id: 'py', name: 'Dinghies', ratingSystem: 'PY' } });
  g.do({ type: 'saveBoat', boat: { id: 'a', classId: 'c1', sailNumber: 'MAS 11', name: 'Alpha', rating: 1.0 } });
  g.do({ type: 'saveBoat', boat: { id: 'b', classId: 'c1', sailNumber: 'MAS 22', name: 'Bravo', rating: 1.1 } });
  g.do({ type: 'saveBoat', boat: { id: 'c', classId: 'c1', sailNumber: 'MAS 33', name: 'Charlie', rating: 0.9 } });
  g.do({ type: 'saveBoat', boat: { id: 'l1', classId: 'py', sailNumber: 'MAS 101', name: 'Laser', rating: 1100 } });
  g.do({ type: 'saveBoat', boat: { id: 'l2', classId: 'py', sailNumber: 'MAS 102', name: 'Topper', rating: 1300 } });
  return g;
}

/** Class 1 started at minute 5 (sequence from minute 0) */
export function started(): Regatta {
  const g = fleet();
  g.do({ type: 'startSequence', classId: 'c1' }, g.at(0));
  g.now = g.at(5);
  return g;
}

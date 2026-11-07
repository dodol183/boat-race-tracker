// One regatta on the server: its state, its record of events, and the devices watching it.
import { advance, apply, decide, emptyRegatta, type Command, type RegattaState } from '@brt/engine';
import type { CommandRecord, Store, StoredEvent } from './store.ts';

export type Role = 'OFFICER' | 'SKIPPER' | 'SPECTATOR';

/** Commands each role may send. Skippers and spectators watch in version 1. */
const ALLOWED: Record<Role, ReadonlySet<Command['type']> | 'ALL'> = {
  OFFICER: 'ALL',
  SKIPPER: new Set(),
  SPECTATOR: new Set(),
};

export interface Subscriber {
  /** New events, in order, with no gaps */
  events(events: StoredEvent[]): void;
}

export type CommandResult = CommandRecord['result'] & { duplicate?: boolean };

export class RegattaHub {
  state: RegattaState;
  private subscribers = new Set<Subscriber>();

  constructor(
    readonly regattaId: string,
    private store: Store,
    private now: () => number
  ) {
    // The state is the events, replayed
    this.state = store.events(regattaId).reduce((s, e) => apply(s, e.event), emptyRegatta());
  }

  get seq(): number {
    return this.state.version;
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  eventsSince(seq: number): StoredEvent[] {
    return this.store.events(this.regattaId, seq);
  }

  /**
   * A command from a device. A command id already answered gets the same answer again and
   * changes nothing, so a device can resend after a lost connection without doubling anything.
   */
  handle(role: Role, commandId: string, command: Command): CommandResult {
    const seen = this.store.command(this.regattaId, commandId);
    if (seen) return { ...seen.result, duplicate: true };

    const receivedAt = this.now();
    const allowed = ALLOWED[role];
    if (allowed !== 'ALL' && !allowed.has(command.type)) {
      // Not recorded: unlocking with the right PIN and resending should then work
      return { ok: false, error: { code: 'NOT_ALLOWED', message: 'Only the race office can do that. Unlock with the race officer PIN.' } };
    }

    const d = decide(this.state, command, receivedAt);
    if (!d.ok) {
      const result: CommandRecord['result'] = { ok: false, error: d.error };
      this.store.append(this.regattaId, [], { id: commandId, receivedAt, result });
      return result;
    }
    const stored = this.commit(d.events, receivedAt, (seq) => ({ id: commandId, receivedAt, result: { ok: true, seq } }));
    return { ok: true, seq: stored.at(-1)?.seq ?? this.seq };
  }

  /** Events time alone causes (the start gun); called on a timer and before reading state */
  tick(): StoredEvent[] {
    const events = advance(this.state, this.now());
    return events.length ? this.commit(events, this.now()) : [];
  }

  private commit(
    events: ReturnType<typeof advance>,
    at: number,
    command?: (lastSeq: number) => { id: string; receivedAt: number; result: CommandRecord['result'] }
  ): StoredEvent[] {
    let next = this.state;
    const stored: StoredEvent[] = events.map((event) => {
      next = apply(next, event);
      return { seq: next.version, at, event };
    });
    // Stored first: nothing reaches a device that isn't in the record
    this.store.append(this.regattaId, stored, command?.(next.version));
    this.state = next;
    for (const s of this.subscribers) s.events(stored);
    return stored;
  }
}

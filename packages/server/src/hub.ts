// One regatta on the server: its state, its record of events, and the devices watching it.
import { advance, apply, cleanFixes, decide, emptyRegatta, gpsSuggestions, mergeTrail, trackerId as toTrackerId, type Command, type Fix, type RegattaState } from '@brt/engine';
import type { CommandRecord, Store, StoredEvent } from './store.ts';
import type { PositionsUpdate, Suggestions } from './protocol.ts';
import { PRACTICE_FIX_MS, practiceBoats, practiceFix } from './practice.ts';

export type Role = 'OFFICER' | 'SKIPPER' | 'SPECTATOR';

/** Commands each role may send. Skippers may connect their own tracker; spectators watch. */
const ALLOWED: Record<Role, ReadonlySet<Command['type']> | 'ALL'> = {
  OFFICER: 'ALL',
  SKIPPER: new Set(['claimTracker', 'releaseTracker']),
  SPECTATOR: new Set(),
};

/** How much track is kept in memory and sent to a device that joins */
const TRAIL_KEEP_MS = 6 * 60 * 60_000;
const TRAIL_SEND_MS = 30 * 60_000;
const TRAIL_SEND_MAX = 400;

export interface Subscriber {
  /** New events, in order, with no gaps */
  events(events: StoredEvent[]): void;
  /** New positions from trackers bound to boats */
  positions?(update: PositionsUpdate): void;
  /** What GPS suggests changed (the server sends it to the race office only) */
  suggestions?(s: Suggestions): void;
  /** An unbound tracker was heard (race office only) */
  heard?(trackers: { trackerId: string; at: number }[]): void;
}

export type PositionsResult = { ok: true; accepted: number; unbound?: boolean } | { ok: false; error: { code: string; message: string } };

export type CommandResult = CommandRecord['result'] & { duplicate?: boolean };

export class RegattaHub {
  state: RegattaState;
  private subscribers = new Set<Subscriber>();
  /** Track per tracker id, oldest first */
  private trails = new Map<string, Fix[]>();
  /** Trackers heard that no boat has: when, but not where */
  private unbound = new Map<string, number>();
  private suggestionsJson = '{"over":[],"finishes":[]}';
  private lastFixSync: number;
  private lastPracticeFix = 0;
  private lastSuggest = 0;

  constructor(
    readonly regattaId: string,
    private store: Store,
    private now: () => number
  ) {
    // The state is the events, replayed
    this.state = store.events(regattaId).reduce((s, e) => apply(s, e.event), emptyRegatta());
    this.trails = store.fixesSince(regattaId, now() - TRAIL_KEEP_MS);
    this.lastFixSync = now();
    this.suggestionsJson = JSON.stringify(this.computeSuggestions());
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
    // A second try only if another server process stored events at the same moment
    for (let attempt = 0; ; attempt++) {
      this.syncFromStore();
      const seen = this.store.command(this.regattaId, commandId);
      if (seen) return { ...seen.result, duplicate: true };

      const receivedAt = this.now();
      const allowed = ALLOWED[role];
      if (allowed !== 'ALL' && !allowed.has(command.type)) {
        // Not recorded: unlocking with the right PIN and resending should then work
        return { ok: false, error: { code: 'NOT_ALLOWED', message: 'Only the race office can do that. Unlock with the race officer PIN.' } };
      }

      try {
        const d = decide(this.state, command, receivedAt);
        if (!d.ok) {
          const result: CommandRecord['result'] = { ok: false, error: d.error };
          this.store.append(this.regattaId, [], { id: commandId, receivedAt, result });
          return result;
        }
        const stored = this.commit(d.events, receivedAt, (seq) => ({ id: commandId, receivedAt, result: { ok: true, seq } }));
        return { ok: true, seq: stored.at(-1)?.seq ?? this.seq };
      } catch (err) {
        if (attempt === 0 && isConflict(err)) continue;
        throw err;
      }
    }
  }

  /** Events time alone causes (the start gun); called on a timer and before reading state */
  tick(): StoredEvent[] {
    const synced = this.syncFromStore();
    this.syncFixes();
    const events = advance(this.state, this.now());
    let stored: StoredEvent[] = [];
    try {
      stored = events.length ? this.commit(events, this.now()) : [];
    } catch (err) {
      // Another process fired the same gun first: take its record
      if (!isConflict(err)) throw err;
      stored = this.syncFromStore();
    }
    this.sailPracticeBoats();
    // Suggestions also change with time (X can only fly for 4 minutes)
    if (this.now() - this.lastSuggest >= 1000) this.refreshSuggestions();
    return [...synced, ...stored];
  }

  /** Moves the practice boats, one fix each on the shared 3 s grid (see practice.ts) */
  private sailPracticeBoats() {
    if (!this.state.options?.practiceBoatsSail) return;
    const grid = Math.floor(this.now() / PRACTICE_FIX_MS) * PRACTICE_FIX_MS;
    if (grid <= this.lastPracticeFix) return;
    this.lastPracticeFix = grid;
    const boats = practiceBoats(this.state);
    boats.forEach((b, i) => {
      const fix = practiceFix(this.state, b, i, boats.length, grid);
      if (fix) this.acceptPositions('OFFICER', b.trackerId!, [fix]);
    });
  }

  // ------------------------------------------------------------------- more than one process
  //
  // cPanel's app runner may start a second copy of the server under load. Each copy keeps its
  // state from the database, so before acting, and on every tick, it takes the events and positions
  // the other copies stored, and passes them on to its own devices.

  /** Events other processes stored since this one last looked */
  syncFromStore(): StoredEvent[] {
    const fresh = this.store.events(this.regattaId, this.state.version);
    if (fresh.length === 0) return [];
    let next = this.state;
    const taken: StoredEvent[] = [];
    for (const e of fresh) {
      if (e.seq !== next.version + 1) break;
      next = apply(next, e.event);
      taken.push(e);
    }
    this.state = next;
    for (const s of this.subscribers) s.events(taken);
    this.refreshSuggestions();
    if (taken.some((e) => e.event.type === 'trackerBound')) for (const s of this.subscribers) s.heard?.(this.heardList());
    return taken;
  }

  /** Positions other processes stored since this one last looked */
  private syncFixes() {
    const since = this.lastFixSync;
    this.lastFixSync = this.now();
    const byTracker = this.store.fixesReceivedSince(this.regattaId, since - 1000);
    const update: PositionsUpdate['trackers'] = [];
    for (const [id, fixes] of byTracker) {
      const trail = this.trails.get(id) ?? [];
      const have = new Set(trail.slice(-2000).map((f) => f.fixTime));
      const fresh = fixes.filter((f) => !have.has(f.fixTime));
      if (fresh.length === 0) continue;
      this.trails.set(id, mergeTrail(trail, fresh));
      update.push({ trackerId: id, fixes: fresh });
    }
    if (update.length) {
      for (const s of this.subscribers) s.positions?.({ trackers: update });
      this.refreshSuggestions();
    }
  }

  // ------------------------------------------------------------------------------------ positions

  /**
   * Fixes from a tracker. Only a tracker bound to a boat moves anything or is kept; others are
   * noted as heard (for the race office to connect) without their positions, since a relay hears
   * every radio on the mesh, strangers' too.
   */
  acceptPositions(role: Role, rawTrackerId: string, rawFixes: unknown): PositionsResult {
    if (role === 'SPECTATOR') return { ok: false, error: { code: 'NOT_ALLOWED', message: 'Unlock with the skipper or race officer PIN to share positions.' } };
    const id = toTrackerId(rawTrackerId);
    if (!id) return { ok: false, error: { code: 'BAD_TRACKER', message: 'That is not a tracker this app knows.' } };
    const now = this.now();
    const fixes = cleanFixes(rawFixes, now);
    const bound = Object.values(this.state.boats).some((b) => b.trackerId === id);
    if (!bound) {
      if (fixes.length) {
        this.unbound.delete(id);
        this.unbound.set(id, now);
        // Kept small: a relay in a busy harbour, or someone sending made-up ids, can't fill memory
        while (this.unbound.size > 200) this.unbound.delete(this.unbound.keys().next().value!);
        for (const s of this.subscribers) s.heard?.(this.heardList());
      }
      return { ok: true, accepted: 0, unbound: true };
    }
    if (fixes.length === 0) return { ok: true, accepted: 0 };
    this.store.addFixes(this.regattaId, id, fixes, now);
    const trail = mergeTrail(this.trails.get(id) ?? [], fixes);
    const cutoff = now - TRAIL_KEEP_MS;
    this.trails.set(id, trail[0]!.fixTime < cutoff ? trail.filter((f) => f.fixTime >= cutoff) : trail);
    for (const s of this.subscribers) s.positions?.({ trackers: [{ trackerId: id, fixes }] });
    this.refreshSuggestions();
    return { ok: true, accepted: fixes.length };
  }

  /** The recent track of every bound tracker, for a device that has just joined */
  positionsSnapshot(): PositionsUpdate {
    const since = this.now() - TRAIL_SEND_MS;
    const trackers: PositionsUpdate['trackers'] = [];
    for (const b of Object.values(this.state.boats)) {
      const trail = b.trackerId ? this.trails.get(b.trackerId) : undefined;
      if (!trail?.length) continue;
      let recent = trail.filter((f) => f.fixTime >= since);
      if (recent.length === 0) recent = [trail.at(-1)!];
      if (recent.length > TRAIL_SEND_MAX) {
        // Every nth point, always ending on the newest
        const step = recent.length / TRAIL_SEND_MAX;
        recent = Array.from({ length: TRAIL_SEND_MAX }, (_, i) => recent[Math.min(recent.length - 1, Math.round((i + 1) * step) - 1)]!);
      }
      trackers.push({ trackerId: b.trackerId!, fixes: recent });
    }
    return { full: true, trackers };
  }

  suggestions(): Suggestions {
    return JSON.parse(this.suggestionsJson);
  }

  heardList(): { trackerId: string; at: number }[] {
    const cutoff = this.now() - 30 * 60_000;
    const bound = new Set(Object.values(this.state.boats).map((b) => b.trackerId));
    return [...this.unbound].filter(([id, at]) => at >= cutoff && !bound.has(id)).map(([trackerId, at]) => ({ trackerId, at })).sort((a, b) => b.at - a.at);
  }

  private computeSuggestions(): Suggestions {
    const byBoat: Record<string, Fix[]> = {};
    for (const b of Object.values(this.state.boats)) {
      const t = b.trackerId ? this.trails.get(b.trackerId) : undefined;
      if (t) byBoat[b.id] = t;
    }
    return gpsSuggestions(this.state, byBoat, this.now());
  }

  private refreshSuggestions() {
    this.lastSuggest = this.now();
    const next = this.computeSuggestions();
    const json = JSON.stringify(next);
    if (json === this.suggestionsJson) return;
    this.suggestionsJson = json;
    for (const s of this.subscribers) s.suggestions?.(next);
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
    // A finish recorded or a tracker connected changes what GPS suggests
    this.refreshSuggestions();
    if (events.some((e) => e.type === 'trackerBound')) for (const s of this.subscribers) s.heard?.(this.heardList());
    return stored;
  }
}

/** SQLite refusing a row another process wrote first (same event number or command id) */
function isConflict(err: unknown): boolean {
  return /constraint/i.test(String((err as Error)?.message ?? err));
}

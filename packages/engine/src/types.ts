// The regatta as the server keeps it. Times are server milliseconds (epoch); nothing here reads a
// clock: the caller passes `now`.

export type RatingSystem = 'IRC' | 'ORC' | 'PY';

export interface RaceClass {
  id: string;
  name: string;
  ratingSystem: RatingSystem;
  /** Minutes from warning signal to start (RRS 26: 5) */
  sequenceMinutes: number;
}

export interface Boat {
  id: string;
  classId: string;
  sailNumber: string;
  name: string;
  /** IRC/ORC: time correction factor (e.g. 1.042). PY: Portsmouth Number (e.g. 1100) */
  rating: number;
  /** The tracker bound to this boat, if any */
  trackerId?: string;
}

/**
 * Where a race is.
 * - SEQUENCE: warning signal made (or due), counting down to `startAt`
 * - POSTPONED: AP up before the start (RRS 27.3 / Race Signals)
 * - RECALLED: general recall (first substitute) after the start, waiting for a new sequence
 * - RACING: started
 * - FINISHED: the race office ended it; results stand
 * - ABANDONED: no results
 */
export type RacePhase = 'SEQUENCE' | 'POSTPONED' | 'RECALLED' | 'RACING' | 'FINISHED' | 'ABANDONED';

/** Scoring codes the race office can give (RRS Appendix A11) */
export type PenaltyCode = 'DNC' | 'DNS' | 'OCS' | 'DNF' | 'RET' | 'DSQ';

export interface Entry {
  boatId: string;
  /** Over the line at the start and not yet back (individual recall) */
  ocs: boolean;
  /** Was recalled and has returned to start correctly */
  returned: boolean;
  finishAt?: number;
  /** How the finish was taken */
  finishSource?: 'TAP' | 'GPS';
  penalty?: PenaltyCode;
}

export interface Race {
  id: string;
  classId: string;
  /** 1, 2, 3 … within the class */
  number: number;
  phase: RacePhase;
  /** Warning signal time of the current sequence */
  warningAt?: number;
  /** Start signal time of the current sequence */
  startAt?: number;
  /** When the race actually started (equal to startAt once the gun has fired) */
  startedAt?: number;
  generalRecalls: number;
  xFlag?: { raisedAt: number; boatIds: string[]; loweredAt?: number };
  endedAt?: number;
  entries: Record<string, Entry>;
}

export interface RegattaState {
  classes: Record<string, RaceClass>;
  boats: Record<string, Boat>;
  races: Record<string, Race>;
  /** Number of events applied; the server's sequence number */
  version: number;
}

export const emptyRegatta = (): RegattaState => ({ classes: {}, boats: {}, races: {}, version: 0 });

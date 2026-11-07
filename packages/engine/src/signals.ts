// What screens need to show about a race at a moment: the sound signals due, and the X flag.
import { MINUTE, X_FLAG_LIMIT_MS } from './engine.ts';
import type { Race } from './types.ts';

export type SignalName = 'WARNING' | 'PREPARATORY' | 'ONE_MINUTE' | 'START';

export interface Signal {
  name: SignalName;
  at: number;
}

/**
 * The sound signals of the current sequence (RRS 26): warning, preparatory 1 minute later,
 * one-minute 1 minute before the start, start. For a sequence longer or shorter than 5 minutes
 * the preparatory signal stays 1 minute after the warning.
 */
export function sequenceSignals(race: Race): Signal[] {
  if (race.warningAt === undefined || race.startAt === undefined) return [];
  const signals: Signal[] = [{ name: 'WARNING', at: race.warningAt }];
  const prep = race.warningAt + MINUTE;
  const oneMinute = race.startAt - MINUTE;
  if (prep < oneMinute) signals.push({ name: 'PREPARATORY', at: prep });
  if (oneMinute > race.warningAt) signals.push({ name: 'ONE_MINUTE', at: oneMinute });
  signals.push({ name: 'START', at: race.startAt });
  return signals;
}

/** The next signal at or after `now`, if any */
export function nextSignal(race: Race, now: number): Signal | undefined {
  return sequenceSignals(race).find((s) => s.at >= now);
}

export interface XFlagState {
  up: boolean;
  /** Time left before the 4-minute limit; 0 once it has passed */
  msLeft: number;
  /** Recalled boats that are still over */
  stillOver: string[];
  /** Every recalled boat has returned, or the limit has passed: X should come down */
  shouldLower: boolean;
}

export function xFlagState(race: Race, now: number): XFlagState {
  const x = race.xFlag;
  if (!x || x.loweredAt !== undefined || race.startedAt === undefined) return { up: false, msLeft: 0, stillOver: [], shouldLower: false };
  const msLeft = Math.max(0, race.startedAt + X_FLAG_LIMIT_MS - now);
  const stillOver = x.boatIds.filter((id) => race.entries[id]?.ocs);
  return { up: true, msLeft, stillOver, shouldLower: msLeft === 0 || stillOver.length === 0 };
}

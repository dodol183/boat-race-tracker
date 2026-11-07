// Corrected time, race results and series standings: RRS Appendix A, Low Point System.
import type { Boat, PenaltyCode, Race, RatingSystem, RegattaState } from './types.ts';

/**
 * Corrected time in seconds.
 * - IRC and ORC (time on time): elapsed × TCC
 * - Portsmouth Yardstick: elapsed × 1000 ÷ Portsmouth Number, so a slower boat (higher number) gets time back
 */
export function correctedSeconds(elapsedSec: number, system: RatingSystem, rating: number): number {
  if (!Number.isFinite(elapsedSec) || !Number.isFinite(rating) || rating <= 0) return elapsedSec;
  return system === 'PY' ? (elapsedSec * 1000) / rating : elapsedSec * rating;
}

export interface RaceResultRow {
  boatId: string;
  sailNumber: string;
  name: string;
  /** Finishing place on corrected time; undefined for a scoring code */
  place?: number;
  elapsedSec?: number;
  correctedSec?: number;
  code?: PenaltyCode;
  points: number;
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * The boats entered in a class's series: every boat now in the class, and any that sailed one of
 * its races and has since left. Scoring codes and DNC both count from this (A5.2).
 */
export function seriesEntries(state: RegattaState, classId: string): number {
  const ids = new Set(Object.values(state.boats).filter((b) => b.classId === classId).map((b) => b.id));
  for (const r of Object.values(state.races)) if (r.classId === classId && r.phase !== 'ABANDONED') for (const id of Object.keys(r.entries)) ids.add(id);
  return ids.size;
}

/**
 * Results of one race. Points: finishing place, tied boats sharing the average of the places
 * (A7); a scoring code scores the number of boats entered in the series plus one (A5.2), so a
 * boat joining the series later changes it for every race. A boat still OCS is scored OCS even if
 * it finished (A5.1).
 */
export function raceResults(state: RegattaState, race: Race): RaceResultRow[] {
  const cls = state.classes[race.classId];
  const entries = Object.values(race.entries);
  const codePoints = seriesEntries(state, race.classId) + 1;
  const boatOf = (id: string): Pick<Boat, 'sailNumber' | 'name' | 'rating'> =>
    state.boats[id] ?? { sailNumber: id, name: '', rating: 1 };

  const finishers: RaceResultRow[] = [];
  const coded: RaceResultRow[] = [];
  for (const e of entries) {
    const b = boatOf(e.boatId);
    const code: PenaltyCode | undefined = e.penalty ?? (e.ocs ? 'OCS' : undefined);
    if (code || e.finishAt === undefined || race.startedAt === undefined) {
      coded.push({ boatId: e.boatId, sailNumber: b.sailNumber, name: b.name, code: code ?? 'DNF', points: codePoints });
      continue;
    }
    const elapsedSec = (e.finishAt - race.startedAt) / 1000;
    finishers.push({
      boatId: e.boatId,
      sailNumber: b.sailNumber,
      name: b.name,
      elapsedSec,
      // To the tenth of a second, as published results are; ties are judged on this value
      correctedSec: round(correctedSeconds(elapsedSec, cls?.ratingSystem ?? 'IRC', b.rating)),
      points: 0,
    });
  }

  finishers.sort((a, b) => a.correctedSec! - b.correctedSec! || a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  for (let i = 0; i < finishers.length; ) {
    let j = i;
    while (j + 1 < finishers.length && finishers[j + 1]!.correctedSec === finishers[i]!.correctedSec) j++;
    const points = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) {
      finishers[k]!.place = i + 1;
      finishers[k]!.points = points;
    }
    i = j + 1;
  }
  coded.sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  return [...finishers, ...coded];
}

export interface DiscardRule {
  /** From this many completed races … */
  fromRaces: number;
  /** … this many worst scores are discarded */
  discards: number;
}

/** No discards until 4 races, then one; a common sailing-instruction default */
export const DEFAULT_DISCARDS: DiscardRule[] = [{ fromRaces: 4, discards: 1 }];

export interface SeriesScore {
  raceId: string;
  points: number;
  code?: PenaltyCode;
  discarded: boolean;
}

export interface SeriesRow {
  boatId: string;
  sailNumber: string;
  name: string;
  rank: number;
  scores: SeriesScore[];
  total: number;
  net: number;
}

export function discardsFor(races: number, rules: DiscardRule[] = DEFAULT_DISCARDS): number {
  return rules.filter((r) => races >= r.fromRaces).reduce((n, r) => Math.max(n, r.discards), 0);
}

/**
 * Series standings for a class over its finished races (abandoned ones don't count). A boat with
 * no entry in a race scores DNC: boats entered in the series plus one (A5.2, A9). Ties are broken by
 * comparing each boat's kept scores from best to worst (A8.1), then by the last race (A8.2).
 */
export function seriesStandings(state: RegattaState, classId: string, rules: DiscardRule[] = DEFAULT_DISCARDS): SeriesRow[] {
  const races = Object.values(state.races)
    .filter((r) => r.classId === classId && r.phase === 'FINISHED')
    .sort((a, b) => a.number - b.number);
  const boats = Object.values(state.boats).filter((b) => b.classId === classId);
  const dncPoints = seriesEntries(state, classId) + 1;
  const results = new Map(races.map((r) => [r.id, new Map(raceResults(state, r).map((row) => [row.boatId, row]))]));
  const nDiscards = discardsFor(races.length, rules);

  const rows: SeriesRow[] = boats.map((b) => {
    const scores: SeriesScore[] = races.map((r) => {
      const row = results.get(r.id)!.get(b.id);
      return row ? { raceId: r.id, points: row.points, ...(row.code ? { code: row.code } : {}), discarded: false } : { raceId: r.id, points: dncPoints, code: 'DNC', discarded: false };
    });
    // Discard the worst; among equal scores, the earliest race
    const order = scores.map((s, i) => i).sort((i, j) => scores[j]!.points - scores[i]!.points || i - j);
    for (const i of order.slice(0, nDiscards)) scores[i]!.discarded = true;
    const total = scores.reduce((t, s) => t + s.points, 0);
    const net = scores.reduce((t, s) => t + (s.discarded ? 0 : s.points), 0);
    return { boatId: b.id, sailNumber: b.sailNumber, name: b.name, rank: 0, scores, total, net };
  });

  const kept = (r: SeriesRow) => r.scores.filter((s) => !s.discarded).map((s) => s.points).sort((a, b) => a - b);
  rows.sort((a, b) => {
    if (a.net !== b.net) return a.net - b.net;
    const ka = kept(a);
    const kb = kept(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    for (let i = a.scores.length - 1; i >= 0; i--) {
      const d = a.scores[i]!.points - b.scores[i]!.points;
      if (d !== 0) return d;
    }
    return 0;
  });
  // Equal ranks only for boats still tied after A8
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && seriesTied(prev, r) ? prev.rank : i + 1;
  });
  return rows;

  function seriesTied(a: SeriesRow, b: SeriesRow): boolean {
    if (a.net !== b.net) return false;
    const ka = kept(a);
    const kb = kept(b);
    if (ka.some((v, i) => v !== kb[i])) return false;
    return a.scores.every((s, i) => s.points === b.scores[i]!.points);
  }
}

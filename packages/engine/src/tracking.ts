// Positions from trackers, and what GPS suggests to the race office. Suggestions only: a tap by the
// race office is the record (LoRa trackers report every 30 s or more, phones every few seconds).
import type { LatLng, Race, RegattaState } from './types.ts';
import { crossingFraction, distanceToSegmentM, isPoint, startLineOffset } from './geo.ts';

// ------------------------------------------------------------------------------------- tracker ids

/**
 * Trackers have one id each, in one written form:
 * - a Meshtastic radio: "!" and its node number in 8 lowercase hex digits ("!a1b2c3d4"). Accepts
 *   "!A1B2C3D4", "0xa1b2c3d4", "a1b2c3d4" (8 digits, with a letter) or a node number.
 * - a phone sharing its own GPS: "phone-" and 6 to 32 letters or digits, chosen by the phone.
 * Returns null for anything else.
 */
export function trackerId(raw: unknown): string | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 && raw <= 0xffffffff ? `!${raw.toString(16).padStart(8, '0')}` : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  const phone = /^phone-([a-z0-9]{6,32})$/i.exec(t);
  if (phone) return `phone-${phone[1]!.toLowerCase()}`;
  const prefixed = /^(!|0x)/i.test(t);
  const hex = t.replace(/^!/, '').replace(/^0x/i, '');
  if (prefixed ? /^[0-9a-f]{1,8}$/i.test(hex) : /^(?=.*[a-f])[0-9a-f]{8}$/i.test(hex)) return `!${hex.toLowerCase().padStart(8, '0')}`;
  return null;
}

export const isPhoneTracker = (id: string) => id.startsWith('phone-');

// ------------------------------------------------------------------------------------------ fixes

export interface Fix {
  lat: number;
  lng: number;
  /** When the position was taken (server clock for phones; the radio's clock for LoRa) */
  fixTime: number;
  speedKt?: number;
  headingDeg?: number;
}

/**
 * A fix older than this doesn't show as live. On connect a radio hands over every node it has
 * heard, with positions that can be hours old. 15 min is Meshtastic's default position interval.
 */
export const MAX_FIX_AGE_MS = 15 * 60_000;
/** A fix a little ahead of the server clock is a device clock running fast; more is wrong */
export const FIX_FUTURE_TOLERANCE_MS = 30_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The usable fixes from what a device sent, oldest first, one per time: positions in range and not
 * 0,0; times not too far ahead (a fast clock is pulled back to now); speed and heading only when
 * they make sense.
 */
export function cleanFixes(raw: unknown, now: number): Fix[] {
  if (!Array.isArray(raw)) return [];
  const byTime = new Map<number, Fix>();
  for (const f of raw) {
    if (!f || typeof f !== 'object' || !isPoint(f) || !isNum((f as Fix).fixTime)) continue;
    const r = f as Fix;
    if (r.fixTime <= 0 || r.fixTime > now + FIX_FUTURE_TOLERANCE_MS) continue;
    const fix: Fix = { lat: r.lat, lng: r.lng, fixTime: Math.min(Math.round(r.fixTime), now) };
    if (isNum(r.speedKt) && r.speedKt >= 0 && r.speedKt < 100) fix.speedKt = r.speedKt;
    if (isNum(r.headingDeg) && r.headingDeg >= 0 && r.headingDeg <= 360) fix.headingDeg = r.headingDeg % 360;
    byTime.set(fix.fixTime, fix);
  }
  return [...byTime.values()].sort((a, b) => a.fixTime - b.fixTime);
}

export const isFixLive = (fix: Fix | undefined, now: number) => !!fix && now - fix.fixTime <= MAX_FIX_AGE_MS;

/** Merges new fixes into a trail (oldest first), keeping one per time */
export function mergeTrail(trail: Fix[], fixes: Fix[]): Fix[] {
  if (fixes.length === 0) return trail;
  const last = trail.at(-1);
  // The common case: everything new is newer
  if (!last || fixes[0]!.fixTime > last.fixTime) return [...trail, ...fixes];
  const byTime = new Map(trail.map((f) => [f.fixTime, f]));
  for (const f of fixes) byTime.set(f.fixTime, f);
  return [...byTime.values()].sort((a, b) => a.fixTime - b.fixTime);
}

/** The position at time `t` from a trail, between the fixes either side; null if none is close */
export function positionAt(trail: Fix[], t: number, maxGapMs: number): LatLng | null {
  let before: Fix | undefined;
  let after: Fix | undefined;
  for (const f of trail) {
    if (f.fixTime <= t) before = f;
    else {
      after = f;
      break;
    }
  }
  if (before && before.fixTime === t) return before;
  if (before && after && after.fixTime - before.fixTime <= maxGapMs) {
    const k = (t - before.fixTime) / (after.fixTime - before.fixTime);
    return { lat: before.lat + (after.lat - before.lat) * k, lng: before.lng + (after.lng - before.lng) * k };
  }
  if (before && t - before.fixTime <= maxGapMs / 2) return before;
  if (after && after.fixTime - t <= maxGapMs / 2) return after;
  return null;
}

// ------------------------------------------------------------------------------------ suggestions

export interface FinishSuggestion {
  raceId: string;
  boatId: string;
  /** Estimated crossing time, between the fixes either side of the line */
  at: number;
  /** Seconds between those fixes: the estimate is only as good as this */
  gapSec: number;
}

export interface OverSuggestion {
  raceId: string;
  boatId: string;
  /** Metres on the course side of the line at the gun */
  metres: number;
}

/** GPS can suggest who was over for this long after the gun (X flag's 4 minutes, RRS 29.1) */
const OVER_WINDOW_MS = 4 * 60_000;
/** Fixes further apart than this can't place a boat at the gun */
const OVER_MAX_GAP_MS = 20_000;
/** The finish line is taken this much longer at each end, for GPS error and the mark's swing */
const LINE_EXTEND_M = 15;
/** A boat must get this far from the finish line before crossing it counts (the start line is often the finish) */
const AWAY_M = 150;

/** The finish line: its own points, or the start line */
export function finishLine(state: RegattaState): [LatLng, LatLng] | null {
  const c = state.course ?? {};
  if (isPoint(c.finishPin) && isPoint(c.finishCommittee)) return [c.finishPin, c.finishCommittee];
  if (isPoint(c.startPin) && isPoint(c.startCommittee)) return [c.startPin, c.startCommittee];
  return null;
}

/**
 * What GPS suggests for races under way: boats that look over the start line at the gun (in the
 * 4 minutes X may be flown), and boats that look to have crossed the finish line. `trails` are by
 * boat id. Boats the race office has already dealt with are left out.
 */
export function gpsSuggestions(state: RegattaState, trails: Record<string, Fix[]>, now: number): { over: OverSuggestion[]; finishes: FinishSuggestion[] } {
  const over: OverSuggestion[] = [];
  const finishes: FinishSuggestion[] = [];
  const c = state.course ?? {};
  const line = finishLine(state);
  for (const race of Object.values(state.races)) {
    if (race.phase !== 'RACING' || race.startedAt === undefined) continue;
    for (const entry of Object.values(race.entries)) {
      const trail = trails[entry.boatId];
      if (!trail?.length) continue;
      if (now - race.startedAt <= OVER_WINDOW_MS && !race.xFlag && !entry.ocs && !entry.penalty && isPoint(c.startPin) && isPoint(c.startCommittee) && isPoint(c.firstMark)) {
        const at = positionAt(trail, race.startedAt, OVER_MAX_GAP_MS);
        const d = at && startLineOffset(at, c.startPin, c.startCommittee, c.firstMark);
        // Within 2 m is too close to call
        if (d !== null && d !== undefined && d > 2) over.push({ raceId: race.id, boatId: entry.boatId, metres: Math.round(d) });
      }
      if (line && entry.finishAt === undefined && (!entry.penalty || entry.penalty === 'OCS')) {
        const s = finishCrossing(race, trail, line, awayTest(state, line));
        if (s) finishes.push({ raceId: race.id, boatId: entry.boatId, ...s });
      }
    }
  }
  finishes.sort((a, b) => a.at - b.at);
  return { over, finishes };
}

/**
 * When a boat has been far enough from the finish line for a crossing to count as finishing. With
 * the finish on the start line, it must have been well up the course side: a late starter coming
 * up from the pre-start area crosses the same line without finishing.
 */
function awayTest(state: RegattaState, line: [LatLng, LatLng]): (p: LatLng) => boolean {
  const c = state.course ?? {};
  const onStartLine = !(isPoint(c.finishPin) && isPoint(c.finishCommittee));
  if (onStartLine && isPoint(c.firstMark)) return (p) => (startLineOffset(p, line[0], line[1], c.firstMark!) ?? 0) >= AWAY_M;
  return (p) => distanceToSegmentM(p, line[0], line[1]) >= AWAY_M;
}

/** The first crossing of the finish line after the start, once the boat has been well away from it */
function finishCrossing(race: Race, trail: Fix[], [a, b]: [LatLng, LatLng], isAway: (p: LatLng) => boolean): { at: number; gapSec: number } | null {
  let away = false;
  let prev: Fix | undefined;
  for (const f of trail) {
    if (f.fixTime < race.startedAt!) continue;
    if (prev && away) {
      const k = crossingFraction(prev, f, a, b, LINE_EXTEND_M);
      if (k !== null) {
        return { at: Math.round(prev.fixTime + (f.fixTime - prev.fixTime) * k), gapSec: Math.round((f.fixTime - prev.fixTime) / 1000) };
      }
    }
    if (!away && isAway(f)) away = true;
    prev = f;
  }
  return null;
}

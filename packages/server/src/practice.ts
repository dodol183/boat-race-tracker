// Practice boats: the server sails boats whose tracker is "sim-…" round the regatta's course, so a
// race officer can try a whole race alone (and show it to the club). Their positions go through the
// same path as real trackers, so the map, GPS suggestions and spectator view all work as on the day.
//
// Where a boat is depends only on the race and the time, never on what was computed before. Two
// server processes therefore produce the same fix for the same moment, and the database keeps one.
import { finishLine, isPracticeTracker, phaseAt, type Boat, type Fix, type LatLng, type Race, type RegattaState } from '@brt/engine';

/** One fix every 3 s, on a grid shared by every process */
export const PRACTICE_FIX_MS = 3000;
const M_PER_DEG = 111_320;
const MS_TO_KT = 1.943844;

interface Frame {
  origin: LatLng;
  /** Unit vectors in metres east/north: along the line (pin → committee boat) and towards the course */
  u: { x: number; y: number };
  n: { x: number; y: number };
  halfLine: number;
}

type P = { x: number; y: number };
type F = Frame & { mark: P };

/** The practice boats, in sail number order (their place in the fleet decides speed and lane) */
export function practiceBoats(state: RegattaState): Boat[] {
  return Object.values(state.boats)
    .filter((b) => b.trackerId && isPracticeTracker(b.trackerId))
    .sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
}

/**
 * Where practice boat number `i` (of `count`) is at time `t`, or null without a start line and
 * first mark. Before the gun the boats mill about below the line and close on it in the last
 * minute; boat 0 is early and over at the gun. Racing, they sail to the first mark and back across
 * the finish line, each a little faster than the one before; boat 0, if X is flown for it, goes back
 * to start again first.
 */
export function practiceFix(state: RegattaState, boat: Boat, i: number, count: number, t: number): Fix | null {
  const frame = frameOf(state);
  if (!frame) return null;
  const at = (time: number) => toLatLng(frame, localAt(state, frame, boat, i, count, time));
  const p = at(t);
  const q = at(t - PRACTICE_FIX_MS);
  // Speed and heading from where it was a moment before
  const dE = (p.lng - q.lng) * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180);
  const dN = (p.lat - q.lat) * M_PER_DEG;
  const metres = Math.hypot(dE, dN);
  const fix: Fix = { lat: round(p.lat), lng: round(p.lng), fixTime: t, speedKt: Math.round(((metres / (PRACTICE_FIX_MS / 1000)) * MS_TO_KT) * 10) / 10 };
  if (metres > 0.5) fix.headingDeg = Math.round(((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360);
  return fix;
}

function localAt(state: RegattaState, f: F, boat: Boat, i: number, count: number, t: number): P {
  const lane = f.halfLine * 0.8 * (count > 1 ? (2 * i) / (count - 1) - 1 : 0);
  const wobble = 3 * Math.sin(t / 7000 + i * 1.7);
  const race = latestRace(state, boat.classId);
  const phase = race ? phaseAt(race, t) : undefined;
  const early = i === 0;

  if (!race || phase !== 'RACING' || race.startedAt === undefined || t < race.startedAt) {
    if (race && phase === 'FINISHED') return finishedSpot(state, f, race, boat, i, count, t);
    // Milling about below the line; in the last minute before the gun, closing on it
    const toGun = race && phase === 'SEQUENCE' && race.startAt !== undefined ? race.startAt - t : Infinity;
    const closing = Math.max(0, Math.min(1, 1 - toGun / 60_000));
    const millX = lane + 30 * Math.sin(t / 20_000 + i) * (1 - closing);
    const millY = -70 + 15 * Math.cos(t / 17_000 + i * 2);
    const lineY = early ? 10 : -6;
    return { x: millX + wobble * (1 - closing), y: millY + (lineY - millY) * closing };
  }

  const start: P = { x: lane, y: early ? 10 : -6 };
  let e = (t - race.startedAt) / 1000;
  let from = start;
  // Over at the gun with X up for it: back below the line first, then a fresh start
  if (early && race.xFlag?.boatIds.includes(boat.id)) {
    const back: P = { x: lane, y: -15 };
    if (e < 40) return lerp(start, back, e / 40);
    from = back;
    e -= 40;
  }
  const route = [from, roundingPoint(f), finishTarget(state, f, lane)];
  return along(route, (2.4 + 0.35 * i) * e, wobble);
}

function finishedSpot(state: RegattaState, f: F, _race: Race, _boat: Boat, i: number, count: number, t: number): P {
  const lane = f.halfLine * 0.8 * (count > 1 ? (2 * i) / (count - 1) - 1 : 0);
  const target = finishTarget(state, f, lane);
  return { x: target.x + 5 * Math.sin(t / 30_000 + i), y: target.y + 5 * Math.cos(t / 30_000 + i) };
}

/** A little outside the first mark, so the track rounds it */
function roundingPoint(f: F): P {
  return { x: f.mark.x + 15, y: f.mark.y + 10 };
}

/** 40 m past the middle of the finish line, coming from the first mark */
function finishTarget(state: RegattaState, f: F, lane: number): P {
  const line = finishLine(state)!;
  const a = toLocal(f, line[0]);
  const b = toLocal(f, line[1]);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const along = { x: b.x - a.x, y: b.y - a.y };
  const len = Math.hypot(along.x, along.y) || 1;
  const spread = { x: (along.x / len) * lane * 0.6, y: (along.y / len) * lane * 0.6 };
  const dir = { x: mid.x - f.mark.x, y: mid.y - f.mark.y };
  const d = Math.hypot(dir.x, dir.y) || 1;
  return { x: mid.x + spread.x + (dir.x / d) * 40, y: mid.y + spread.y + (dir.y / d) * 40 };
}

/** The point `dist` metres along a route of straight legs; the end once it is sailed */
function along(route: P[], dist: number, wobble: number): P {
  let left = Math.max(0, dist);
  for (let k = 0; k < route.length - 1; k++) {
    const a = route[k]!;
    const b = route[k + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len) {
      const p = lerp(a, b, len === 0 ? 1 : left / len);
      // A little side to side, as boats do (none at the ends of a leg)
      const w = wobble * Math.sin((Math.PI * left) / Math.max(len, 1));
      return { x: p.x + ((b.y - a.y) / (len || 1)) * w, y: p.y - ((b.x - a.x) / (len || 1)) * w };
    }
    left -= len;
  }
  return route[route.length - 1]!;
}

const lerp = (a: P, b: P, k: number): P => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const round = (v: number) => Math.round(v * 1e7) / 1e7;

function latestRace(state: RegattaState, classId: string): Race | undefined {
  return Object.values(state.races)
    .filter((r) => r.classId === classId)
    .sort((a, b) => b.number - a.number)[0];
}

// ---------------------------------------------------------------------------------- the frame

function frameOf(state: RegattaState): F | null {
  const c = state.course ?? {};
  if (!c.startPin || !c.startCommittee || !c.firstMark) return null;
  const origin = { lat: (c.startPin.lat + c.startCommittee.lat) / 2, lng: (c.startPin.lng + c.startCommittee.lng) / 2 };
  const en = (p: LatLng) => ({ x: (p.lng - origin.lng) * M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180), y: (p.lat - origin.lat) * M_PER_DEG });
  const pin = en(c.startPin);
  const cb = en(c.startCommittee);
  const len = Math.hypot(cb.x - pin.x, cb.y - pin.y);
  if (len < 1) return null;
  const u = { x: (cb.x - pin.x) / len, y: (cb.y - pin.y) / len };
  let n = { x: -u.y, y: u.x };
  const m = en(c.firstMark);
  if (m.x * n.x + m.y * n.y < 0) n = { x: -n.x, y: -n.y };
  const frame = { origin, u, n, halfLine: len / 2, mark: { x: 0, y: 0 } };
  frame.mark = toLocal(frame, c.firstMark);
  return frame;
}

function toLocal(f: Frame, p: LatLng): P {
  const e = (p.lng - f.origin.lng) * M_PER_DEG * Math.cos((f.origin.lat * Math.PI) / 180);
  const nn = (p.lat - f.origin.lat) * M_PER_DEG;
  return { x: e * f.u.x + nn * f.u.y, y: e * f.n.x + nn * f.n.y };
}

function toLatLng(f: Frame, p: P): LatLng {
  const e = p.x * f.u.x + p.y * f.n.x;
  const nn = p.x * f.u.y + p.y * f.n.y;
  return { lat: f.origin.lat + nn / M_PER_DEG, lng: f.origin.lng + e / (M_PER_DEG * Math.cos((f.origin.lat * Math.PI) / 180)) };
}

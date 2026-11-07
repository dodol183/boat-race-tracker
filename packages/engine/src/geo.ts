// Start-line geometry, for GPS suggestions only: the race officer decides who is over.

import type { LatLng } from './types.ts';
export type { LatLng };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Metres east/north of `origin`; accurate enough over a start area */
export function toLocal(p: LatLng, origin: LatLng): { x: number; y: number } {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat };
}

/**
 * Which side of the start line (pin to committee boat) a position is on. The course side is the
 * side the first mark is on. Null when the line is degenerate, a point is missing, or the position
 * is within `toleranceM` of the line.
 */
export function startLineSide(pos: LatLng, pin: LatLng, committee: LatLng, firstMark: LatLng, toleranceM = 2): 'COURSE' | 'PRE_START' | null {
  const d = startLineOffset(pos, pin, committee, firstMark);
  if (d === null || Math.abs(d) <= toleranceM) return null;
  return d > 0 ? 'COURSE' : 'PRE_START';
}

/** Metres from the start line: positive on the course side. Null when it can't be told. */
export function startLineOffset(pos: LatLng, pin: LatLng, committee: LatLng, firstMark: LatLng): number | null {
  for (const p of [pos, pin, committee, firstMark]) if (!isPoint(p)) return null;
  const b = toLocal(committee, pin);
  const len = Math.hypot(b.x, b.y);
  if (len < 1) return null;
  const side = (p: LatLng) => {
    const q = toLocal(p, pin);
    return (b.x * q.y - b.y * q.x) / len;
  };
  const courseSign = Math.sign(side(firstMark));
  if (courseSign === 0) return null;
  return side(pos) * courseSign;
}

/** A real position: numbers in range, and not 0,0 (what a GPS without a fix reports) */
export function isPoint(p: unknown): p is LatLng {
  const q = p as LatLng;
  return !!q && isNum(q.lat) && isNum(q.lng) && Math.abs(q.lat) <= 90 && Math.abs(q.lng) <= 180 && !(q.lat === 0 && q.lng === 0);
}

/** Distance in metres between two nearby points */
export function distanceM(a: LatLng, b: LatLng): number {
  const q = toLocal(b, a);
  return Math.hypot(q.x, q.y);
}

/** Distance in metres from `p` to the segment a–b */
export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const B = toLocal(b, a);
  const P = toLocal(p, a);
  const len2 = B.x * B.x + B.y * B.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / len2));
  return Math.hypot(P.x - t * B.x, P.y - t * B.y);
}

/**
 * Where the path p1→p2 crosses the line a–b (extended by `extendM` at each end, for GPS error):
 * the fraction along p1→p2, or null if it doesn't cross.
 */
export function crossingFraction(p1: LatLng, p2: LatLng, a: LatLng, b: LatLng, extendM = 0): number | null {
  const A0 = { x: 0, y: 0 };
  const B0 = toLocal(b, a);
  const len = Math.hypot(B0.x, B0.y);
  if (len < 1) return null;
  const ux = B0.x / len;
  const uy = B0.y / len;
  const A = { x: A0.x - ux * extendM, y: A0.y - uy * extendM };
  const B = { x: B0.x + ux * extendM, y: B0.y + uy * extendM };
  const P = toLocal(p1, a);
  const Q = toLocal(p2, a);
  const r = { x: Q.x - P.x, y: Q.y - P.y };
  const s = { x: B.x - A.x, y: B.y - A.y };
  const denom = r.x * s.y - r.y * s.x;
  if (denom === 0) return null;
  const t = ((A.x - P.x) * s.y - (A.y - P.y) * s.x) / denom;
  const u = ((A.x - P.x) * r.y - (A.y - P.y) * r.x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

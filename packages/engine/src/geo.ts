// Start-line geometry, for GPS suggestions only: the race officer decides who is over.

export interface LatLng {
  lat: number;
  lng: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Metres east/north of `origin`; accurate enough over a start area */
function toLocal(p: LatLng, origin: LatLng): { x: number; y: number } {
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
  for (const p of [pos, pin, committee, firstMark]) if (!p || !isNum(p.lat) || !isNum(p.lng)) return null;
  const b = toLocal(committee, pin);
  const len = Math.hypot(b.x, b.y);
  if (len < 1) return null;
  const side = (p: LatLng) => {
    const q = toLocal(p, pin);
    return (b.x * q.y - b.y * q.x) / len;
  };
  const courseSign = Math.sign(side(firstMark));
  if (courseSign === 0) return null;
  const d = side(pos) * courseSign;
  if (Math.abs(d) <= toleranceM) return null;
  return d > 0 ? 'COURSE' : 'PRE_START';
}

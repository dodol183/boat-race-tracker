// Files for Sailwave, the scoring program many clubs use: a competitor list and the race results,
// as CSV with a header row of Sailwave field names (its importer matches columns by name, and lets
// you map any it doesn't recognise by hand).
//
// - Competitors (File → Import → Competitors): Class, SailNo, Boat, Rating
// - Race results (File → Import → Race results): one row per boat per race, matched to the
//   competitor by sail number: SailNo, Class, RaceNo, Start, Finish (times of day) and Elapsed, or a
//   scoring Code. Sailwave works out corrected times and points itself with its own settings.
// Sailwave's own .blw file format is undocumented, so it isn't written.
import { raceResults, type RegattaState } from '@brt/engine';

const q = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (rows: (string | number)[][]) => rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';

/** hh:mm:ss in the race office's time zone */
function timeOfDay(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) });
}

/** h:mm:ss, whole seconds */
function hms(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function sailwaveCompetitors(state: RegattaState, classId: string): string {
  const cls = state.classes[classId];
  const boats = Object.values(state.boats)
    .filter((b) => b.classId === classId)
    .sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  return csv([['Class', 'SailNo', 'Boat', 'Rating'], ...boats.map((b) => [cls?.name ?? '', b.sailNumber, b.name, b.rating])]);
}

/**
 * Every finished race of the class, numbered as in this app. A boat with a finish has its start and
 * finish times; one with a scoring code (or still OCS) has the code instead. Abandoned races are left
 * out, as they are from the series.
 */
export function sailwaveResults(state: RegattaState, classId: string, timeZone?: string): string {
  const cls = state.classes[classId];
  const races = Object.values(state.races)
    .filter((r) => r.classId === classId && r.phase === 'FINISHED' && r.startedAt !== undefined)
    .sort((a, b) => a.number - b.number);
  const rows: (string | number)[][] = [['SailNo', 'Class', 'RaceNo', 'Start', 'Finish', 'Elapsed', 'Code']];
  for (const r of races) {
    // The engine's results: which boats finished and which have a code (an OCS boat that finished is OCS)
    const results = raceResults(state, r).sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
    for (const row of results) {
      const finishAt = r.entries[row.boatId]?.finishAt;
      if (row.code || finishAt === undefined) rows.push([row.sailNumber, cls?.name ?? '', r.number, '', '', '', row.code ?? 'DNF']);
      else rows.push([row.sailNumber, cls?.name ?? '', r.number, timeOfDay(r.startedAt!, timeZone), timeOfDay(finishAt, timeZone), hms(row.elapsedSec!), '']);
    }
  }
  return csv(rows);
}

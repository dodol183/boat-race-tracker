// Result tables shared by the race office and the public view.
import { raceResults, seriesStandings, type PenaltyCode, type Race, type RegattaState } from '@brt/engine';
import { duration, points } from '../lib/format.ts';

const CODES: PenaltyCode[] = ['DNC', 'DNS', 'OCS', 'DNF', 'RET', 'DSQ'];

/** One race on corrected time. With `onPenalty`, the race office can give or clear a code. */
export function RaceTable({ regatta, race, onPenalty }: { regatta: RegattaState; race: Race; onPenalty?: (boatId: string, code: PenaltyCode | null) => void }) {
  const rows = raceResults(regatta, race);
  const live = race.phase === 'RACING';
  if (rows.length === 0) return <p className="text-muted">No boats entered yet.</p>;
  return (
    // Focusable so it can be scrolled from a keyboard when the table is wider than the screen
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`Race ${race.number} results`}>
      <table className="w-full text-left">
        <thead className="text-sm text-muted">
          <tr>
            <th className="py-2 pr-2">Place</th>
            <th className="py-2 pr-2">Boat</th>
            <th className="py-2 pr-2 text-right">Elapsed</th>
            <th className="py-2 pr-2 text-right">Corrected</th>
            <th className="py-2 pr-2 text-right">Points</th>
            {onPenalty && <th className="py-2"><span className="sr-only">Scoring code</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            const entry = race.entries[r.boatId];
            // While racing, a boat with no finish and no code hasn't finished yet: not DNF
            const stillRacing = live && !entry?.penalty && !entry?.ocs && entry?.finishAt === undefined;
            return (
              <tr key={r.boatId}>
                <td className="py-2 pr-2 font-semibold">{r.place ?? (stillRacing ? '' : r.code)}</td>
                <td className="py-2 pr-2">
                  <span className="font-semibold">{r.sailNumber}</span> <span className="text-muted text-sm">{r.name}</span>
                </td>
                <td className="py-2 pr-2 text-right font-mono">{r.elapsedSec !== undefined ? duration(r.elapsedSec) : ''}</td>
                <td className="py-2 pr-2 text-right font-mono">{r.correctedSec !== undefined ? duration(r.correctedSec) : ''}</td>
                <td className="py-2 pr-2 text-right font-mono">{stillRacing ? <span className="text-muted">racing</span> : points(r.points)}</td>
                {onPenalty && (
                  <td className="py-1">
                    <label className="sr-only" htmlFor={`code-${race.id}-${r.boatId}`}>Scoring code for {r.sailNumber}</label>
                    <select
                      id={`code-${race.id}-${r.boatId}`}
                      className="min-h-11 rounded-lg border border-line bg-canvas px-2"
                      value={entry?.penalty ?? ''}
                      onChange={(e) => onPenalty(r.boatId, (e.target.value || null) as PenaltyCode | null)}
                    >
                      <option value="">{entry?.ocs ? 'OCS (not back)' : 'No code'}</option>
                      {CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Series standings for a class; discarded scores in brackets */
export function SeriesTable({ regatta, classId }: { regatta: RegattaState; classId: string }) {
  const rows = seriesStandings(regatta, classId);
  const races = Object.values(regatta.races)
    .filter((r) => r.classId === classId && r.phase === 'FINISHED')
    .sort((a, b) => a.number - b.number);
  if (races.length === 0) return <p className="text-muted">No races finished yet.</p>;
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Series standings">
      <table className="w-full text-left">
        <thead className="text-sm text-muted">
          <tr>
            <th className="py-2 pr-2">Rank</th>
            <th className="py-2 pr-2">Boat</th>
            {races.map((r) => <th key={r.id} className="py-2 pr-2 text-right">R{r.number}</th>)}
            <th className="py-2 pr-2 text-right">Total</th>
            <th className="py-2 text-right">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.boatId}>
              <td className="py-2 pr-2 font-semibold">{row.rank}</td>
              <td className="py-2 pr-2 whitespace-nowrap">
                <span className="font-semibold">{row.sailNumber}</span> <span className="text-muted text-sm">{row.name}</span>
              </td>
              {row.scores.map((s) => {
                const text = `${points(s.points)}${s.code ? ` ${s.code}` : ''}`;
                return <td key={s.raceId} className={`py-2 pr-2 text-right font-mono whitespace-nowrap ${s.discarded ? 'text-muted' : ''}`}>{s.discarded ? `(${text})` : text}</td>;
              })}
              <td className="py-2 pr-2 text-right font-mono">{points(row.total)}</td>
              <td className="py-2 text-right font-mono font-bold">{points(row.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Series standings as CSV: one row per boat, a column per race, for Sailwave or a spreadsheet */
export function seriesCsv(regatta: RegattaState, classId: string): string {
  const races = Object.values(regatta.races)
    .filter((r) => r.classId === classId && r.phase === 'FINISHED')
    .sort((a, b) => a.number - b.number);
  const q = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Rank', 'SailNo', 'Boat', ...races.map((r) => `R${r.number}`), 'Total', 'Nett'];
  const lines = seriesStandings(regatta, classId).map((row) => [
    row.rank,
    row.sailNumber,
    row.name,
    ...row.scores.map((s) => {
      const t = `${points(s.points)}${s.code ? ` ${s.code}` : ''}`;
      return s.discarded ? `(${t})` : t;
    }),
    points(row.total),
    points(row.net),
  ]);
  return [head, ...lines].map((l) => l.map(q).join(',')).join('\r\n') + '\r\n';
}

/** A class picker as a row of chips; hidden when there is only one class */
export function ClassChips({ regatta, value, onChange }: { regatta: RegattaState; value: string | undefined; onChange: (id: string) => void }) {
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));
  if (classes.length < 2) return null;
  return (
    <div role="group" aria-label="Class" className="flex flex-wrap gap-2">
      {classes.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
          className={`min-h-11 px-4 rounded-lg font-semibold border ${value === c.id ? 'bg-accent text-accent-ink border-accent' : 'bg-surface border-line'}`}
        >
          {c.name}
        </button>
      ))}
    </div>
  );
}

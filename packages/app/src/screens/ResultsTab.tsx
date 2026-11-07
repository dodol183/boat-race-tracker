import { useState } from 'react';
import type { PenaltyCode, RegattaState } from '@brt/engine';
import type { RegattaClient } from '../lib/client.ts';
import { Button, Card, Pill } from '../ui/kit.tsx';
import { ClassChips, RaceTable, SeriesTable, seriesCsv } from '../ui/results.tsx';

/** Race results and series standings. The race office can also give scoring codes here. */
export function ResultsTab({ client, regatta }: { client: RegattaClient; regatta: RegattaState }) {
  const officer = client.getSnapshot().role === 'OFFICER';
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));
  const [classId, setClassId] = useState<string | undefined>(classes[0]?.id);
  const cls = (classId && regatta.classes[classId]) || classes[0];
  const races = cls
    ? Object.values(regatta.races)
        .filter((r) => r.classId === cls.id && (r.phase === 'FINISHED' || r.phase === 'RACING'))
        .sort((a, b) => b.number - a.number)
    : [];
  const [raceId, setRaceId] = useState<string>();
  const race = races.find((r) => r.id === raceId) ?? races[0];

  if (!cls) return <p className="text-muted">No classes yet.</p>;

  const download = () => {
    const blob = new Blob([seriesCsv(regatta, cls.id)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cls.name.replace(/[^\w-]+/g, '_')}_series.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="space-y-4">
      <ClassChips regatta={regatta} value={cls.id} onChange={(id) => { setClassId(id); setRaceId(undefined); }} />

      <Card
        title={`${cls.name} · Series`}
        actions={officer && <Button onClick={download}>Download CSV</Button>}
      >
        <SeriesTable regatta={regatta} classId={cls.id} />
        <p className="text-sm text-muted">Low Point System (RRS Appendix A). One discard from 4 races. Discarded scores in brackets.</p>
      </Card>

      {race ? (
        <Card
          title={`Race ${race.number}`}
          actions={race.phase === 'RACING' ? <Pill tone="go">Provisional · racing</Pill> : <Pill tone="muted">Finished</Pill>}
        >
          {races.length > 1 && (
            <div role="group" aria-label="Race" className="flex flex-wrap gap-2">
              {races.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={r.id === race.id}
                  onClick={() => setRaceId(r.id)}
                  className={`min-h-11 min-w-11 px-3 rounded-lg font-semibold border ${r.id === race.id ? 'bg-accent text-accent-ink border-accent' : 'bg-surface border-line'}`}
                >
                  R{r.number}
                </button>
              ))}
            </div>
          )}
          <RaceTable
            regatta={regatta}
            race={race}
            {...(officer ? { onPenalty: (boatId: string, code: PenaltyCode | null) => void client.send({ type: 'setPenalty', raceId: race.id, boatId, code }) } : {})}
          />
        </Card>
      ) : (
        <p className="text-muted">No race in {cls.name} has started yet.</p>
      )}
    </div>
  );
}

import { useState } from 'react';
import { activeRace, nextSignal, phaseAt, type Fix, type RegattaState } from '@brt/engine';
import type { RegattaClient } from '../lib/client.ts';
import { useServerNow } from '../lib/useRegatta.ts';
import { countdown, duration } from '../lib/format.ts';
import { Card, Pill } from '../ui/kit.tsx';
import { ClassChips, RaceTable } from '../ui/results.tsx';
import { RaceMap } from '../ui/RaceMap.tsx';

const SIGNAL = { WARNING: 'warning signal', PREPARATORY: 'preparatory signal', ONE_MINUTE: 'one minute', START: 'start' } as const;

/** What a spectator or skipper sees: where each class is, and the race as it finishes */
export function LiveTab({ client, regatta, tracks }: { client: RegattaClient; regatta: RegattaState; tracks: Record<string, Fix[]> }) {
  const now = useServerNow(client, 500);
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));
  const [classId, setClassId] = useState<string | undefined>(classes[0]?.id);
  if (classes.length === 0) return <p className="text-muted">The race office hasn't set up the fleet yet.</p>;
  const cls = (classId && regatta.classes[classId]) || classes[0]!;

  const race = activeRace(regatta, cls.id) ?? lastFinished(regatta, cls.id);
  const phase = race ? phaseAt(race, now) : undefined;

  let status: JSX.Element;
  if (!race) status = <p className="text-muted">No race yet.</p>;
  else if (phase === 'SEQUENCE') {
    const next = nextSignal(race, now);
    status = (
      <>
        <p className="text-sm text-muted">Start in</p>
        <p className="text-5xl font-bold font-mono">{countdown(race.startAt! - now)}</p>
        {next && next.name !== 'START' && <p className="text-muted">Next: {SIGNAL[next.name]} in {countdown(next.at - now)}</p>}
      </>
    );
  } else if (phase === 'POSTPONED') status = <p className="font-semibold">Start postponed (AP flag). A new warning signal comes 1 minute after it's lowered.</p>;
  else if (phase === 'RECALLED') status = <p className="font-semibold">General recall. A new start sequence follows.</p>;
  else if (phase === 'RACING') {
    const startedAt = race.startedAt ?? race.startAt!;
    status = (
      <>
        <p className="text-sm text-muted">Racing for</p>
        <p className="text-4xl font-bold font-mono">{duration((now - startedAt) / 1000)}</p>
        {race.xFlag && !race.xFlag.loweredAt && <p className="text-stop font-semibold">X flag: individual recall</p>}
      </>
    );
  } else status = <p className="text-muted">Race {race.number} finished.</p>;

  const tone = phase === 'RACING' ? 'go' : phase === 'SEQUENCE' ? 'warn' : phase === 'POSTPONED' || phase === 'RECALLED' ? 'stop' : 'muted';
  const label = { SEQUENCE: 'Start sequence', POSTPONED: 'Postponed', RECALLED: 'Recalled', RACING: 'Racing', FINISHED: 'Finished', ABANDONED: 'Abandoned' } as const;

  return (
    <div className="space-y-4">
      <ClassChips regatta={regatta} value={cls.id} onChange={setClassId} />
      <Card title={race ? `${cls.name} · Race ${race.number}` : cls.name} actions={phase && <Pill tone={tone}>{label[phase]}</Pill>}>
        <div aria-live="polite" aria-atomic="true" className="space-y-1">{status}</div>
      </Card>
      <RaceMap regatta={regatta} tracks={tracks} now={now} />
      {race && (phase === 'RACING' || phase === 'FINISHED') && race.startedAt !== undefined && (
        <Card title={phase === 'RACING' ? 'Provisional results' : 'Results'}>
          <RaceTable regatta={regatta} race={race} />
        </Card>
      )}
    </div>
  );
}

function lastFinished(regatta: RegattaState, classId: string) {
  return Object.values(regatta.races)
    .filter((r) => r.classId === classId && r.phase === 'FINISHED')
    .sort((a, b) => b.number - a.number)[0];
}

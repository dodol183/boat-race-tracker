import { useEffect, useRef, useState } from 'react';
import {
  activeRace, nextSignal, phaseAt, sequenceSignals, xFlagState, X_FLAG_LIMIT_MS,
  type OverSuggestion, type Race, type RaceClass, type RegattaState,
} from '@brt/engine';
import type { RegattaClient } from '../../lib/client.ts';
import { useServerNow } from '../../lib/useRegatta.ts';
import { countdown, duration } from '../../lib/format.ts';
import { enableSound, horn } from '../../lib/horn.ts';
import { Button, Card, ConfirmButton, Pill } from '../../ui/kit.tsx';

const SIGNAL_LABEL = { WARNING: 'Warning signal', PREPARATORY: 'Preparatory signal', ONE_MINUTE: 'One minute', START: 'Start' } as const;

export function StartTab({ client, regatta, over }: { client: RegattaClient; regatta: RegattaState; over: OverSuggestion[] }) {
  const now = useServerNow(client);
  const [sound, setSound] = useState(false);
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));
  if (classes.length === 0) return <p className="text-muted">Add a class and its boats in Setup first.</p>;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button tone={sound ? 'primary' : 'secondary'} aria-pressed={sound} onClick={() => setSound(sound ? false : enableSound())}>
          {sound ? 'Horn on' : 'Horn off'}
        </Button>
      </div>
      {classes.map((c) => (
        <ClassCard key={c.id} cls={c} regatta={regatta} client={client} now={now} sound={sound} over={over} />
      ))}
    </div>
  );
}

function ClassCard({ cls, regatta, client, now, sound, over }: { cls: RaceClass; regatta: RegattaState; client: RegattaClient; now: number; sound: boolean; over: OverSuggestion[] }) {
  const race = activeRace(regatta, cls.id);
  const boats = Object.values(regatta.boats).filter((b) => b.classId === cls.id);
  useSignalHorn(race, now, sound);

  if (!race) {
    const done = Object.values(regatta.races).filter((r) => r.classId === cls.id && r.phase === 'FINISHED').length;
    return (
      <Card title={cls.name} actions={<Pill tone="muted">{done ? `${done} race${done > 1 ? 's' : ''} sailed` : 'No race yet'}</Pill>}>
        <p className="text-muted">{boats.length} boat{boats.length === 1 ? '' : 's'}.</p>
        <Button tone="primary" disabled={boats.length === 0} onClick={() => client.send({ type: 'startSequence', classId: cls.id })}>
          Start {cls.sequenceMinutes}-minute sequence
        </Button>
      </Card>
    );
  }

  const phase = phaseAt(race, now);
  const title = `${cls.name} · Race ${race.number}`;

  if (phase === 'SEQUENCE') {
    const next = nextSignal(race, now);
    return (
      <Card title={title} actions={<Pill tone="warn">Sequence</Pill>}>
        <p className="text-6xl font-bold font-mono" aria-live="off">{countdown(race.startAt! - now)}</p>
        {next && <p className="text-muted">Next: {SIGNAL_LABEL[next.name]} in {countdown(next.at - now)}</p>}
        <SignalList race={race} now={now} />
        <ConfirmButton label="AP: postpone" confirm="Raise AP" tone="primary" onConfirm={() => client.send({ type: 'postpone', raceId: race.id })} />
      </Card>
    );
  }

  if (phase === 'POSTPONED' || phase === 'RECALLED') {
    return (
      <Card title={title} actions={<Pill tone="stop">{phase === 'POSTPONED' ? 'AP up' : 'General recall'}</Pill>}>
        <p>{phase === 'POSTPONED' ? 'The start is postponed.' : `General recall${race.generalRecalls > 1 ? ` (${race.generalRecalls})` : ''}. All boats return to the pre-start area.`}</p>
        <Button tone="primary" onClick={() => client.send({ type: 'resumeSequence', raceId: race.id })}>
          {phase === 'POSTPONED' ? 'Lower AP' : 'Lower first substitute'}: warning in 1 minute
        </Button>
        <ConfirmButton label="Abandon race" confirm="Abandon this race" onConfirm={() => client.send({ type: 'abandonRace', raceId: race.id })} />
      </Card>
    );
  }

  // Racing. The server sends raceStarted a moment after the gun; until then the entries are empty.
  const entries = Object.values(race.entries);
  const finished = entries.filter((e) => e.finishAt !== undefined).length;
  const startedAt = race.startedAt ?? race.startAt!;
  return (
    <Card title={title} actions={<Pill tone="go">Racing</Pill>}>
      <p className="text-4xl font-bold font-mono">{duration((now - startedAt) / 1000)}</p>
      <p className="text-muted">{finished} of {entries.length} finished.</p>
      <XFlag race={race} regatta={regatta} client={client} now={now} over={over.filter((o) => o.raceId === race.id)} />
      <div className="flex flex-wrap gap-2 pt-2 border-t border-line">
        {finished === 0 && (
          <ConfirmButton label="General recall" confirm="Signal general recall" onConfirm={() => client.send({ type: 'generalRecall', raceId: race.id })} />
        )}
        <ConfirmButton label="End race" confirm={`End race: ${entries.length - finished} without a finish become DNF`} tone="primary" onConfirm={() => client.send({ type: 'endRace', raceId: race.id })} />
        <ConfirmButton label="Abandon" confirm="Abandon this race" onConfirm={() => client.send({ type: 'abandonRace', raceId: race.id })} />
      </div>
    </Card>
  );
}

function SignalList({ race, now }: { race: Race; now: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-sm">
      {sequenceSignals(race).map((s) => (
        <li key={s.name} className={`px-2 py-1 rounded border ${s.at <= now ? 'border-line text-muted line-through' : 'border-accent'}`}>
          {SIGNAL_LABEL[s.name]} {new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
        </li>
      ))}
    </ol>
  );
}

/** Individual recall: choose the boats, raise X; then mark them back and lower it */
function XFlag({ race, regatta, client, now, over }: { race: Race; regatta: RegattaState; client: RegattaClient; now: number; over: OverSuggestion[] }) {
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const x = xFlagState(race, now);
  const startedAt = race.startedAt;
  const sail = (id: string) => regatta.boats[id]?.sailNumber ?? id;

  if (x.up) {
    return (
      <div className="p-3 rounded-lg border border-stop space-y-2">
        <p className="font-bold">X flag up · {x.msLeft > 0 ? `${countdown(x.msLeft)} to the 4-minute limit` : '4 minutes since the start'}</p>
        {x.shouldLower && <p className="text-stop font-semibold">{x.stillOver.length ? 'Lower X now. Boats still over stay OCS.' : 'Every recalled boat is back. Lower X.'}</p>}
        <ul className="space-y-1">
          {race.xFlag!.boatIds.map((id) => (
            <li key={id} className="flex items-center justify-between gap-2">
              <span className="font-semibold">{sail(id)}</span>
              {race.entries[id]?.ocs ? (
                <Button onClick={() => client.send({ type: 'markReturned', raceId: race.id, boatId: id })}>Returned</Button>
              ) : (
                <span className="text-go font-semibold px-2">Back</span>
              )}
            </li>
          ))}
        </ul>
        <Button tone={x.shouldLower ? 'primary' : 'secondary'} onClick={() => client.send({ type: 'lowerX', raceId: race.id })}>Lower X</Button>
      </div>
    );
  }
  if (race.xFlag || startedAt === undefined || now - startedAt >= X_FLAG_LIMIT_MS) return null;

  const gpsOver = over.length > 0 && (
    <p className="text-warn font-semibold">
      GPS: {over.map((o) => `${sail(o.boatId)} (${o.metres} m)`).join(', ')} looked over the line at the gun. Check before raising X.
    </p>
  );
  if (!choosing) {
    return (
      <div className="space-y-2">
        {gpsOver}
        {/* GPS only suggests: the boats start ticked, the race office decides */}
        <Button onClick={() => { setChosen(new Set(over.map((o) => o.boatId))); setChoosing(true); }}>X flag: individual recall</Button>
      </div>
    );
  }
  const ids = Object.keys(race.entries).sort((a, b) => sail(a).localeCompare(sail(b), undefined, { numeric: true }));
  return (
    <fieldset className="p-3 rounded-lg border border-line space-y-2">
      <legend className="font-bold px-1">Boats over the line</legend>
      {gpsOver}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {ids.map((id) => (
          <label key={id} className="min-h-11 flex items-center gap-2 px-3 rounded-lg border border-line has-[:checked]:border-stop">
            <input type="checkbox" className="w-5 h-5" checked={chosen.has(id)} onChange={() => setChosen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })} />
            <span className="font-semibold whitespace-nowrap">{sail(id)}</span>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button tone="danger" disabled={chosen.size === 0} onClick={() => { client.send({ type: 'individualRecall', raceId: race.id, boatIds: [...chosen] }); setChoosing(false); }}>
          Raise X for {chosen.size || ''} {chosen.size === 1 ? 'boat' : 'boats'}
        </Button>
        <Button tone="quiet" onClick={() => setChoosing(false)}>Cancel</Button>
      </div>
    </fieldset>
  );
}

/** Sounds each signal as its time passes, while the horn is on and this screen is open */
function useSignalHorn(race: Race | undefined, now: number, on: boolean) {
  const played = useRef(new Set<string>());
  useEffect(() => {
    if (!on || !race) return;
    for (const s of sequenceSignals(race)) {
      const key = `${race.id}|${s.at}|${s.name}`;
      // Only signals that just passed; opening the screen late doesn't replay old ones
      if (s.at <= now && now - s.at < 1500 && !played.current.has(key)) {
        played.current.add(key);
        horn(s.name === 'START' || s.name === 'WARNING');
      }
    }
  }, [race, now, on]);
}

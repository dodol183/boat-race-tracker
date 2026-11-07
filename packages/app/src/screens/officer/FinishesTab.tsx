import { useState } from 'react';
import { phaseAt, type FinishSuggestion, type Race, type RegattaState } from '@brt/engine';
import type { Pending, RegattaClient } from '../../lib/client.ts';
import { useServerNow } from '../../lib/useRegatta.ts';
import { clock, duration } from '../../lib/format.ts';
import { Button, Card, ConfirmButton, Pill, inputClass } from '../../ui/kit.tsx';

const normal = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Finds a boat in the race from what was typed: the whole sail number ("MAS 11"), or just its
 * number ("11") when only one boat in the race ends that way.
 */
export function boatBySail(regatta: RegattaState, race: Race, typed: string): string | undefined {
  const t = normal(typed);
  if (!t) return undefined;
  const ids = Object.keys(race.entries);
  const sail = (id: string) => normal(regatta.boats[id]?.sailNumber ?? id);
  const exact = ids.filter((id) => sail(id) === t);
  if (exact.length === 1) return exact[0];
  const tail = ids.filter((id) => sail(id).replace(/\s/g, '').endsWith(t.replace(/\s/g, '')) && /\d$/.test(t));
  return tail.length === 1 ? tail[0] : undefined;
}

export function FinishesTab({ client, regatta, pending, suggested }: { client: RegattaClient; regatta: RegattaState; pending: Pending[]; suggested: FinishSuggestion[] }) {
  const now = useServerNow(client, 1000);
  const racing = Object.values(regatta.races)
    .filter((r) => phaseAt(r, now) === 'RACING')
    .sort((a, b) => (regatta.classes[a.classId]?.name ?? '').localeCompare(regatta.classes[b.classId]?.name ?? ''));
  if (racing.length === 0) return <p className="text-muted">No race is under way. Finishes are taken here once a start gun has gone.</p>;
  return (
    <div className="space-y-4">
      {racing.map((r) => (
        <RaceFinishes key={r.id} race={r} regatta={regatta} client={client} pending={pending} now={now} suggested={suggested.filter((f) => f.raceId === r.id)} />
      ))}
    </div>
  );
}

function RaceFinishes({ race, regatta, client, pending, now, suggested }: { race: Race; regatta: RegattaState; client: RegattaClient; pending: Pending[]; now: number; suggested: FinishSuggestion[] }) {
  const [typed, setTyped] = useState('');
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [miss, setMiss] = useState<string>();
  const cls = regatta.classes[race.classId];
  const title = `${cls?.name ?? 'Class'} · Race ${race.number}`;
  const sail = (id: string) => regatta.boats[id]?.sailNumber ?? id;
  const name = (id: string) => regatta.boats[id]?.name ?? '';

  if (race.startedAt === undefined) {
    return (
      <Card title={title} actions={<Pill tone="go">Racing</Pill>}>
        <p className="text-muted">Waiting for the server to confirm the start…</p>
      </Card>
    );
  }
  const startedAt = race.startedAt;

  // Taps not yet answered by the server count as finished here, so a boat isn't tapped twice
  const sending = new Map<string, number>();
  for (const p of pending) {
    if (p.command.type === 'recordFinish' && p.command.raceId === race.id) sending.set(p.command.boatId, p.command.at ?? p.queuedAt);
    if (p.command.type === 'undoFinish' && p.command.raceId === race.id) sending.delete(p.command.boatId);
  }
  const entries = Object.values(race.entries);
  const finishedRows = [
    ...entries.filter((e) => e.finishAt !== undefined && !sending.has(e.boatId)).map((e) => ({ boatId: e.boatId, at: e.finishAt!, sending: false })),
    ...[...sending].filter(([id]) => race.entries[id]?.finishAt === undefined).map(([boatId, at]) => ({ boatId, at, sending: true })),
  ].sort((a, b) => a.at - b.at);
  const done = new Set(finishedRows.map((f) => f.boatId));
  const toCome = entries
    .filter((e) => !done.has(e.boatId) && (!e.penalty || e.penalty === 'OCS'))
    .sort((a, b) => sail(a.boatId).localeCompare(sail(b.boatId), undefined, { numeric: true }));

  const gpsRows = suggested.filter((f) => !done.has(f.boatId) && !ignored.has(`${f.boatId}|${f.at}`));

  const finish = (boatId: string) => {
    void client.send({ type: 'recordFinish', raceId: race.id, boatId, at: client.serverNow(), source: 'TAP' });
  };

  return (
    <Card title={title} actions={<Pill tone="go">{duration((now - startedAt) / 1000)}</Pill>}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const id = boatBySail(regatta, race, typed);
          if (!id) return setMiss(`No single boat in this race matches “${typed.trim()}”.`);
          if (done.has(id)) return setMiss(`${sail(id)} already has a finish.`);
          finish(id);
          setTyped('');
          setMiss(undefined);
        }}
      >
        <label className="sr-only" htmlFor={`sail-${race.id}`}>Sail number</label>
        <input
          id={`sail-${race.id}`}
          className={inputClass}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="Sail number, then Enter"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" tone="primary">Finish</Button>
      </form>
      {miss && <p role="alert" className="text-stop font-semibold">{miss}</p>}

      {gpsRows.length > 0 && (
        <div className="p-3 rounded-lg border border-accent space-y-2">
          <h3 className="font-semibold">GPS says these boats crossed the finish line</h3>
          <ul className="space-y-2">
            {gpsRows.map((f) => (
              <li key={f.boatId} className="flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{sail(f.boatId)}</span> at <span className="font-mono">{clock(f.at)}</span>
                  <span className="block text-sm text-muted">Estimate between fixes {f.gapSec} s apart</span>
                </span>
                <Button tone="primary" onClick={() => void client.send({ type: 'recordFinish', raceId: race.id, boatId: f.boatId, at: f.at, source: 'GPS' })}>Record</Button>
                <Button tone="quiet" onClick={() => setIgnored((s) => new Set(s).add(`${f.boatId}|${f.at}`))}>Ignore</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {toCome.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-muted mb-2">Tap a boat as it crosses the line</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {toCome.map((e) => (
              <button
                key={e.boatId}
                type="button"
                onClick={() => finish(e.boatId)}
                className="min-h-16 rounded-lg border-2 border-accent bg-canvas px-2 py-2 text-left active:bg-accent active:text-accent-ink"
              >
                <span className="block text-xl font-bold leading-tight">{sail(e.boatId)}</span>
                <span className="block text-sm text-muted truncate">{e.ocs ? 'OCS · not back' : name(e.boatId)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-go font-semibold">Every boat has a finish or a scoring code. End the race on the Start tab.</p>
      )}

      {finishedRows.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-muted mb-2">Finish order (elapsed time)</h3>
          <ol className="divide-y divide-line border border-line rounded-lg">
            {finishedRows.map((f, i) => (
              <li key={f.boatId} className="flex items-center gap-3 px-3 py-2">
                <span className="w-6 text-right font-mono text-muted">{i + 1}</span>
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{sail(f.boatId)}</span>{' '}
                  <span className="text-muted text-sm">{clock(f.at)}</span>
                </span>
                <span className="font-mono">{duration((f.at - startedAt) / 1000)}</span>
                {f.sending ? (
                  <span className="text-warn text-sm font-semibold w-20 text-center">Sending…</span>
                ) : (
                  <ConfirmButton label="Undo" confirm="Remove finish" onConfirm={() => void client.send({ type: 'undoFinish', raceId: race.id, boatId: f.boatId })} />
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

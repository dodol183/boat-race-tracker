import { useState } from 'react';
import { activeRace, type Boat, type RaceClass, type RatingSystem, type RegattaState } from '@brt/engine';
import type { RegattaClient } from '../../lib/client.ts';
import { Button, Card, ConfirmButton, Field, Pill, inputClass } from '../../ui/kit.tsx';

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const SYSTEMS: { id: RatingSystem; label: string }[] = [
  { id: 'IRC', label: 'IRC' },
  { id: 'ORC', label: 'ORC' },
  { id: 'PY', label: 'Portsmouth Yardstick (PY)' },
];
const ratingLabel = (s: RatingSystem | undefined) => (s === 'PY' ? 'Portsmouth Number' : 'Time correction factor (TCC)');
const ratingHint = (s: RatingSystem | undefined) => (s === 'PY' ? 'e.g. 1100' : 'e.g. 1.042');

export function SetupTab({ client, regatta }: { client: RegattaClient; regatta: RegattaState }) {
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-4">
      <ShareCard client={client} />
      {classes.map((c) => (
        <ClassSection key={c.id} cls={c} regatta={regatta} client={client} />
      ))}
      <Card title="Add a class">
        <ClassForm client={client} onDone={() => {}} />
      </Card>
    </div>
  );
}

/** The codes to give out: spectators need only the event code; skippers get their PIN */
function ShareCard({ client }: { client: RegattaClient }) {
  const { regattaId, skipperPin } = client.getSnapshot();
  const base = `${window.location.origin}${window.location.pathname}`;
  const spectatorLink = `${base}?r=${regattaId}`;
  const [copied, setCopied] = useState(false);
  return (
    <Card title="Share">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted">Event code</dt>
        <dd className="font-mono font-bold text-lg">{regattaId}</dd>
        {skipperPin && (
          <>
            <dt className="text-muted">Skipper PIN</dt>
            <dd className="font-mono font-bold text-lg">{skipperPin}</dd>
          </>
        )}
      </dl>
      <p className="text-sm text-muted">Anyone with the event code can watch. Keep your race office PIN to yourself.</p>
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          onClick={() => {
            navigator.clipboard?.writeText(spectatorLink).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          Copy spectator link
        </Button>
        {copied && <span role="status" className="text-go font-semibold">Copied</span>}
      </div>
    </Card>
  );
}

function ClassSection({ cls, regatta, client }: { cls: RaceClass; regatta: RegattaState; client: RegattaClient }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editBoat, setEditBoat] = useState<string>();
  const boats = Object.values(regatta.boats)
    .filter((b) => b.classId === cls.id)
    .sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  const racing = activeRace(regatta, cls.id);
  const hasRaces = Object.values(regatta.races).some((r) => r.classId === cls.id);

  return (
    <Card
      title={cls.name}
      actions={
        <span className="flex items-center gap-2">
          <Pill tone="muted">{cls.ratingSystem} · {cls.sequenceMinutes} min</Pill>
          {!editing && <Button tone="quiet" onClick={() => setEditing(true)}>Edit class</Button>}
        </span>
      }
    >
      {editing && (
        <div className="p-3 rounded-lg border border-line space-y-3">
          <ClassForm client={client} cls={cls} onDone={() => setEditing(false)} />
          {boats.length === 0 && !hasRaces && (
            <ConfirmButton label="Remove class" confirm={`Remove ${cls.name}`} onConfirm={() => void client.send({ type: 'removeClass', classId: cls.id })} />
          )}
        </div>
      )}
      {racing && <p className="text-warn font-semibold">Race {racing.number} is under way: boats in it can't be removed until it ends.</p>}

      {boats.length === 0 ? (
        <p className="text-muted">No boats yet.</p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-lg">
          {boats.map((b) =>
            editBoat === b.id ? (
              <li key={b.id} className="p-3">
                <BoatForm client={client} regatta={regatta} classId={cls.id} boat={b} onDone={() => setEditBoat(undefined)} />
              </li>
            ) : (
              <li key={b.id} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{b.sailNumber}</span> <span className="text-muted">{b.name}</span>
                  <span className="block text-sm text-muted">
                    {cls.ratingSystem === 'PY' ? `PN ${b.rating}` : `TCC ${b.rating.toFixed(3)}`}
                    {b.trackerId ? ` · tracker ${b.trackerId}` : ''}
                  </span>
                </span>
                <Button tone="quiet" onClick={() => setEditBoat(b.id)}>Edit</Button>
              </li>
            )
          )}
        </ul>
      )}
      {adding ? (
        <div className="p-3 rounded-lg border border-line">
          <BoatForm client={client} regatta={regatta} classId={cls.id} onDone={() => setAdding(false)} keepOpen />
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>Add boat</Button>
      )}
    </Card>
  );
}

function ClassForm({ client, cls, onDone }: { client: RegattaClient; cls?: RaceClass; onDone: () => void }) {
  const [name, setName] = useState(cls?.name ?? '');
  const [system, setSystem] = useState<RatingSystem>(cls?.ratingSystem ?? 'IRC');
  const [minutes, setMinutes] = useState(String(cls?.sequenceMinutes ?? 5));
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const out = await client.send({ type: 'saveClass', class: { id: cls?.id ?? newId('c'), name: name.trim(), ratingSystem: system, sequenceMinutes: Number(minutes) } });
        setBusy(false);
        if (out.ok) {
          if (!cls) {
            setName('');
            setMinutes('5');
          }
          onDone();
        }
      }}
    >
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Class name">
          <input className={inputClass} required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IRC 1" />
        </Field>
        <Field label="Rating system">
          <select className={inputClass} value={system} onChange={(e) => setSystem(e.target.value as RatingSystem)}>
            {SYSTEMS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Start sequence (minutes)" hint="Warning to start; RRS 26 is 5">
          <input className={inputClass} type="number" min={1} max={10} step={1} required value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" tone="primary" disabled={busy || !name.trim()}>{cls ? 'Save class' : 'Add class'}</Button>
        {cls && <Button tone="quiet" onClick={onDone}>Cancel</Button>}
      </div>
    </form>
  );
}

function BoatForm({ client, regatta, classId, boat, onDone, keepOpen }: { client: RegattaClient; regatta: RegattaState; classId: string; boat?: Boat; onDone: () => void; keepOpen?: boolean }) {
  const [sail, setSail] = useState(boat?.sailNumber ?? '');
  const [name, setName] = useState(boat?.name ?? '');
  const [cls, setCls] = useState(boat?.classId ?? classId);
  const [rating, setRating] = useState(boat ? String(boat.rating) : '');
  const [tracker, setTracker] = useState(boat?.trackerId ?? '');
  const [busy, setBusy] = useState(false);
  const system = regatta.classes[cls]?.ratingSystem;
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const id = boat?.id ?? newId('b');
        const out = await client.send({ type: 'saveBoat', boat: { id, classId: cls, sailNumber: sail.trim(), name: name.trim(), rating: Number(rating) } });
        let ok = out.ok;
        const t = tracker.trim();
        if (ok && t !== (boat?.trackerId ?? '')) ok = (await client.send({ type: 'bindTracker', boatId: id, trackerId: t || null })).ok;
        setBusy(false);
        if (!ok) return;
        if (keepOpen) {
          // Ready for the next boat
          setSail('');
          setName('');
          setTracker('');
        } else onDone();
      }}
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Sail number">
          <input className={inputClass} required autoCapitalize="characters" value={sail} onChange={(e) => setSail(e.target.value)} placeholder="e.g. MAS 1234" />
        </Field>
        <Field label="Boat name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={ratingLabel(system)} hint={ratingHint(system)}>
          <input className={inputClass} required inputMode="decimal" value={rating} onChange={(e) => setRating(e.target.value)} />
        </Field>
        {classes.length > 1 && (
          <Field label="Class">
            <select className={inputClass} value={cls} onChange={(e) => setCls(e.target.value)}>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Tracker ID (optional)" hint="The tracker on board, if it has one">
          <input className={inputClass} value={tracker} onChange={(e) => setTracker(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" tone="primary" disabled={busy || !sail.trim() || !rating.trim()}>{boat ? 'Save boat' : 'Add boat'}</Button>
        <Button tone="quiet" onClick={onDone}>{keepOpen ? 'Done' : 'Cancel'}</Button>
        {boat && (
          <ConfirmButton label="Remove boat" confirm={`Remove ${boat.sailNumber}`} onConfirm={() => void client.send({ type: 'removeBoat', boatId: boat.id }).then((o) => o.ok && onDone())} />
        )}
      </div>
    </form>
  );
}

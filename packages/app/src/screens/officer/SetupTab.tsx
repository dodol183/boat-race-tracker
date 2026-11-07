import { useCallback, useEffect, useState } from 'react';
import { activeRace, type Boat, type Course, type Fix, type LatLng, type RaceClass, type RatingSystem, type RegattaState } from '@brt/engine';
import type { RegattaClient } from '../../lib/client.ts';
import { useServerNow } from '../../lib/useRegatta.ts';
import { Button, Card, ConfirmButton, Field, Pill, inputClass } from '../../ui/kit.tsx';
import { MARK_LABELS, RaceMap } from '../../ui/RaceMap.tsx';

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const SYSTEMS: { id: RatingSystem; label: string }[] = [
  { id: 'IRC', label: 'IRC' },
  { id: 'ORC', label: 'ORC' },
  { id: 'PY', label: 'Portsmouth Yardstick (PY)' },
];
const ratingLabel = (s: RatingSystem | undefined) => (s === 'PY' ? 'Portsmouth Number' : 'Time correction factor (TCC)');
const ratingHint = (s: RatingSystem | undefined) => (s === 'PY' ? 'e.g. 1100' : 'e.g. 1.042');

export function SetupTab({ client, regatta, heard, tracks }: { client: RegattaClient; regatta: RegattaState; heard: { trackerId: string; at: number }[]; tracks: Record<string, Fix[]> }) {
  const classes = Object.values(regatta.classes).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-4">
      <ShareCard client={client} />
      <TrackersCard client={client} regatta={regatta} heard={heard} />
      <CourseCard client={client} regatta={regatta} tracks={tracks} />
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
        <Field label="Tracker ID (optional)" hint="A Meshtastic node ID such as !a1b2c3d4, or a skipper’s phone (phone-…)">
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

/** Who connects trackers, and radios heard that no boat has yet */
function TrackersCard({ client, regatta, heard }: { client: RegattaClient; regatta: RegattaState; heard: { trackerId: string; at: number }[] }) {
  const now = useServerNow(client, 5000);
  const allowed = regatta.options?.skippersConnectTrackers === true;
  const free = Object.values(regatta.boats)
    .filter((b) => !b.trackerId)
    .sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  const [pick, setPick] = useState<Record<string, string>>({});
  // Shown at once; the server's answer settles it (offline, it waits with the command)
  const [want, setWant] = useState<boolean | null>(null);
  useEffect(() => {
    if (want === allowed) setWant(null);
  }, [allowed, want]);
  return (
    <Card title="Trackers">
      <label className="flex items-start gap-3 min-h-11">
        <input
          type="checkbox"
          className="w-6 h-6 mt-1"
          checked={want ?? allowed}
          onChange={(e) => {
            const v = e.target.checked;
            setWant(v);
            void client.send({ type: 'setOptions', options: { skippersConnectTrackers: v } }).then((o) => !o.ok && setWant(null));
          }}
        />
        <span>
          <span className="font-semibold block">Skippers can connect their own phone or tracker</span>
          <span className="text-sm text-muted">With the skipper PIN, to a boat that has no tracker yet. Only you can change or remove one.</span>
        </span>
      </label>
      {heard.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold">Heard, not on a boat</h3>
          <ul className="divide-y divide-line border border-line rounded-lg">
            {heard.map((h) => (
              <li key={h.trackerId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="flex-1 min-w-0">
                  <span className="font-mono font-semibold">{h.trackerId}</span>
                  <span className="block text-sm text-muted">{Math.max(0, Math.round((now - h.at) / 60_000))} min ago</span>
                </span>
                <label className="sr-only" htmlFor={`heard-${h.trackerId}`}>Boat for {h.trackerId}</label>
                <select id={`heard-${h.trackerId}`} className="min-h-11 rounded-lg border border-line bg-canvas px-2" value={pick[h.trackerId] ?? ''} onChange={(e) => setPick({ ...pick, [h.trackerId]: e.target.value })}>
                  <option value="">Boat…</option>
                  {free.map((b) => <option key={b.id} value={b.id}>{b.sailNumber}</option>)}
                </select>
                <Button disabled={!pick[h.trackerId]} onClick={() => void client.send({ type: 'bindTracker', boatId: pick[h.trackerId]!, trackerId: h.trackerId })}>Connect</Button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">A relay hears every radio nearby. Positions are kept only for trackers on a boat.</p>
        </div>
      )}
    </Card>
  );
}

const START_MARKS: (keyof Course)[] = ['startPin', 'startCommittee', 'firstMark'];
const FINISH_MARKS: (keyof Course)[] = ['finishPin', 'finishCommittee'];

/** The start line, first mark and finish line: tap the map, or stand on the mark with this phone */
function CourseCard({ client, regatta, tracks }: { client: RegattaClient; regatta: RegattaState; tracks: Record<string, Fix[]> }) {
  const now = useServerNow(client, 5000);
  const saved = regatta.course ?? {};
  const savedJson = JSON.stringify(saved);
  const [draft, setDraft] = useState<Course>(saved);
  const [finishOnStart, setFinishOnStart] = useState(!saved.finishPin);
  const [picking, setPicking] = useState<keyof Course>('startPin');
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string>();
  // Another officer saving the course replaces this draft
  useEffect(() => {
    setDraft(saved);
    setFinishOnStart(!saved.finishPin);
  }, [savedJson]);

  const marks = finishOnStart ? START_MARKS : [...START_MARKS, ...FINISH_MARKS];
  const wanted: Course = Object.fromEntries(marks.filter((k) => draft[k]).map((k) => [k, draft[k]]));
  const changed = JSON.stringify(wanted) !== savedJson;

  const place = useCallback(
    (p: LatLng) => {
      setDraft((d) => {
        const next = { ...d, [picking]: p };
        // On to the next mark not yet placed
        const nextMark = marks.find((k) => !next[k]);
        if (nextMark) setPicking(nextMark);
        return next;
      });
    },
    [picking, finishOnStart]
  );

  const here = () => {
    if (!navigator.geolocation) return setProblem('This browser cannot read the phone’s position.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        if (pos.coords.accuracy > 30) setProblem(`GPS is only good to ±${Math.round(pos.coords.accuracy)} m here; placed anyway.`);
        else setProblem(undefined);
        place({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setProblem('Could not get this phone’s position. Allow location for this site, or tap the map.');
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }
    );
  };

  return (
    <Card title="Course" actions={changed ? <Pill tone="warn">Not saved</Pill> : saved.startPin ? <Pill tone="go">Saved</Pill> : <Pill tone="muted">Not set</Pill>}>
      <p className="text-sm text-muted">For GPS suggestions and the map. Choose a mark, then tap the map where it is, or stand on it with this phone.</p>
      <div role="group" aria-label="Mark to place" className="flex flex-wrap gap-2">
        {marks.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={picking === k}
            onClick={() => setPicking(k)}
            className={`min-h-11 px-3 rounded-lg font-semibold border ${picking === k ? 'bg-accent text-accent-ink border-accent' : 'bg-surface border-line'}`}
          >
            {draft[k] ? '✓ ' : ''}{MARK_LABELS[k]}
          </button>
        ))}
      </div>
      <RaceMap regatta={regatta} tracks={tracks} now={now} course={wanted} onPick={place} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={here} disabled={locating}>{locating ? 'Getting position…' : `${MARK_LABELS[picking]}: use this phone’s position`}</Button>
        {draft[picking] && <Button tone="quiet" onClick={() => setDraft((d) => { const { [picking]: _gone, ...rest } = d; return rest; })}>Clear {MARK_LABELS[picking]}</Button>}
      </div>
      <label className="flex items-center gap-3 min-h-11">
        <input
          type="checkbox"
          className="w-6 h-6"
          checked={finishOnStart}
          onChange={(e) => {
            setFinishOnStart(e.target.checked);
            if (!e.target.checked && !draft.finishPin) setPicking('finishPin');
            if (e.target.checked && FINISH_MARKS.includes(picking)) setPicking('startPin');
          }}
        />
        <span className="font-semibold">The finish line is the start line</span>
      </label>
      {problem && <p role="status" className="text-warn font-semibold">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={!changed} onClick={() => void client.send({ type: 'setCourse', course: wanted })}>Save course</Button>
        {changed && <Button tone="quiet" onClick={() => { setDraft(saved); setFinishOnStart(!saved.finishPin); }}>Undo changes</Button>}
      </div>
    </Card>
  );
}

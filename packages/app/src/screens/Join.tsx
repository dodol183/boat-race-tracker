import { useState } from 'react';
import { Button, Card, Field, inputClass } from '../ui/kit.tsx';
import { createRegatta, isNativeApp, serverOrigin, setServerOrigin, type CreatedRegatta } from '../lib/platform.ts';

export interface Joined {
  regattaId: string;
  pin?: string;
}

/** Enter the event code; a PIN makes you the race office (or a skipper), none makes you a spectator */
export function Join({ onJoin, initial, problem }: { onJoin: (j: Joined) => void; initial?: Joined; problem?: string }) {
  const [code, setCode] = useState(initial?.regattaId ?? '');
  const [pin, setPin] = useState(initial?.pin ?? '');
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  // In the app the pages are on the phone, so it needs the server's address
  const native = isNativeApp();
  const [server, setServer] = useState(() => (native ? serverOrigin() : ''));
  const [serverProblem, setServerProblem] = useState<string>();
  return (
    <main className="max-w-md mx-auto p-4 pt-10 space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold">Boat Race Tracker</h1>
        <p className="text-muted">Join a regatta with its event code.</p>
      </header>
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (native && !setServerOrigin(server)) return setServerProblem('Enter the server’s address, e.g. race.yourclub.org');
            if (clean) onJoin({ regattaId: clean, ...(pin.trim() ? { pin: pin.trim() } : {}) });
          }}
        >
          <Field label="Event code">
            <input className={`${inputClass} uppercase font-mono tracking-wider`} value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="off" placeholder="e.g. 3F9A21BC" />
          </Field>
          <Field label="PIN (optional)" hint="Race officers and skippers have a PIN. Leave it empty to watch.">
            <input className={`${inputClass} font-mono`} value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" />
          </Field>
          {native && (
            <Field label="Server" hint="Where the race office runs Boat Race Tracker">
              <input className={inputClass} value={server} onChange={(e) => { setServer(e.target.value); setServerProblem(undefined); }} inputMode="url" autoCapitalize="none" autoComplete="off" placeholder="race.yourclub.org" />
            </Field>
          )}
          {serverProblem && <p role="alert" className="text-stop font-semibold">{serverProblem}</p>}
          {problem && <p role="alert" className="text-stop font-semibold">{problem}</p>}
          <Button tone="primary" type="submit" disabled={!clean} className="w-full">Join</Button>
        </form>
      </Card>
      <NewRegatta
        beforeSend={() => {
          if (native && !setServerOrigin(server)) {
            setServerProblem('Enter the server’s address, e.g. race.yourclub.org');
            return false;
          }
          return true;
        }}
        onOpen={(r) => onJoin({ regattaId: r.id, pin: r.officerPin })}
      />
    </main>
  );
}

/** For whoever runs the server: a new regatta, with its code and PINs to hand out */
function NewRegatta({ beforeSend, onOpen }: { beforeSend: () => boolean; onOpen: (r: CreatedRegatta) => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [made, setMade] = useState<CreatedRegatta>();

  if (made) {
    return (
      <Card title={made.name}>
        <p>Write these down: the server won’t show the PINs again.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="text-muted">Event code</dt>
          <dd className="font-mono font-bold text-lg">{made.id}</dd>
          <dt className="text-muted">Race office PIN</dt>
          <dd className="font-mono font-bold text-lg">{made.officerPin}</dd>
          <dt className="text-muted">Skipper PIN</dt>
          <dd className="font-mono font-bold text-lg">{made.skipperPin}</dd>
        </dl>
        <p className="text-sm text-muted">The race office PIN runs the race: keep it to the race office. The skipper PIN shows again on the Setup tab.</p>
        <Button tone="primary" className="w-full" onClick={() => onOpen(made)}>Open as the race office</Button>
      </Card>
    );
  }
  if (!open) {
    return (
      <div className="text-center">
        <Button tone="quiet" onClick={() => setOpen(true)}>Run a new regatta</Button>
      </div>
    );
  }
  return (
    <Card title="Run a new regatta">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!beforeSend()) return;
          setBusy(true);
          setProblem(undefined);
          const r = await createRegatta(token, name.trim());
          setBusy(false);
          if (r.ok) setMade(r.regatta);
          else setProblem(r.message);
        }}
      >
        <Field label="Regatta name">
          <input className={inputClass} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Club Race Saturday" />
        </Field>
        <Field label="Admin token" hint="Set as ADMIN_TOKEN when the server was installed">
          <input className={`${inputClass} font-mono`} type="password" required value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
        {problem && <p role="alert" className="text-stop font-semibold">{problem}</p>}
        <div className="flex gap-2">
          <Button tone="primary" type="submit" disabled={busy || !name.trim() || !token.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
          <Button tone="quiet" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

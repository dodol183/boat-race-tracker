import { useState } from 'react';
import { Button, Card, Field, inputClass } from '../ui/kit.tsx';
import { isNativeApp, serverOrigin, setServerOrigin } from '../lib/platform.ts';

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
    </main>
  );
}

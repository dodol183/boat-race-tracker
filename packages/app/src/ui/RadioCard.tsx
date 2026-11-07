// Connect a Meshtastic radio over Bluetooth and relay what it hears: the radio on a skipper's boat,
// or a base radio at the race office that hears the fleet.
import { useState, useSyncExternalStore } from 'react';
import type { RegattaState } from '@brt/engine';
import type { RegattaClient } from '../lib/client.ts';
import type { MeshtasticRelay } from '../lib/meshtastic/relay.ts';
import { bluetoothAvailable } from '../lib/meshtastic/bleLink.ts';
import { isNativeApp } from '../lib/platform.ts';
import { Button, Card, Field, Pill, inputClass } from './kit.tsx';

const STATE_LABEL = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  configuring: 'Reading the radio…',
  connected: 'Relaying',
  reconnecting: 'Reconnecting…',
  lost: 'Connection lost',
} as const;

export function RadioCard({ client, regatta, relay, officer }: { client: RegattaClient; regatta: RegattaState; relay: MeshtasticRelay; officer: boolean }) {
  const s = useSyncExternalStore(relay.subscribe, relay.getStatus);
  const [choice, setChoice] = useState('');
  const native = isNativeApp();
  const onBoat = s.radioId ? Object.values(regatta.boats).find((b) => b.trackerId === s.radioId) : undefined;
  const free = Object.values(regatta.boats)
    .filter((b) => !b.trackerId)
    .sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  const canClaim = officer || regatta.options?.skippersConnectTrackers === true;
  const busy = s.state === 'connecting' || s.state === 'configuring' || s.state === 'reconnecting';

  return (
    <Card title="Meshtastic radio" actions={<Pill tone={s.state === 'connected' ? 'go' : s.state === 'lost' ? 'stop' : busy ? 'warn' : 'muted'}>{STATE_LABEL[s.state]}</Pill>}>
      {!bluetoothAvailable(native) ? (
        <p className="text-muted">This browser has no Bluetooth. Use Chrome on Android or on a computer, or the Android app.</p>
      ) : s.state === 'idle' || s.state === 'lost' ? (
        <>
          <p className="text-sm text-muted">
            {officer
              ? 'A radio at the race office passes on every boat’s tracker it hears.'
              : 'Connect the Meshtastic tracker on your boat. Its positions, and those of boats it hears, go to the race office.'}
          </p>
          <Button tone="primary" onClick={() => void relay.start()}>Connect a radio</Button>
        </>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted">Radio</dt>
            <dd>{s.deviceName ?? '–'}{s.radioId && <span className="font-mono text-sm text-muted"> {s.radioId}</span>}</dd>
            <dt className="text-muted">Heard</dt>
            <dd>{s.heard} other radio{s.heard === 1 ? '' : 's'}</dd>
            <dt className="text-muted">Passed on</dt>
            <dd>{s.sent} position{s.sent === 1 ? '' : 's'}</dd>
          </dl>
          <Button onClick={() => void relay.stop()}>{busy ? 'Cancel' : 'Disconnect'}</Button>
        </>
      )}
      {s.error && <p role="alert" className="text-stop font-semibold">{s.error}</p>}

      {s.state === 'connected' && s.radioId && (
        onBoat ? (
          <p>This radio is on <span className="font-semibold">{onBoat.sailNumber}</span>.</p>
        ) : canClaim && free.length > 0 ? (
          <form
            className="space-y-2 pt-2 border-t border-line"
            onSubmit={(e) => {
              e.preventDefault();
              if (choice) void client.send(officer ? { type: 'bindTracker', boatId: choice, trackerId: s.radioId! } : { type: 'claimTracker', boatId: choice, trackerId: s.radioId! });
            }}
          >
            <Field label={officer ? 'Put this radio on a boat (optional)' : 'Your boat'} hint={officer ? 'Leave it off if it stays at the race office.' : undefined}>
              <select className={inputClass} value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose…</option>
                {free.map((b) => <option key={b.id} value={b.id}>{b.sailNumber}{b.name ? ` · ${b.name}` : ''}</option>)}
              </select>
            </Field>
            <Button type="submit" disabled={!choice}>Put radio on this boat</Button>
          </form>
        ) : !canClaim ? (
          <p className="text-sm text-muted">Ask the race office to put radio {s.radioId} on your boat.</p>
        ) : null
      )}
      {s.state === 'connected' && (
        <p className="text-sm text-muted">
          {native
            ? 'With the screen off, Android keeps the app running while it shares this phone’s position.'
            : 'Keep this page open: relaying stops if the browser closes or the phone locks.'}
        </p>
      )}
    </Card>
  );
}

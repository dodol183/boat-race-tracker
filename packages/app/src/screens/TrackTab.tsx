import { useState, useSyncExternalStore } from 'react';
import type { RegattaState } from '@brt/engine';
import type { RegattaClient } from '../lib/client.ts';
import type { GpsSource } from '../lib/phoneGps.ts';
import type { MeshtasticRelay } from '../lib/meshtastic/relay.ts';
import { RadioCard } from '../ui/RadioCard.tsx';
import { clock } from '../lib/format.ts';
import { Button, Card, ConfirmButton, Field, Pill, inputClass } from '../ui/kit.tsx';

/** A skipper sharing this phone's position for their boat */
export function TrackTab({ client, regatta, gps, relay, fixesWaiting, shareProblem }: { client: RegattaClient; regatta: RegattaState; gps: GpsSource; relay: MeshtasticRelay; fixesWaiting: number; shareProblem: string | null }) {
  const status = useSyncExternalStore(gps.subscribe, gps.getStatus);
  const me = client.phoneTrackerId;
  const myBoat = Object.values(regatta.boats).find((b) => b.trackerId === me);
  const free = Object.values(regatta.boats)
    .filter((b) => !b.trackerId)
    .sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const allowed = regatta.options?.skippersConnectTrackers === true;

  if (!myBoat) {
    return (
      <div className="space-y-4">
      <Card title="Share this phone’s position">
        {allowed ? (
          free.length === 0 ? (
            <p className="text-muted">Every boat already has a tracker. Ask the race office if yours is wrong.</p>
          ) : (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!choice) return;
                setBusy(true);
                await client.send({ type: 'claimTracker', boatId: choice, trackerId: me });
                setBusy(false);
              }}
            >
              <Field label="Your boat">
                <select className={inputClass} value={choice} onChange={(e) => setChoice(e.target.value)} required>
                  <option value="">Choose…</option>
                  {free.map((b) => (
                    <option key={b.id} value={b.id}>{b.sailNumber}{b.name ? ` · ${b.name}` : ''}</option>
                  ))}
                </select>
              </Field>
              <Button type="submit" tone="primary" disabled={!choice || busy}>Connect this phone</Button>
            </form>
          )
        ) : (
          <p>The race office connects phones in this event. Ask them to connect this phone to your boat; its tracker ID is <span className="font-mono font-bold">{me}</span>.</p>
        )}
      </Card>
      <RadioCard client={client} regatta={regatta} relay={relay} officer={false} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card title={`${myBoat.sailNumber}${myBoat.name ? ` · ${myBoat.name}` : ''}`} actions={status.sharing ? <Pill tone="go">Sharing</Pill> : <Pill tone="muted">Not sharing</Pill>}>
        {status.sharing ? (
          <Button tone="secondary" onClick={() => gps.stop()}>Stop sharing</Button>
        ) : (
          <Button tone="primary" disabled={!gps.available()} onClick={() => gps.start(me)}>Start sharing my position</Button>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Last position</dt>
          <dd>{status.last ? `${clock(status.last.fixTime)} (±${status.last.accuracyM} m)` : '–'}</dd>
          {status.last?.speedKt !== undefined && (
            <>
              <dt className="text-muted">Speed</dt>
              <dd className="font-mono">{status.last.speedKt.toFixed(1)} kn</dd>
            </>
          )}
          <dt className="text-muted">Waiting to send</dt>
          <dd>{fixesWaiting === 0 ? 'Nothing' : `${fixesWaiting} position${fixesWaiting === 1 ? '' : 's'} (sent when there is signal)`}</dd>
        </dl>
        {status.problem && <p role="alert" className="text-stop font-semibold">{status.problem}</p>}
        {shareProblem && <p role="alert" className="text-stop font-semibold">{shareProblem}</p>}
        {status.needsSettings && gps.openSettings && <Button onClick={() => gps.openSettings!()}>Open the app’s settings</Button>}
        {status.sharing && (
          <p className="text-sm text-muted">
            {status.background
              ? 'Sharing carries on with the screen off. A notification shows while it does.'
              : `${status.screenKeptOn ? 'The screen stays on while sharing.' : 'Keep the screen on.'} In a browser, sharing stops when the phone locks; the Android app keeps going with the screen off.`}
          </p>
        )}
      </Card>
      <RadioCard client={client} regatta={regatta} relay={relay} officer={false} />
      <ConfirmButton
        label="Disconnect this phone"
        confirm={`Disconnect from ${myBoat.sailNumber}`}
        onConfirm={() => {
          gps.stop();
          void client.send({ type: 'releaseTracker', boatId: myBoat.id, trackerId: me });
        }}
      />
    </div>
  );
}

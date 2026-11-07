import { isFixLive, type Fix, type RegattaState } from '@brt/engine';
import type { RegattaClient } from '../../lib/client.ts';
import { useServerNow } from '../../lib/useRegatta.ts';
import { Card, Pill } from '../../ui/kit.tsx';
import { RaceMap } from '../../ui/RaceMap.tsx';
import { RadioCard } from '../../ui/RadioCard.tsx';
import type { MeshtasticRelay } from '../../lib/meshtastic/relay.ts';

/** The course and the boats, and which boats are being tracked: the check before a start */
export function MapTab({ client, regatta, tracks, relay }: { client: RegattaClient; regatta: RegattaState; tracks: Record<string, Fix[]>; relay: MeshtasticRelay }) {
  const now = useServerNow(client, 1000);
  const boats = Object.values(regatta.boats).sort((a, b) => a.sailNumber.localeCompare(b.sailNumber, undefined, { numeric: true }));
  return (
    <div className="space-y-4">
      <RaceMap regatta={regatta} tracks={tracks} now={now} className="h-[60vh] min-h-80" />
      <Card title="Tracking">
        {boats.length === 0 ? (
          <p className="text-muted">No boats yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {boats.map((b) => {
              const last = b.trackerId ? tracks[b.trackerId]?.at(-1) : undefined;
              const ago = last ? Math.round((now - last.fixTime) / 1000) : undefined;
              return (
                <li key={b.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1 min-w-0">
                    <span className="font-semibold">{b.sailNumber}</span> <span className="text-muted text-sm">{b.name}</span>
                    <span className="block text-sm text-muted">{b.trackerId ? (b.trackerId.startsWith('phone-') ? 'Skipper’s phone' : `Tracker ${b.trackerId}`) : 'No tracker'}</span>
                  </span>
                  {!b.trackerId ? (
                    <Pill tone="muted">Not tracked</Pill>
                  ) : !last || !isFixLive(last, now) ? (
                    <Pill tone="stop">No position</Pill>
                  ) : (
                    <span className="text-right">
                      <Pill tone={ago! > 120 ? 'warn' : 'go'}>{ago! < 60 ? `${ago} s ago` : `${Math.round(ago! / 60)} min ago`}</Pill>
                      {last.speedKt !== undefined && <span className="block text-sm text-muted font-mono">{last.speedKt.toFixed(1)} kn</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-sm text-muted">LoRa trackers report about every 30 seconds; phones every few seconds.</p>
      </Card>
      <RadioCard client={client} regatta={regatta} relay={relay} officer />
    </div>
  );
}

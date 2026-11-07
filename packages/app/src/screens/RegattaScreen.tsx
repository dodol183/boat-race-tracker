import { useEffect, useMemo, useState } from 'react';
import { useRegatta } from '../lib/useRegatta.ts';
import type { Joined } from './Join.tsx';
import { Button, Pill } from '../ui/kit.tsx';
import { StartTab } from './officer/StartTab.tsx';
import { FinishesTab } from './officer/FinishesTab.tsx';
import { ResultsTab } from './ResultsTab.tsx';
import { SetupTab } from './officer/SetupTab.tsx';
import { LiveTab } from './LiveTab.tsx';
import { TrackTab } from './TrackTab.tsx';
import { MapTab } from './officer/MapTab.tsx';
import { PhoneGps } from '../lib/phoneGps.ts';

type Tab = 'start' | 'finishes' | 'map' | 'results' | 'setup' | 'live' | 'track';

const OFFICER_TABS: { id: Tab; label: string }[] = [
  { id: 'start', label: 'Start' },
  { id: 'finishes', label: 'Finishes' },
  { id: 'map', label: 'Map' },
  { id: 'results', label: 'Results' },
  { id: 'setup', label: 'Setup' },
];
const SKIPPER_TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'track', label: 'Track' },
  { id: 'results', label: 'Results' },
];
const WATCH_TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'results', label: 'Results' },
];

export function RegattaScreen({ joined, onLeave }: { joined: Joined; onLeave: (why?: string) => void }) {
  const { client, snap } = useRegatta(joined.regattaId, joined.pin);
  const officer = snap.role === 'OFFICER';
  const tabs = officer ? OFFICER_TABS : snap.role === 'SKIPPER' ? SKIPPER_TABS : WATCH_TABS;
  // One GPS per joined regatta, so sharing carries on while other tabs are open
  const gps = useMemo(() => new PhoneGps(client), [client]);
  useEffect(() => () => gps.stop(), [gps]);
  const [tab, setTab] = useState<Tab>(officer ? 'start' : 'live');

  // A wrong code or PIN: back to the join screen, saying why
  useEffect(() => {
    if (snap.status === 'failed') onLeave(snap.notice?.message);
  }, [snap.status]);
  // The role arrives with welcome: show that role's first tab
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(tabs[0]!.id);
  }, [snap.role]);

  const status = {
    connecting: <Pill tone="muted">Connecting…</Pill>,
    live: <Pill tone="go">Live</Pill>,
    offline: <Pill tone="warn">Offline</Pill>,
    failed: <Pill tone="stop">Not joined</Pill>,
  }[snap.status];

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-surface border-b border-line px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold truncate">{snap.name || 'Regatta'}</h1>
          <p className="text-sm text-muted">
            <span className="font-mono">{snap.regattaId}</span> · {officer ? 'Race office' : snap.role === 'SKIPPER' ? 'Skipper' : 'Spectator'}
          </p>
        </div>
        {snap.pending.length > 0 && (
          // Its own line on a phone, so the regatta name keeps its room
          <span className="order-last basis-full sm:order-none sm:basis-auto">
            <Pill tone="warn">{snap.pending.length} waiting to send</Pill>
          </span>
        )}
        {status}
        <Button tone="quiet" onClick={() => onLeave()}>Leave</Button>
      </header>

      {snap.status === 'offline' && (
        <p role="status" className="px-4 py-2 bg-surface border-b border-line text-warn font-semibold">
          No connection. What you do is kept on this device and sent when the connection is back.
        </p>
      )}
      {snap.notice?.kind === 'refused' && (
        <div role="alert" className="mx-4 mt-3 p-3 rounded-lg border border-stop bg-surface flex items-start gap-3">
          <p className="flex-1 text-stop font-semibold">{snap.notice.message}</p>
          <Button tone="quiet" onClick={() => client.dismissNotice()}>Dismiss</Button>
        </div>
      )}

      <nav role="tablist" aria-label="Sections" className="flex gap-1 px-4 pt-3 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`min-h-11 px-2.5 text-sm sm:px-4 sm:text-base rounded-full font-semibold shrink-0 ${tab === t.id ? 'bg-accent text-accent-ink' : 'bg-surface border border-line'}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 p-4 max-w-4xl w-full mx-auto">
        {!snap.regatta ? (
          <p className="text-muted">Loading the regatta…</p>
        ) : tab === 'start' ? (
          <StartTab client={client} regatta={snap.regatta} over={snap.suggestions.over} />
        ) : tab === 'finishes' ? (
          <FinishesTab client={client} regatta={snap.regatta} pending={snap.pending} suggested={snap.suggestions.finishes} />
        ) : tab === 'map' ? (
          <MapTab client={client} regatta={snap.regatta} tracks={snap.tracks} />
        ) : tab === 'setup' ? (
          <SetupTab client={client} regatta={snap.regatta} heard={snap.heard} tracks={snap.tracks} />
        ) : tab === 'results' ? (
          <ResultsTab client={client} regatta={snap.regatta} />
        ) : tab === 'track' ? (
          <TrackTab client={client} regatta={snap.regatta} gps={gps} fixesWaiting={snap.fixesWaiting} shareProblem={snap.shareProblem} />
        ) : (
          <LiveTab client={client} regatta={snap.regatta} tracks={snap.tracks} />
        )}
      </main>
    </div>
  );
}

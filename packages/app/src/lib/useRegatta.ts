// React glue for RegattaClient: one connection per joined regatta, and a ticking clock.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RegattaClient } from './client.ts';
import { isNativeApp, postFixes, socketUrl } from './platform.ts';

export function safeStorage(): Storage | null {
  try {
    const k = '__brt_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}

export function useRegatta(regattaId: string, pin: string | undefined) {
  const client = useMemo(
    () =>
      new RegattaClient({
        url: socketUrl(),
        regattaId,
        storage: safeStorage(),
        ...(pin ? { pin, postFixes: (trackerId, fixes, secret) => postFixes(regattaId, pin, trackerId, fixes, secret) } : {}),
      }),
    [regattaId, pin]
  );
  useEffect(() => {
    client.connect();
    const lost = () => client.networkLost();
    const back = () => client.networkBack();
    // In the background the app's socket is throttled; positions go by native HTTP instead
    const visibility = () => isNativeApp() && client.setFixesOverHttp(document.visibilityState === 'hidden');
    window.addEventListener('offline', lost);
    window.addEventListener('online', back);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('offline', lost);
      window.removeEventListener('online', back);
      document.removeEventListener('visibilitychange', visibility);
      client.close();
    };
  }, [client]);
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return { client, snap };
}

/** The server's time, re-read every `ms` (a countdown needs 250 ms) */
export function useServerNow(client: RegattaClient, ms = 250): number {
  const [now, setNow] = useState(() => client.serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(client.serverNow()), ms);
    return () => clearInterval(t);
  }, [client, ms]);
  return now;
}

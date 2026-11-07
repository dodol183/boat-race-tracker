// React glue for RegattaClient: one connection per joined regatta, and a ticking clock.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RegattaClient } from './client.ts';

export function socketUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}/ws`;
}

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
  const client = useMemo(() => new RegattaClient({ url: socketUrl(), regattaId, ...(pin ? { pin } : {}), storage: safeStorage() }), [regattaId, pin]);
  useEffect(() => {
    client.connect();
    const lost = () => client.networkLost();
    const back = () => client.networkBack();
    window.addEventListener('offline', lost);
    window.addEventListener('online', back);
    return () => {
      window.removeEventListener('offline', lost);
      window.removeEventListener('online', back);
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

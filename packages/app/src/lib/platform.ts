// Website or Android app. On the website the server is the site itself; in the app the pages are
// on the phone, so the server's address comes from the build (VITE_SERVER_URL) or the join screen.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { Fix } from '@brt/engine';

export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

const SERVER_KEY = 'brt:server';

/** The server's address, e.g. https://race.example.org (no trailing slash) */
export function serverOrigin(): string {
  if (!isNativeApp()) return window.location.origin;
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    if (saved) return saved;
  } catch {}
  return (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/+$/, '');
}

/** Checks and keeps the server address typed in the app; returns it cleaned, or null if unusable */
export function setServerOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
  const origin = url.origin;
  try {
    localStorage.setItem(SERVER_KEY, origin);
  } catch {}
  return origin;
}

export function socketUrl(): string {
  const origin = serverOrigin();
  return `${origin.replace(/^http/i, 'ws')}/ws`;
}

/**
 * Sends positions over plain HTTP, for when the socket is down or the app is in the background
 * (Android throttles the WebView's own requests there; the app's native HTTP isn't).
 */
export async function postFixes(regattaId: string, pin: string, trackerId: string, fixes: Fix[]): Promise<{ ok: boolean; status: number; accepted?: number; unbound?: boolean; error?: string }> {
  const url = `${serverOrigin()}/api/regattas/${encodeURIComponent(regattaId)}/positions`;
  const headers = { 'content-type': 'application/json', 'x-regatta-pin': pin };
  try {
    if (isNativeApp()) {
      const r = await CapacitorHttp.post({ url, headers, data: { trackerId, fixes }, connectTimeout: 15_000, readTimeout: 15_000 });
      const body = typeof r.data === 'string' ? safeJson(r.data) : r.data;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, ...body };
    }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ trackerId, fixes }) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...body };
  } catch {
    return { ok: false, status: 0 };
  }
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

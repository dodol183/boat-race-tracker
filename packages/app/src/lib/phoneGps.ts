// This phone sharing its own GPS. The website uses the browser's geolocation, which stops when the
// screen locks or the browser goes to the background; the Android app (phase 4b) puts a
// background service behind the same interface.
import type { Fix } from '@brt/engine';
import type { RegattaClient } from './client.ts';

export interface GpsStatus {
  sharing: boolean;
  /** The last position taken, on the server's clock */
  last?: Fix & { accuracyM: number };
  /** In words, for the skipper */
  problem?: string;
  /** The screen is kept on while sharing (the website stops when it locks) */
  screenKeptOn: boolean;
  /** Keeps sharing with the screen off (the Android app) */
  background?: boolean;
  /** The fix is in the phone's settings (location not allowed) */
  needsSettings?: boolean;
}

/** This phone's GPS, from the browser or the Android app */
export interface GpsSource {
  subscribe(l: () => void): () => void;
  getStatus(): GpsStatus;
  available(): boolean;
  start(trackerId: string): void | Promise<void>;
  stop(): void;
  openSettings?(): void;
}

/** One fix at most this often: plenty for a boat, light on battery and data */
const MIN_INTERVAL_MS = 3000;
/** Fixes are sent in small batches */
const SEND_EVERY_MS = 5000;
/** A fix worse than this is not used */
const MAX_ACCURACY_M = 50;
const MS_TO_KT = 1.943844;

type WakeLock = { release(): Promise<void>; addEventListener?(t: string, fn: () => void): void };

export class PhoneGps implements GpsSource {
  private status: GpsStatus = { sharing: false, screenKeptOn: false };
  private listeners = new Set<() => void>();
  private watchId: number | null = null;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private batch: Fix[] = [];
  private lastTaken = 0;
  private wake: WakeLock | null = null;
  private trackerId = '';

  constructor(private client: RegattaClient) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getStatus = () => this.status;

  static available(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }
  available = () => PhoneGps.available();

  start(trackerId: string) {
    if (this.status.sharing) return;
    if (!PhoneGps.available()) return this.set({ problem: 'This browser cannot read the phone’s position.' });
    this.trackerId = trackerId;
    this.set({ sharing: true, problem: undefined });
    this.watchId = navigator.geolocation.watchPosition((p) => this.take(p), (e) => this.failed(e), { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
    this.sendTimer = setInterval(() => this.flush(), SEND_EVERY_MS);
    void this.keepScreenOn();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.sendTimer = null;
    this.flush();
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.wake?.release().catch(() => {});
    this.wake = null;
    this.set({ sharing: false, screenKeptOn: false });
  }

  private take(p: GeolocationPosition) {
    const c = p.coords;
    if (c.accuracy > MAX_ACCURACY_M) return this.set({ problem: `Waiting for a better GPS fix (±${Math.round(c.accuracy)} m).` });
    // The phone's clock may be off; times are kept on the server's clock
    const fixTime = Math.round(this.client.serverNow() - (Date.now() - p.timestamp));
    if (fixTime - this.lastTaken < MIN_INTERVAL_MS) return;
    this.lastTaken = fixTime;
    const fix: Fix = { lat: c.latitude, lng: c.longitude, fixTime };
    if (c.speed !== null && Number.isFinite(c.speed)) fix.speedKt = Math.round(c.speed * MS_TO_KT * 10) / 10;
    if (c.heading !== null && Number.isFinite(c.heading)) fix.headingDeg = Math.round(c.heading);
    this.batch.push(fix);
    this.set({ last: { ...fix, accuracyM: Math.round(c.accuracy) }, problem: undefined });
  }

  private failed(e: GeolocationPositionError) {
    const problem =
      e.code === e.PERMISSION_DENIED
        ? 'Location is blocked for this site. Allow it in the browser settings, then try again.'
        : e.code === e.TIMEOUT
          ? 'No GPS fix yet. Keep the phone where it can see the sky.'
          : 'The phone could not get its position.';
    if (e.code === e.PERMISSION_DENIED) this.stop();
    this.set({ problem });
  }

  private flush() {
    if (this.batch.length === 0) return;
    this.client.shareFixes(this.trackerId, this.batch);
    this.batch = [];
  }

  private async keepScreenOn() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<WakeLock> } }).wakeLock;
    if (!wl || !this.status.sharing) return;
    try {
      this.wake = await wl.request('screen');
      this.wake.addEventListener?.('release', () => this.set({ screenKeptOn: false }));
      this.set({ screenKeptOn: true });
    } catch {
      this.set({ screenKeptOn: false });
    }
  }

  /** The browser drops the wake lock when the page is hidden; take it again on return */
  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.status.sharing) void this.keepScreenOn();
  };

  private set(patch: Partial<GpsStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }
}

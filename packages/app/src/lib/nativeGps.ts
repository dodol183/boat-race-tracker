// The Android app sharing the phone's GPS with the screen off: a foreground service with a
// notification (@capacitor-community/background-geolocation). Same interface as PhoneGps.
import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { BackgroundGeolocationPlugin, Location } from '@capacitor-community/background-geolocation';
import type { Fix } from '@brt/engine';
import type { RegattaClient } from './client.ts';
import type { GpsSource, GpsStatus } from './phoneGps.ts';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

const MIN_INTERVAL_MS = 3000;
const SEND_EVERY_MS = 5000;
const MAX_ACCURACY_M = 50;
const MS_TO_KT = 1.943844;

export class NativeGps implements GpsSource {
  private status: GpsStatus = { sharing: false, screenKeptOn: false, background: true };
  private listeners = new Set<() => void>();
  private watcher: string | null = null;
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private batch: Fix[] = [];
  private lastTaken = 0;
  private trackerId = '';

  constructor(private client: RegattaClient) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getStatus = () => this.status;
  available = () => true;

  async start(trackerId: string) {
    if (this.status.sharing) return;
    this.trackerId = trackerId;
    this.set({ sharing: true, problem: undefined });
    // Android 13+: without this the "sharing your position" notification doesn't show
    await LocalNotifications.requestPermissions().catch(() => {});
    try {
      this.watcher = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: 'Sharing your boat’s position',
          backgroundMessage: 'Boat Race Tracker keeps sending your position while you race. Stop sharing in the app.',
          requestPermissions: true,
          stale: false,
          distanceFilter: 0,
        },
        (loc, err) => (err ? this.failed(err.code, err.message) : loc && this.take(loc))
      );
    } catch (e) {
      this.failed(undefined, String((e as Error)?.message ?? e));
      return;
    }
    this.sendTimer = setInterval(() => this.flush(), SEND_EVERY_MS);
  }

  stop() {
    if (this.watcher) void BackgroundGeolocation.removeWatcher({ id: this.watcher }).catch(() => {});
    this.watcher = null;
    if (this.sendTimer) clearInterval(this.sendTimer);
    this.sendTimer = null;
    this.flush();
    this.set({ sharing: false });
  }

  openSettings() {
    void BackgroundGeolocation.openSettings();
  }

  private take(loc: Location) {
    if (loc.accuracy > MAX_ACCURACY_M) return this.set({ problem: `Waiting for a better GPS fix (±${Math.round(loc.accuracy)} m).` });
    const taken = loc.time ?? Date.now();
    // The phone's clock may be off; times are kept on the server's clock
    const fixTime = Math.round(this.client.serverNow() - (Date.now() - taken));
    if (fixTime - this.lastTaken < MIN_INTERVAL_MS) return;
    this.lastTaken = fixTime;
    const fix: Fix = { lat: loc.latitude, lng: loc.longitude, fixTime };
    if (loc.speed !== null && Number.isFinite(loc.speed)) fix.speedKt = Math.round(loc.speed * MS_TO_KT * 10) / 10;
    if (loc.bearing !== null && Number.isFinite(loc.bearing)) fix.headingDeg = Math.round(loc.bearing);
    this.batch.push(fix);
    this.set({ last: { ...fix, accuracyM: Math.round(loc.accuracy) }, problem: undefined });
  }

  private failed(code: string | undefined, message: string) {
    if (code === 'NOT_AUTHORIZED') {
      this.stop();
      return this.set({ problem: 'Location is not allowed for this app. Allow it (“Allow all the time” keeps sharing with the screen off), then start again.', needsSettings: true });
    }
    this.set({ problem: message || 'The phone could not get its position.' });
  }

  private flush() {
    if (this.batch.length === 0) return;
    this.client.shareFixes(this.trackerId, this.batch);
    this.batch = [];
  }

  private set(patch: Partial<GpsStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }
}

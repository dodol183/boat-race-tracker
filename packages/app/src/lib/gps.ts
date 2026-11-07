// This phone's GPS: the Android app's background service, or the browser's geolocation.
import type { RegattaClient } from './client.ts';
import { isNativeApp } from './platform.ts';
import { NativeGps } from './nativeGps.ts';
import { PhoneGps, type GpsSource } from './phoneGps.ts';

export function createGps(client: RegattaClient): GpsSource {
  return isNativeApp() ? new NativeGps(client) : new PhoneGps(client);
}

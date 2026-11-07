// The Bluetooth link to a Meshtastic radio, through @capacitor-community/bluetooth-le: native
// Bluetooth in the Android app, Web Bluetooth in Chrome (Android, Windows, macOS, ChromeOS).
import { BleClient } from '@capacitor-community/bluetooth-le';
import type { RadioLink } from './relay.ts';

export const MESHTASTIC_SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const FROM_RADIO = '2c55e69e-4993-11ed-b878-0242ac120002'; // read: one FromRadio per read, empty when drained
const TO_RADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7'; // write: one ToRadio per write
const FROM_NUM = 'ed9da18c-a800-4f66-a670-aa7547e34453'; // notify: data is waiting

const LAST_RADIO = 'brt:last-radio';
let initialized = false;

/** Whether this device can reach a radio over Bluetooth at all */
export function bluetoothAvailable(isNative: boolean): boolean {
  return isNative || (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
}

/**
 * Opens a link to a radio. `again` reconnects to the last one without asking, where the platform
 * allows; otherwise the person picks from the radios nearby.
 */
export async function openRadio(again: boolean): Promise<RadioLink> {
  if (!initialized) {
    await BleClient.initialize();
    initialized = true;
  }
  if (!(await BleClient.isEnabled().catch(() => true))) {
    await BleClient.requestEnable().catch(() => {});
  }
  let device: { deviceId: string; name?: string } | undefined;
  if (again) {
    const last = remembered();
    if (last) device = (await BleClient.getDevices([last.deviceId]).catch(() => []))[0] ?? last;
  }
  device ??= await BleClient.requestDevice({ services: [MESHTASTIC_SERVICE] });
  const id = device.deviceId;
  const name = device.name || 'Meshtastic radio';
  remember({ deviceId: id, name });

  let dropped: (() => void) | null = null;
  await BleClient.connect(id, () => dropped?.(), { timeout: 15_000 });
  const toView = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    name,
    write: (bytes) => BleClient.write(id, MESHTASTIC_SERVICE, TO_RADIO, toView(bytes)),
    read: async () => {
      const dv = await BleClient.read(id, MESHTASTIC_SERVICE, FROM_RADIO);
      return new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    },
    notify: async (cb) => {
      await BleClient.startNotifications(id, MESHTASTIC_SERVICE, FROM_NUM, () => cb());
      return true;
    },
    onDisconnect: (cb) => {
      dropped = cb;
    },
    close: async () => {
      dropped = null;
      await BleClient.stopNotifications(id, MESHTASTIC_SERVICE, FROM_NUM).catch(() => {});
      await BleClient.disconnect(id).catch(() => {});
    },
  };
}

function remembered(): { deviceId: string; name: string } | null {
  try {
    const raw = localStorage.getItem(LAST_RADIO);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function remember(d: { deviceId: string; name: string }) {
  try {
    localStorage.setItem(LAST_RADIO, JSON.stringify(d));
  } catch {}
}

// Messages between devices and the server, over one WebSocket per device. JSON, one object per
// message, `t` says which.
import type { Command, RegattaState } from '@brt/engine';
import type { Role } from './hub.ts';
import type { StoredEvent } from './store.ts';

export type ClientMessage =
  /** Join a regatta. `pin` sets the role; `lastSeq` asks for only the events after it */
  | { t: 'hello'; regattaId: string; pin?: string; lastSeq?: number }
  /** `id` is unique per command, chosen by the device, so a resend is recognised */
  | { t: 'command'; id: string; command: Command }
  /** The device saw a gap in event numbers: send the whole state again */
  | { t: 'resync' }
  | { t: 'ping'; clientTime: number };

export type ServerMessage =
  | { t: 'welcome'; regattaId: string; name: string; role: Role; /** Only to the race office, to share with skippers */ skipperPin?: string; seq: number; serverTime: number; state?: RegattaState; events?: StoredEvent[] }
  | { t: 'events'; events: StoredEvent[] }
  | { t: 'result'; id: string; ok: true; seq: number; duplicate?: boolean }
  | { t: 'result'; id: string; ok: false; error: { code: string; message: string }; duplicate?: boolean }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

const COMMAND_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A message from a device, checked for shape (the engine checks the meaning) */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'hello':
      if (typeof m.regattaId !== 'string' || !m.regattaId) return null;
      return {
        t: 'hello',
        regattaId: m.regattaId.trim().toUpperCase(),
        ...(typeof m.pin === 'string' && m.pin ? { pin: m.pin.trim() } : {}),
        ...(Number.isInteger(m.lastSeq) && m.lastSeq >= 0 ? { lastSeq: m.lastSeq } : {}),
      };
    case 'command':
      if (typeof m.id !== 'string' || !COMMAND_ID.test(m.id)) return null;
      if (!m.command || typeof m.command !== 'object' || typeof m.command.type !== 'string') return null;
      return { t: 'command', id: m.id, command: m.command };
    case 'resync':
      return { t: 'resync' };
    case 'ping':
      return typeof m.clientTime === 'number' ? { t: 'ping', clientTime: m.clientTime } : null;
    default:
      return null;
  }
}

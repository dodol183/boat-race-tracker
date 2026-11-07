// Messages between devices and the server, over one WebSocket per device. JSON, one object per
// message, `t` says which.
import type { Command, Fix, FinishSuggestion, OverSuggestion, RegattaState } from '@brt/engine';
import type { Role } from './hub.ts';
import type { StoredEvent } from './store.ts';

export type ClientMessage =
  /** Join a regatta. `pin` sets the role; `lastSeq` asks for only the events after it */
  | { t: 'hello'; regattaId: string; pin?: string; lastSeq?: number }
  /** `id` is unique per command, chosen by the device, so a resend is recognised */
  | { t: 'command'; id: string; command: Command }
  /** The device saw a gap in event numbers: send the whole state again */
  | { t: 'resync' }
  | { t: 'ping'; clientTime: number }
  /** Positions from one tracker (a phone's own GPS, or a radio it relays). Answered by positionsAck. */
  | { t: 'positions'; id: string; trackerId: string; fixes: unknown[] };

/** New fixes per tracker. `full` replaces what the device has (sent after welcome). */
export interface PositionsUpdate {
  full?: boolean;
  trackers: { trackerId: string; fixes: Fix[] }[];
}

export interface Suggestions {
  over: OverSuggestion[];
  finishes: FinishSuggestion[];
}

export type ServerMessage =
  | { t: 'welcome'; regattaId: string; name: string; role: Role; /** Only to the race office, to share with skippers */ skipperPin?: string; seq: number; serverTime: number; state?: RegattaState; events?: StoredEvent[] }
  | { t: 'events'; events: StoredEvent[] }
  | { t: 'result'; id: string; ok: true; seq: number; duplicate?: boolean }
  | { t: 'result'; id: string; ok: false; error: { code: string; message: string }; duplicate?: boolean }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; code: string; message: string }
  | ({ t: 'positions' } & PositionsUpdate)
  | { t: 'positionsAck'; id: string; accepted: number; unbound?: boolean; error?: { code: string; message: string } }
  /** Race office only: what GPS suggests */
  | ({ t: 'suggestions' } & Suggestions)
  /** Race office only: trackers heard that no boat has, to connect in Setup */
  | { t: 'heard'; trackers: { trackerId: string; at: number }[] };

/** Most fixes in one message: a phone's backlog goes in several */
export const MAX_FIXES_PER_MESSAGE = 500;

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
    case 'positions':
      if (typeof m.id !== 'string' || !COMMAND_ID.test(m.id) || typeof m.trackerId !== 'string') return null;
      if (!Array.isArray(m.fixes) || m.fixes.length > MAX_FIXES_PER_MESSAGE) return null;
      return { t: 'positions', id: m.id, trackerId: m.trackerId, fixes: m.fixes };
    default:
      return null;
  }
}

// A device's connection to one regatta: keeps a copy of the race from the server's events, queues
// commands (kept on the device until the server answers), and estimates the server's clock.
// No React and no DOM here, so it can be tested in Node and reused by the Android app.
import { apply, type Command, type RegattaState, type RegattaEvent } from '@brt/engine';

export type Role = 'OFFICER' | 'SKIPPER' | 'SPECTATOR';

interface StoredEvent {
  seq: number;
  at: number;
  event: RegattaEvent;
}

type ServerMessage =
  | { t: 'welcome'; regattaId: string; name: string; role: Role; skipperPin?: string; seq: number; serverTime: number; state?: RegattaState; events?: StoredEvent[] }
  | { t: 'events'; events: StoredEvent[] }
  | { t: 'result'; id: string; ok: true; seq: number; duplicate?: boolean }
  | { t: 'result'; id: string; ok: false; error: { code: string; message: string }; duplicate?: boolean }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; code: string; message: string };

/** The parts of a WebSocket this uses (the browser's, or a test double) */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Pending {
  id: string;
  command: Command;
  queuedAt: number;
}

export type ConnectionStatus = 'connecting' | 'live' | 'offline' | 'failed';

export interface ClientSnapshot {
  status: ConnectionStatus;
  regattaId: string;
  name: string;
  role: Role;
  /** Given only to the race office, to pass on to skippers */
  skipperPin?: string;
  regatta: RegattaState | null;
  seq: number;
  /** Commands not yet answered by the server, oldest first */
  pending: Pending[];
  /** The last refusal or connection problem, in words for the person */
  notice: { kind: 'refused' | 'failed'; message: string; at: number } | null;
}

export type CommandOutcome = { ok: true } | { ok: false; message: string; code: string };

export interface ClientOptions {
  url: string;
  regattaId: string;
  pin?: string;
  socket?: (url: string) => SocketLike;
  storage?: StorageLike | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const OPEN = 1;
const PING_MS = 15_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export class RegattaClient {
  private snap: ClientSnapshot;
  private listeners = new Set<() => void>();
  private ws: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  /** When the server was last heard from, and when the last ping went out */
  private lastHeard = 0;
  private lastPing = 0;
  private offsetMs = 0;
  private bestRoundTrip = Infinity;
  private waiting = new Map<string, (o: CommandOutcome) => void>();
  private counter = 0;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private opts: ClientOptions) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.deviceId = this.loadDeviceId();
    const saved = this.load();
    this.snap = {
      status: 'connecting',
      regattaId: opts.regattaId,
      name: saved?.name ?? '',
      role: 'SPECTATOR',
      regatta: saved?.regatta ?? null,
      seq: saved?.seq ?? 0,
      pending: saved?.pending ?? [],
      notice: null,
    };
  }

  // ------------------------------------------------------------------ for React (useSyncExternalStore)

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClientSnapshot => this.snap;

  /** The server's clock, as best this device knows it */
  serverNow(): number {
    return this.now() + this.offsetMs;
  }

  // ----------------------------------------------------------------------------------- lifecycle

  connect() {
    this.stopped = false;
    this.open();
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    if (this.pingTimer) this.clearTimer(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  /**
   * Sends a command. It is kept on the device until the server answers, and sent again after a
   * reconnect (the server recognises the id, so it never runs twice). Resolves with the answer.
   */
  send(command: Command): Promise<CommandOutcome> {
    const id = `${this.deviceId}-${this.now().toString(36)}-${(this.counter++).toString(36)}`;
    const item: Pending = { id, command, queuedAt: this.serverNow() };
    this.update({ pending: [...this.snap.pending, item] });
    this.save();
    const done = new Promise<CommandOutcome>((resolve) => this.waiting.set(id, resolve));
    if (this.snap.status === 'live') this.transmit(item);
    return done;
  }

  dismissNotice() {
    this.update({ notice: null });
  }

  /** The device says it has lost its network: stop waiting on a socket that can't answer */
  networkLost() {
    if (this.ws) this.lost(this.ws);
  }

  /** The device says its network is back: try now instead of waiting out the pause */
  networkBack() {
    if (this.stopped || this.ws || this.snap.status === 'failed') return;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    this.open();
  }

  // ------------------------------------------------------------------------------------ internals

  private open() {
    if (this.stopped) return;
    this.update({ status: this.snap.status === 'failed' ? 'failed' : 'connecting' });
    const factory = this.opts.socket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    const ws = factory(this.opts.url);
    this.ws = ws;
    this.lastPing = 0;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          regattaId: this.opts.regattaId,
          ...(this.opts.pin ? { pin: this.opts.pin } : {}),
          ...(this.snap.regatta && this.snap.seq > 0 ? { lastSeq: this.snap.seq } : {}),
        })
      );
      this.ping();
    };
    ws.onmessage = (ev) => {
      this.lastHeard = this.now();
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.receive(m);
    };
    ws.onerror = () => {};
    ws.onclose = () => this.lost(ws);
  }

  /** The connection is gone (closed, or silent): show offline and try again after a pause */
  private lost(ws: SocketLike) {
    if (this.ws !== ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    // A socket that went quiet may take minutes to report closing; don't wait for it
    if (ws.readyState < 2) ws.close();
    if (this.pingTimer) this.clearTimer(this.pingTimer);
    if (this.stopped || this.snap.status === 'failed') return;
    this.update({ status: 'offline' });
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private receive(m: ServerMessage) {
    switch (m.t) {
      case 'welcome': {
        this.attempt = 0;
        this.noteServerTime(m.serverTime, 0);
        let regatta = this.snap.regatta;
        let seq = this.snap.seq;
        if (m.state) {
          regatta = m.state;
          seq = m.seq;
        } else if (m.events && regatta) {
          for (const e of m.events) {
            if (e.seq !== seq + 1) return this.resync();
            regatta = apply(regatta, e.event);
            seq = e.seq;
          }
        }
        this.update({ status: 'live', name: m.name, role: m.role, skipperPin: m.skipperPin, regatta, seq });
        this.save();
        // Whatever was queued while offline goes now, in order
        for (const item of this.snap.pending) this.transmit(item);
        return;
      }
      case 'events': {
        let regatta = this.snap.regatta;
        let seq = this.snap.seq;
        if (!regatta) return this.resync();
        for (const e of m.events) {
          if (e.seq <= seq) continue; // already have it
          if (e.seq !== seq + 1) return this.resync();
          regatta = apply(regatta, e.event);
          seq = e.seq;
        }
        this.update({ regatta, seq });
        this.save();
        return;
      }
      case 'result': {
        const pending = this.snap.pending.filter((p) => p.id !== m.id);
        const notice = m.ok ? this.snap.notice : { kind: 'refused' as const, message: m.error.message, at: this.now() };
        this.update({ pending, notice });
        this.save();
        const resolve = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        resolve?.(m.ok ? { ok: true } : { ok: false, code: m.error.code, message: m.error.message });
        return;
      }
      case 'pong': {
        const roundTrip = this.now() - m.clientTime;
        this.noteServerTime(m.serverTime, roundTrip, m.clientTime);
        return;
      }
      case 'error': {
        // A wrong code or PIN won't get better by retrying
        if (['NO_SUCH_REGATTA', 'WRONG_PIN', 'TOO_MANY_PIN_TRIES'].includes(m.code)) {
          this.update({ status: 'failed', notice: { kind: 'failed', message: m.message, at: this.now() } });
          this.stopped = true;
          this.ws?.close();
        }
        return;
      }
    }
  }

  private resync() {
    this.ws?.send(JSON.stringify({ t: 'resync' }));
  }

  private transmit(item: Pending) {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify({ t: 'command', id: item.id, command: item.command }));
  }

  private ping() {
    // Nothing back since the last ping, a whole interval ago: the connection is dead even if open
    if (this.ws && this.lastPing > 0 && this.lastHeard <= this.lastPing) return this.lost(this.ws);
    if (this.ws && this.ws.readyState === OPEN) {
      this.lastPing = this.now();
      this.ws.send(JSON.stringify({ t: 'ping', clientTime: this.lastPing }));
    }
    if (this.pingTimer) this.clearTimer(this.pingTimer);
    this.pingTimer = this.setTimer(() => this.ping(), PING_MS);
  }

  /** Keeps the estimate from the quickest round trip seen (the least network delay in it) */
  private noteServerTime(serverTime: number, roundTrip: number, sentAt?: number) {
    if (sentAt === undefined) {
      if (this.bestRoundTrip === Infinity) this.offsetMs = serverTime - this.now();
      return;
    }
    if (roundTrip <= this.bestRoundTrip) {
      this.bestRoundTrip = roundTrip;
      this.offsetMs = serverTime - (sentAt + roundTrip / 2);
    }
  }

  private update(patch: Partial<ClientSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------- kept on the device

  private key() {
    return `brt:${this.opts.regattaId}`;
  }

  private load(): { name: string; regatta: RegattaState; seq: number; pending: Pending[] } | null {
    try {
      const raw = this.opts.storage?.getItem(this.key());
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private save() {
    try {
      this.opts.storage?.setItem(this.key(), JSON.stringify({ name: this.snap.name, regatta: this.snap.regatta, seq: this.snap.seq, pending: this.snap.pending }));
    } catch {
      // Full or blocked storage: the queue still lives in memory
    }
  }

  private loadDeviceId(): string {
    try {
      const existing = this.opts.storage?.getItem('brt:device');
      if (existing) return existing;
      const id = Math.random().toString(36).slice(2, 10);
      this.opts.storage?.setItem('brt:device', id);
      return id;
    } catch {
      return Math.random().toString(36).slice(2, 10);
    }
  }
}

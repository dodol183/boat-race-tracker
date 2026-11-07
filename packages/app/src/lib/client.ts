// A device's connection to one regatta: keeps a copy of the race from the server's events, queues
// commands (kept on the device until the server answers), and estimates the server's clock.
// No React and no DOM here, so it can be tested in Node and reused by the Android app.
import { apply, mergeTrail, type Command, type FinishSuggestion, type Fix, type OverSuggestion, type RegattaState, type RegattaEvent } from '@brt/engine';

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
  | { t: 'error'; code: string; message: string }
  | { t: 'positions'; full?: boolean; trackers: { trackerId: string; fixes: Fix[] }[] }
  | { t: 'positionsAck'; id: string; accepted: number; unbound?: boolean; error?: { code: string; message: string } }
  | { t: 'suggestions'; over: OverSuggestion[]; finishes: FinishSuggestion[] }
  | { t: 'heard'; trackers: { trackerId: string; at: number }[] };

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
  /** Recent track of each tracker, oldest first (boats name their tracker) */
  tracks: Record<string, Fix[]>;
  /** What GPS suggests (race office only) */
  suggestions: { over: OverSuggestion[]; finishes: FinishSuggestion[] };
  /** Trackers heard that no boat has (race office only) */
  heard: { trackerId: string; at: number }[];
  /** Positions from this device not yet taken by the server */
  fixesWaiting: number;
  /** Why the server last turned this device's positions away, if it did */
  shareProblem: string | null;
}

interface QueuedFixes {
  trackerId: string;
  fixes: Fix[];
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
  /** Sends positions over HTTP (with this device's PIN), for when the socket can't */
  postFixes?: (trackerId: string, fixes: Fix[]) => Promise<{ ok: boolean; status: number; accepted?: number; unbound?: boolean; error?: string }>;
}

const OPEN = 1;
const PING_MS = 15_000;
/** Track kept on the device for the map */
const TRACK_KEEP_MS = 30 * 60_000;
/** Positions kept while offline: about 7 hours at one every 5 s */
const FIX_QUEUE_MAX = 5000;
const FIXES_PER_MESSAGE = 200;
/** After a failed HTTP send, the next try */
const HTTP_RETRY_MS = 15_000;
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
  private fixQueue: QueuedFixes[] = [];
  /** The batch the server has but hasn't answered */
  private fixesInFlight: { id: string; count: number; via: 'ws' | 'http' } | null = null;
  /** Positions go over HTTP even while the socket is up (the app in the background) */
  private fixesOverHttp = false;
  private httpRetryTimer: unknown = null;
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
      tracks: {},
      suggestions: { over: [], finishes: [] },
      heard: [],
      fixesWaiting: 0,
      shareProblem: null,
    };
    this.fixQueue = this.loadFixes();
    this.snap.fixesWaiting = this.countFixes();
  }

  /** This device's id as a tracker, when it shares its own GPS */
  get phoneTrackerId(): string {
    return `phone-${this.deviceId}`;
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
    if (this.httpRetryTimer) this.clearTimer(this.httpRetryTimer);
    this.httpRetryTimer = null;
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

  /**
   * Positions from a tracker this device reads (its own GPS, or a radio it relays). Kept on the
   * device until the server has them, so a skipper out of signal loses nothing.
   */
  shareFixes(trackerId: string, fixes: Fix[]) {
    if (fixes.length === 0) return;
    const last = this.fixQueue.at(-1);
    if (last && last.trackerId === trackerId && last !== this.inFlightGroup()) last.fixes.push(...fixes);
    else this.fixQueue.push({ trackerId, fixes: [...fixes] });
    // Too many: the oldest go first
    // (never from a batch the server has but hasn't answered)
    let extra = this.countFixes() - FIX_QUEUE_MAX;
    const first = this.fixesInFlight ? 1 : 0;
    while (extra > 0 && this.fixQueue.length > first) {
      const g = this.fixQueue[first]!;
      const n = Math.min(extra, g.fixes.length);
      g.fixes.splice(0, n);
      extra -= n;
      if (g.fixes.length === 0) this.fixQueue.splice(first, 1);
    }
    this.saveFixes();
    this.update({ fixesWaiting: this.countFixes() });
    this.flushFixes();
  }

  /**
   * In the background Android throttles the WebView's socket; the app's native HTTP keeps going.
   * Set while the app is hidden.
   */
  setFixesOverHttp(on: boolean) {
    this.fixesOverHttp = on;
    this.flushFixes();
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
    // A batch sent on this socket is lost with it and goes again
    if (this.fixesInFlight?.via === 'ws') this.fixesInFlight = null;
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
        if (this.fixesInFlight?.via === 'ws') this.fixesInFlight = null;
        this.flushFixes();
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
      case 'positions': {
        const tracks: Record<string, Fix[]> = m.full ? {} : { ...this.snap.tracks };
        const cutoff = this.serverNow() - TRACK_KEEP_MS;
        for (const t of m.trackers) {
          const merged = mergeTrail(tracks[t.trackerId] ?? [], t.fixes);
          // Always keep the newest, however old, so a boat still shows where it was last seen
          const recent = merged.filter((f, i) => f.fixTime >= cutoff || i === merged.length - 1);
          tracks[t.trackerId] = recent;
        }
        this.update({ tracks });
        return;
      }
      case 'positionsAck': {
        if (this.fixesInFlight?.id !== m.id) return;
        this.fixesTaken(m.error?.message ?? null, !!m.unbound);
        return;
      }
      case 'suggestions':
        this.update({ suggestions: { over: m.over, finishes: m.finishes } });
        return;
      case 'heard':
        this.update({ heard: m.trackers });
        return;
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

  private flushFixes() {
    if (this.fixesInFlight || this.stopped || this.snap.status === 'failed') return;
    const g = this.fixQueue[0];
    if (!g) return;
    const fixes = g.fixes.slice(0, FIXES_PER_MESSAGE);
    const id = `${this.deviceId}-f${this.now().toString(36)}-${(this.counter++).toString(36)}`;
    const socketUp = this.snap.status === 'live' && !!this.ws && this.ws.readyState === OPEN;
    if (socketUp && !(this.fixesOverHttp && this.opts.postFixes && this.opts.pin)) {
      this.fixesInFlight = { id, count: fixes.length, via: 'ws' };
      this.ws!.send(JSON.stringify({ t: 'positions', id, trackerId: g.trackerId, fixes }));
      return;
    }
    // No socket (or the app in the background): HTTP, if this device has a PIN to send with
    if (!this.opts.postFixes || !this.opts.pin || this.httpRetryTimer) return;
    this.fixesInFlight = { id, count: fixes.length, via: 'http' };
    void this.opts.postFixes(g.trackerId, fixes).then((r) => {
      if (this.fixesInFlight?.id !== id) return;
      if (r.ok) return this.fixesTaken(null, !!r.unbound);
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return this.fixesTaken(r.error ?? 'The server turned these positions away.', false);
      // No connection, or the server busy: try again later
      this.fixesInFlight = null;
      this.httpRetryTimer = this.setTimer(() => {
        this.httpRetryTimer = null;
        this.flushFixes();
      }, HTTP_RETRY_MS);
    });
  }

  /** The server has the batch in flight (or turned it away, with the reason): on to the next */
  private fixesTaken(problem: string | null, unbound: boolean) {
    const { count } = this.fixesInFlight!;
    this.fixesInFlight = null;
    const g = this.fixQueue[0];
    if (g) {
      g.fixes.splice(0, count);
      if (g.fixes.length === 0) this.fixQueue.shift();
    }
    this.saveFixes();
    const shareProblem = problem ?? (unbound ? 'This tracker is not connected to a boat, so its positions are not kept.' : null);
    this.update({ fixesWaiting: this.countFixes(), shareProblem });
    this.flushFixes();
  }

  private inFlightGroup(): QueuedFixes | undefined {
    return this.fixesInFlight ? this.fixQueue[0] : undefined;
  }

  private countFixes(): number {
    return this.fixQueue.reduce((n, g) => n + g.fixes.length, 0);
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

  private loadFixes(): QueuedFixes[] {
    try {
      const raw = this.opts.storage?.getItem(`${this.key()}:fixes`);
      const q = raw ? JSON.parse(raw) : [];
      return Array.isArray(q) ? q.filter((g) => g && typeof g.trackerId === 'string' && Array.isArray(g.fixes)) : [];
    } catch {
      return [];
    }
  }

  private saveFixes() {
    try {
      if (this.fixQueue.length) this.opts.storage?.setItem(`${this.key()}:fixes`, JSON.stringify(this.fixQueue));
      else this.opts.storage?.removeItem(`${this.key()}:fixes`);
    } catch {
      // Full storage: they still go from memory
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

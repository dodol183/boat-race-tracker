// Relays a Meshtastic radio's positions to the server: the radio on a skipper's boat, or a base
// radio at the race office that hears the whole fleet. The radio is reached over Bluetooth through
// a RadioLink (Web Bluetooth in Chrome, the native plugin in the Android app).
//
// The Meshtastic client protocol, as the firmware expects it:
// 1. Write ToRadio { want_config_id }.
// 2. Read FromRadio until it is empty, and again whenever FromNum notifies, until
//    config_complete_id comes back with our id. The radio's own node and its NodeDB come first.
// 3. Keep reading: each packet the mesh delivers arrives as a FromRadio.
// GATT operations run one at a time.
import { MAX_FIX_AGE_MS, trackerId, type Fix } from '@brt/engine';
import {
  PortNum,
  decodeFromRadio,
  decodePosition,
  encodeWantConfig,
  newPacketId,
  positionLatLng,
  positionSpeedKt,
  positionTrackDeg,
  type NodeInfoMsg,
  type MeshPacketMsg,
  type PositionMsg,
} from './protocol.ts';

/** The Bluetooth link to one radio */
export interface RadioLink {
  readonly name: string;
  write(bytes: Uint8Array): Promise<void>;
  /** One FromRadio message; empty when there is nothing more to read */
  read(): Promise<Uint8Array>;
  /** Calls back when the radio has data waiting; false if it can't notify (the relay then polls) */
  notify(cb: () => void): Promise<boolean>;
  onDisconnect(cb: () => void): void;
  close(): Promise<void>;
}

export type RelayState = 'idle' | 'connecting' | 'configuring' | 'connected' | 'reconnecting' | 'lost';

export interface RelayStatus {
  state: RelayState;
  deviceName?: string;
  /** The connected radio's own tracker id */
  radioId?: string;
  /** Radios heard over the air since connecting */
  heard: number;
  /** Positions passed on to the server */
  sent: number;
  error?: string;
}

const CONFIG_TIMEOUT_MS = 20_000;
const RECONNECT_DELAYS_MS = [2000, 5000, 10_000, 30_000];
/** A radio clock a little ahead is fine; more means the time is wrong */
const FUTURE_SLACK_MS = 30_000;

export interface RelayOptions {
  /** Opens a link: with `again`, to the radio used last, without asking the person to pick */
  connect(again: boolean): Promise<RadioLink>;
  /** Positions for the server, per tracker */
  share(trackerId: string, fixes: Fix[]): void;
  /** The server's clock */
  now?: () => number;
  /** For tests: the want_config id to use */
  configId?: () => number;
}

export class MeshtasticRelay {
  private status: RelayStatus = { state: 'idle', heard: 0, sent: 0 };
  private listeners = new Set<() => void>();
  private link: RadioLink | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private draining = false;
  private drainAgain = false;
  private configId = 0;
  private configured: ((ok: boolean) => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private myNum: number | undefined;
  private heard = new Set<string>();
  /** The newest fix time passed on, per tracker */
  private lastSent = new Map<string, number>();
  private readonly now: () => number;

  constructor(private opts: RelayOptions) {
    this.now = opts.now ?? Date.now;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getStatus = () => this.status;

  /** Asks the person to pick a radio, connects, and relays until stopped */
  async start(): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    this.clearReconnect();
    await this.session(false);
  }

  async stop() {
    this.stopped = true;
    this.clearReconnect();
    await this.teardown();
    this.set({ state: 'idle', error: undefined });
  }

  // ---------------------------------------------------------------------------------- session

  private async session(again: boolean): Promise<boolean> {
    this.set({ state: again ? 'reconnecting' : 'connecting', error: undefined });
    let link: RadioLink;
    try {
      link = await this.opts.connect(again);
    } catch (err) {
      this.set({ state: again ? 'reconnecting' : 'idle', error: describe(err) });
      return false;
    }
    if (this.stopped) {
      await link.close().catch(() => {});
      return false;
    }
    this.link = link;
    this.set({ deviceName: link.name });
    link.onDisconnect(() => {
      if (this.link !== link) return;
      void this.dropped();
    });
    try {
      const notifying = await this.op(() => link.notify(() => void this.drain())).catch(() => false);
      // Without notifications, read every 2 s
      if (!notifying) this.poll = setInterval(() => void this.drain(), 2000);
      this.set({ state: 'configuring' });
      if (!(await this.handshake())) throw new Error('The radio did not finish sending its settings in time. Turn it off and on, then try again.');
      this.attempt = 0;
      this.set({ state: 'connected' });
      return true;
    } catch (err) {
      await this.teardown();
      this.set({ state: again ? 'reconnecting' : 'idle', error: describe(err) });
      return false;
    }
  }

  private async handshake(): Promise<boolean> {
    this.configId = this.opts.configId?.() ?? newPacketId();
    const done = new Promise<boolean>((resolve) => (this.configured = resolve));
    await this.op(() => this.link!.write(encodeWantConfig(this.configId)));
    // Keep reading while the settings come, in case a notification is missed
    const kick = setInterval(() => void this.drain(), 500);
    void this.drain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), CONFIG_TIMEOUT_MS)));
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearInterval(kick);
      clearTimeout(timer);
      this.configured = null;
    }
  }

  private async dropped() {
    await this.teardown();
    if (this.stopped) return;
    if (this.attempt >= RECONNECT_DELAYS_MS.length) {
      this.set({ state: 'lost', error: 'Lost the Bluetooth connection to the radio. Check it is on and in range, then connect again.' });
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.attempt++]!;
    this.set({ state: 'reconnecting' });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (!(await this.session(true)) && !this.stopped) void this.dropped();
    }, delay);
  }

  private async teardown() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.configured?.(false);
    this.configured = null;
    const link = this.link;
    this.link = null;
    if (link) await link.close().catch(() => {});
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** One GATT operation at a time */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Reads until the radio has nothing more; a request meanwhile causes one more pass */
  private async drain() {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        for (let i = 0; i < 1000; i++) {
          const link = this.link;
          if (!link) return;
          const bytes = await this.op(() => link.read());
          if (!bytes || bytes.byteLength === 0) break;
          this.handleFromRadio(bytes);
        }
      } while (this.drainAgain && this.link);
    } catch {
      // A failed read: the link's disconnect event, or the next notification, follows
    } finally {
      this.draining = false;
    }
  }

  // ------------------------------------------------------------------------------- messages

  /** One FromRadio message (public so recorded traffic can be replayed in tests) */
  handleFromRadio(bytes: Uint8Array) {
    let fr;
    try {
      fr = decodeFromRadio(bytes);
    } catch {
      return;
    }
    if (fr.myInfo?.myNodeNum !== undefined) {
      this.myNum = fr.myInfo.myNodeNum;
      this.set({ radioId: trackerId(this.myNum) ?? undefined });
    }
    if (fr.nodeInfo) this.nodeInfo(fr.nodeInfo);
    if (fr.packet) this.packet(fr.packet);
    if (fr.configCompleteId !== undefined && fr.configCompleteId === this.configId) this.configured?.(true);
    if (fr.rebooted && this.status.state === 'connected') {
      // The radio restarted and forgot this session: ask for its settings again
      this.set({ state: 'configuring' });
      void this.handshake().then((ok) => this.link && this.set(ok ? { state: 'connected' } : { state: 'lost', error: 'The radio restarted and did not resend its settings.' }));
    }
  }

  /** A NodeDB entry: whatever the radio last heard from that node, possibly hours ago */
  private nodeInfo(ni: NodeInfoMsg) {
    // Heard through an internet gateway, not over the air: not ours to relay
    if (ni.viaMqtt || ni.num === undefined) return;
    const id = trackerId(ni.num);
    if (!id) return;
    if (ni.num !== this.myNum) this.noteHeard(id);
    const sec = ni.position?.time || ni.position?.timestamp;
    // A position without its own time has an unknown age: not used
    if (ni.position && sec) this.offer(id, ni.position, sec * 1000);
  }

  /** A packet the mesh delivered just now */
  private packet(p: MeshPacketMsg) {
    if (p.from === undefined || p.viaMqtt || p.encrypted) return;
    const id = trackerId(p.from);
    if (!id) return;
    if (p.from !== this.myNum) this.noteHeard(id);
    if (p.decoded?.portnum !== PortNum.POSITION_APP || !p.decoded.payload) return;
    let pos: PositionMsg;
    try {
      pos = decodePosition(p.decoded.payload);
    } catch {
      return;
    }
    // The fix's own time when it has one (a node without a fresh fix resends its last one, with its
    // old time); otherwise when it was received
    const sec = pos.time || pos.timestamp;
    this.offer(id, pos, sec ? sec * 1000 : p.rxTime ? p.rxTime * 1000 : this.now());
  }

  private offer(id: string, pos: PositionMsg, takenAt: number) {
    const ll = positionLatLng(pos);
    if (!ll) return;
    const now = this.now();
    if (takenAt > now + FUTURE_SLACK_MS || now - takenAt > MAX_FIX_AGE_MS) return;
    const fixTime = Math.min(Math.round(takenAt), now);
    if ((this.lastSent.get(id) ?? 0) >= fixTime) return;
    this.lastSent.set(id, fixTime);
    const fix: Fix = { ...ll, fixTime };
    const kt = positionSpeedKt(pos);
    const deg = positionTrackDeg(pos);
    if (kt !== undefined) fix.speedKt = kt;
    if (deg !== undefined) fix.headingDeg = deg;
    this.opts.share(id, [fix]);
    this.set({ sent: this.status.sent + 1 });
  }

  private noteHeard(id: string) {
    if (this.heard.has(id)) return;
    this.heard.add(id);
    this.set({ heard: this.heard.size });
  }

  private set(patch: Partial<RelayStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'NotFoundError') return 'No radio was chosen.';
  const raw = e?.message || String(err || 'The Bluetooth connection failed.');
  if (/GATT|connect/i.test(raw)) return `${raw} Check the radio is on, in range, and not connected to the Meshtastic app.`;
  return raw;
}

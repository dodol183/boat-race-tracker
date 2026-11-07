// The relay against frames recorded from a real T-Echo (RM1, firmware 2.7.26): its settings dump and
// ten minutes of mesh traffic. The recording was cleaned for a public repository: settings, channel
// and log frames dropped, every position moved by one fixed offset, other nodes given made-up ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_FIX_AGE_MS, type Fix } from '@brt/engine';
import { MeshtasticRelay, type RadioLink } from '../src/lib/meshtastic/relay.ts';
import { decodeFromRadio } from '../src/lib/meshtastic/protocol.ts';

const RM1 = '!dd69e9a8'; // the T-Echo on the cable
const RM2 = '!a12264da'; // the other T-Echo, heard over LoRa

type Frame = { t: number; dir: 'from' | 'to'; kind: string; b64: string };
const frames: Frame[] = readFileSync(fileURLToPath(new URL('./fixtures/techo-rm1-usb.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const bytes = (f: Frame) => new Uint8Array(Buffer.from(f.b64, 'base64'));
const fromRadio = frames.filter((f) => f.dir === 'from').map((f) => ({ f, msg: decodeFromRadio(bytes(f)) }));
// The recording answers the want_config_id its own client sent; the relay is given the same id
const CONFIG_ID = fromRadio.find((x) => x.msg.configCompleteId !== undefined)!.msg.configCompleteId!;
const rm2Fix = fromRadio.find((x) => x.msg.nodeInfo?.num === 0xa12264da)!.msg.nodeInfo!.position!;
const RM2_FIX_MS = (rm2Fix.time || rm2Fix.timestamp)! * 1000;
const viaMqtt = new Set(fromRadio.filter((x) => x.msg.nodeInfo?.viaMqtt).map((x) => `!${x.msg.nodeInfo!.num!.toString(16).padStart(8, '0')}`));

/** A radio that answers want_config with the recording, then has nothing more */
class RecordedRadio implements RadioLink {
  name = 'RM1';
  queue: Uint8Array[] = [];
  written: Uint8Array[] = [];
  closed = false;
  private onDrop: (() => void) | null = null;
  async write(b: Uint8Array) {
    this.written.push(b);
    this.queue.push(...fromRadio.map((x) => bytes(x.f)));
  }
  async read() {
    return this.queue.shift() ?? new Uint8Array(0);
  }
  async notify() {
    return true;
  }
  onDisconnect(cb: () => void) {
    this.onDrop = cb;
  }
  async close() {
    this.closed = true;
  }
  drop() {
    this.onDrop?.();
  }
}

async function relayAt(now: number) {
  const radio = new RecordedRadio();
  const shared: { trackerId: string; fix: Fix }[] = [];
  const relay = new MeshtasticRelay({
    connect: async () => radio,
    share: (trackerId, fixes) => fixes.forEach((fix) => shared.push({ trackerId, fix })),
    now: () => now,
    configId: () => CONFIG_ID,
  });
  await relay.start();
  return { relay, radio, shared };
}

test('relay: connects, asks the radio for its settings, and knows which radio it is', async () => {
  const { relay, radio } = await relayAt(RM2_FIX_MS + 60_000);
  const s = relay.getStatus();
  assert.deepEqual([s.state, s.radioId, s.deviceName], ['connected', RM1, 'RM1']);
  assert.ok(s.heard >= 9, `heard ${s.heard} radios`);
  assert.equal(radio.written.length, 1, 'one want_config');
  await relay.stop();
  assert.equal(radio.closed, true);
  assert.equal(relay.getStatus().state, 'idle');
});

test('relay: passes on fresh positions heard over the air, each once, and never those that came over the internet', async () => {
  // As if connected a minute after RM2 took its fix
  const { relay, shared } = await relayAt(RM2_FIX_MS + 60_000);
  const rm2 = shared.filter((s) => s.trackerId === RM2);
  assert.equal(rm2.length, 1);
  assert.equal(rm2[0]!.fix.fixTime, RM2_FIX_MS, 'timed when the fix was taken, not when it was relayed');
  for (const s of shared) {
    assert.match(s.trackerId, /^![0-9a-f]{8}$/);
    assert.ok(!viaMqtt.has(s.trackerId), `${s.trackerId} was heard through an MQTT gateway`);
  }
  const before = shared.length;
  for (const x of fromRadio) relay.handleFromRadio(bytes(x.f));
  assert.equal(shared.length, before, 'hearing the same fixes again passes nothing on');
  await relay.stop();
});

test('relay: hours-old positions from the radio’s memory are not passed on', async () => {
  // The recording is from the past: connected today, every position in it is too old to show
  const now = Date.now();
  const { relay, shared } = await relayAt(now);
  assert.equal(relay.getStatus().state, 'connected');
  for (const s of shared) assert.ok(now - s.fix.fixTime <= MAX_FIX_AGE_MS, `${s.trackerId} fix is ${Math.round((now - s.fix.fixTime) / 60_000)} min old`);
  assert.equal(shared.some((s) => s.trackerId === RM2), false);
  await relay.stop();
});

test('relay: a radio that never finishes its settings is given up, and a dropped link is retried', async () => {
  const silent: RadioLink = { name: 'mute', write: async () => {}, read: async () => new Uint8Array(0), notify: async () => true, onDisconnect: () => {}, close: async () => {} };
  const t0 = Date.now();
  const r = new MeshtasticRelay({ connect: async () => silent, share: () => {}, configId: () => 1 });
  // Shortened: the real wait is 20 s; here the relay is stopped while it waits
  const started = r.start();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.getStatus().state, 'configuring');
  await r.stop();
  await started;
  assert.equal(r.getStatus().state, 'idle');
  assert.ok(Date.now() - t0 < 5000);

  const { relay, radio } = await relayAt(RM2_FIX_MS + 60_000);
  radio.drop();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(relay.getStatus().state, 'reconnecting');
  await relay.stop();
  assert.equal(relay.getStatus().state, 'idle');
});

test('relay: a radio heard through an internet gateway is not passed on, even with a fresh position', async () => {
  const mqtt = fromRadio.find((x) => x.msg.nodeInfo?.viaMqtt && (x.msg.nodeInfo.position?.time || x.msg.nodeInfo.position?.timestamp))!.msg.nodeInfo!;
  const id = `!${mqtt.num!.toString(16).padStart(8, '0')}`;
  const at = (mqtt.position!.time || mqtt.position!.timestamp)! * 1000;
  // A minute after that radio's fix, so only the gateway rule can keep it out
  const { relay, shared } = await relayAt(at + 60_000);
  assert.equal(shared.some((s) => s.trackerId === id), false);
  await relay.stop();
});

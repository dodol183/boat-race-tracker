/**
 * Minimal Meshtastic protobuf decoder/encoder for the messages this app uses.
 *
 * Field numbers and types follow Meshtastic's mesh.proto / telemetry.proto. The official
 * definitions are GPLv3, so they are not bundled into the app; tests/meshtasticProtocol.test.ts
 * checks this module against them byte for byte (dev dependency only).
 *
 * Units, as the firmware fills them:
 * - Position.latitude_i / longitude_i: degrees × 1e7
 * - Position.ground_speed: whole km/h (only sent if the device's SPEED position flag is on)
 * - Position.ground_track: degrees × 1e5 (only sent if the HEADING position flag is on)
 * - DeviceMetrics.battery_level: percent; 101 means external power
 *
 * proto3 omits fields that hold their default value, so a field that is absent here is
 * `undefined`, never filled in with a guess.
 */
import pb from 'protobufjs/minimal.js';

const { Reader, Writer } = pb;
type PbReader = InstanceType<typeof Reader>;

export const PortNum = {
  TEXT_MESSAGE_APP: 1,
  POSITION_APP: 3,
  NODEINFO_APP: 4,
  ROUTING_APP: 5,
  TELEMETRY_APP: 67,
} as const;

export const BROADCAST_NUM = 0xffffffff;

/** A few common hardware models, by Meshtastic HardwareModel enum value */
export const HARDWARE_MODEL_NAMES: Record<number, string> = {
  3: 'LilyGO T-LoRa V2.1-1.6',
  4: 'LilyGO T-Beam',
  7: 'LilyGO T-Echo',
  9: 'RAK WisBlock 4631',
  31: 'Station G2',
  33: 'LilyGO T-Echo Plus',
  43: 'Heltec V3',
  44: 'Heltec Wireless Stick Lite V3',
  48: 'Heltec Wireless Tracker',
  50: 'LilyGO T-Deck',
  71: 'Seeed T1000-E',
  81: 'Seeed XIAO ESP32-S3',
  99: 'Seeed Wio Tracker L1',
  110: 'Heltec V4',
};

export function hardwareModelName(hw: number | undefined): string | undefined {
  if (hw === undefined || hw === 0) return undefined;
  return HARDWARE_MODEL_NAMES[hw] ?? `Hardware model ${hw}`;
}

// ---------------------------------------------------------------------------
// Message shapes (only the fields this app reads)

export interface PositionMsg {
  latitudeI?: number;
  longitudeI?: number;
  altitude?: number;
  time?: number;
  timestamp?: number;
  groundSpeed?: number; // km/h
  groundTrack?: number; // degrees × 1e5
  satsInView?: number;
  precisionBits?: number;
}

export interface UserMsg {
  id?: string;
  longName?: string;
  shortName?: string;
  hwModel?: number;
}

export interface DeviceMetricsMsg {
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  uptimeSeconds?: number;
}

export interface EnvironmentMetricsMsg {
  temperature?: number;
  relativeHumidity?: number;
  barometricPressure?: number;
  gasResistance?: number;
  iaq?: number;
}

export interface TelemetryMsg {
  time?: number;
  deviceMetrics?: DeviceMetricsMsg;
  environmentMetrics?: EnvironmentMetricsMsg;
}

export interface DataMsg {
  portnum?: number;
  payload?: Uint8Array;
  wantResponse?: boolean;
  requestId?: number;
}

export interface MeshPacketMsg {
  from?: number;
  to?: number;
  channel?: number;
  decoded?: DataMsg;
  /** True when the payload arrived encrypted (we can't read it without the channel key) */
  encrypted?: boolean;
  /** The encrypted payload bytes, when `encrypted` */
  encryptedPayload?: Uint8Array;
  id?: number;
  rxTime?: number;
  rxSnr?: number;
  hopLimit?: number;
  wantAck?: boolean;
  rxRssi?: number;
  viaMqtt?: boolean;
  hopStart?: number;
}

export interface NodeInfoMsg {
  num?: number;
  user?: UserMsg;
  position?: PositionMsg;
  snr?: number;
  lastHeard?: number;
  deviceMetrics?: DeviceMetricsMsg;
  channel?: number;
  viaMqtt?: boolean;
  hopsAway?: number;
}

export interface MyNodeInfoMsg {
  myNodeNum?: number;
  rebootCount?: number;
}

export interface DeviceMetadataMsg {
  firmwareVersion?: string;
  hwModel?: number;
}

export interface FromRadioMsg {
  id?: number;
  packet?: MeshPacketMsg;
  myInfo?: MyNodeInfoMsg;
  nodeInfo?: NodeInfoMsg;
  configCompleteId?: number;
  rebooted?: boolean;
  metadata?: DeviceMetadataMsg;
}

// ---------------------------------------------------------------------------
// Generic decoder driven by a field table

type Scalar = 'uint32' | 'int32' | 'sint32' | 'fixed32' | 'sfixed32' | 'float' | 'bool' | 'string' | 'bytes' | 'enum';
type FieldSpec = [name: string, kind: Scalar | ((bytes: Uint8Array) => unknown)];

const WIRE: Record<Scalar, number> = {
  uint32: 0, int32: 0, sint32: 0, bool: 0, enum: 0,
  fixed32: 5, sfixed32: 5, float: 5,
  string: 2, bytes: 2,
};

function readScalar(r: PbReader, kind: Scalar): unknown {
  switch (kind) {
    case 'uint32': return r.uint32();
    case 'int32': return r.int32();
    case 'enum': return r.int32();
    case 'sint32': return r.sint32();
    case 'fixed32': return r.fixed32();
    case 'sfixed32': return r.sfixed32();
    case 'float': return r.float();
    case 'bool': return r.bool();
    case 'string': return r.string();
    case 'bytes': return r.bytes();
  }
}

function decodeWith<T>(bytes: Uint8Array, spec: Record<number, FieldSpec>): T {
  const r = Reader.create(bytes);
  const out: Record<string, unknown> = {};
  while (r.pos < r.len) {
    const tag = r.uint32();
    const field = tag >>> 3;
    const wire = tag & 7;
    const s = spec[field];
    if (!s) {
      r.skipType(wire);
      continue;
    }
    const [name, kind] = s;
    if (typeof kind === 'function') {
      if (wire !== 2) { r.skipType(wire); continue; }
      out[name] = kind(r.bytes());
    } else if (wire !== WIRE[kind]) {
      // Wrong wire type for this field: skip it rather than misread it
      r.skipType(wire);
    } else {
      out[name] = readScalar(r, kind);
    }
  }
  return out as T;
}

export const decodePosition = (b: Uint8Array) => decodeWith<PositionMsg>(b, {
  1: ['latitudeI', 'sfixed32'],
  2: ['longitudeI', 'sfixed32'],
  3: ['altitude', 'int32'],
  4: ['time', 'fixed32'],
  7: ['timestamp', 'fixed32'],
  15: ['groundSpeed', 'uint32'],
  16: ['groundTrack', 'uint32'],
  19: ['satsInView', 'uint32'],
  23: ['precisionBits', 'uint32'],
});

export const decodeUser = (b: Uint8Array) => decodeWith<UserMsg>(b, {
  1: ['id', 'string'],
  2: ['longName', 'string'],
  3: ['shortName', 'string'],
  5: ['hwModel', 'enum'],
});

export const decodeDeviceMetrics = (b: Uint8Array) => decodeWith<DeviceMetricsMsg>(b, {
  1: ['batteryLevel', 'uint32'],
  2: ['voltage', 'float'],
  3: ['channelUtilization', 'float'],
  4: ['airUtilTx', 'float'],
  5: ['uptimeSeconds', 'uint32'],
});

export const decodeEnvironmentMetrics = (b: Uint8Array) => decodeWith<EnvironmentMetricsMsg>(b, {
  1: ['temperature', 'float'],
  2: ['relativeHumidity', 'float'],
  3: ['barometricPressure', 'float'],
  4: ['gasResistance', 'float'],
  7: ['iaq', 'uint32'],
});

export const decodeTelemetry = (b: Uint8Array) => decodeWith<TelemetryMsg>(b, {
  1: ['time', 'fixed32'],
  2: ['deviceMetrics', decodeDeviceMetrics],
  3: ['environmentMetrics', decodeEnvironmentMetrics],
});

export const decodeData = (b: Uint8Array) => decodeWith<DataMsg>(b, {
  1: ['portnum', 'enum'],
  2: ['payload', 'bytes'],
  3: ['wantResponse', 'bool'],
  6: ['requestId', 'fixed32'],
});

export function decodeMeshPacket(b: Uint8Array): MeshPacketMsg {
  const m = decodeWith<MeshPacketMsg & { encryptedBytes?: Uint8Array }>(b, {
    1: ['from', 'fixed32'],
    2: ['to', 'fixed32'],
    3: ['channel', 'uint32'],
    4: ['decoded', decodeData],
    5: ['encryptedBytes', 'bytes'],
    6: ['id', 'fixed32'],
    7: ['rxTime', 'fixed32'],
    8: ['rxSnr', 'float'],
    9: ['hopLimit', 'uint32'],
    10: ['wantAck', 'bool'],
    12: ['rxRssi', 'int32'],
    14: ['viaMqtt', 'bool'],
    15: ['hopStart', 'uint32'],
  });
  const { encryptedBytes, ...rest } = m;
  return encryptedBytes && encryptedBytes.length > 0 ? { ...rest, encrypted: true, encryptedPayload: encryptedBytes } : rest;
}

export const decodeNodeInfo = (b: Uint8Array) => decodeWith<NodeInfoMsg>(b, {
  1: ['num', 'uint32'],
  2: ['user', decodeUser],
  3: ['position', decodePosition],
  4: ['snr', 'float'],
  5: ['lastHeard', 'fixed32'],
  6: ['deviceMetrics', decodeDeviceMetrics],
  7: ['channel', 'uint32'],
  8: ['viaMqtt', 'bool'],
  9: ['hopsAway', 'uint32'],
});

export const decodeMyNodeInfo = (b: Uint8Array) => decodeWith<MyNodeInfoMsg>(b, {
  1: ['myNodeNum', 'uint32'],
  8: ['rebootCount', 'uint32'],
});

export const decodeDeviceMetadata = (b: Uint8Array) => decodeWith<DeviceMetadataMsg>(b, {
  1: ['firmwareVersion', 'string'],
  9: ['hwModel', 'enum'],
});

/** MQTT ServiceEnvelope: what gateways publish on msh/<region>/2/e/<channel>/<gateway> */
export interface ServiceEnvelopeMsg {
  packet?: MeshPacketMsg;
  channelId?: string;
  gatewayId?: string;
}

export const decodeServiceEnvelope = (b: Uint8Array) => decodeWith<ServiceEnvelopeMsg>(b, {
  1: ['packet', decodeMeshPacket],
  2: ['channelId', 'string'],
  3: ['gatewayId', 'string'],
});

export const decodeFromRadio = (b: Uint8Array) => decodeWith<FromRadioMsg>(b, {
  1: ['id', 'uint32'],
  2: ['packet', decodeMeshPacket],
  3: ['myInfo', decodeMyNodeInfo],
  4: ['nodeInfo', decodeNodeInfo],
  7: ['configCompleteId', 'uint32'],
  8: ['rebooted', 'bool'],
  13: ['metadata', decodeDeviceMetadata],
});

// ---------------------------------------------------------------------------
// Encoders (ToRadio)

export interface OutgoingPacket {
  to: number;
  portnum: number;
  payload: Uint8Array;
  id: number;
  channel?: number;
  wantAck?: boolean;
  wantResponse?: boolean;
  hopLimit?: number;
}

function encodeData(p: OutgoingPacket): Uint8Array {
  const w = Writer.create();
  w.uint32((1 << 3) | 0).int32(p.portnum);
  if (p.payload.length > 0) w.uint32((2 << 3) | 2).bytes(p.payload);
  if (p.wantResponse) w.uint32((3 << 3) | 0).bool(true);
  return w.finish();
}

function encodeMeshPacket(p: OutgoingPacket): Uint8Array {
  const w = Writer.create();
  w.uint32((2 << 3) | 5).fixed32(p.to >>> 0);
  if (p.channel) w.uint32((3 << 3) | 0).uint32(p.channel);
  w.uint32((4 << 3) | 2).bytes(encodeData(p));
  w.uint32((6 << 3) | 5).fixed32(p.id >>> 0);
  if (p.hopLimit) w.uint32((9 << 3) | 0).uint32(p.hopLimit);
  if (p.wantAck) w.uint32((10 << 3) | 0).bool(true);
  return w.finish();
}

/** ToRadio { packet } */
export function encodeToRadioPacket(p: OutgoingPacket): Uint8Array {
  return Writer.create().uint32((1 << 3) | 2).bytes(encodeMeshPacket(p)).finish();
}

/** ToRadio { want_config_id }: asks the device to send its config and NodeDB, ending with config_complete_id */
export function encodeWantConfig(configId: number): Uint8Array {
  return Writer.create().uint32((3 << 3) | 0).uint32(configId >>> 0).finish();
}

/** ToRadio { heartbeat }: keeps the connection alive */
export function encodeHeartbeat(): Uint8Array {
  return Writer.create().uint32((7 << 3) | 2).bytes(new Uint8Array(0)).finish();
}

/** Random non-zero 32-bit packet id */
export function newPacketId(): number {
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
}

// ---------------------------------------------------------------------------
// Unit helpers

export const KMH_TO_KT = 0.539957;

/**
 * Worst-case distance in metres between a reported position and the real one, from
 * Position.precision_bits (32 or missing = exact). The firmware keeps the top N bits of each
 * coordinate and reports the centre of the remaining square.
 */
/**
 * Hops a packet took: hop_start − hop_limit. proto3 leaves a zero hop_limit off the wire, so a
 * packet that used every hop arrives with hop_start set and hop_limit missing: that means 0.
 */
export function hopsTaken(hopStart: number | undefined, hopLimit: number | undefined): number | undefined {
  if (hopStart === undefined || hopStart === 0) return undefined;
  const limit = hopLimit ?? 0;
  return hopStart >= limit ? hopStart - limit : undefined;
}

export function positionErrorMeters(precisionBits: number | undefined): number | undefined {
  if (precisionBits === undefined || precisionBits === 0 || precisionBits >= 32) return undefined;
  const stepDeg = Math.pow(2, 32 - precisionBits) * 1e-7;
  return Math.round((stepDeg / 2) * 111_320);
}

export function positionLatLng(p: PositionMsg): { lat: number; lng: number } | null {
  if (p.latitudeI === undefined || p.longitudeI === undefined) return null;
  if (p.latitudeI === 0 && p.longitudeI === 0) return null;
  return { lat: p.latitudeI / 1e7, lng: p.longitudeI / 1e7 };
}

/** Ground speed in knots, or undefined if the tracker didn't send it */
export function positionSpeedKt(p: PositionMsg): number | undefined {
  return p.groundSpeed === undefined ? undefined : +(p.groundSpeed * KMH_TO_KT).toFixed(1);
}

/** Ground track in whole degrees, or undefined if the tracker didn't send it */
export function positionTrackDeg(p: PositionMsg): number | undefined {
  return p.groundTrack === undefined ? undefined : Math.round(p.groundTrack / 1e5) % 360;
}

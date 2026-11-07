// Checks our minimal Meshtastic decoder/encoder against the official definitions.
// @meshtastic/protobufs is GPLv3 and is a dev dependency used only here; it is not bundled into the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import { Mesh, Telemetry, Portnums } from '@meshtastic/protobufs';
import {
  decodeFromRadio,
  decodeTelemetry,
  decodePosition,
  encodeToRadioPacket,
  encodeWantConfig,
  encodeHeartbeat,
  positionLatLng,
  positionSpeedKt,
  positionTrackDeg,
  PortNum,
  HARDWARE_MODEL_NAMES,
} from '../src/lib/meshtastic/protocol.ts';

const position = () =>
  create(Mesh.PositionSchema, {
    latitudeI: 63080123,
    longitudeI: 998200456,
    altitude: 12,
    time: 1_790_000_000,
    groundSpeed: 13, // km/h
    groundTrack: 27_150_000, // 271.5°
    satsInView: 9,
    precisionBits: 32,
    // Fields the old decoder confused with speed / heading / sats
    timestampMillisAdjust: -250,
    altitudeHae: 40,
    altitudeGeoidalSeparation: -7,
  });

test('Position: speed, track and sats come from fields 15, 16 and 19', () => {
  const p = decodePosition(toBinary(Mesh.PositionSchema, position()));
  assert.equal(p.latitudeI, 63080123);
  assert.equal(p.longitudeI, 998200456);
  assert.equal(p.altitude, 12);
  assert.equal(p.time, 1_790_000_000);
  assert.equal(p.groundSpeed, 13);
  assert.equal(p.groundTrack, 27_150_000);
  assert.equal(p.satsInView, 9);
  assert.deepEqual(positionLatLng(p), { lat: 6.3080123, lng: 99.8200456 });
  assert.equal(positionSpeedKt(p), 7.0); // 13 km/h
  assert.equal(positionTrackDeg(p), 272);
});

test('Position: negative coordinates and a reported 0 km/h', () => {
  const p = decodePosition(toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, {
    latitudeI: -338688000, longitudeI: -1512093000, groundSpeed: 0, groundTrack: 0,
  })));
  assert.deepEqual(positionLatLng(p), { lat: -33.8688, lng: -151.2093 });
  assert.equal(positionSpeedKt(p), 0, 'explicit 0 is a real reading');
  assert.equal(positionTrackDeg(p), 0);
});

test('Position: speed and track missing when the device does not send them', () => {
  const p = decodePosition(toBinary(Mesh.PositionSchema, create(Mesh.PositionSchema, { latitudeI: 1, longitudeI: 1 })));
  assert.equal(positionSpeedKt(p), undefined);
  assert.equal(positionTrackDeg(p), undefined);
  assert.equal(p.satsInView, undefined);
});

test('FromRadio packet: from, SNR, RSSI, hops and decoded position', () => {
  const pkt = create(Mesh.MeshPacketSchema, {
    from: 0xa1b2c3d4,
    to: 0xffffffff,
    id: 0x01020304,
    rxTime: 1_790_000_100,
    rxSnr: 6.25,
    hopLimit: 2,
    hopStart: 3,
    rxRssi: -97,
    priority: Mesh.MeshPacket_Priority.BACKGROUND,
    payloadVariant: {
      case: 'decoded',
      value: create(Mesh.DataSchema, {
        portnum: Portnums.PortNum.POSITION_APP,
        payload: toBinary(Mesh.PositionSchema, position()),
      }),
    },
  });
  const bytes = toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { id: 5, payloadVariant: { case: 'packet', value: pkt } }));
  const fr = decodeFromRadio(bytes);
  assert.equal(fr.id, 5);
  const p = fr.packet!;
  assert.equal(p.from, 0xa1b2c3d4);
  assert.equal(p.to, 0xffffffff);
  assert.equal(p.rxTime, 1_790_000_100);
  assert.equal(p.rxSnr, 6.25);
  assert.equal(p.rxRssi, -97);
  assert.equal(p.hopLimit, 2);
  assert.equal(p.hopStart, 3);
  assert.equal(p.decoded?.portnum, PortNum.POSITION_APP);
  assert.equal(decodePosition(p.decoded!.payload!).groundSpeed, 13);
});

test('FromRadio queueStatus (field 11) is not mistaken for a packet', () => {
  const bytes = toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, {
    payloadVariant: { case: 'queueStatus', value: create(Mesh.QueueStatusSchema, { res: 0, free: 16, maxlen: 16, meshPacketId: 7 }) },
  }));
  const fr = decodeFromRadio(bytes);
  assert.equal(fr.packet, undefined);
});

test('FromRadio encrypted packet is flagged, not decoded', () => {
  const bytes = toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, {
    payloadVariant: { case: 'packet', value: create(Mesh.MeshPacketSchema, { from: 1, payloadVariant: { case: 'encrypted', value: new Uint8Array([1, 2, 3]) } }) },
  }));
  const p = decodeFromRadio(bytes).packet!;
  assert.equal(p.encrypted, true);
  assert.equal(p.decoded, undefined);
});

test('FromRadio my_info, node_info, metadata and config_complete_id', () => {
  const my = decodeFromRadio(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, {
    payloadVariant: { case: 'myInfo', value: create(Mesh.MyNodeInfoSchema, { myNodeNum: 0xa1b2c3d4, rebootCount: 3 }) },
  })));
  assert.equal(my.myInfo?.myNodeNum, 0xa1b2c3d4);

  const ni = decodeFromRadio(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, {
    payloadVariant: {
      case: 'nodeInfo',
      value: create(Mesh.NodeInfoSchema, {
        num: 0x11223344,
        user: create(Mesh.UserSchema, { id: '!11223344', longName: 'Far node', shortName: 'FAR', hwModel: Mesh.HardwareModel.T_ECHO }),
        position: position(),
        snr: -3.5,
        lastHeard: 1_790_000_000,
        deviceMetrics: create(Telemetry.DeviceMetricsSchema, { batteryLevel: 101, voltage: 4.2 }),
        channel: 1,
        viaMqtt: true,
        hopsAway: 2,
      }),
    },
  }))).nodeInfo!;
  assert.equal(ni.num, 0x11223344);
  assert.deepEqual(ni.user, { id: '!11223344', longName: 'Far node', shortName: 'FAR', hwModel: Mesh.HardwareModel.T_ECHO });
  assert.equal(ni.snr, -3.5);
  assert.equal(ni.lastHeard, 1_790_000_000);
  assert.equal(ni.deviceMetrics?.batteryLevel, 101);
  assert.ok(Math.abs((ni.deviceMetrics?.voltage ?? 0) - 4.2) < 1e-6);
  assert.equal(ni.channel, 1, 'channel (field 7) is not hops_away');
  assert.equal(ni.hopsAway, 2);
  assert.equal(ni.viaMqtt, true);
  assert.equal(ni.position?.groundSpeed, 13);

  const md = decodeFromRadio(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, {
    payloadVariant: { case: 'metadata', value: create(Mesh.DeviceMetadataSchema, { firmwareVersion: '2.6.11.60ec05e', hwModel: Mesh.HardwareModel.T_ECHO }) },
  }))).metadata!;
  assert.equal(md.firmwareVersion, '2.6.11.60ec05e');
  assert.equal(md.hwModel, Mesh.HardwareModel.T_ECHO);

  const done = decodeFromRadio(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, {
    payloadVariant: { case: 'configCompleteId', value: 424242 },
  })));
  assert.equal(done.configCompleteId, 424242);
});

test('Telemetry: device and environment metrics', () => {
  const dm = decodeTelemetry(toBinary(Telemetry.TelemetrySchema, create(Telemetry.TelemetrySchema, {
    time: 1_790_000_000,
    variant: { case: 'deviceMetrics', value: create(Telemetry.DeviceMetricsSchema, { batteryLevel: 87, voltage: 3.98, channelUtilization: 4.5, airUtilTx: 0.75 }) },
  })));
  assert.equal(dm.deviceMetrics?.batteryLevel, 87);
  assert.equal(dm.deviceMetrics?.channelUtilization, 4.5);
  assert.equal(dm.deviceMetrics?.airUtilTx, 0.75);

  const env = decodeTelemetry(toBinary(Telemetry.TelemetrySchema, create(Telemetry.TelemetrySchema, {
    variant: { case: 'environmentMetrics', value: create(Telemetry.EnvironmentMetricsSchema, { temperature: 28.5, relativeHumidity: 74, barometricPressure: 1012.5 }) },
  })));
  assert.equal(env.environmentMetrics?.temperature, 28.5);
  assert.equal(env.environmentMetrics?.relativeHumidity, 74);
  assert.equal(env.environmentMetrics?.barometricPressure, 1012.5);
});

test('ToRadio text packet decodes with the official definitions', () => {
  const bytes = encodeToRadioPacket({
    to: 0x11223344,
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: new TextEncoder().encode('Hello fleet'),
    id: 0xdeadbeef,
    wantAck: true,
    hopLimit: 3,
  });
  const tr = fromBinary(Mesh.ToRadioSchema, bytes);
  assert.equal(tr.payloadVariant.case, 'packet');
  const p = tr.payloadVariant.value as Mesh.MeshPacket;
  assert.equal(p.to, 0x11223344);
  assert.equal(p.id, 0xdeadbeef);
  assert.equal(p.wantAck, true);
  assert.equal(p.hopLimit, 3);
  assert.equal(p.payloadVariant.case, 'decoded');
  const d = p.payloadVariant.value as Mesh.Data;
  assert.equal(d.portnum, Portnums.PortNum.TEXT_MESSAGE_APP);
  assert.equal(new TextDecoder().decode(d.payload), 'Hello fleet');
});

test('ToRadio want_config_id and heartbeat decode with the official definitions', () => {
  const wc = fromBinary(Mesh.ToRadioSchema, encodeWantConfig(123456));
  assert.deepEqual([wc.payloadVariant.case, wc.payloadVariant.value], ['wantConfigId', 123456]);
  const hb = fromBinary(Mesh.ToRadioSchema, encodeHeartbeat());
  assert.equal(hb.payloadVariant.case, 'heartbeat');
});

test('port numbers and hardware model numbers match the official enums', () => {
  assert.equal(PortNum.TEXT_MESSAGE_APP, Portnums.PortNum.TEXT_MESSAGE_APP);
  assert.equal(PortNum.POSITION_APP, Portnums.PortNum.POSITION_APP);
  assert.equal(PortNum.NODEINFO_APP, Portnums.PortNum.NODEINFO_APP);
  assert.equal(PortNum.ROUTING_APP, Portnums.PortNum.ROUTING_APP);
  assert.equal(PortNum.TELEMETRY_APP, Portnums.PortNum.TELEMETRY_APP);
  const expected: Record<string, number> = {
    TLORA_V2_1_1P6: 3, TBEAM: 4, T_ECHO: 7, RAK4631: 9, STATION_G2: 31, T_ECHO_PLUS: 33, HELTEC_V3: 43,
    HELTEC_WSL_V3: 44, HELTEC_WIRELESS_TRACKER: 48, T_DECK: 50, TRACKER_T1000_E: 71, SEEED_XIAO_S3: 81,
    SEEED_WIO_TRACKER_L1: 99, HELTEC_V4: 110,
  };
  for (const [name, num] of Object.entries(expected)) {
    assert.equal((Mesh.HardwareModel as any)[name], num, name);
    assert.ok(HARDWARE_MODEL_NAMES[num], `name for ${name}`);
  }
  // Every name in the table is for a number checked above, so none can sit on the wrong model
  assert.deepEqual(Object.keys(HARDWARE_MODEL_NAMES).map(Number).sort((a, b) => a - b), Object.values(expected).sort((a, b) => a - b));
});

test('hops taken: a missing hop_limit (proto3 zero) means every hop was used', async () => {
  const { hopsTaken } = await import('../src/lib/meshtastic/protocol.ts');
  assert.equal(hopsTaken(3, 1), 2);
  assert.equal(hopsTaken(3, undefined), 3);
  assert.equal(hopsTaken(3, 3), 0);
  assert.equal(hopsTaken(undefined, 2), undefined, 'old firmware without hop_start');
  assert.equal(hopsTaken(2, 5), undefined, 'inconsistent values');
});

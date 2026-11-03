import test from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode, encodeCbor, decodeCbor, decodePayload, validatePacket, MAX_PACKET_BYTES, SOS } from '../src/proto.mjs';
import { encrypt, decrypt, peekHeader, checkFreshness, epochFor, OVERHEAD_BYTES, MAX_AGE_S } from '../src/crypto.mjs';
import { beacon, nowSec } from './helpers.mjs';

/* ---------------- protobuf ---------------- */

test('proto: roundtrip preserves every field', () => {
  const msg = beacon({ duress_flag: true });
  const back = decode(encode(msg));
  for (const k of Object.keys(msg)) assert.equal(back[k], msg[k], k);
});

test('proto: negative coordinates and altitude survive zigzag', () => {
  const msg = beacon({ lat: Math.round(-33.8688 * 1e6), lon: Math.round(-151.2093 * 1e6), altitude_m: -12 });
  const back = decode(encode(msg));
  assert.equal(back.lat, msg.lat);
  assert.equal(back.lon, msg.lon);
  assert.equal(back.altitude_m, -12);
});

test('proto: a typical sealed envelope is well under the 100 byte cap', () => {
  const sealed = encrypt(encode(beacon()), { deviceId: 0x4b21, timestamp: nowSec() });
  assert.ok(sealed.length < MAX_PACKET_BYTES, `got ${sealed.length}`);
  assert.equal(sealed.length, encode(beacon()).length + OVERHEAD_BYTES);
});

/* ---------------- CBOR ---------------- */

test('cbor: roundtrip preserves every field, including negatives and booleans', () => {
  const msg = beacon({ lat: Math.round(-33.8688 * 1e6), altitude_m: -12, duress_flag: true });
  const back = decodeCbor(encodeCbor(msg));
  for (const k of Object.keys(msg)) assert.equal(back[k], msg[k], k);
});

test('cbor: decodePayload tells the two codecs apart', () => {
  const msg = beacon();
  assert.equal(decodePayload(encode(msg)).format, 'protobuf');
  assert.equal(decodePayload(encodeCbor(msg)).format, 'cbor');
  assert.equal(decodePayload(encodeCbor(msg)).msg.sos_code, msg.sos_code);
});

test('cbor: truncated and trailing-garbage input is refused', () => {
  const good = encodeCbor(beacon());
  assert.throws(() => decodeCbor(good.subarray(0, good.length - 2)));
  assert.throws(() => decodeCbor(Buffer.concat([good, Buffer.from([0])])), /trailing/);
});

/* ---------------- validation ---------------- */

test('validate: every range is enforced', () => {
  const ok = (m) => validatePacket(m, 40);
  assert.deepEqual(ok(beacon()), []);
  assert.ok(ok(beacon({ lat: Math.round(120 * 1e6) })).some((e) => /lat/.test(e)));
  assert.ok(ok(beacon({ lon: Math.round(200 * 1e6) })).some((e) => /lon/.test(e)));
  assert.ok(ok(beacon({ sos_code: 8 })).some((e) => /3-bit/.test(e)));
  assert.ok(ok(beacon({ battery_pct: 101 })).some((e) => /battery/.test(e)));
  assert.ok(ok(beacon({ altitude_m: 40000 })).some((e) => /int16/.test(e)));
  assert.ok(ok(beacon({ spo2: 30 })).some((e) => /spo2/.test(e)));
  assert.ok(ok(beacon({ heart_rate: 300 })).some((e) => /heart_rate/.test(e)));
  assert.ok(validatePacket(beacon(), 100).some((e) => /cap/.test(e)));
  assert.ok(validatePacket({ device_id: 1 }, 10).some((e) => /missing/.test(e)));
});

test('validate: spo2 of 0 means unknown and is accepted', () => {
  assert.deepEqual(validatePacket(beacon({ spo2: 0, heart_rate: 0 }), 40), []);
});

test('sos enum: cancel is code 7 and the enum fits 3 bits', () => {
  assert.equal(SOS.CANCEL, 7);
  assert.ok(Math.max(...Object.values(SOS)) <= 7);
});

/* ---------------- crypto ---------------- */

const T = nowSec();

test('crypto: roundtrip recovers the payload, device and epoch', () => {
  const p = encode(beacon());
  const env = encrypt(p, { deviceId: 77, timestamp: T });
  const out = decrypt(env);
  assert.deepEqual(Buffer.from(out.payload), Buffer.from(p));
  assert.equal(out.deviceId, 77);
  assert.equal(out.epoch, epochFor(T));
  assert.deepEqual(peekHeader(env), { deviceId: 77, epoch: epochFor(T) });
});

test('crypto: tampered ciphertext fails authentication', () => {
  const env = encrypt(encode(beacon()), { deviceId: 77, timestamp: T });
  env[env.length - 1] ^= 0xff;
  assert.throws(() => decrypt(env));
});

test('crypto: a device cannot claim another device id (header is bound as AAD)', () => {
  const env = encrypt(encode(beacon({ device_id: 1 })), { deviceId: 1, timestamp: T });
  env.writeUInt32BE(2, 1); // rewrite header device_id 1 -> 2
  assert.throws(() => decrypt(env));
});

test('crypto: rewriting the epoch fails (keys rotate per epoch)', () => {
  const env = encrypt(encode(beacon()), { deviceId: 5, timestamp: T });
  env.writeUInt16BE((epochFor(T) + 1) & 0xffff, 5);
  assert.throws(() => decrypt(env));
});

test('crypto: two envelopes of the same payload differ (random IV)', () => {
  const a = encrypt(encode(beacon()), { deviceId: 5, timestamp: T });
  const b = encrypt(encode(beacon()), { deviceId: 5, timestamp: T });
  assert.notDeepEqual(a, b);
});

test('crypto: short and wrong-version envelopes are refused', () => {
  assert.throws(() => peekHeader(Buffer.alloc(10)), /too short/);
  const env = encrypt(encode(beacon()), { deviceId: 5, timestamp: T });
  env[0] = 9;
  assert.throws(() => peekHeader(env), /version/);
});

/* ---------------- freshness ---------------- */

test('freshness: late mesh packets are accepted and their age is reported', () => {
  const r = checkFreshness(T - 1800, T);
  assert.equal(r.ok, true);
  assert.equal(r.age_s, 1800);
});

test('freshness: far-future and ancient beacons are refused', () => {
  assert.match(checkFreshness(T + 4000, T).reason, /future/);
  assert.match(checkFreshness(T - MAX_AGE_S - 10, T).reason, /old/);
  assert.equal(checkFreshness(NaN, T).ok, false);
});

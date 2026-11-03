import test from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode, validatePacket, MAX_PACKET_BYTES } from '../src/proto.mjs';
import { encrypt, decrypt, checkReplay, _resetReplayState } from '../src/crypto.mjs';
import { canTransition, applyTransition } from '../src/state.mjs';
import { triage } from '../src/triage.mjs';
import { geoContext, _clearCache } from '../src/geo.mjs';
import { createApp } from '../src/server.mjs';

const beacon = (over = {}) => ({
  device_id: 0x4b21,
  timestamp: 1_760_000_000,
  lat: Math.round(25.2048 * 1e6),
  lon: Math.round(55.2708 * 1e6),
  altitude_m: 14,
  sos_code: 2,
  heart_rate: 118,
  spo2: 91,
  battery_pct: 43,
  duress_flag: false,
  ...over,
});

/* ---------------- Phase 0/1: wire format ---------------- */

test('proto: roundtrip preserves every field', () => {
  const msg = beacon({ duress_flag: true });
  const buf = encode(msg);
  const back = decode(buf);
  assert.equal(back.device_id, msg.device_id);
  assert.equal(back.timestamp, msg.timestamp);
  assert.equal(back.lat, msg.lat);
  assert.equal(back.lon, msg.lon);
  assert.equal(back.altitude_m, msg.altitude_m);
  assert.equal(back.sos_code, msg.sos_code);
  assert.equal(back.heart_rate, msg.heart_rate);
  assert.equal(back.spo2, msg.spo2);
  assert.equal(back.battery_pct, msg.battery_pct);
  assert.equal(back.duress_flag, true);
});

test('proto: negative coordinates survive zigzag', () => {
  const msg = beacon({ lat: Math.round(-33.8688 * 1e6), lon: Math.round(-151.2093 * 1e6), altitude_m: -12 });
  const back = decode(encode(msg));
  assert.equal(back.lat, msg.lat);
  assert.equal(back.lon, msg.lon);
  assert.equal(back.altitude_m, -12);
});

test('proto: typical packet is well under the 100 byte cap', () => {
  const len = encode(beacon()).length;
  assert.ok(len < MAX_PACKET_BYTES, `expected <${MAX_PACKET_BYTES}, got ${len}`);
  assert.ok(len < 45, `expected a small packet, got ${len}`);
});

test('proto: oversize packet is rejected by validation', () => {
  const padded = encode(beacon({ ext: Buffer.alloc(120, 0xaa) }));
  const errors = validatePacket(decode(padded), padded.length);
  assert.ok(errors.some((e) => e.includes('cap')), errors.join('; '));
});

test('proto: out-of-range latitude is rejected', () => {
  const msg = beacon({ lat: Math.round(120 * 1e6) });
  const errors = validatePacket(msg, encode(msg).length);
  assert.ok(errors.some((e) => e.includes('lat out of range')));
});

/* ---------------- Phase 1: crypto + replay ---------------- */

test('crypto: encrypt/decrypt roundtrip', () => {
  const plain = encode(beacon());
  const env = encrypt(plain);
  const { payload, keyId } = decrypt(env);
  assert.equal(keyId, 'k1');
  assert.deepEqual(Buffer.from(payload), Buffer.from(plain));
});

test('crypto: tampered ciphertext fails authentication', () => {
  const env = encrypt(encode(beacon()));
  env[env.length - 1] ^= 0xff;
  assert.throws(() => decrypt(env), /authenticate|Unsupported state|bad decrypt/i);
});

test('crypto: wrong key ring entry fails authentication', () => {
  const env = encrypt(encode(beacon()), 'k2');
  assert.equal(decrypt(env).keyId, 'k2');
  env[1] = 1; // claim k1
  assert.throws(() => decrypt(env));
});

test('replay: identical beacon is rejected the second time', () => {
  _resetReplayState();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(checkReplay(0x4b21, now).ok, true);
  const second = checkReplay(0x4b21, now);
  assert.equal(second.ok, false);
  assert.match(second.reason, /replay/);
});

test('replay: stale timestamp outside the window is rejected', () => {
  _resetReplayState();
  const r = checkReplay(0x999, Math.floor(Date.now() / 1000) - 600);
  assert.equal(r.ok, false);
  assert.match(r.reason, /window/);
});

/* ---------------- Phase 0: CAD state machine ---------------- */

test('state: legal path is accepted and audited', () => {
  const inc = { id: 'INC-0001', state: 'SOS_RECEIVED', audit: [] };
  assert.equal(canTransition('SOS_RECEIVED', 'AI_TRIAGED', 'system').ok, true);
  const r = applyTransition(inc, 'AI_TRIAGED', 'system', 'triage');
  assert.equal(r.ok, true);
  assert.equal(inc.state, 'AI_TRIAGED');
  assert.equal(inc.audit.length, 1);
  assert.equal(inc.audit[0].actor, 'system');
});

test('state: illegal jump is refused and state unchanged', () => {
  const inc = { id: 'INC-0002', state: 'SOS_RECEIVED', audit: [] };
  const r = applyTransition(inc, 'EXTRACTED', 'dispatcher', 'skip');
  assert.equal(r.ok, false);
  assert.equal(inc.state, 'SOS_RECEIVED');
  assert.equal(inc.audit.length, 0);
});

test('state: wrong actor is refused', () => {
  const inc = { id: 'INC-0003', state: 'AI_TRIAGED', audit: [] };
  const r = applyTransition(inc, 'UNIT_ASSIGNED', 'unit', 'unit tries to self-assign');
  assert.equal(r.ok, false);
  assert.match(r.reason, /may not perform/);
});

/* ---------------- Phase 3: triage ---------------- */

const fakeIncident = (over = {}) => ({
  id: 'INC-0001',
  sos_code: 2,
  position: { lat: 25.2048, lon: 55.2708, altitude_m: 10 },
  vitals: { heart_rate: 118, spo2: 91, battery_pct: 43, duress_flag: false },
  ...over,
});

test('triage: SpO2 below 90 forces P1', async () => {
  const inc = fakeIncident({ vitals: { heart_rate: 100, spo2: 84, battery_pct: 80, duress_flag: false } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.priority, 'P1');
  assert.equal(out.status, 'OK');
  assert.ok(out.grounding.length > 0);
  assert.ok(out.grounding.every((g) => g.source === 'LOCAL_KB' && g.chunk_id));
});

test('triage: low battery without critical vitals is P2', async () => {
  const inc = fakeIncident({ vitals: { heart_rate: 88, spo2: 97, battery_pct: 11, duress_flag: false } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.priority, 'P2');
});

test('triage: calm casualty is P3', async () => {
  const inc = fakeIncident({ vitals: { heart_rate: 76, spo2: 98, battery_pct: 91, duress_flag: false } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.priority, 'P3');
});

test('triage: duress flag is covert and suppresses detail', async () => {
  const inc = fakeIncident({ sos_code: 3, vitals: { heart_rate: 128, spo2: 93, battery_pct: 61, duress_flag: true } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.triage_category, 'HOSTAGE_COVERT');
  assert.equal(out.priority, 'P1');
  assert.equal(out.user_satellite_reply, 'HAPTIC_ACK_ONLY');
});

test('triage: every category produces a legal downlink', async () => {
  const ctx = await geoContext(25.2048, 55.2708);
  for (const sos_code of [0, 1, 2, 3, 4, 5, 6]) {
    const out = await triage({ incident: fakeIncident({ sos_code }), context: ctx });
    const r = out.user_satellite_reply;
    assert.ok(r.length > 0 && r.length <= 160, `len ${r.length} for sos ${sos_code}`);
    assert.match(r, /^[\x20-\x7E]+$/, `non-ascii reply for sos ${sos_code}`);
  }
});

test('triage: missing context says so instead of inventing', async () => {
  const out = await triage({ incident: fakeIncident(), context: null });
  assert.equal(out.status, 'CONTEXT_MISSING');
  assert.deepEqual(out.geo_facts, []);
  assert.deepEqual(out.grounding, []);
});

test('geo: context is cached and deterministic', async () => {
  _clearCache();
  const a = await geoContext(25.1, 55.2);
  const b = await geoContext(25.1, 55.2);
  assert.equal(a.cache, 'MISS');
  assert.equal(b.cache, 'HIT');
  assert.deepEqual(a.hazards, b.hazards);
  assert.ok(a.hospitals.length >= 2);
});

/* ---------------- integration: HTTP + ingest ---------------- */

async function withServer(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('http: simulate -> list -> transition -> downlink', async () => {
  await withServer(async (base) => {
    const post = (p, body) =>
      fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const created = await post('/api/v1/dev/simulate', { sos_code: 2, heart_rate: 140, spo2: 87, battery_pct: 30 });
    assert.equal(created.status, 201);
    const inc = await created.json();
    assert.match(inc.incident_id, /^INC-\d{4}$/);
    assert.equal(inc.state, 'AI_TRIAGED');
    assert.equal(inc.triage.priority, 'P1');
    assert.ok(inc.packet_bytes < MAX_PACKET_BYTES);

    const list = await (await fetch(base + '/api/v1/incidents')).json();
    assert.equal(list.incidents.length, 1);

    const ok = await post(`/api/v1/incidents/${inc.incident_id}/transition`, {
      to: 'UNIT_ASSIGNED', actor: 'dispatcher', reason: 'eta 18 min',
    });
    assert.equal(ok.status, 200);

    const bad = await post(`/api/v1/incidents/${inc.incident_id}/transition`, {
      to: 'CLOSED', actor: 'dispatcher', reason: 'skip ahead',
    });
    assert.equal(bad.status, 200, 'CLOSED is legal from UNIT_ASSIGNED by dispatcher');

    const long = await post(`/api/v1/incidents/${inc.incident_id}/downlink`, { text: 'x'.repeat(170) });
    assert.equal(long.status, 422);

    const good = await post(`/api/v1/incidents/${inc.incident_id}/downlink`, { text: 'ACK P1. HELP EN ROUTE ETA 18 MIN.' });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).chars, 33);

    const full = await (await fetch(base + `/api/v1/incidents/${inc.incident_id}`)).json();
    assert.ok(full.audit.length >= 3, 'audit trail records creation, triage, transition');
  });
});

test('http: tampered envelope is refused at the gateway', async () => {
  await withServer(async (base) => {
    const env = encrypt(encode(beacon({ timestamp: Math.floor(Date.now() / 1000) })));
    env[env.length - 3] ^= 0x01;
    const res = await fetch(base + '/api/v1/sat-ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope_base64: env.toString('base64') }),
    });
    assert.equal(res.status, 401);
  });
});

test('http: replay of the same envelope is refused', async () => {
  await withServer(async (base) => {
    const env = encrypt(encode(beacon({ timestamp: Math.floor(Date.now() / 1000) })));
    const send = () =>
      fetch(base + '/api/v1/sat-ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope_base64: env.toString('base64') }),
      });
    const first = await send();
    assert.equal(first.status, 201);
    const second = await send();
    assert.equal(second.status, 409);
  });
});

test('http: health reports feature status honestly', async () => {
  await withServer(async (base) => {
    const h = await (await fetch(base + '/api/v1/health')).json();
    assert.equal(h.ok, true);
    assert.equal(h.llm.enabled, false);
    assert.equal(h.llm.status, 'DISABLED');
    assert.ok(h.key_ids.includes('k1'));
  });
});

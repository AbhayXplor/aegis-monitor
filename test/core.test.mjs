import test from 'node:test';
import assert from 'node:assert/strict';

import { encode, decode, validatePacket, MAX_PACKET_BYTES } from '../src/proto.mjs';
import { encrypt, decrypt, checkReplay, _resetReplayState } from '../src/crypto.mjs';
import { canTransition, applyTransition } from '../src/state.mjs';
import { triage, priorityLevel, triageCategory, bearingDeg, compass, reRank, groundingFor } from '../src/triage.mjs';
import { geoContext, _clearCache } from '../src/geo.mjs';
import { classifyGesture, hapticPattern, covertPolicy, nextBurstSeconds, pollPPG, meshRelay, gestureToBeacon, MESH_MAX_HOPS, GESTURE } from '../src/wristband.mjs';
import { createApp } from '../src/server.mjs';

const beacon = (over = {}) => ({
  device_id: 0x4b21, timestamp: 1_760_000_000,
  lat: Math.round(25.2048 * 1e6), lon: Math.round(55.2708 * 1e6),
  altitude_m: 14, sos_code: 2, heart_rate: 118, spo2: 91, battery_pct: 43, duress_flag: false,
  ...over,
});

const fakeIncident = (over = {}) => ({
  id: 'INC-0001', sos_code: 2,
  position: { lat: 25.2048, lon: 55.2708, altitude_m: 10 },
  vitals: { heart_rate: 118, spo2: 91, battery_pct: 43, duress_flag: false },
  ...over,
});

const SCHEMA_KEYS = ['incident_id', 'priority_level', 'triage_category', 'physiological_status',
  'hazard_assessment', 'deconflicted_route_plan', 'dispatcher_checklist', 'user_satellite_reply'];

/* ---------------- wire format ---------------- */

test('proto: roundtrip preserves every field', () => {
  const msg = beacon({ duress_flag: true });
  const back = decode(encode(msg));
  for (const k of Object.keys(msg)) assert.equal(back[k], msg[k], k);
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
  assert.ok(len < MAX_PACKET_BYTES, `got ${len}`);
  assert.ok(len < 45, `expected a small packet, got ${len}`);
});

test('proto: oversize packet is rejected', () => {
  const padded = encode(beacon({ ext: Buffer.alloc(120, 0xaa) }));
  assert.ok(validatePacket(decode(padded), padded.length).some((e) => e.includes('cap')));
});

test('proto: out-of-range latitude is rejected', () => {
  const msg = beacon({ lat: Math.round(120 * 1e6) });
  assert.ok(validatePacket(msg, encode(msg).length).some((e) => e.includes('lat out of range')));
});

/* ---------------- crypto ---------------- */

test('crypto: encrypt/decrypt roundtrip', () => {
  const plain = encode(beacon());
  const { payload, keyId } = decrypt(encrypt(plain));
  assert.equal(keyId, 'k1');
  assert.deepEqual(Buffer.from(payload), Buffer.from(plain));
});

test('crypto: tampered ciphertext fails authentication', () => {
  const env = encrypt(encode(beacon()));
  env[env.length - 1] ^= 0xff;
  assert.throws(() => decrypt(env));
});

test('crypto: forged key id fails authentication', () => {
  const env = encrypt(encode(beacon()), 'k2');
  env[1] = 1;
  assert.throws(() => decrypt(env));
});

test('replay: identical beacon rejected the second time', () => {
  _resetReplayState();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(checkReplay(0x4b21, now).ok, true);
  const second = checkReplay(0x4b21, now);
  assert.equal(second.ok, false);
  assert.match(second.reason, /replay/);
});

test('replay: stale timestamp rejected', () => {
  _resetReplayState();
  const r = checkReplay(0x999, Math.floor(Date.now() / 1000) - 600);
  assert.equal(r.ok, false);
  assert.match(r.reason, /window/);
});

/* ---------------- state machine ---------------- */

test('state: legal path accepted and audited', () => {
  const inc = { id: 'INC-0001', state: 'SOS_RECEIVED', audit: [] };
  assert.equal(applyTransition(inc, 'AI_TRIAGED', 'system', 'triage').ok, true);
  assert.equal(inc.state, 'AI_TRIAGED');
  assert.equal(inc.audit[0].actor, 'system');
});

test('state: illegal jump refused, state unchanged', () => {
  const inc = { id: 'INC-0002', state: 'SOS_RECEIVED', audit: [] };
  assert.equal(applyTransition(inc, 'EXTRACTED', 'dispatcher', 'skip').ok, false);
  assert.equal(inc.state, 'SOS_RECEIVED');
  assert.equal(inc.audit.length, 0);
});

test('state: wrong actor refused', () => {
  const inc = { id: 'INC-0003', state: 'AI_TRIAGED', audit: [] };
  const r = applyTransition(inc, 'UNIT_ASSIGNED', 'unit', 'self assign');
  assert.equal(r.ok, false);
  assert.match(r.reason, /may not perform/);
});

/* ---------------- triage: schema + rules ---------------- */

test('triage: output matches the brief schema exactly', async () => {
  const out = await triage({ incident: fakeIncident(), context: await geoContext(25.2048, 55.2708) });
  assert.deepEqual(Object.keys(out.triage).sort(), SCHEMA_KEYS.slice().sort());
  assert.equal(typeof out.triage.priority_level, 'number');
  assert.ok(out.triage.priority_level >= 1 && out.triage.priority_level <= 5);
  assert.equal(out.triage.dispatcher_checklist.length, 3);
  assert.ok(out.triage.dispatcher_checklist.every((c) => typeof c === 'string' && c.length > 0));
});

test('triage: SpO2 below 90 forces priority 1', async () => {
  const inc = fakeIncident({ vitals: { heart_rate: 100, spo2: 84, battery_pct: 80, duress_flag: false } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.triage.priority_level, 1);
  assert.equal(out.triage.triage_category, 'MEDEVAC');
});

test('triage: heart rate above 130 forces priority 1', async () => {
  const inc = fakeIncident({ vitals: { heart_rate: 141, spo2: 96, battery_pct: 80, duress_flag: false } });
  assert.equal((await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) })).triage.priority_level, 1);
});

test('triage: duress is covert, priority 1, and haptic-only', async () => {
  const inc = fakeIncident({ sos_code: 3, vitals: { heart_rate: 128, spo2: 93, battery_pct: 61, duress_flag: true } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.triage.triage_category, 'HOSTAGE_COVERT');
  assert.equal(out.triage.priority_level, 1);
  assert.equal(out.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
  assert.match(out.triage.dispatcher_checklist.join(' '), /unencrypted|silent|off-air/i);
});

test('triage: hostile without duress is combat extraction', () => {
  assert.equal(triageCategory({ sos_code: 3, vitals: { duress_flag: false } }), 'COMBAT_EXTRACTION');
});

test('triage: water request is a supply drop at priority 5', async () => {
  const inc = fakeIncident({ sos_code: 5, vitals: { heart_rate: 84, spo2: 97, battery_pct: 70, duress_flag: false } });
  const out = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  assert.equal(out.triage.priority_level, 5);
  assert.equal(out.triage.triage_category, 'SUPPLY_DROP');
  assert.match(out.triage.deconflicted_route_plan, /DRONE/);
});

test('triage: unknown SOS is search and rescue', () => {
  assert.equal(triageCategory({ sos_code: 0, vitals: {} }), 'SAR');
});

test('triage: every SOS code yields a legal ASCII downlink', async () => {
  const ctx = await geoContext(25.2048, 55.2708);
  for (const sos_code of [0, 1, 2, 3, 4, 5, 6]) {
    const out = await triage({ incident: fakeIncident({ sos_code }), context: ctx });
    const r = out.triage.user_satellite_reply;
    assert.ok(r.length > 0 && r.length <= 160, `len ${r.length} sos ${sos_code}`);
    assert.match(r, /^[\x20-\x7E]+$/, `non-ascii sos ${sos_code}`);
  }
});

test('triage: missing context declares itself and invents nothing', async () => {
  const out = await triage({ incident: fakeIncident(), context: null });
  assert.match(out.triage.hazard_assessment, /CONTEXT_MISSING/);
  assert.match(out.triage.deconflicted_route_plan, /NO PLAN/);
  assert.equal(out.triage.dispatcher_checklist.length, 3);
});

test('triage: route plan names a transport mode and a compass vector', async () => {
  const out = await triage({ incident: fakeIncident(), context: await geoContext(25.2048, 55.2708) });
  assert.match(out.triage.deconflicted_route_plan, /GROUND|HELI|DRONE/);
  assert.match(out.triage.deconflicted_route_plan, /APPROACH \d{3}° /);
});

test('triage: grounding always cites local chunks', async () => {
  const ctx = await geoContext(25.2048, 55.2708);
  for (const sos_code of [0, 1, 2, 3, 4, 5, 6]) {
    const out = await triage({ incident: fakeIncident({ sos_code }), context: ctx });
    assert.ok(out.grounding.length > 0);
    assert.ok(out.grounding.every((g) => g.source === 'LOCAL_KB' && g.chunk_id && g.quote));
  }
  assert.ok(groundingFor('HOSTAGE_COVERT', 1).some((g) => g.topic === 'HOSTAGE'));
});

test('triage: priority table maps all five levels', () => {
  assert.equal(priorityLevel({ sos_code: 2, vitals: { duress_flag: true } }), 1);
  assert.equal(priorityLevel({ sos_code: 2, vitals: { spo2: 88 } }), 1);
  assert.equal(priorityLevel({ sos_code: 2, vitals: { spo2: 96, heart_rate: 90 } }), 2);
  assert.equal(priorityLevel({ sos_code: 0, vitals: { battery_pct: 40 } }), 3);
  assert.equal(priorityLevel({ sos_code: 4, vitals: {} }), 4);
  assert.equal(priorityLevel({ sos_code: 5, vitals: {} }), 5);
});

test('geo: bearing and compass agree', () => {
  const deg = bearingDeg({ lat: 25.0, lon: 55.0 }, { lat: 25.1, lon: 55.0 });
  assert.equal(compass(deg), 'N');
  assert.equal(compass(bearingDeg({ lat: 25.0, lon: 55.0 }, { lat: 25.0, lon: 55.1 })), 'E');
});

test('rerank: deteriorating vitals escalate an active incident', async () => {
  const inc = fakeIncident({ vitals: { heart_rate: 96, spo2: 96, battery_pct: 80, duress_flag: false } });
  const { triage: t } = await triage({ incident: inc, context: await geoContext(25.2048, 55.2708) });
  inc.triage = t;
  assert.equal(t.priority_level, 2);
  inc.vitals.spo2 = 82; // new packet shows deterioration
  const changes = reRank([inc]);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { incident_id: 'INC-0001', from: 2, to: 1 });
  assert.equal(inc.triage.priority_level, 1);
  assert.equal(reRank([inc]).length, 0, 'idempotent when nothing changed');
});

/* ---------------- wristband ---------------- */

test('wristband: 3 presses medical, 5 hostile, hold cancels, others ignored', () => {
  assert.equal(classifyGesture(3, 0), GESTURE.MEDICAL_SOS);
  assert.equal(classifyGesture(5, 0), GESTURE.HOSTILE_EXTRACTION);
  assert.equal(classifyGesture(9, 10_000), GESTURE.CANCEL);
  assert.equal(classifyGesture(1, 0), null);
  assert.equal(classifyGesture(2, 0), null);
  assert.equal(classifyGesture(4, 0), null);
});

test('wristband: gestures map to the right beacon fields', () => {
  const medical = gestureToBeacon({ gesture: GESTURE.MEDICAL_SOS, device_id: 1, timestamp: 1, lat: 0, lon: 0 });
  assert.equal(medical.sos_code, 2);
  assert.equal(medical.duress_flag, false);
  const hostile = gestureToBeacon({ gesture: GESTURE.HOSTILE_EXTRACTION, device_id: 1, timestamp: 1, lat: 0, lon: 0 });
  assert.equal(hostile.sos_code, 3);
  assert.equal(hostile.duress_flag, true);
  assert.equal(gestureToBeacon({ gesture: GESTURE.CANCEL, device_id: 1, timestamp: 1, lat: 0, lon: 0 }), null);
});

test('wristband: haptic patterns are distinct and well formed', () => {
  const dur = (p) => p.reduce((sum, s) => sum + (s.ms || 0) + (s.gap || 0), 0);
  const sent = hapticPattern('SENT');
  const ack = hapticPattern('ACK');
  const dispatched = hapticPattern('DISPATCHED');

  // the wearer must be able to tell them apart by length alone
  assert.ok(dur(sent) < dur(ack), `${dur(sent)} vs ${dur(ack)}`);
  assert.ok(dur(ack) < dur(dispatched), `${dur(ack)} vs ${dur(dispatched)}`);
  assert.notDeepEqual(sent, ack);
  assert.notDeepEqual(ack, dispatched);

  for (const p of [sent, ack, dispatched]) {
    assert.ok(p.every((s) => s.ms || s.gap));
    assert.ok(p.some((s) => s.ms && s.ms > 0));
  }
  assert.throws(() => hapticPattern('NOPE'));
});

test('wristband: covert policy silences the device and jitters bursts', () => {
  const normal = covertPolicy({ duress: false });
  assert.equal(normal.leds, true);
  assert.deepEqual(normal.burstIntervalS, [300, 300]);
  const covert = covertPolicy({ duress: true });
  assert.equal(covert.leds, false);
  assert.equal(covert.sound, false);
  assert.equal(covert.wipeLocalLog, true);
  const a = nextBurstSeconds(covert, () => 0);
  const b = nextBurstSeconds(covert, () => 1);
  assert.equal(a, 90);
  assert.equal(b, 260);
});

test('wristband: PPG stub is deterministic and in range', () => {
  const a = pollPPG(7);
  const b = pollPPG(7);
  assert.deepEqual(a, b);
  assert.ok(a.heart_rate >= 62 && a.heart_rate <= 132);
  assert.ok(a.spo2 >= 88 && a.spo2 <= 99);
});

test('mesh: relay honours the hop limit', () => {
  assert.equal(meshRelay({ packet: 'x', hops: 1 }).delivered, true);
  const tooFar = meshRelay({ packet: 'x', hops: MESH_MAX_HOPS + 1 });
  assert.equal(tooFar.delivered, false);
  assert.match(tooFar.reason, /hop limit/);
});

/* ---------------- integration ---------------- */

async function withServer(fn) {
  const server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('http: simulate -> list -> transition -> downlink', async () => {
  await withServer(async (base) => {
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const created = await post('/api/v1/dev/simulate', { sos_code: 2, heart_rate: 140, spo2: 87, battery_pct: 30 });
    assert.equal(created.status, 201);
    const inc = await created.json();
    assert.equal(inc.state, 'AI_TRIAGED');
    assert.equal(inc.triage.priority_level, 1);
    assert.ok(inc.packet_bytes < MAX_PACKET_BYTES);
    assert.deepEqual(Object.keys(inc.triage).sort(), SCHEMA_KEYS.slice().sort());

    const list = await (await fetch(base + '/api/v1/incidents')).json();
    assert.equal(list.incidents.length, 1);

    assert.equal((await post(`/api/v1/incidents/${inc.incident_id}/transition`, { to: 'UNIT_ASSIGNED', actor: 'dispatcher', reason: 'eta 18' })).status, 200);
    assert.equal((await post(`/api/v1/incidents/${inc.incident_id}/transition`, { to: 'EXTRACTED', actor: 'dispatcher', reason: 'skip' })).status, 409);

    assert.equal((await post(`/api/v1/incidents/${inc.incident_id}/downlink`, { text: 'x'.repeat(170) })).status, 422);
    const good = await post(`/api/v1/incidents/${inc.incident_id}/downlink`, { text: 'ACK P1. STAY STILL. HELP EN ROUTE.' });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).chars, 34);

    const full = await (await fetch(base + `/api/v1/incidents/${inc.incident_id}`)).json();
    assert.ok(full.audit.length >= 3);
    assert.ok(full.battery_eta_min > 0);
  });
});

test('http: wristband 3-press produces a medical incident', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/v1/dev/wristband', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presses: 3, held_ms: 0, use_ppg: true, heart_rate: 132, spo2: 89 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.gesture, GESTURE.MEDICAL_SOS);
    assert.equal(body.triage.triage_category, 'MEDEVAC');
    assert.equal(body.triage.priority_level, 1);
    assert.ok(body.packet_bytes < MAX_PACKET_BYTES);
    assert.equal(body.covert.silent, false);
    assert.ok(Array.isArray(body.haptic));
  });
});

test('http: wristband 5-press is covert and refuses a plaintext downlink', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/v1/dev/wristband', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presses: 5, held_ms: 0 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.triage.triage_category, 'HOSTAGE_COVERT');
    assert.equal(body.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.equal(body.covert.silent, true);
    assert.equal(body.covert.leds, false);

    const bad = await fetch(base + `/api/v1/incidents/${body.incident_id}/downlink`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'SEND HELI' }),
    });
    assert.equal(bad.status, 409);

    const ok = await fetch(base + `/api/v1/incidents/${body.incident_id}/downlink`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'HAPTIC_ACK_ONLY' }),
    });
    assert.equal(ok.status, 200);
  });
});

test('http: 4 presses is refused as an accidental gesture', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/v1/dev/wristband', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presses: 4, held_ms: 0 }),
    });
    assert.equal(res.status, 400);
  });
});

test('http: mesh relay delivers within the hop limit and refuses beyond it', async () => {
  await withServer(async (base) => {
    const ok = await fetch(base + '/api/v1/dev/mesh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hops: 2 }),
    });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.delivered, true);
    assert.equal(body.remaining, 1);

    const far = await fetch(base + '/api/v1/dev/mesh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hops: MESH_MAX_HOPS + 1 }),
    });
    assert.equal(far.status, 422);
  });
});

test('http: tampered envelope refused at the gateway', async () => {
  await withServer(async (base) => {
    const env = encrypt(encode(beacon({ timestamp: Math.floor(Date.now() / 1000) })));
    env[env.length - 3] ^= 0x01;
    const res = await fetch(base + '/api/v1/sat-ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope_base64: env.toString('base64') }),
    });
    assert.equal(res.status, 401);
  });
});

test('http: replay of the same envelope refused', async () => {
  await withServer(async (base) => {
    const env = encrypt(encode(beacon({ timestamp: Math.floor(Date.now() / 1000) })));
    const send = () => fetch(base + '/api/v1/sat-ingest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope_base64: env.toString('base64') }),
    });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 409);
  });
});

test('http: health reports honest feature status', async () => {
  await withServer(async (base) => {
    const h = await (await fetch(base + '/api/v1/health')).json();
    assert.equal(h.ok, true);
    assert.equal(h.llm.enabled, false);
    assert.equal(h.llm.status, 'DISABLED');
    assert.equal(h.mesh_max_hops, 3);
    assert.ok(h.key_ids.includes('k1'));
  });
});

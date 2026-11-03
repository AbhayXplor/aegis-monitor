import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeService, send, beacon, freshDevice, nowSec } from './helpers.mjs';
import { createService, batteryEstimate, HttpError } from '../src/service.mjs';
import { createGeo } from '../src/geo.mjs';
import { SOS } from '../src/proto.mjs';
import { encrypt } from '../src/crypto.mjs';
import { encode } from '../src/proto.mjs';

const rejects = async (p, status, re) => {
  await assert.rejects(p, (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)), `expected HTTP ${status}`);
};

/* ---------------- ingest ---------------- */

test('ingest: a valid beacon creates an AI_TRIAGED incident with raw telemetry stored', async () => {
  const svc = makeService();
  const { result, envelope } = await send(svc, { device_id: freshDevice() });
  assert.equal(result.action, 'CREATED');
  assert.equal(result.incident.state, 'AI_TRIAGED');
  assert.equal(svc.store.telemetryCount(), 1);
  assert.deepEqual(svc.store.telemetryFor(result.incident.id)[0].envelope_bytes, envelope.length);
  assert.equal(svc.health().telemetry_rows, 1);
});

test('ingest: tampered, forged and oversize envelopes are refused with the right status', async () => {
  const svc = makeService();
  const env = svc.sealBeacon(beacon({ device_id: freshDevice() }));
  const bad = Buffer.from(env);
  bad[bad.length - 1] ^= 1;
  await rejects(svc.ingest(bad), 401);
  const forged = Buffer.from(env);
  forged.writeUInt32BE(forged.readUInt32BE(1) + 1, 1);
  await rejects(svc.ingest(forged), 401);
  await rejects(svc.ingest(Buffer.alloc(120, 1)), 413);
  await rejects(svc.ingest(Buffer.alloc(5)), 422);
  assert.equal(svc.counters.rejected, 4);
});

test('ingest: an envelope whose payload names another device is refused', async () => {
  const svc = makeService();
  const d = freshDevice();
  const msg = beacon({ device_id: d + 1 }); // payload says d+1 ...
  const env = encrypt(encode(msg), { deviceId: d, timestamp: msg.timestamp }); // ... sealed as d
  await rejects(svc.ingest(env), 401, /header does not match/);
});

test('ingest: the same envelope arriving twice (two mesh paths) is idempotent, not an error', async () => {
  const svc = makeService();
  const env = svc.sealBeacon(beacon({ device_id: freshDevice() }));
  const a = await svc.ingest(env);
  const b = await svc.ingest(env);
  assert.equal(b.duplicate, true);
  assert.equal(b.incident.id, a.incident.id);
  assert.equal(svc.counters.duplicates, 1);
  assert.equal(svc.store.telemetryCount(), 1);
});

test('ingest: a replayed (older) timestamp for a known device is refused', async () => {
  const svc = makeService();
  const d = freshDevice();
  const t = nowSec() + 50;
  await svc.ingest(svc.sealBeacon(beacon({ device_id: d, timestamp: t })));
  await rejects(svc.ingest(svc.sealBeacon(beacon({ device_id: d, timestamp: t - 5 }))), 409, /replay/);
  await rejects(svc.ingest(svc.sealBeacon(beacon({ device_id: d, timestamp: t }))), 409, /replay/);
});

test('ingest: a stale mesh packet is accepted, flagged with its age, and triaged as old', async () => {
  const svc = makeService();
  const { result } = await send(svc, { device_id: freshDevice(), timestamp: nowSec() - 1800 });
  assert.ok(result.incident.age_s >= 1800);
  assert.match(result.incident.triage.physiological_status, /30 min old/);
  assert.match(result.incident.audit[0].reason, /30 min old/);
});

test('ingest: far-future and ancient timestamps are refused', async () => {
  const svc = makeService();
  await rejects(send(svc, { device_id: freshDevice(), timestamp: nowSec() + 4000 }), 422, /future/);
  await rejects(send(svc, { device_id: freshDevice(), timestamp: nowSec() - 90000 }), 422, /old/);
});

test('ingest: revoked devices are refused; closed provisioning refuses unknown ones', async () => {
  const svc = makeService();
  const d = freshDevice();
  svc.setDevice({ device_id: d, label: 'lost', revoked: true });
  await rejects(send(svc, { device_id: d }), 403, /revoked/);

  const closed = makeService({ env: { AEGIS_GEO: 'demo', AEGIS_OPEN_PROVISIONING: '0' } });
  await rejects(send(closed, { device_id: freshDevice() }), 403, /not provisioned/);
  const known = freshDevice();
  closed.setDevice({ device_id: known, label: 'issued' });
  assert.equal((await send(closed, { device_id: known })).result.action, 'CREATED');
});

test('ingest: a CBOR beacon is accepted exactly like a protobuf one', async () => {
  const svc = makeService();
  const msg = beacon({ device_id: freshDevice() });
  const r = await svc.ingest(svc.sealBeacon(msg, { codec: 'cbor' }));
  assert.equal(r.format, 'cbor');
  assert.equal(r.incident.codec, 'cbor');
  assert.equal(r.incident.triage.priority_level, 2);
});

/* ---------------- one living incident per device ---------------- */

test('update: new packets from one device update ONE incident (regression: each packet made a new incident)', async () => {
  const svc = makeService();
  const d = freshDevice();
  const a = await send(svc, { device_id: d, spo2: 97 });
  const b = await send(svc, { device_id: d, spo2: 96 });
  const c = await send(svc, { device_id: d, spo2: 95 });
  assert.equal(a.result.action, 'CREATED');
  assert.equal(b.result.action, 'UPDATED');
  assert.equal(c.result.incident.id, a.result.incident.id);
  assert.equal(svc.list().length, 1);
  assert.equal(c.result.incident.history.length, 3);
  assert.equal(svc.store.telemetryFor(a.result.incident.id).length, 3);
});

test('update: after EXTRACTED or CLOSED the same device starts a fresh incident', async () => {
  const svc = makeService();
  const d = freshDevice();
  const a = (await send(svc, { device_id: d })).result.incident;
  svc.transition(a.id, 'CLOSED', 'dispatcher', 'done');
  const b = (await send(svc, { device_id: d })).result.incident;
  assert.notEqual(a.id, b.id);
});

/* ---------------- biometric re-ranking ---------------- */

test('re-rank: falling SpO2 escalates P2 -> P1, is audited with reasons, and is broadcast', async () => {
  const svc = makeService();
  const d = freshDevice();
  await send(svc, { device_id: d, sos_code: SOS.TRAUMA, spo2: 97, heart_rate: 90 });
  assert.equal(svc.list()[0].priority_level, 2);
  const mid = (await send(svc, { device_id: d, sos_code: SOS.TRAUMA, spo2: 93, heart_rate: 95 })).result.incident;
  assert.equal(mid.triage.priority_level, 1, 'a 4-point SpO2 drop is deterioration');
  const ev = svc.events.find((e) => e.type === 'INCIDENT_RERANKED');
  assert.ok(ev, 'INCIDENT_RERANKED was broadcast');
  assert.equal(ev.changes.find((c) => c.incident_id === mid.id).to_priority, 1);
  assert.match(mid.audit.at(-1).reason, /re-ranked P2 -> P1/);
  assert.ok(mid.priority_log.at(-1).reasons.join().includes('SpO2 fell'));
});

test('re-rank: crossing a hard threshold (SpO2 < 90, HR > 130) goes straight to P1', async () => {
  const svc = makeService();
  const a = freshDevice();
  const b = freshDevice();
  await send(svc, { device_id: a, sos_code: SOS.MEDICAL, spo2: 98, heart_rate: 80 });
  await send(svc, { device_id: b, sos_code: SOS.MEDICAL, spo2: 98, heart_rate: 80 });
  await send(svc, { device_id: a, sos_code: SOS.MEDICAL, spo2: 98, heart_rate: 138 });
  assert.equal(svc.list().find((i) => i.device_id === a).priority_level, 1);
  assert.equal(svc.list().find((i) => i.device_id === b).priority_level, 2);
});

test('re-rank: the queue reorders across beacons when one deteriorates', async () => {
  const svc = makeService();
  const [a, b] = [freshDevice(), freshDevice()];
  await send(svc, { device_id: a, sos_code: SOS.TRAUMA, spo2: 97, heart_rate: 90 });
  await send(svc, { device_id: b, sos_code: SOS.TRAUMA, spo2: 97, heart_rate: 90 });
  assert.deepEqual(svc.list().map((i) => i.device_id), [a, b], 'equal priority: longest waiting first');
  svc.events.length = 0;
  await send(svc, { device_id: b, sos_code: SOS.TRAUMA, spo2: 88, heart_rate: 120 });
  assert.deepEqual(svc.list().map((i) => i.device_id), [b, a]);
  const rr = svc.events.find((e) => e.type === 'INCIDENT_RERANKED');
  const move = rr.changes.find((c) => c.incident_id === svc.list()[0].id);
  assert.deepEqual([move.from_rank, move.to_rank], [2, 1]);
  const bumped = rr.changes.find((c) => c.incident_id === svc.list()[1].id);
  assert.deepEqual([bumped.from_rank, bumped.to_rank], [1, 2], 'the displaced incident is reported too');
});

test('re-rank: urgency never relaxes when vitals recover; only a dispatcher can lower it', async () => {
  const svc = makeService();
  const d = freshDevice();
  await send(svc, { device_id: d, sos_code: SOS.TRAUMA, spo2: 85, heart_rate: 120 });
  const rec = (await send(svc, { device_id: d, sos_code: SOS.TRAUMA, spo2: 98, heart_rate: 80 })).result.incident;
  assert.equal(rec.triage.priority_level, 1, 'held at P1');
  const lowered = await svc.setPriority(rec.id, 3, 'dispatcher', 'stabilised on scene call');
  assert.equal(lowered.incident.triage.priority_level, 3);
  assert.match(lowered.entry.reason, /stabilised/);
});

test('re-rank: a dispatcher cannot lower a duress incident below P1', async () => {
  const svc = makeService();
  const inc = (await send(svc, { device_id: freshDevice(), sos_code: SOS.HOSTILE, duress_flag: true })).result.incident;
  const r = await svc.setPriority(inc.id, 4, 'dispatcher', 'try');
  assert.equal(r.incident.triage.priority_level, 1);
  await rejects(svc.setPriority(inc.id, 9, 'dispatcher'), 422);
});

/* ---------------- cancel / false alarm ---------------- */

test('cancel: a plain wristband cancel before assignment closes the incident as a false alarm', async () => {
  const svc = makeService();
  const d = freshDevice();
  const inc = (await send(svc, { device_id: d, sos_code: SOS.MEDICAL })).result.incident;
  const r = await send(svc, { device_id: d, sos_code: SOS.CANCEL });
  assert.equal(r.result.action, 'CANCEL_CLOSED');
  assert.equal(svc.get(inc.id).state, 'CLOSED');
  assert.equal(svc.get(inc.id).audit.at(-1).actor, 'device');
});

test('cancel: after a unit is assigned a cancel is only a request the dispatcher must confirm', async () => {
  const svc = makeService();
  const d = freshDevice();
  const inc = (await send(svc, { device_id: d, sos_code: SOS.MEDICAL })).result.incident;
  svc.transition(inc.id, 'UNIT_ASSIGNED', 'dispatcher', 'go');
  const r = await send(svc, { device_id: d, sos_code: SOS.CANCEL });
  assert.equal(r.result.action, 'CANCEL_REQUESTED');
  assert.equal(svc.get(inc.id).state, 'UNIT_ASSIGNED');
  assert.equal(svc.get(inc.id).cancel_request.pending, true);
  svc.resolveCancel(inc.id, true, 'dispatcher', 'confirmed by voice');
  assert.equal(svc.get(inc.id).state, 'CLOSED');
});

test('cancel: from a duress or silent device it is never trusted (it may be coerced)', async () => {
  const svc = makeService();
  const d = freshDevice();
  const inc = (await send(svc, { device_id: d, sos_code: SOS.HOSTILE, duress_flag: true })).result.incident;
  const r = await send(svc, { device_id: d, sos_code: SOS.CANCEL });
  assert.equal(r.result.action, 'CANCEL_REQUESTED');
  assert.equal(svc.get(inc.id).cancel_request.possibly_coerced, true);
  assert.equal(svc.get(inc.id).state, 'AI_TRIAGED');
  svc.resolveCancel(inc.id, false, 'dispatcher', 'covert: verify off-air');
  assert.equal(svc.get(inc.id).cancel_request.pending, false);
  assert.equal(svc.get(inc.id).state, 'AI_TRIAGED');
  assert.ok(svc.events.some((e) => e.type === 'INCIDENT_CANCEL_REQUEST'));
});

test('cancel: with nothing open it is acknowledged and changes nothing', async () => {
  const svc = makeService();
  const r = await send(svc, { device_id: freshDevice(), sos_code: SOS.CANCEL });
  assert.equal(r.result.action, 'CANCEL_NO_OPEN_INCIDENT');
  assert.equal(svc.list().length, 0);
  await rejects(Promise.resolve().then(() => svc.resolveCancel('INC-0001', true)), 404);
});

/* ---------------- CAD state machine ---------------- */

test('state: the full lifecycle is walkable and audited; illegal jumps and wrong actors are refused', async () => {
  const svc = makeService();
  const inc = (await send(svc, { device_id: freshDevice() })).result.incident;
  assert.throws(() => svc.transition(inc.id, 'EXTRACTED', 'dispatcher', 'skip'), (e) => e.status === 409);
  assert.throws(() => svc.transition(inc.id, 'UNIT_ASSIGNED', 'unit', 'self'), (e) => e.status === 409 && /may not perform/.test(e.message));
  for (const [to, actor] of [['UNIT_ASSIGNED', 'dispatcher'], ['EN_ROUTE', 'unit'], ['EXTRACTED', 'unit'], ['CLOSED', 'dispatcher']]) svc.transition(inc.id, to, actor, 'step');
  assert.deepEqual(svc.get(inc.id).audit.map((a) => a.to), ['SOS_RECEIVED', 'AI_TRIAGED', 'UNIT_ASSIGNED', 'EN_ROUTE', 'EXTRACTED', 'CLOSED']);
  assert.throws(() => svc.transition(inc.id, 'CLOSED', 'dispatcher', 'again'), (e) => e.status === 409);
});

test('state: UNIT_ASSIGNED records which unit, defaults to the recommended asset, and rejects unknown ones', async () => {
  const svc = makeService();
  const a = (await send(svc, { device_id: freshDevice() })).result.incident;
  const rec = a.deconfliction.recommended.asset;
  const r = svc.transition(a.id, 'UNIT_ASSIGNED', 'dispatcher', 'go');
  assert.equal(r.incident.assigned_unit.id, rec.id);

  const b = (await send(svc, { device_id: freshDevice() })).result.incident;
  assert.throws(() => svc.transition(b.id, 'UNIT_ASSIGNED', 'dispatcher', 'go', { unit: 'AS-NOPE' }), (e) => e.status === 422);
  const named = b.context.assets.at(-1);
  assert.equal(svc.transition(b.id, 'UNIT_ASSIGNED', 'dispatcher', 'go', { unit: named.id }).incident.assigned_unit.id, named.id);
});

/* ---------------- downlink & outbox ---------------- */

test('downlink: ACK haptic is queued on every packet and DISPATCHED when a unit is assigned', async () => {
  const svc = makeService();
  const d = freshDevice();
  const inc = (await send(svc, { device_id: d })).result.incident;
  await send(svc, { device_id: d });
  assert.equal(svc.pendingDownlinks(d), 2);
  svc.transition(inc.id, 'UNIT_ASSIGNED', 'dispatcher', 'go');
  const msgs = svc.pullDownlinks(d);
  assert.deepEqual(msgs.map((m) => m.body.event), ['ACK', 'ACK', 'DISPATCHED']);
  assert.ok(msgs.every((m) => m.kind === 'HAPTIC' && m.body.pattern.length > 0));
  assert.equal(svc.pullDownlinks(d).length, 0, 'a pulled message is delivered once');
});

test('downlink: plain incidents accept ASCII text up to 160; longer, empty, non-ASCII are refused', async () => {
  const svc = makeService();
  const inc = (await send(svc, { device_id: freshDevice() })).result.incident;
  assert.equal(svc.downlink(inc.id, { text: 'STAY STILL. HELP INBOUND.' }).chars, 25);
  assert.equal(svc.downlink(inc.id, { text: 'x'.repeat(160) }).chars, 160);
  await rejects(Promise.resolve().then(() => svc.downlink(inc.id, { text: 'x'.repeat(161) })), 422);
  await rejects(Promise.resolve().then(() => svc.downlink(inc.id, { text: '' })), 422);
  await rejects(Promise.resolve().then(() => svc.downlink(inc.id, { text: 'café' })), 422);
});

test('downlink: duress AND silent-mode incidents accept only HAPTIC_ACK_ONLY, queued as a haptic', async () => {
  const svc = makeService();
  const duress = (await send(svc, { device_id: freshDevice(), sos_code: SOS.HOSTILE, duress_flag: true })).result.incident;
  const d2 = freshDevice();
  svc.setDevice({ device_id: d2, silent_mode: true });
  const silent = (await send(svc, { device_id: d2 })).result.incident;
  for (const inc of [duress, silent]) {
    await rejects(Promise.resolve().then(() => svc.downlink(inc.id, { text: 'HELP IS COMING' })), 409, /HAPTIC_ACK_ONLY/);
    const ok = svc.downlink(inc.id, { text: 'HAPTIC_ACK_ONLY' });
    assert.equal(ok.queued, true);
    const last = svc.store.downlinksFor(inc.id).at(-1);
    assert.equal(last.kind, 'HAPTIC');
  }
  assert.equal(silent.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
});

test('full record: carries the derived covert / deteriorating / packets fields the list summary has (regression: clients saw covert undefined)', async () => {
  const svc = makeService();
  const duress = (await send(svc, { device_id: freshDevice(), sos_code: SOS.HOSTILE, duress_flag: true })).result.incident;
  const d2 = freshDevice();
  svc.setDevice({ device_id: d2, silent_mode: true });
  const silent = (await send(svc, { device_id: d2 })).result.incident;
  const plain = (await send(svc, { device_id: freshDevice() })).result.incident;
  assert.equal(svc.full(duress.id).covert, true);
  assert.equal(svc.full(silent.id).covert, true);
  assert.equal(svc.full(plain.id).covert, false);
  for (const inc of [duress, silent, plain]) {
    const list = svc.list().find((i) => i.id === inc.id);
    const full = svc.full(inc.id);
    assert.equal(full.covert, list.covert);
    assert.equal(full.deteriorating, list.deteriorating);
    assert.equal(full.packets, list.packets);
  }
});

test('downlink: nothing can be sent to a closed incident', async () => {
  const svc = makeService();
  const inc = (await send(svc, { device_id: freshDevice() })).result.incident;
  svc.transition(inc.id, 'CLOSED', 'dispatcher', 'x');
  await rejects(Promise.resolve().then(() => svc.downlink(inc.id, { text: 'hi' })), 409);
});

/* ---------------- battery ---------------- */

test('battery: uses the assumption with one sample and the observed slope with more', () => {
  const one = batteryEstimate([{ ts: 0, battery_pct: 30 }]);
  assert.equal(one.model, 'assumed');
  assert.equal(one.eta_min, 1000);
  const obs = batteryEstimate([{ ts: 0, battery_pct: 50 }, { ts: 600, battery_pct: 40 }]);
  assert.equal(obs.model, 'observed');
  assert.equal(obs.rate_pct_per_min, 1);
  assert.equal(obs.eta_min, 40);
  assert.equal(batteryEstimate([]).model, 'none');
  assert.equal(batteryEstimate([{ ts: 0, battery_pct: 50 }, { ts: 600, battery_pct: 50 }]).model, 'assumed', 'no drop observed: do not divide by zero');
});

/* ---------------- mesh through the service ---------------- */

test('mesh: store-and-forward delivers into the service when sky returns, with hop metadata', async () => {
  const svc = makeService();
  for (const n of ['wristband', 'phone-a', 'phone-b', 'relay-node']) svc.mesh.nodes.get(n).sky = false;
  const env = svc.sealBeacon(beacon({ device_id: freshDevice(), sos_code: SOS.MEDICAL }));
  const sent = svc.mesh.send(env, 'wristband');
  assert.equal(sent.delivered, false);
  assert.equal(svc.list().length, 0);
  svc.mesh.setSky('relay-node', true);
  const out = await svc.drainMesh();
  assert.equal(out[0].ok, true);
  const inc = svc.list()[0];
  assert.equal(inc.source, 'MESH_RELAY');
  assert.deepEqual(svc.get(inc.id).mesh.path, ['wristband', 'phone-a', 'relay-node']);
  assert.equal(svc.get(inc.id).mesh.stored, true);
});

/* ---------------- persistence ---------------- */

test('persistence: incidents, replay state and the outbox survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-'));
  const file = path.join(dir, 'a.db');
  try {
    const mk = () => createService({ dbPath: file, geo: createGeo({ env: { AEGIS_GEO: 'demo' } }), env: { AEGIS_GEO: 'demo' } });
    const d = freshDevice();
    const t = nowSec() + 20;
    const s1 = mk();
    const inc = (await s1.ingest(s1.sealBeacon(beacon({ device_id: d, timestamp: t })))).incident;
    s1.transition(inc.id, 'UNIT_ASSIGNED', 'dispatcher', 'go');
    s1.close();

    const s2 = mk();
    assert.equal(s2.get(inc.id).state, 'UNIT_ASSIGNED');
    assert.equal(s2.get(inc.id).audit.length, inc.audit.length);
    assert.equal(s2.pendingDownlinks(d), 2);
    // replay protection survived: the old timestamp is still refused. (Device keys are
    // ephemeral per process, so reseal with the new process's keys.)
    await rejects(s2.ingest(s2.sealBeacon(beacon({ device_id: d, timestamp: t }))), 409, /replay/);
    // and numbering continues, it does not restart at INC-0001
    const next = (await s2.ingest(s2.sealBeacon(beacon({ device_id: freshDevice() })))).incident;
    assert.equal(next.id, 'INC-0002');
    s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- model pass is off the request path ---------------- */

test('model pass: ingest returns on the rules answer without waiting for the model', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { default: http } = await import('node:http');
  const server = http.createServer((req, res) => { req.resume(); req.on('end', async () => { await gate; res.writeHead(500); res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, { AEGIS_LLM: '1', AEGIS_LLM_PROVIDER: 'openai', AEGIS_LLM_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, AEGIS_LLM_TIMEOUT_MS: '3000' });
  try {
    const svc = makeService();
    const t0 = Date.now();
    const r = await send(svc, { device_id: freshDevice() });
    assert.ok(Date.now() - t0 < 1500, 'did not block on the model');
    assert.equal(r.result.incident.model.used, 'rules');
    assert.match(r.result.incident.model.reason, /pending/);
    release();
    await svc.idle();
    assert.equal(r.result.incident.model.used, 'rules');
    assert.match(r.result.incident.model.reason, /HTTP 500/);
    assert.equal(r.result.incident.triage.priority_level, 2, 'rules answer stands when the model fails');
  } finally {
    process.env = saved;
    release();
    await new Promise((r) => server.close(r));
  }
});

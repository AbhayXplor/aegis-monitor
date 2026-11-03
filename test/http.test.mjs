import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

import { createApp } from '../src/server.mjs';
import { beacon, freshDevice } from './helpers.mjs';
import { SOS } from '../src/proto.mjs';

async function boot(env = {}) {
  const app = createApp({ dbPath: ':memory:', env: { AEGIS_GEO: 'demo', ...env } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const J = { 'content-type': 'application/json' };
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: body === undefined ? headers : { ...J, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, base, call, svc: app.service, port: app.address().port, close: () => new Promise((r) => { app.closeAllConnections?.(); app.close(r); }) };
}

test('http: panel, shared RAG module and contracts are served; source files are not', async () => {
  const s = await boot();
  try {
    assert.match((await s.call('GET', '/')).text, /AEGIS/);
    const rag = await s.call('GET', '/lib/rag-core.mjs');
    assert.equal(rag.status, 200);
    assert.match(rag.headers.get('content-type'), /javascript/);
    assert.equal((await s.call('GET', '/src/server.mjs')).status, 404);
    assert.equal((await s.call('GET', '/api/v1/contracts')).json.contracts.includes('openapi.yaml'), true);
    assert.equal((await s.call('GET', '/api/v1/kb')).json.chunks.length >= 30, true);
  } finally { await s.close(); }
});

test('http: path traversal is refused (raw request, so the client cannot normalise it away)', async () => {
  const s = await boot();
  try {
    for (const p of ['/..%2fsrc%2fserver.mjs', '/%2e%2e/src/server.mjs', '/..%2f..%2fpackage.json', '/%00']) {
      const status = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: s.port, path: p, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve('error'));
        req.end();
      });
      assert.ok([400, 403, 404].includes(status), `${p} -> ${status}`);
    }
  } finally { await s.close(); }
});

/* ---------------- sat-ingest ---------------- */

test('sat-ingest: raw binary, JSON base64, RockBLOCK form (hex) and Swarm JSON (base64) all work', async () => {
  const s = await boot();
  try {
    const mk = () => s.svc.sealBeacon(beacon({ device_id: freshDevice() }));
    const raw = await fetch(s.base + '/api/v1/sat-ingest', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: mk() });
    assert.equal(raw.status, 201);
    const j = await s.call('POST', '/api/v1/sat-ingest', { envelope_base64: mk().toString('base64') });
    assert.equal(j.status, 201);
    const rock = await fetch(s.base + '/api/v1/sat-ingest', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ imei: '300234010753370', momsn: '12', data: mk().toString('hex') }) });
    assert.equal(rock.status, 201);
    const swarm = await s.call('POST', '/api/v1/sat-ingest', { packetId: 1, deviceType: 1, deviceId: 2, data: mk().toString('base64') });
    assert.equal(swarm.status, 201);
    assert.equal(s.svc.list().length, 4);
  } finally { await s.close(); }
});

test('sat-ingest: the response never leaks triage detail back to the satellite provider', async () => {
  const s = await boot();
  try {
    const r = await s.call('POST', '/api/v1/sat-ingest', { envelope_base64: s.svc.sealBeacon(beacon({ device_id: freshDevice() })).toString('base64') });
    assert.deepEqual(Object.keys(r.json).sort(), ['action', 'duplicate', 'incident_id', 'state']);
  } finally { await s.close(); }
});

test('sat-ingest: 201 creates, 200 updates or dedupes, and failures carry the right status', async () => {
  const s = await boot();
  try {
    const d = freshDevice();
    const e1 = s.svc.sealBeacon(beacon({ device_id: d }));
    const post = (b) => s.call('POST', '/api/v1/sat-ingest', { envelope_base64: b.toString('base64') });
    assert.equal((await post(e1)).status, 201);
    const dup = await post(e1);
    assert.equal(dup.status, 200);
    assert.equal(dup.json.duplicate, true);
    const upd = await post(s.svc.sealBeacon(beacon({ device_id: d })));
    assert.equal(upd.status, 200);
    assert.equal(upd.json.action, 'UPDATED');
    const bad = Buffer.from(e1); bad[bad.length - 1] ^= 1;
    assert.equal((await post(bad)).status, 401);
    assert.equal((await post(Buffer.alloc(150, 1))).status, 413);
    assert.equal((await s.call('POST', '/api/v1/sat-ingest', { nothing: true })).status, 400);
    const form = await fetch(s.base + '/api/v1/sat-ingest', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=zz' });
    assert.equal(form.status, 400);
  } finally { await s.close(); }
});

/* ---------------- robustness & hardening ---------------- */

test('http: malformed JSON is a 400 (regression: 500), wrong content-type is a 415 (CSRF guard), oversize body a 413', async () => {
  const s = await boot();
  try {
    const bad = await fetch(s.base + '/api/v1/dev/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(bad.status, 400);
    const plain = await fetch(s.base + '/api/v1/dev/simulate', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415);
    assert.equal(s.svc.list().length, 0, 'the cross-site simple POST did nothing');
    const big = await fetch(s.base + '/api/v1/dev/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    assert.equal(big.status, 413);
    assert.equal((await s.call('GET', '/api/v1/incidents/INC-9999')).status, 404);
    assert.equal((await s.call('PUT', '/api/v1/incidents', {})).status, 405);
  } finally { await s.close(); }
});

test('http: unexpected errors return a generic 500, not an internal message', async () => {
  const s = await boot();
  const orig = s.svc.list;
  s.svc.list = () => { throw new Error('secret internal detail /Users/x/y'); };
  const log = console.error; console.error = () => {};
  try {
    const r = await s.call('GET', '/api/v1/incidents');
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'internal error');
  } finally { console.error = log; s.svc.list = orig; await s.close(); }
});

test('http: the dispatcher token gates the API when configured; health and ingest stay open', async () => {
  const s = await boot({ AEGIS_DISPATCH_TOKEN: 'tok-123' });
  try {
    assert.equal((await s.call('GET', '/api/v1/incidents')).status, 401);
    assert.equal((await s.call('GET', '/api/v1/incidents', undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await s.call('GET', '/api/v1/incidents', undefined, { authorization: 'Bearer tok-123' })).status, 200);
    assert.equal((await s.call('GET', '/api/v1/health')).status, 200);
    assert.match((await s.call('GET', '/api/v1/health')).json.auth, /token/);
    const ing = await s.call('POST', '/api/v1/sat-ingest', { envelope_base64: s.svc.sealBeacon(beacon({ device_id: freshDevice() })).toString('base64') });
    assert.equal(ing.status, 201, 'satellite webhooks authenticate by AES-GCM, not by dispatcher token');
  } finally { await s.close(); }
});

test('http: CORS is an allowlist, not a wildcard', async () => {
  const s = await boot({ AEGIS_CORS_ORIGINS: 'http://localhost:5173' });
  try {
    const ok = await s.call('GET', '/api/v1/health', undefined, { origin: 'http://localhost:5173' });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const no = await s.call('GET', '/api/v1/health', undefined, { origin: 'https://evil.example' });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(s.base + '/api/v1/incidents', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.equal(pre.status, 403);
    const preOk = await fetch(s.base + '/api/v1/incidents', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
    assert.equal(preOk.status, 204);
  } finally { await s.close(); }
});

test('http: dev endpoints can be switched off', async () => {
  const s = await boot({ AEGIS_DEV: '0' });
  try {
    assert.equal((await s.call('POST', '/api/v1/dev/simulate', {})).status, 403);
    assert.equal((await s.call('POST', '/api/v1/dev/wristband', { presses: 3 })).status, 403);
    assert.equal((await s.call('GET', '/api/v1/health')).json.dev_endpoints, false);
  } finally { await s.close(); }
});

/* ---------------- wristband & mesh endpoints ---------------- */

test('wristband: 3 = medical P2, 5 = hostile extraction (NOT covert), 7 = duress (covert); 4 presses refused', async () => {
  const s = await boot();
  try {
    const med = await s.call('POST', '/api/v1/dev/wristband', { presses: 3 });
    assert.equal(med.json.gesture, 'MEDICAL_SOS');
    assert.equal(med.json.triage.triage_category, 'MEDEVAC');
    assert.equal(med.json.covert.silent, false);
    const hos = await s.call('POST', '/api/v1/dev/wristband', { presses: 5 });
    assert.equal(hos.json.triage.triage_category, 'COMBAT_EXTRACTION');
    assert.equal(hos.json.triage.priority_level, 2);
    assert.notEqual(hos.json.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.equal(hos.json.covert.silent, false);
    const dur = await s.call('POST', '/api/v1/dev/wristband', { presses: 7 });
    assert.equal(dur.json.triage.triage_category, 'HOSTAGE_COVERT');
    assert.equal(dur.json.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.deepEqual([dur.json.covert.silent, dur.json.covert.wipeLocalLog], [true, true]);
    assert.ok(dur.json.packet_bytes < 100);
    assert.equal((await s.call('POST', '/api/v1/dev/wristband', { presses: 4 })).status, 400);
  } finally { await s.close(); }
});

test('wristband: a 10 s hold cancels the right incident, and needs a device id', async () => {
  const s = await boot();
  try {
    const start = await s.call('POST', '/api/v1/dev/wristband', { presses: 3 });
    assert.equal((await s.call('POST', '/api/v1/dev/wristband', { held_ms: 10000 })).status, 400);
    const cancel = await s.call('POST', '/api/v1/dev/wristband', { held_ms: 10000, device_id: start.json.device_id });
    assert.equal(cancel.json.action, 'CANCEL_CLOSED');
    assert.equal((await s.call('GET', '/api/v1/incidents/' + start.json.incident_id)).json.state, 'CLOSED');
    assert.equal((await s.call('POST', '/api/v1/dev/wristband', { held_ms: 9000, device_id: 5 })).status, 400, '9 s is not a cancel');
  } finally { await s.close(); }
});

test('wristband: vitals can come from the PPG analysis path', async () => {
  const s = await boot();
  try {
    const r = await s.call('POST', '/api/v1/dev/wristband', { presses: 3, use_ppg: true, heart_rate: 142, spo2: 84 });
    const v = (await s.call('GET', '/api/v1/incidents/' + r.json.incident_id)).json.vitals;
    assert.ok(Math.abs(v.heart_rate - 142) <= 2 && Math.abs(v.spo2 - 84) <= 2);
    assert.equal(r.json.triage.priority_level, 1);
    assert.ok(r.json.ppg_quality > 0.8);
  } finally { await s.close(); }
});

test('mesh: without sky the packet is stored (202); restoring sky delivers it', async () => {
  const s = await boot();
  try {
    const stored = await s.call('POST', '/api/v1/dev/mesh', { sky: [] });
    assert.equal(stored.status, 202);
    assert.equal(stored.json.stored, true);
    assert.equal(s.svc.list().length, 0);
    const back = await s.call('POST', '/api/v1/dev/mesh/sky', { node: 'phone-a' });
    assert.equal(back.json.delivered, 1);
    assert.equal(s.svc.list().length, 1);
    assert.equal(s.svc.list()[0].source, 'MESH_RELAY');
    const direct = await s.call('POST', '/api/v1/dev/mesh', { sky: ['relay-node'] });
    assert.deepEqual(direct.json.path, ['wristband', 'phone-a', 'relay-node']);
    assert.equal((await s.call('POST', '/api/v1/dev/mesh/sky', { node: 'ghost' })).status, 400);
  } finally { await s.close(); }
});

/* ---------------- dispatcher flow ---------------- */

test('flow: simulate -> list -> assign unit -> en route -> device pulls haptics -> downlink -> close', async () => {
  const s = await boot();
  try {
    const sim = await s.call('POST', '/api/v1/dev/simulate', { device_id: 700, sos_code: SOS.TRAUMA });
    const id = sim.json.incident_id;
    assert.equal(sim.status, 201);
    assert.equal((await s.call('GET', '/api/v1/incidents')).json.incidents[0].id, id);

    const full = (await s.call('GET', '/api/v1/incidents/' + id)).json;
    assert.equal(full.telemetry.length, 1);
    const unit = full.deconfliction.recommended.asset.id;
    const assign = await s.call('POST', `/api/v1/incidents/${id}/transition`, { to: 'UNIT_ASSIGNED', actor: 'dispatcher', reason: 'panel', unit });
    assert.equal(assign.json.assigned_unit.id, unit);
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/transition`, { to: 'CLOSED', actor: 'unit' })).status, 409);
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/transition`, { to: 'EN_ROUTE', actor: 'unit', reason: 'rolling' })).status, 200);

    const pull = await s.call('POST', '/api/v1/devices/700/downlink/pull', {});
    assert.deepEqual(pull.json.messages.map((m) => m.body.event), ['ACK', 'DISPATCHED']);
    assert.equal((await s.call('POST', '/api/v1/devices/700/downlink/pull', {})).json.messages.length, 0);

    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/downlink`, { text: 'STAY STILL. HELP INBOUND.' })).json.queued, true);
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/downlink`, { text: 'x'.repeat(161) })).status, 422);
    const msgs = (await s.call('POST', '/api/v1/devices/700/downlink/pull', {})).json.messages;
    assert.deepEqual(msgs.map((m) => m.body.text), ['STAY STILL. HELP INBOUND.']);
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/transition`, { to: 'EXTRACTED', actor: 'unit', reason: 'x' })).status, 200);
  } finally { await s.close(); }
});

test('flow: silent-mode device setting is honoured end to end', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('PUT', '/api/v1/devices/801', { label: 'COURIER', silent_mode: true })).json.silent_mode, true);
    const sim = await s.call('POST', '/api/v1/dev/simulate', { device_id: 801, sos_code: SOS.TRAUMA });
    assert.equal(sim.json.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.equal((await s.call('POST', `/api/v1/incidents/${sim.json.incident_id}/downlink`, { text: 'HELLO' })).status, 409);
    assert.equal((await s.call('PUT', '/api/v1/devices/801', { revoked: true })).json.revoked, true);
    assert.equal((await s.call('POST', '/api/v1/dev/simulate', { device_id: 801 })).status, 403);
    assert.equal((await s.call('GET', '/api/v1/devices')).json.devices.some((d) => d.device_id === 801), true);
  } finally { await s.close(); }
});

test('flow: priority override and cancel confirmation endpoints', async () => {
  const s = await boot();
  try {
    const sim = await s.call('POST', '/api/v1/dev/simulate', { device_id: 900, sos_code: SOS.EVACUATION, spo2: 97, heart_rate: 80 });
    const id = sim.json.incident_id;
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/priority`, { level: 5, reason: 'confirmed by phone' })).json.priority_level, 5);
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/priority`, { level: 0 })).status, 422);
    await s.call('POST', `/api/v1/incidents/${id}/transition`, { to: 'UNIT_ASSIGNED', actor: 'dispatcher', reason: 'go' });
    await s.call('POST', '/api/v1/dev/wristband', { held_ms: 10000, device_id: 900 });
    assert.equal((await s.call('GET', '/api/v1/incidents/' + id)).json.cancel_request.pending, true);
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/cancel`, { accept: true, reason: 'voice check' })).json.state, 'CLOSED');
    assert.equal((await s.call('POST', `/api/v1/incidents/${id}/cancel`, { accept: true })).status, 409);
  } finally { await s.close(); }
});

/* ---------------- WebSocket ---------------- */

function wsConnect(port, { origin, path = '/ws' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const messages = [];
    sock.on('connect', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!head.startsWith('HTTP/1.1 101')) { sock.destroy(); return resolve({ status: Number(head.split(' ')[1]) }); }
        upgraded = true;
        resolve({ status: 101, sock, messages });
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        if ((buf[0] & 0x0f) === 1) messages.push(JSON.parse(buf.subarray(off, off + len).toString()));
        buf = buf.subarray(off + len);
      }
    });
    sock.on('error', reject);
    sock.on('close', () => { if (!upgraded) resolve({ status: 0 }); });
  });
}
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

test('ws: same-origin clients receive live events; foreign origins and wrong tokens are refused', async () => {
  const s = await boot();
  try {
    const own = await wsConnect(s.port, { origin: `http://127.0.0.1:${s.port}` });
    assert.equal(own.status, 101);
    const foreign = await wsConnect(s.port, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);

    await s.call('POST', '/api/v1/dev/simulate', { device_id: 1100, sos_code: SOS.TRAUMA, spo2: 97, heart_rate: 90 });
    await s.call('POST', '/api/v1/dev/simulate', { device_id: 1100, sos_code: SOS.TRAUMA, spo2: 91, heart_rate: 95 });
    assert.ok(await until(() => own.messages.some((m) => m.type === 'INCIDENT_RERANKED')), 'got INCIDENT_RERANKED over the socket');
    const types = new Set(own.messages.map((m) => m.type));
    for (const t of ['INCIDENT_CREATED', 'INCIDENT_UPDATED', 'INCIDENT_TRIAGED', 'INCIDENT_RERANKED', 'DOWNLINK_QUEUED']) assert.ok(types.has(t), t);
    own.sock.destroy();
  } finally { await s.close(); }

  const t = await boot({ AEGIS_DISPATCH_TOKEN: 'abc' });
  try {
    assert.equal((await wsConnect(t.port)).status, 403);
    const ok = await wsConnect(t.port, { path: '/ws?token=abc' });
    assert.equal(ok.status, 101);
    ok.sock.destroy();
  } finally { await t.close(); }
});

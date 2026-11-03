// AegisMonitor core service — v0.1
//
// Implemented: encrypted ingest, packet validation, replay guard, wristband gesture
// pipeline, mesh relay stub, 25 km geo-context (MOCK), triage to the brief's schema,
// biometric re-ranking, CAD state machine with audit, panel push.
// Not implemented: real WorldMonitor MCP, live Ollama call, PostgreSQL/Redis,
// CBOR fallback, firmware, on-device model. See README for the status table.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encrypt, decrypt, checkReplay, listKeyIds } from './crypto.mjs';
import { encode, decode, validatePacket, MAX_PACKET_BYTES } from './proto.mjs';
import { applyTransition, STATES, TRANSITIONS } from './state.mjs';
import { geoContext } from './geo.mjs';
import { triage, reRank, llmStatus } from './triage.mjs';
import { enhance, llmConfig } from './llm.mjs';
import { classifyGesture, gestureToBeacon, hapticPattern, covertPolicy, pollPPG, meshRelay, MESH_MAX_HOPS, GESTURE } from './wristband.mjs';
import { attachWS, broadcast, clientCount } from './ws.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Load aegis/.env if present. A missing file is fine. Values already in the
// environment win, so a platform secret store always overrides this file.
try {
  const envFile = path.join(__dirname, '..', '.env');
  // Never load local secrets under the test runner: tests must stay hermetic.
  if (!process.env.NODE_TEST_CONTEXT && fs.existsSync(envFile)) process.loadEnvFile?.(envFile);
} catch {
  /* ignore malformed .env: never crash the service over it */
}

const incidents = new Map();
let seq = 0;
const nextId = () => 'INC-' + String(++seq).padStart(4, '0');

// Battery decay is an ESTIMATE from a documented assumption, not telemetry.
const DRAIN_PCT_PER_MIN = 0.03;
const batteryEtaMin = (pct) => (Number.isFinite(pct) ? Math.round(pct / DRAIN_PCT_PER_MIN) : null);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function audit(incident, from, to, actor, reason, at = new Date().toISOString()) {
  const entry = { incident_id: incident.id, from, to, actor, reason, at };
  incident.audit.push(entry);
  return entry;
}

async function ingest(envelope, { source = 'SAT_INGEST', deviceHint = null, mesh = null } = {}) {
  if (envelope.length >= MAX_PACKET_BYTES) throw new HttpError(413, `envelope ${envelope.length}B >= cap ${MAX_PACKET_BYTES}B`);

  let opened;
  try {
    opened = decrypt(envelope);
  } catch (e) {
    throw new HttpError(401, 'authentication failed: ' + e.message);
  }

  let msg;
  try {
    msg = decode(opened.payload);
  } catch (e) {
    throw new HttpError(422, 'decode failed: ' + e.message);
  }

  const errors = validatePacket(msg, opened.payload.length);
  if (errors.length) throw new HttpError(422, 'packet invalid: ' + errors.join('; '));

  const replay = checkReplay(msg.device_id, msg.timestamp);
  if (!replay.ok) throw new HttpError(409, replay.reason);

  const inc = {
    id: nextId(),
    device_id: msg.device_id,
    device_label: deviceHint || 'DEVICE-' + msg.device_id.toString(16).toUpperCase(),
    state: 'SOS_RECEIVED',
    received_at: new Date().toISOString(),
    position: { lat: msg.lat / 1e6, lon: msg.lon / 1e6, altitude_m: msg.altitude_m ?? 0 },
    vitals: {
      heart_rate: msg.heart_rate ?? null,
      spo2: msg.spo2 ?? null,
      battery_pct: msg.battery_pct ?? null,
      duress_flag: !!msg.duress_flag,
    },
    sos_code: msg.sos_code,
    source,
    mesh,
    telemetry_bytes: opened.payload.length,
    envelope_bytes: envelope.length,
    key_id: opened.keyId,
    battery_eta_min: batteryEtaMin(msg.battery_pct),
    audit: [],
  };

  incidents.set(inc.id, inc);
  audit(inc, null, 'SOS_RECEIVED', 'system', `beacon received (${opened.payload.length}B, key ${opened.keyId}${mesh ? `, mesh hops ${mesh.hops}` : ''})`);
  broadcast({ type: 'INCIDENT_CREATED', incident: summary(inc) });

  const context = await geoContext(inc.position.lat, inc.position.lon, 25);
  const { triage: ruleTriage, grounding, routes } = await triage({ incident: inc, context });

  // Optional model pass. Rules are always computed first and act as a floor.
  let t = ruleTriage;
  let model = { used: 'rules', reason: 'llm disabled' };
  if (llmConfig().enabled) {
    const r = await enhance({ incident: inc, ruleTriage, grounding, context });
    t = r.triage;
    model = { used: r.used, reason: r.reason, notes: r.notes || [] };
  }

  inc.context = context;
  inc.triage = t;
  inc.grounding = grounding;
  inc.routes = routes;
  inc.model = model;

  const moved = applyTransition(inc, 'AI_TRIAGED', 'system', `triage P${t.priority_level} ${t.triage_category} via ${model.used}`);
  if (!moved.ok) audit(inc, inc.state, 'AI_TRIAGED', 'system', 'triage recorded without transition: ' + moved.reason);

  // Biometric re-ranking across every active incident.
  const changes = reRank([...incidents.values()]);
  broadcast({ type: 'INCIDENT_TRIAGED', incident_id: inc.id, triage: t, state: inc.state, model });
  if (changes.length) broadcast({ type: 'INCIDENT_RERANKED', changes });
  return inc;
}

function summary(inc) {
  return {
    id: inc.id,
    device_label: inc.device_label,
    state: inc.state,
    received_at: inc.received_at,
    position: inc.position,
    vitals: inc.vitals,
    source: inc.source,
    priority_level: inc.triage ? inc.triage.priority_level : null,
    category: inc.triage ? inc.triage.triage_category : null,
    battery_eta_min: inc.battery_eta_min,
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end('forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);
const devDeviceId = () => 0x4000 + Math.floor(Math.random() * 0x0fff);

export function createApp() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'POST' && p === '/api/v1/sat-ingest') {
        const body = await readBody(req);
        let envelope = body;
        if ((req.headers['content-type'] || '').includes('application/json')) {
          const parsed = JSON.parse(body.toString('utf8') || '{}');
          envelope = Buffer.from(parsed.envelope_base64 || '', 'base64');
        }
        const inc = await ingest(envelope, { source: 'SAT_INGEST' });
        return json(res, 201, { incident_id: inc.id, state: inc.state, triage: inc.triage, grounding: inc.grounding });
      }

      if (req.method === 'POST' && p === '/api/v1/dev/simulate') {
        if (process.env.AEGIS_DEV === '0') throw new HttpError(403, 'dev endpoint disabled');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const msg = {
          device_id: body.device_id ?? devDeviceId(),
          timestamp: nowSec(),
          lat: Math.round((body.lat ?? 25.2048) * 1e6),
          lon: Math.round((body.lon ?? 55.2708) * 1e6),
          altitude_m: body.altitude_m ?? 12,
          sos_code: body.sos_code ?? 2,
          heart_rate: body.heart_rate ?? 118,
          spo2: body.spo2 ?? 91,
          battery_pct: body.battery_pct ?? 43,
          duress_flag: !!body.duress,
        };
        const envelope = encrypt(encode(msg), body.key_id || 'k1');
        const inc = await ingest(envelope, { source: 'DEV_SIMULATE', deviceHint: body.device_label || 'WRIST-' + msg.device_id.toString(16).toUpperCase() });
        return json(res, 201, { incident_id: inc.id, state: inc.state, triage: inc.triage, packet_bytes: envelope.length });
      }

      // Wristband gesture path: presses -> gesture -> PPG -> packet -> ingest.
      if (req.method === 'POST' && p === '/api/v1/dev/wristband') {
        if (process.env.AEGIS_DEV === '0') throw new HttpError(403, 'dev endpoint disabled');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const gesture = classifyGesture(Number(body.presses ?? 0), Number(body.held_ms ?? 0));
        if (!gesture) throw new HttpError(400, 'no gesture: 3 presses = medical, 5 = hostile, hold 10 s = cancel');
        if (gesture === GESTURE.CANCEL) {
          return json(res, 200, { gesture, cancelled: true, haptic: hapticPattern('CANCELLED'), packet_sent: false });
        }
        const ppg = body.use_ppg ? pollPPG(body.ppg_seed ?? 42) : { heart_rate: body.heart_rate ?? 96, spo2: body.spo2 ?? 95 };
        const device_id = body.device_id ?? devDeviceId();
        const beacon = gestureToBeacon({
          gesture,
          device_id,
          timestamp: nowSec(),
          lat: Math.round((body.lat ?? 25.2048) * 1e6),
          lon: Math.round((body.lon ?? 55.2708) * 1e6),
          heart_rate: ppg.heart_rate,
          spo2: ppg.spo2,
          battery_pct: body.battery_pct ?? 55,
        });
        const envelope = encrypt(encode(beacon), body.key_id || 'k1');
        const policy = covertPolicy({ duress: gesture === GESTURE.HOSTILE_EXTRACTION });
        const inc = await ingest(envelope, { source: 'WRISTBAND', deviceHint: body.device_label || 'WRIST-' + device_id.toString(16).toUpperCase() });
        return json(res, 201, {
          gesture,
          packet_sent: true,
          haptic: hapticPattern('SENT'),
          covert: policy,
          packet_bytes: envelope.length,
          incident_id: inc.id,
          triage: inc.triage,
        });
      }

      // Mesh relay: same ciphertext, extra hops, then ingest.
      if (req.method === 'POST' && p === '/api/v1/dev/mesh') {
        if (process.env.AEGIS_DEV === '0') throw new HttpError(403, 'dev endpoint disabled');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const hops = Number(body.hops ?? 2);
        const msg = {
          device_id: body.device_id ?? devDeviceId(),
          timestamp: nowSec(),
          lat: Math.round((body.lat ?? 25.2048) * 1e6),
          lon: Math.round((body.lon ?? 55.2708) * 1e6),
          altitude_m: 0,
          sos_code: body.sos_code ?? 2,
          heart_rate: body.heart_rate ?? 104,
          spo2: body.spo2 ?? 92,
          battery_pct: body.battery_pct ?? 30,
          duress_flag: !!body.duress,
        };
        const envelope = encrypt(encode(msg), 'k1');
        const relay = meshRelay({ packet: envelope.toString('base64'), hops, relayedBy: body.relayed_by || 'phone-a' });
        if (!relay.delivered) throw new HttpError(422, relay.reason);
        const inc = await ingest(envelope, { source: 'MESH_RELAY', mesh: { hops: relay.hops, relayed_by: relay.relayedBy }, deviceHint: 'WRIST-' + msg.device_id.toString(16).toUpperCase() });
        return json(res, 201, { delivered: true, hops: relay.hops, remaining: relay.remaining, incident_id: inc.id, triage: inc.triage });
      }

      if (req.method === 'GET' && p === '/api/v1/incidents') {
        const list = [...incidents.values()].map((i) => ({
          ...summary(i),
          recommended_asset: i.triage ? i.triage.deconflicted_route_plan : null,
          reply: i.triage ? i.triage.user_satellite_reply : null,
        }));
        return json(res, 200, { incidents: list, ws_clients: clientCount() });
      }

      const m = p.match(/^\/api\/v1\/incidents\/([^/]+)(?:\/(transition|downlink))?$/);
      if (m) {
        const inc = incidents.get(m[1]);
        if (!inc) throw new HttpError(404, 'no such incident');

        if (req.method === 'GET' && !m[2]) return json(res, 200, inc);

        if (req.method === 'POST' && m[2] === 'transition') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const moved = applyTransition(inc, body.to, body.actor, body.reason ?? '(no reason given)');
          if (!moved.ok) throw new HttpError(409, moved.reason);
          broadcast({ type: 'INCIDENT_STATE', incident_id: inc.id, state: inc.state, audit: moved.entry });
          return json(res, 200, { incident_id: inc.id, state: inc.state, audit: moved.entry });
        }

        if (req.method === 'POST' && m[2] === 'downlink') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const text = String(body.text ?? '');
          if (inc.triage && inc.triage.triage_category === 'HOSTAGE_COVERT' && text !== 'HAPTIC_ACK_ONLY') {
            throw new HttpError(409, 'covert incident: only HAPTIC_ACK_ONLY may be downlinked');
          }
          if (text.length === 0) throw new HttpError(422, 'text required');
          if (text.length > 160) throw new HttpError(422, `downlink is ${text.length} chars, cap is 160`);
          if (!/^[\x20-\x7E]*$/.test(text)) throw new HttpError(422, 'downlink must be ASCII');
          const entry = audit(inc, inc.state, inc.state, body.actor || 'dispatcher', 'downlink queued: ' + text);
          broadcast({ type: 'DOWNLINK_QUEUED', incident_id: inc.id, text, chars: text.length });
          return json(res, 200, { queued: true, chars: text.length, audit: entry });
        }
      }

      if (req.method === 'GET' && p === '/api/v1/health') {
        return json(res, 200, {
          ok: true,
          incidents: incidents.size,
          ws_clients: clientCount(),
          key_ids: listKeyIds(),
          llm: llmStatus(),
          mesh_max_hops: MESH_MAX_HOPS,
          battery_drain_pct_per_min: DRAIN_PCT_PER_MIN,
          states: STATES,
        });
      }

      if (req.method === 'GET' && p === '/api/v1/contracts') {
        return json(res, 200, { contracts: fs.readdirSync(path.join(__dirname, '..', 'contracts')) });
      }

      if (req.method === 'GET') return serveStatic(res, p);

      throw new HttpError(405, 'method not allowed');
    } catch (e) {
      json(res, e.status || 500, { error: e.message, status: e.status || 500 });
    }
  });

  attachWS(server);
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 3001);
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`[aegis] core service on http://0.0.0.0:${port}  (panel: /, ws: /ws)`);
    console.log(`[aegis] LLM: ${JSON.stringify(llmStatus())}`);
  });
}

export { ingest, incidents, STATES, TRANSITIONS };

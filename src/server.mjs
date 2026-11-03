// AegisMonitor core service — v0.1
// HTTP + WebSocket, no third-party dependencies.
//
// Implemented: encrypted ingest, packet validation, replay guard, geo-context
// (MOCK), triage (deterministic), CAD state machine with audit, panel push.
// Not implemented: real WorldMonitor MCP, real Ollama call, PostgreSQL, Redis,
// CBOR fallback, wristband firmware. All labelled in README.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encrypt, decrypt, checkReplay, listKeyIds } from './crypto.mjs';
import { encode, decode, validatePacket, MAX_PACKET_BYTES } from './proto.mjs';
import { applyTransition, STATES, TRANSITIONS } from './state.mjs';
import { geoContext } from './geo.mjs';
import { triage, llmStatus } from './triage.mjs';
import { attachWS, broadcast, clientCount } from './ws.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const incidents = new Map();
let seq = 0;
const nextId = () => 'INC-' + String(++seq).padStart(4, '0');

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

/** Ingest one encrypted envelope: decrypt -> decode -> validate -> replay -> triage. */
async function ingest(envelope, { source = 'SAT_INGEST', deviceHint = null } = {}) {
  if (envelope.length >= MAX_PACKET_BYTES) {
    throw new HttpError(413, `envelope ${envelope.length}B >= cap ${MAX_PACKET_BYTES}B`);
  }
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

  const lat = msg.lat / 1e6;
  const lon = msg.lon / 1e6;
  const inc = {
    id: nextId(),
    device_id: msg.device_id,
    device_label: deviceHint || 'DEVICE-' + msg.device_id.toString(16).toUpperCase(),
    state: 'SOS_RECEIVED',
    received_at: new Date().toISOString(),
    position: { lat, lon, altitude_m: msg.altitude_m ?? 0 },
    vitals: {
      heart_rate: msg.heart_rate ?? null,
      spo2: msg.spo2 ?? null,
      battery_pct: msg.battery_pct ?? null,
      duress_flag: !!msg.duress_flag,
    },
    sos_code: msg.sos_code,
    source,
    telemetry_bytes: opened.payload.length,
    envelope_bytes: envelope.length,
    key_id: opened.keyId,
    updates: 1,
    audit: [],
  };
  incidents.set(inc.id, inc);
  audit(inc, null, 'SOS_RECEIVED', 'system', `beacon received (${opened.payload.length}B, key ${opened.keyId})`);
  broadcast({ type: 'INCIDENT_CREATED', incident: summary(inc) });

  const context = await geoContext(lat, lon, 25);
  const tri = await triage({ incident: inc, context });
  inc.context = context;
  inc.triage = tri;
  const moved = applyTransition(
    inc,
    'AI_TRIAGED',
    'system',
    `triage ${tri.priority} ${tri.triage_category} confidence ${tri.confidence}`
  );
  if (!moved.ok) audit(inc, inc.state, 'AI_TRIAGED', 'system', 'triage recorded without transition: ' + moved.reason);
  broadcast({ type: 'INCIDENT_TRIAGED', incident_id: inc.id, triage: tri, state: inc.state });
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
    priority: inc.triage ? inc.triage.priority : null,
    category: inc.triage ? inc.triage.triage_category : null,
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

export function createApp() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'POST' && p === '/api/v1/sat-ingest') {
        const body = await readBody(req);
        let envelope = body;
        const ctype = req.headers['content-type'] || '';
        if (ctype.includes('application/json')) {
          const parsed = JSON.parse(body.toString('utf8') || '{}');
          envelope = Buffer.from(parsed.envelope_base64 || '', 'base64');
        }
        const inc = await ingest(envelope, { source: 'SAT_INGEST' });
        return json(res, 201, { incident_id: inc.id, state: inc.state, triage: inc.triage });
      }

      if (req.method === 'POST' && p === '/api/v1/dev/simulate') {
        if (process.env.AEGIS_DEV === '0') throw new HttpError(403, 'dev endpoint disabled');
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const now = Math.floor(Date.now() / 1000);
        const msg = {
          // random id per click so repeat demos are not rejected as replays
          device_id: body.device_id ?? 0x4000 + Math.floor(Math.random() * 0x0fff),
          timestamp: now,
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
        const inc = await ingest(envelope, {
          source: 'DEV_SIMULATE',
          deviceHint: body.device_label || 'WRIST-' + msg.device_id.toString(16).toUpperCase(),
        });
        return json(res, 201, { incident_id: inc.id, state: inc.state, triage: inc.triage, packet_bytes: envelope.length });
      }

      if (req.method === 'GET' && p === '/api/v1/incidents') {
        const list = [...incidents.values()].map((i) => ({
          ...summary(i),
          recommended_asset: i.triage ? i.triage.recommended_asset : null,
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
          states: STATES,
        });
      }

      if (req.method === 'GET' && p === '/api/v1/contracts') {
        const dir = path.join(__dirname, '..', 'contracts');
        const files = fs.readdirSync(dir);
        return json(res, 200, { contracts: files });
      }

      if (req.method === 'GET') return serveStatic(res, p);

      throw new HttpError(405, 'method not allowed');
    } catch (e) {
      const status = e.status || 500;
      json(res, status, { error: e.message, status });
    }
  });

  attachWS(server);
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 3001);
  const server = createApp();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[aegis] core service on http://0.0.0.0:${port}  (panel: /, ws: /ws)`);
    console.log(`[aegis] LLM: ${JSON.stringify(llmStatus())}`);
  });
}

export { ingest, incidents, STATES, TRANSITIONS };

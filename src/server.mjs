// aegis-core-service HTTP/WebSocket transport. All behaviour lives in service.mjs.
//
// Run: node src/server.mjs   (panel at /, API under /api/v1, WebSocket at /ws)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createService, HttpError } from './service.mjs';
import { createGeo } from './geo.mjs';
import { attachWS, broadcast, clientCount } from './ws.mjs';
import { llmConfig } from './llm.mjs';
import { kbChunks, kbInfo } from './rag.mjs';
import { SOS } from './proto.mjs';
import {
  GESTURE, runButtonEvents, tapEvents, holdEvents, gestureToBeacon, hapticPattern, covertPolicy, pollPPG,
} from './wristband.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Load .env if present. Values already in the environment win. Never under the test
// runner: tests must stay hermetic.
try {
  const envFile = path.join(ROOT, '.env');
  if (!process.env.NODE_TEST_CONTEXT && fs.existsSync(envFile)) process.loadEnvFile?.(envFile);
} catch {
  /* a malformed .env must never crash the service */
}

export const SCENARIOS = [
  { id: 'urban', name: 'Urban collapse', lat: 25.2048, lon: 55.2708 },
  { id: 'mountain', name: 'Mountain SAR', lat: 27.9881, lon: 86.925 },
  { id: 'floodplain', name: 'Flood plain', lat: 26.2006, lon: 92.9376 },
  { id: 'frontier', name: 'Frontier conflict edge', lat: 36.3392, lon: 43.1189 },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

export function createApp({ service, dbPath, geo, env = process.env } = {}) {
  const svc = service || createService({ dbPath, geo: geo || createGeo({ env }), broadcast, env });
  const token = env.AEGIS_DISPATCH_TOKEN || '';
  const devOn = env.AEGIS_DEV !== '0';
  const corsAllow = new Set((env.AEGIS_CORS_ORIGINS ?? (devOn ? 'http://localhost:3000,http://localhost:5173,http://localhost:4173,http://127.0.0.1:3000,http://127.0.0.1:5173' : '')).split(',').map((s) => s.trim()).filter(Boolean));

  const send = (req, res, status, obj, extra = {}) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', ...extra });
    res.end(body);
  };

  function authorise(req) {
    if (!token) return;
    const h = req.headers.authorization || '';
    if (h !== `Bearer ${token}`) throw new HttpError(401, 'dispatcher token required');
  }

  function requireJson(req) {
    if (!(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json');
    }
  }

  const json = async (req) => {
    requireJson(req);
    return parseJson(await readBody(req));
  };

  function devOnly() {
    if (!devOn) throw new HttpError(403, 'dev endpoint disabled');
  }

  const nowSec = () => Math.floor(Date.now() / 1000);
  const devDeviceId = () => 0x4000 + Math.floor(Math.random() * 0x0fff);
  /** Dev timestamps stay strictly increasing per device so rapid demo clicks are not replays. */
  const devTimestamp = (deviceId) => Math.max(nowSec(), (svc.store.lastTimestamp(deviceId) ?? 0) + 1);

  function baseMsg(body, deviceId) {
    const scenario = SCENARIOS.find((s) => s.id === body.scenario);
    const lat = body.lat ?? scenario?.lat ?? 25.2048;
    const lon = body.lon ?? scenario?.lon ?? 55.2708;
    return {
      device_id: deviceId,
      timestamp: devTimestamp(deviceId),
      lat: Math.round(lat * 1e6),
      lon: Math.round(lon * 1e6),
      altitude_m: body.altitude_m ?? 12,
      battery_pct: body.battery_pct ?? 55,
    };
  }

  /** Vitals either given directly or measured by pushing a synthetic PPG through the analysis. */
  function vitalsFrom(body, defaults) {
    if (body.use_ppg) {
      const p = pollPPG({ seed: body.ppg_seed ?? 42, hr: body.heart_rate ?? defaults.heart_rate, spo2: body.spo2 ?? defaults.spo2 });
      return { heart_rate: p.heart_rate, spo2: p.spo2, ppg_quality: p.quality };
    }
    return { heart_rate: body.heart_rate ?? defaults.heart_rate, spo2: body.spo2 ?? defaults.spo2 };
  }

  function applySilent(deviceId, body) {
    if (typeof body.silent_mode === 'boolean') {
      const cur = svc.store.getDevice(deviceId);
      svc.setDevice({ device_id: deviceId, label: body.device_label ?? cur?.label ?? null, silent_mode: body.silent_mode, revoked: cur?.revoked ?? false });
    } else if (body.device_label) {
      const cur = svc.store.getDevice(deviceId);
      svc.setDevice({ device_id: deviceId, label: body.device_label, silent_mode: cur?.silent_mode ?? false, revoked: cur?.revoked ?? false });
    }
  }

  const ingestResult = (r) => ({
    action: r.action,
    incident_id: r.incident?.id ?? null,
    duplicate: r.duplicate,
    state: r.incident?.state ?? null,
  });

  /** Accept the satellite webhook shapes: raw binary, JSON, RockBLOCK form, Swarm JSON. */
  async function extractEnvelope(req) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const raw = await readBody(req);
    if (ct.includes('application/json')) {
      const j = parseJson(raw);
      if (typeof j.envelope_base64 === 'string') return Buffer.from(j.envelope_base64, 'base64');
      if (typeof j.data === 'string') return /^([0-9a-f]{2})+$/i.test(j.data) ? Buffer.from(j.data, 'hex') : Buffer.from(j.data, 'base64'); // Swarm Hive: base64
      throw new HttpError(400, 'JSON body needs envelope_base64 or data');
    }
    if (ct.includes('application/x-www-form-urlencoded')) {
      const data = new URLSearchParams(raw.toString('utf8')).get('data'); // RockBLOCK / Iridium SBD: hex
      if (!data || !/^([0-9a-f]{2})+$/i.test(data)) throw new HttpError(400, 'form body needs hex `data`');
      return Buffer.from(data, 'hex');
    }
    return raw;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const origin = req.headers.origin;
    const cors = origin && corsAllow.has(origin)
      ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' }
      : {};
    const reply = (status, obj) => send(req, res, status, obj, cors);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, cors);
        return res.end();
      }

      /* ---- satellite ingest ---- */
      if (req.method === 'POST' && p === '/api/v1/sat-ingest') {
        const envelope = await extractEnvelope(req);
        const r = await svc.ingest(envelope, { source: 'SAT_INGEST', via: 'SAT' });
        return reply(r.action === 'CREATED' ? 201 : 200, ingestResult(r));
      }

      /* ---- dev simulators ---- */
      if (req.method === 'POST' && p === '/api/v1/dev/simulate') {
        devOnly();
        const body = await json(req);
        const device_id = body.device_id ?? devDeviceId();
        applySilent(device_id, body);
        const v = vitalsFrom(body, { heart_rate: 118, spo2: 91 });
        const msg = { ...baseMsg(body, device_id), sos_code: body.sos_code ?? SOS.TRAUMA, heart_rate: v.heart_rate, spo2: v.spo2, duress_flag: !!body.duress };
        const envelope = svc.sealBeacon(msg, { codec: body.codec === 'cbor' ? 'cbor' : 'protobuf' });
        const r = await svc.ingest(envelope, { source: 'DEV_SIMULATE', deviceHint: body.device_label });
        return reply(r.action === 'CREATED' ? 201 : 200, { ...ingestResult(r), device_id, packet_bytes: envelope.length, format: r.format, triage: r.incident?.triage, model: r.incident?.model });
      }

      if (req.method === 'POST' && p === '/api/v1/dev/wristband') {
        devOnly();
        const body = await json(req);
        const events = Array.isArray(body.events) ? body.events
          : Number(body.held_ms) > 0 ? holdEvents(Number(body.held_ms))
          : tapEvents(Number(body.presses ?? 0));
        const got = runButtonEvents(events).filter((e) => e.gesture || e.ignored);
        const hit = got.find((e) => e.gesture);
        if (!hit) throw new HttpError(400, 'no gesture: 3 presses = medical, 5 = hostile extraction, 7 = duress, hold 10 s = cancel');

        const device_id = body.device_id ?? devDeviceId();
        if (hit.gesture === GESTURE.CANCEL && body.device_id === undefined) throw new HttpError(400, 'cancel needs the device_id of the incident to cancel');
        applySilent(device_id, body);
        const v = vitalsFrom(body, { heart_rate: 96, spo2: 95 });
        const beacon = gestureToBeacon({
          gesture: hit.gesture,
          device_id,
          ...baseMsg(body, device_id),
          heart_rate: v.heart_rate,
          spo2: v.spo2,
          duress: !!body.duress,
        });
        const envelope = svc.sealBeacon(beacon);
        const dev = svc.store.getDevice(device_id);
        const policy = covertPolicy({ duress: beacon.duress_flag, silentMode: !!dev?.silent_mode });
        const r = await svc.ingest(envelope, { source: 'WRISTBAND', deviceHint: body.device_label });
        return reply(r.action === 'CREATED' ? 201 : 200, {
          gesture: hit.gesture,
          presses: hit.presses,
          packet_sent: true,
          haptic: hapticPattern(hit.gesture === GESTURE.CANCEL ? 'CANCELLED' : 'SENT'),
          covert: policy,
          ppg_quality: v.ppg_quality,
          packet_bytes: envelope.length,
          device_id,
          ...ingestResult(r),
          triage: r.incident?.triage,
          model: r.incident?.model,
        });
      }

      if (req.method === 'POST' && p === '/api/v1/dev/mesh') {
        devOnly();
        const body = await json(req);
        const device_id = body.device_id ?? devDeviceId();
        applySilent(device_id, body);
        const v = vitalsFrom(body, { heart_rate: 104, spo2: 92 });
        const msg = { ...baseMsg(body, device_id), sos_code: body.sos_code ?? SOS.TRAUMA, heart_rate: v.heart_rate, spo2: v.spo2, duress_flag: !!body.duress };
        const sky = new Set(Array.isArray(body.sky) ? body.sky : ['relay-node']);
        for (const n of ['wristband', 'phone-a', 'phone-b', 'relay-node']) svc.mesh.nodes.get(n).sky = sky.has(n);
        const envelope = svc.sealBeacon(msg);
        const sent = svc.mesh.send(envelope, 'wristband');
        const deliveries = await svc.drainMesh();
        const ok = deliveries.find((d) => d.ok)?.r;
        return reply(sent.delivered ? 201 : 202, {
          delivered: sent.delivered,
          stored: sent.stored,
          hops: sent.hops ?? null,
          path: sent.path ?? null,
          stored_at: sent.stored_at ?? null,
          reason: sent.reason ?? null,
          device_id,
          packet_bytes: envelope.length,
          ...(ok ? ingestResult(ok) : {}),
          triage: ok?.incident?.triage,
        });
      }

      if (req.method === 'POST' && p === '/api/v1/dev/mesh/sky') {
        devOnly();
        const body = await json(req);
        if (!svc.mesh.nodes.has(body.node)) throw new HttpError(400, `unknown mesh node '${body.node}'`);
        const flushed = svc.mesh.setSky(body.node, body.sky !== false);
        const deliveries = await svc.drainMesh();
        return reply(200, { node: body.node, sky: body.sky !== false, delivered: flushed.length, incidents: deliveries.filter((d) => d.ok).map((d) => d.r.incident?.id), pending: svc.mesh.pendingPackets() });
      }

      if (req.method === 'GET' && p === '/api/v1/dev/scenarios') return reply(200, { scenarios: SCENARIOS });

      /* ---- dispatcher API ---- */
      if (req.method === 'GET' && p === '/api/v1/health') {
        return reply(200, { ...svc.health(), ws_clients: clientCount(), auth: token ? 'dispatcher token required' : 'OFF (set AEGIS_DISPATCH_TOKEN)', dev_endpoints: devOn, llm: { ...svc.health().llm, url_set: !!llmConfig().url } });
      }

      if (req.method === 'GET' && p === '/api/v1/kb') return reply(200, { ...kbInfo(), chunks: kbChunks() });

      if (req.method === 'GET' && p === '/api/v1/contracts') return reply(200, { contracts: fs.readdirSync(path.join(ROOT, 'contracts')) });

      if (p.startsWith('/api/v1/')) authorise(req);

      if (req.method === 'GET' && p === '/api/v1/incidents') return reply(200, { incidents: svc.list(), ws_clients: clientCount() });

      const m = p.match(/^\/api\/v1\/incidents\/([^/]+)(?:\/(transition|downlink|priority|cancel))?$/);
      if (m) {
        const id = m[1];
        if (req.method === 'GET' && !m[2]) return reply(200, svc.full(id));

        if (req.method === 'POST' && m[2] === 'transition') {
          const body = await json(req);
          const r = svc.transition(id, body.to, body.actor, body.reason, { unit: body.unit });
          return reply(200, { incident_id: id, state: r.incident.state, assigned_unit: r.incident.assigned_unit, audit: r.entry });
        }
        if (req.method === 'POST' && m[2] === 'downlink') {
          const body = await json(req);
          return reply(200, svc.downlink(id, { text: body.text, actor: body.actor }));
        }
        if (req.method === 'POST' && m[2] === 'priority') {
          const body = await json(req);
          const r = await svc.setPriority(id, body.level, body.actor, body.reason);
          return reply(200, { incident_id: id, priority_level: r.incident.triage.priority_level, audit: r.entry });
        }
        if (req.method === 'POST' && m[2] === 'cancel') {
          const body = await json(req);
          const r = svc.resolveCancel(id, body.accept === true, body.actor, body.reason);
          return reply(200, { incident_id: id, state: r.incident.state, cancel_request: r.incident.cancel_request });
        }
      }

      if (req.method === 'GET' && p === '/api/v1/devices') return reply(200, { devices: svc.devices() });
      const d = p.match(/^\/api\/v1\/devices\/(\d+)(?:\/(downlink\/pull))?$/);
      if (d) {
        const deviceId = Number(d[1]);
        if (req.method === 'PUT' && !d[2]) {
          const body = await json(req);
          const cur = svc.store.getDevice(deviceId);
          return reply(200, svc.setDevice({ device_id: deviceId, label: body.label ?? cur?.label ?? null, silent_mode: body.silent_mode ?? cur?.silent_mode ?? false, revoked: body.revoked ?? cur?.revoked ?? false }));
        }
        if (req.method === 'POST' && d[2]) {
          await json(req);
          return reply(200, { device_id: deviceId, messages: svc.pullDownlinks(deviceId) });
        }
      }

      /* ---- static ---- */
      if (req.method === 'GET') return serveStatic(res, p, cors);

      throw new HttpError(405, 'method not allowed');
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message, status: e.status });
      console.error('[aegis] internal error:', e);
      return reply(500, { error: 'internal error', status: 500 });
    }
  });

  // WebSocket upgrade gate: same-origin or allow-listed browser origins only (no cross-site
  // reads of live incident data), and the dispatcher token when one is configured.
  attachWS(server, {
    verify: (req, url) => {
      const origin = req.headers.origin;
      if (origin) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === req.headers.host;
        } catch {
          /* malformed origin: not same host */
        }
        if (!sameHost && !corsAllow.has(origin)) return false;
      }
      return !token || url.searchParams.get('token') === token;
    },
  });
  server.service = svc;
  return server;
}

// Static files: the panel from public/, plus the one shared module the offline field app imports.
const SHARED = { '/lib/rag-core.mjs': path.join(ROOT, 'src', 'rag-core.mjs') };

function serveStatic(res, urlPath, cors = {}) {
  let file;
  if (SHARED[urlPath]) file = SHARED[urlPath];
  else {
    let rel;
    try {
      rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath).replace(/^\/+/, '');
    } catch {
      return res.writeHead(400, cors).end('bad path');
    }
    if (rel.includes('\0')) return res.writeHead(400, cors).end('bad path');
    file = path.resolve(PUBLIC_DIR, rel);
    const within = path.relative(PUBLIC_DIR, file);
    if (within.startsWith('..') || path.isAbsolute(within)) return res.writeHead(403, cors).end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, cors).end('not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...cors });
    res.end(data);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || '127.0.0.1';
  const dbPath = process.env.AEGIS_DB || path.join(ROOT, 'data', 'aegis.db');
  const app = createApp({ dbPath });
  app.listen(port, host, () => {
    const h = app.service.health();
    console.log(`[aegis] core service on http://${host}:${port}  (panel: /, ws: /ws)`);
    console.log(`[aegis] db=${h.db}  keys=${h.keys.mode}  geo=${h.geo.mode}  llm=${h.llm.enabled ? h.llm.provider + ':' + h.llm.model : 'off'}  auth=${process.env.AEGIS_DISPATCH_TOKEN ? 'token' : 'OFF'}`);
    if (h.keys.mode === 'EPHEMERAL') console.log('[aegis] AEGIS_MASTER_KEY not set: device keys are ephemeral and rotate on every restart');
  });
}

// AegisMonitor core service: the CAD engine behind the HTTP layer.
//
// Owns: authenticated beacon ingest, one living incident per device (new packets
// UPDATE the open incident), trend-based biometric re-ranking, cancel handling, the
// state machine, the device downlink outbox, and write-through persistence.
// server.mjs is only the transport.

import { encrypt, decrypt, peekHeader, envelopeId, checkFreshness, epochFor, keyMode, KEY_EPOCH_S, MAX_AGE_S } from './crypto.mjs';
import { encode, encodeCbor, decodePayload, validatePacket, MAX_PACKET_BYTES, SOS, SOS_NAME } from './proto.mjs';
import { applyTransition, OPEN_STATES, STATES } from './state.mjs';
import { createGeo } from './geo.mjs';
import { triage as runTriage, isCovert, trendOf } from './triage.mjs';
import { enhance, llmConfig } from './llm.mjs';
import { openStore } from './store.mjs';
import { MeshNetwork, MESH_MAX_HOPS } from './mesh.mjs';
import { kbInfo } from './rag.mjs';
import { hapticPattern } from './wristband.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HISTORY_CAP = 120;
// Battery drain is an ESTIMATE. With <2 usable samples the documented assumption is
// used; with more, the observed slope replaces it.
export const ASSUMED_DRAIN_PCT_PER_MIN = 0.03;

export function batteryEstimate(history = []) {
  const pts = history.filter((h) => Number.isFinite(h.battery_pct) && h.battery_pct > 0).slice(-10);
  const last = pts[pts.length - 1];
  if (!last) return { eta_min: null, model: 'none', rate_pct_per_min: null, samples: 0 };
  if (pts.length >= 2) {
    const first = pts[0];
    const minutes = (last.ts - first.ts) / 60;
    const drop = first.battery_pct - last.battery_pct;
    if (minutes >= 2 && drop > 0) {
      const rate = drop / minutes;
      return { eta_min: Math.round(last.battery_pct / rate), model: 'observed', rate_pct_per_min: +rate.toFixed(3), samples: pts.length };
    }
  }
  return { eta_min: Math.round(last.battery_pct / ASSUMED_DRAIN_PCT_PER_MIN), model: 'assumed', rate_pct_per_min: ASSUMED_DRAIN_PCT_PER_MIN, samples: pts.length };
}

export function createService({
  dbPath = ':memory:',
  geo = createGeo(),
  broadcast = () => {},
  now = () => Date.now(),
  env = process.env,
} = {}) {
  const store = openStore(dbPath);
  const incidents = new Map();
  const seqOf = new Map();
  let seq = store.nextSeq() - 1;
  for (const inc of store.loadIncidents()) {
    incidents.set(inc.id, inc);
    seqOf.set(inc.id, Number(inc.id.slice(4)));
  }
  const counters = { ingested: 0, duplicates: 0, rejected: 0, updates: 0 };
  const jobs = new Set();
  const track = (p) => {
    jobs.add(p);
    p.finally(() => jobs.delete(p));
    return p;
  };

  const iso = () => new Date(now()).toISOString();
  const nowSec = () => Math.floor(now() / 1000);

  /* ---------------- helpers ---------------- */

  function audit(inc, from, to, actor, reason) {
    const entry = { incident_id: inc.id, from, to, actor, reason, at: iso() };
    inc.audit.push(entry);
    return entry;
  }

  const persist = (inc) => store.saveIncident(inc, seqOf.get(inc.id));
  const isOpen = (inc) => OPEN_STATES.includes(inc.state);
  const findOpen = (deviceId) => [...incidents.values()].reverse().find((i) => i.device_id === deviceId && isOpen(i));

  /** Queue order: priority, then deteriorating first, then longest-waiting. */
  function ranking() {
    const open = [...incidents.values()].filter(isOpen);
    open.sort((a, b) => {
      const pa = a.triage?.priority_level ?? 9;
      const pb = b.triage?.priority_level ?? 9;
      if (pa !== pb) return pa - pb;
      const da = a.trend?.deteriorating ? 0 : 1;
      const db = b.trend?.deteriorating ? 0 : 1;
      if (da !== db) return da - db;
      return a.received_at < b.received_at ? -1 : 1;
    });
    return new Map(open.map((inc, i) => [inc.id, i + 1]));
  }

  function summary(inc, ranks = ranking()) {
    return {
      id: inc.id,
      device_id: inc.device_id,
      device_label: inc.device_label,
      state: inc.state,
      received_at: inc.received_at,
      updated_at: inc.updated_at,
      position: inc.position,
      vitals: inc.vitals,
      source: inc.source,
      packets: inc.history.length,
      age_s: inc.age_s,
      priority_level: inc.triage?.priority_level ?? null,
      category: inc.triage?.triage_category ?? null,
      queue_rank: ranks.get(inc.id) ?? null,
      deteriorating: !!inc.trend?.deteriorating,
      covert: isCovert(inc),
      battery: inc.battery,
      assigned_unit: inc.assigned_unit,
      cancel_request: inc.cancel_request,
      reply: inc.triage?.user_satellite_reply ?? null,
    };
  }

  /** Emit INCIDENT_RERANKED for every incident whose priority or queue position moved. */
  function emitRerank(before, after, causeId) {
    const changes = [];
    for (const [id, snap] of before) {
      const inc = incidents.get(id);
      if (!inc) continue;
      const rankNow = after.get(id) ?? null;
      const pNow = inc.triage?.priority_level ?? null;
      if (snap.priority !== pNow || snap.rank !== rankNow) {
        changes.push({ incident_id: id, from_priority: snap.priority, to_priority: pNow, from_rank: snap.rank, to_rank: rankNow, reasons: id === causeId ? inc.priority_reasons || [] : ['queue position shifted'] });
      }
    }
    if (changes.length) broadcast({ type: 'INCIDENT_RERANKED', changes });
    return changes;
  }

  const snapshot = () => {
    const r = ranking();
    return new Map([...incidents.values()].map((i) => [i.id, { priority: i.triage?.priority_level ?? null, rank: r.get(i.id) ?? null }]));
  };

  function enqueueHaptic(inc, event) {
    const id = store.enqueueDownlink({ incident_id: inc.id, device_id: inc.device_id, kind: 'HAPTIC', body: { event, pattern: hapticPattern(event) } });
    broadcast({ type: 'DOWNLINK_QUEUED', incident_id: inc.id, kind: 'HAPTIC', event, id });
  }

  /* ---------------- triage ---------------- */

  async function runRules(inc) {
    const context = await geo.geoContext(inc.position.lat, inc.position.lon, 25);
    const r = await runTriage({ incident: inc, context });
    const prev = inc.triage?.priority_level;
    inc.context = context;
    inc.triage = r.triage;
    inc.grounding = r.grounding;
    inc.deconfliction = r.deconfliction;
    inc.priority_reasons = r.assessment.reasons;
    inc.trend = r.assessment.trend;
    inc.peak_priority = Math.min(inc.peak_priority ?? 9, r.triage.priority_level);
    if (inc.priority_override !== null && inc.priority_override !== undefined) inc.peak_priority = r.triage.priority_level;
    inc.model = { used: 'rules', reason: llmConfig().enabled ? 'model pass pending' : 'llm disabled' };
    if (prev !== undefined && prev !== r.triage.priority_level) {
      inc.priority_log.push({ at: iso(), from: prev, to: r.triage.priority_level, reasons: r.assessment.reasons });
    }
    return r;
  }

  /** Optional model pass, off the request path: the rules answer is already published. */
  function scheduleModelPass(inc) {
    if (!llmConfig().enabled) return;
    const rev = inc.rev;
    track((async () => {
      const r = await enhance({ incident: inc, ruleTriage: inc.triage, grounding: inc.grounding, context: inc.context, deconfliction: inc.deconfliction });
      if (inc.rev !== rev || inc.state === 'CLOSED') return; // newer packet or closed: discard
      if (r.used === 'llm') {
        inc.triage = r.triage;
        inc.model = { used: 'llm', model: r.model, reason: r.reason, notes: r.notes || [] };
      } else {
        inc.model = { used: 'rules', reason: r.reason };
      }
      persist(inc);
      broadcast({ type: 'INCIDENT_TRIAGED', incident_id: inc.id, triage: inc.triage, state: inc.state, model: inc.model });
    })().catch(() => {}));
  }

  /* ---------------- ingest ---------------- */

  function authenticate(envelope) {
    if (envelope.length >= MAX_PACKET_BYTES) throw new HttpError(413, `envelope ${envelope.length}B >= cap ${MAX_PACKET_BYTES}B`);
    let hdr;
    try {
      hdr = peekHeader(envelope);
    } catch (e) {
      throw new HttpError(422, e.message);
    }
    const dev = store.getDevice(hdr.deviceId);
    if (dev?.revoked) throw new HttpError(403, `device ${hdr.deviceId} is revoked`);
    if (!dev && env.AEGIS_OPEN_PROVISIONING === '0') throw new HttpError(403, `device ${hdr.deviceId} is not provisioned`);
    let opened;
    try {
      opened = decrypt(envelope);
    } catch {
      throw new HttpError(401, 'authentication failed');
    }
    return { opened, device: dev };
  }

  async function ingest(envelope, { source = 'SAT_INGEST', via = 'SAT', deviceHint = null, mesh = null } = {}) {
    try {
      return await ingestInner(envelope, { source, via, deviceHint, mesh });
    } catch (e) {
      counters.rejected += 1;
      throw e;
    }
  }

  async function ingestInner(envelope, { source, via, deviceHint, mesh }) {
    const { opened, device } = authenticate(envelope);

    let decoded;
    try {
      decoded = decodePayload(opened.payload);
    } catch (e) {
      throw new HttpError(422, 'decode failed: ' + e.message);
    }
    const msg = decoded.msg;
    const errors = validatePacket(msg, envelope.length);
    if (errors.length) throw new HttpError(422, 'packet invalid: ' + errors.join('; '));
    if (msg.device_id !== opened.deviceId || epochFor(msg.timestamp) !== opened.epoch) {
      throw new HttpError(401, 'envelope header does not match the authenticated payload');
    }

    const eid = envelopeId(envelope);
    const dup = store.envelopeSeen(eid);
    if (dup) {
      counters.duplicates += 1;
      return { incident: incidents.get(dup) || null, duplicate: true, action: 'DUPLICATE', envelope_id: eid };
    }

    const fresh = checkFreshness(msg.timestamp, nowSec());
    if (!fresh.ok) throw new HttpError(422, fresh.reason);
    const last = store.lastTimestamp(msg.device_id);
    if (last !== null && msg.timestamp <= last) throw new HttpError(409, `replay: timestamp ${msg.timestamp} <= last seen ${last}`);

    // Everything authenticated and fresh: commit to the replay state and registry.
    store.setLastTimestamp(msg.device_id, msg.timestamp);
    store.markEnvelope(eid, 'pending');
    const dev = device || store.putDevice({ device_id: msg.device_id, label: deviceHint, silent_mode: false });
    counters.ingested += 1;

    if (msg.sos_code === SOS.CANCEL) return handleCancel(msg, dev, { eid, envelope, decoded, via, source });

    const before = snapshot();
    const sample = {
      ts: msg.timestamp,
      received_at: iso(),
      lat: msg.lat / 1e6,
      lon: msg.lon / 1e6,
      heart_rate: msg.heart_rate ?? 0,
      spo2: msg.spo2 ?? 0,
      battery_pct: msg.battery_pct ?? 0,
      sos_code: msg.sos_code,
      duress_flag: !!msg.duress_flag,
    };

    let inc = findOpen(msg.device_id);
    const created = !inc;
    if (created) {
      seq += 1;
      inc = {
        id: 'INC-' + String(seq).padStart(4, '0'),
        device_id: msg.device_id,
        device_label: dev.label || deviceHint || 'WRIST-' + msg.device_id.toString(16).toUpperCase(),
        state: 'SOS_RECEIVED',
        received_at: iso(),
        history: [],
        audit: [],
        priority_log: [],
        peak_priority: null,
        priority_override: null,
        assigned_unit: null,
        cancel_request: null,
        rev: 0,
      };
      incidents.set(inc.id, inc);
      seqOf.set(inc.id, seq);
    } else {
      counters.updates += 1;
    }

    inc.rev += 1;
    inc.updated_at = iso();
    inc.source = source;
    inc.mesh = mesh;
    inc.silent_mode = !!dev.silent_mode;
    inc.sos_code = msg.sos_code;
    inc.position = { lat: sample.lat, lon: sample.lon, altitude_m: msg.altitude_m ?? 0 };
    inc.vitals = { heart_rate: sample.heart_rate, spo2: sample.spo2, battery_pct: sample.battery_pct, duress_flag: sample.duress_flag };
    inc.age_s = fresh.age_s;
    inc.telemetry_bytes = opened.payload.length;
    inc.envelope_bytes = envelope.length;
    inc.codec = decoded.format;
    inc.key_epoch = opened.epoch;
    inc.history.push(sample);
    if (inc.history.length > HISTORY_CAP) inc.history.shift();
    inc.battery = batteryEstimate(inc.history);

    store.saveTelemetry({ incident_id: inc.id, device_id: msg.device_id, device_ts: msg.timestamp, received_at: iso(), via, format: decoded.format, envelope, decoded: msg });
    store.markEnvelope(eid, inc.id);

    audit(inc, created ? null : inc.state, inc.state, 'system',
      `${created ? 'beacon' : 'update'} ${inc.history.length} via ${via} (${opened.payload.length}B ${decoded.format}, epoch ${opened.epoch}${mesh ? `, mesh ${mesh.hops} hop(s)` : ''}${fresh.age_s > 60 ? `, ${Math.round(fresh.age_s / 60)} min old` : ''})`);
    broadcast({ type: created ? 'INCIDENT_CREATED' : 'INCIDENT_UPDATED', incident: summary(inc) });

    const priorBefore = inc.triage?.priority_level ?? null;
    await runRules(inc);
    if (inc.state === 'SOS_RECEIVED') {
      const moved = applyTransition(inc, 'AI_TRIAGED', 'system', `triage P${inc.triage.priority_level} ${inc.triage.triage_category} via rules`, iso());
      if (!moved.ok) audit(inc, inc.state, 'AI_TRIAGED', 'system', 'triage recorded without transition: ' + moved.reason);
    } else if (priorBefore !== null && priorBefore !== inc.triage.priority_level) {
      audit(inc, inc.state, inc.state, 'system', `re-ranked P${priorBefore} -> P${inc.triage.priority_level}: ${inc.priority_reasons.join('; ')}`);
    }

    persist(inc);
    enqueueHaptic(inc, 'ACK');
    broadcast({ type: 'INCIDENT_TRIAGED', incident_id: inc.id, triage: inc.triage, state: inc.state, model: inc.model });
    emitRerank(before, ranking(), inc.id);
    scheduleModelPass(inc);
    return { incident: inc, created, duplicate: false, action: created ? 'CREATED' : 'UPDATED', envelope_id: eid, format: decoded.format };
  }

  function handleCancel(msg, dev, { eid, envelope, decoded, via }) {
    const inc = findOpen(msg.device_id);
    store.markEnvelope(eid, inc ? inc.id : 'none');
    if (!inc) return { incident: null, duplicate: false, action: 'CANCEL_NO_OPEN_INCIDENT', envelope_id: eid };

    store.saveTelemetry({ incident_id: inc.id, device_id: msg.device_id, device_ts: msg.timestamp, received_at: iso(), via, format: decoded.format, envelope, decoded: msg });
    const coerced = isCovert(inc) || !!msg.duress_flag;
    // Before any unit is committed, a plain cancel closes the incident. Otherwise, or if
    // the device is covert / in duress (a cancel may be coerced), a human must confirm.
    if (!coerced && ['SOS_RECEIVED', 'AI_TRIAGED'].includes(inc.state)) {
      const moved = applyTransition(inc, 'CLOSED', 'device', 'false alarm: wristband cancel (10 s hold)', iso());
      inc.updated_at = iso();
      persist(inc);
      enqueueHaptic(inc, 'CANCELLED');
      broadcast({ type: 'INCIDENT_STATE', incident_id: inc.id, state: inc.state, audit: moved.entry });
      return { incident: inc, duplicate: false, action: 'CANCEL_CLOSED', envelope_id: eid };
    }
    inc.cancel_request = { at: iso(), possibly_coerced: coerced, pending: true };
    audit(inc, inc.state, inc.state, 'device', `cancel requested by wristband${coerced ? ' (covert/duress: possibly coerced)' : ' (unit already committed)'}; dispatcher must confirm`);
    inc.updated_at = iso();
    persist(inc);
    broadcast({ type: 'INCIDENT_CANCEL_REQUEST', incident_id: inc.id, possibly_coerced: coerced });
    return { incident: inc, duplicate: false, action: 'CANCEL_REQUESTED', envelope_id: eid };
  }

  /* ---------------- dispatcher actions ---------------- */

  function get(id) {
    const inc = incidents.get(id);
    if (!inc) throw new HttpError(404, 'no such incident');
    return inc;
  }

  function resolveUnit(inc, unit) {
    const assets = inc.context?.assets || [];
    const wanted = typeof unit === 'string' ? unit : unit?.id || unit?.name;
    const rec = inc.deconfliction?.recommended?.asset;
    const pick = wanted ? assets.find((a) => a.id === wanted || a.name === wanted) : rec;
    if (!pick) throw new HttpError(422, wanted ? `unknown unit '${wanted}' (not in the asset registry for this slice)` : 'unit required: no recommended asset to default to');
    return { id: pick.id, name: pick.name, kind: pick.kind };
  }

  function transition(id, to, actor, reason, { unit } = {}) {
    const inc = get(id);
    const before = snapshot();
    let assigned = null;
    if (to === 'UNIT_ASSIGNED') assigned = resolveUnit(inc, unit);
    const moved = applyTransition(inc, to, actor, reason ?? '(no reason given)', iso());
    if (!moved.ok) throw new HttpError(409, moved.reason);
    if (assigned) {
      inc.assigned_unit = assigned;
      moved.entry.reason += ` [unit ${assigned.name}]`;
      enqueueHaptic(inc, 'DISPATCHED');
    }
    if (to === 'CLOSED' && inc.cancel_request?.pending) inc.cancel_request = { ...inc.cancel_request, pending: false, resolved: 'closed' };
    inc.updated_at = iso();
    persist(inc);
    broadcast({ type: 'INCIDENT_STATE', incident_id: inc.id, state: inc.state, audit: moved.entry, assigned_unit: inc.assigned_unit });
    emitRerank(before, ranking(), inc.id);
    return { incident: inc, entry: moved.entry };
  }

  function resolveCancel(id, accept, actor, reason) {
    const inc = get(id);
    if (!inc.cancel_request?.pending) throw new HttpError(409, 'no pending cancel request');
    if (accept) return transition(id, 'CLOSED', 'dispatcher', reason || 'dispatcher confirmed wristband cancel');
    inc.cancel_request = { ...inc.cancel_request, pending: false, resolved: 'rejected' };
    const entry = audit(inc, inc.state, inc.state, actor || 'dispatcher', 'cancel request rejected: ' + (reason || 'treated as possibly coerced'));
    persist(inc);
    broadcast({ type: 'INCIDENT_UPDATED', incident: summary(inc) });
    return { incident: inc, entry };
  }

  /** A dispatcher may lower (or raise) urgency; vitals that demand P1 always win. */
  async function setPriority(id, level, actor, reason) {
    if (!Number.isInteger(level) || level < 1 || level > 5) throw new HttpError(422, 'priority must be an integer 1-5');
    const inc = get(id);
    if (!isOpen(inc)) throw new HttpError(409, 'incident is not open');
    const before = snapshot();
    inc.priority_override = level;
    inc.peak_priority = null;
    inc.rev += 1;
    await runRules(inc);
    const entry = audit(inc, inc.state, inc.state, actor || 'dispatcher', `priority set to P${level} (result P${inc.triage.priority_level}): ${reason || 'no reason given'}`);
    inc.updated_at = iso();
    persist(inc);
    broadcast({ type: 'INCIDENT_TRIAGED', incident_id: inc.id, triage: inc.triage, state: inc.state, model: inc.model });
    emitRerank(before, ranking(), inc.id);
    return { incident: inc, entry };
  }

  function downlink(id, { text, actor = 'dispatcher' }) {
    const inc = get(id);
    if (inc.state === 'CLOSED') throw new HttpError(409, 'incident is closed');
    const body = String(text ?? '');
    const covert = isCovert(inc);
    if (covert && body !== 'HAPTIC_ACK_ONLY') throw new HttpError(409, 'covert incident (duress or silent mode): only HAPTIC_ACK_ONLY may be downlinked');
    if (body.length === 0) throw new HttpError(422, 'text required');
    if (body.length > 160) throw new HttpError(422, `downlink is ${body.length} chars, cap is 160`);
    if (!/^[\x20-\x7E]*$/.test(body)) throw new HttpError(422, 'downlink must be ASCII');
    let queued;
    if (body === 'HAPTIC_ACK_ONLY') {
      queued = store.enqueueDownlink({ incident_id: inc.id, device_id: inc.device_id, kind: 'HAPTIC', body: { event: 'ACK', pattern: hapticPattern('ACK') } });
    } else {
      queued = store.enqueueDownlink({ incident_id: inc.id, device_id: inc.device_id, kind: 'TEXT', body: { text: body } });
    }
    const entry = audit(inc, inc.state, inc.state, actor, 'downlink queued: ' + body);
    persist(inc);
    broadcast({ type: 'DOWNLINK_QUEUED', incident_id: inc.id, kind: body === 'HAPTIC_ACK_ONLY' ? 'HAPTIC' : 'TEXT', text: body, chars: body.length, id: queued });
    return { queued: true, id: queued, chars: body.length, audit: entry };
  }

  /* ---------------- mesh (simulated BLE/LoRa) ---------------- */

  const meshJobs = [];
  const mesh = new MeshNetwork({
    uplink: (envelope, meta) => {
      meshJobs.push(ingest(envelope, { source: 'MESH_RELAY', via: 'MESH', mesh: { hops: meta.hops, path: meta.path, stored: meta.stored } }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })));
    },
  });
  mesh.addNode('wristband').addNode('phone-a').addNode('phone-b').addNode('relay-node');
  mesh.link('wristband', 'phone-a').link('phone-a', 'phone-b').link('phone-a', 'relay-node');
  const drainMesh = async () => {
    const out = await Promise.all(meshJobs.splice(0));
    return out;
  };

  /* ---------------- dev helpers ---------------- */

  function sealBeacon(msg, { codec = 'protobuf' } = {}) {
    const payload = codec === 'cbor' ? encodeCbor(msg) : encode(msg);
    return encrypt(payload, { deviceId: msg.device_id, timestamp: msg.timestamp });
  }

  /* ---------------- views ---------------- */

  const list = () => {
    const ranks = ranking();
    return [...incidents.values()].map((i) => summary(i, ranks)).sort((a, b) => (a.queue_rank ?? 1e9) - (b.queue_rank ?? 1e9) || (a.received_at < b.received_at ? 1 : -1));
  };

  function full(id) {
    const inc = get(id);
    const ranks = ranking();
    // The full record carries the same derived fields as the list summary, so every client
    // (panel, WorldMonitor extension) reads one definition of covert / deteriorating.
    return {
      ...inc,
      queue_rank: ranks.get(id) ?? null,
      covert: isCovert(inc),
      deteriorating: !!inc.trend?.deteriorating,
      packets: inc.history.length,
      downlinks: store.downlinksFor(id),
      telemetry: store.telemetryFor(id),
      battery: batteryEstimate(inc.history),
    };
  }

  function health() {
    const cfg = llmConfig();
    return {
      ok: true,
      version: '0.2.0',
      incidents: incidents.size,
      open: [...incidents.values()].filter(isOpen).length,
      counters,
      keys: { mode: keyMode(), epoch_s: KEY_EPOCH_S, max_age_s: MAX_AGE_S },
      provisioning: env.AEGIS_OPEN_PROVISIONING === '0' ? 'closed' : 'open',
      db: store.file === ':memory:' ? 'memory (not persistent)' : store.file,
      telemetry_rows: store.telemetryCount(),
      geo: { mode: geo.mode() },
      llm: { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model, models: cfg.models, key_present: cfg.keyPresent },
      kb: kbInfo(),
      mesh: { max_hops: MESH_MAX_HOPS, pending: mesh.pendingPackets().length },
      assumptions: { battery_drain_pct_per_min: ASSUMED_DRAIN_PCT_PER_MIN },
      states: STATES,
    };
  }

  return {
    store, incidents, mesh, counters,
    ingest, transition, resolveCancel, setPriority, downlink, drainMesh, sealBeacon,
    list, full, get, summary, health, trendOf,
    pullDownlinks: (deviceId) => store.pullDownlinks(deviceId, iso()),
    pendingDownlinks: (deviceId) => store.pendingCount(deviceId),
    devices: () => store.listDevices(),
    setDevice: (d) => store.putDevice(d),
    idle: async () => { while (jobs.size) await Promise.allSettled([...jobs]); },
    close: () => store.close(),
    SOS_NAME,
  };
}

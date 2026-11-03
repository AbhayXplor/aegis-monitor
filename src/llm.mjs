// Gemma 4 (or any chat model) adapter.
//
// Disabled unless AEGIS_LLM=1 AND AEGIS_LLM_URL is set. The key is read from the
// server environment only — never from the browser, never logged, never returned.
//
// Design rules:
//  - The system prompt is read from contracts/Modelfile, so there is exactly one copy.
//  - Output must parse as JSON and pass the §3 schema, or we fall back to rules.
//  - Safety floors run AFTER the model: urgency may only go up, never down; covert
//    incidents stay covert; assets must exist in the supplied context; reply stays
//    ASCII <= 160. A model cannot invent a hospital into existence.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ['MEDEVAC', 'COMBAT_EXTRACTION', 'HOSTAGE_COVERT', 'SAR', 'SUPPLY_DROP'];
const KEYS = ['incident_id', 'priority_level', 'triage_category', 'physiological_status',
  'hazard_assessment', 'deconflicted_route_plan', 'dispatcher_checklist', 'user_satellite_reply'];

export function llmConfig() {
  const url = process.env.AEGIS_LLM_URL || '';
  return {
    enabled: process.env.AEGIS_LLM === '1' && !!url,
    url,
    provider: (process.env.AEGIS_LLM_PROVIDER || 'openai').toLowerCase(),
    model: process.env.AEGIS_LLM_MODEL || 'gemma4',
    keyPresent: !!(process.env.AEGIS_LLM_KEY || process.env.OPENAI_API_KEY),
    timeoutMs: Number(process.env.AEGIS_LLM_TIMEOUT_MS || 8000),
  };
}

export function systemPrompt() {
  const file = path.join(HERE, '..', 'contracts', 'Modelfile');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/SYSTEM\s+"""([\s\S]*?)"""/);
  if (!m) throw new Error('SYSTEM block missing from contracts/Modelfile');
  return m[1].trim();
}

function requestBody(cfg, payload) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: JSON.stringify(payload) },
  ];
  if (cfg.provider === 'ollama') {
    return { model: cfg.model, messages, stream: false, format: 'json', options: { temperature: 0 } };
  }
  return { model: cfg.model, messages, temperature: 0, response_format: { type: 'json_object' } };
}

function extractContent(cfg, body) {
  if (cfg.provider === 'ollama') return body?.message?.content ?? body?.response ?? '';
  return body?.choices?.[0]?.message?.content ?? '';
}

/** Apply hard floors the model is not allowed to override. */
export function enforceFloors(modelTriage, { ruleTriage, context, incidentId }) {
  const notes = [];
  const out = { ...modelTriage };

  if (out.incident_id !== incidentId) {
    notes.push(`incident_id corrected (${out.incident_id} → ${incidentId})`);
    out.incident_id = incidentId;
  }

  // urgency may only increase
  if (!Number.isInteger(out.priority_level) || out.priority_level < 1 || out.priority_level > 5) {
    notes.push('priority out of range, using rule value');
    out.priority_level = ruleTriage.priority_level;
  } else if (out.priority_level > ruleTriage.priority_level) {
    notes.push(`priority raised ${out.priority_level} → ${ruleTriage.priority_level} by rules floor`);
    out.priority_level = ruleTriage.priority_level;
  }

  // covert mode is non-negotiable
  if (ruleTriage.triage_category === 'HOSTAGE_COVERT' && out.triage_category !== 'HOSTAGE_COVERT') {
    notes.push('category forced to HOSTAGE_COVERT by rules floor');
    out.triage_category = 'HOSTAGE_COVERT';
  }
  if (out.triage_category === 'HOSTAGE_COVERT') {
    out.user_satellite_reply = 'HAPTIC_ACK_ONLY';
  }

  if (!CATEGORIES.includes(out.triage_category)) {
    notes.push('unknown category, using rule value');
    out.triage_category = ruleTriage.triage_category;
  }

  // no invented assets: every "via X" must exist in the supplied context
  const names = new Set((context?.hospitals || []).map((h) => h.name));
  const plan = String(out.deconflicted_route_plan || '');
  const via = [...plan.matchAll(/via\s+([^().]+?)\s*(?:\(|\.|$)/gi)].map((m) => m[1].trim());
  const invented = via.filter((v) => !names.has(v));
  if (invented.length) {
    notes.push(`invented asset rejected: ${invented.join(', ')}`);
    out.deconflicted_route_plan = ruleTriage.deconflicted_route_plan;
  }

  // downlink discipline
  let reply = String(out.user_satellite_reply || '');
  if (out.triage_category === 'HOSTAGE_COVERT') reply = 'HAPTIC_ACK_ONLY';
  reply = reply.replace(/[^\x20-\x7E]/g, '').slice(0, 160);
  if (!reply) {
    notes.push('empty reply, using rule value');
    reply = ruleTriage.user_satellite_reply;
  }
  out.user_satellite_reply = reply;

  // checklist must be exactly three non-empty strings
  if (!Array.isArray(out.dispatcher_checklist) || out.dispatcher_checklist.length !== 3 ||
      out.dispatcher_checklist.some((c) => typeof c !== 'string' || !c.trim())) {
    notes.push('checklist invalid, using rule value');
    out.dispatcher_checklist = ruleTriage.dispatcher_checklist;
  }

  for (const k of ['physiological_status', 'hazard_assessment']) {
    if (typeof out[k] !== 'string' || !out[k].trim()) {
      notes.push(`${k} empty, using rule value`);
      out[k] = ruleTriage[k];
    }
  }

  return { triage: out, notes };
}

export function validateShape(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  const missing = KEYS.filter((k) => !(k in obj));
  if (missing.length) return 'missing keys: ' + missing.join(', ');
  const extra = Object.keys(obj).filter((k) => !KEYS.includes(k));
  if (extra.length) return 'extra keys: ' + extra.join(', ');
  return null;
}

export async function enhance({ incident, ruleTriage, grounding, context }) {
  const cfg = llmConfig();
  if (!cfg.enabled) return { triage: ruleTriage, used: 'rules', reason: 'llm disabled' };

  const payload = {
    incident_id: incident.id,
    beacon: {
      device_id: incident.device_id,
      sos_code: incident.sos_code,
      position: incident.position,
      vitals: incident.vitals,
      duress_flag: !!incident.vitals?.duress_flag,
      received_at: incident.received_at,
    },
    geo_context_25km: context,
    protocol_chunks: grounding.map((g) => ({ id: g.chunk_id, topic: g.topic, text: g.quote })),
    required_output_schema: KEYS,
  };

  const headers = { 'content-type': 'application/json' };
  const key = process.env.AEGIS_LLM_KEY || process.env.OPENAI_API_KEY;
  if (key) headers.authorization = `Bearer ${key}`;

  const send = (body) => fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  let raw;
  let status = 0;
  try {
    let res = await send(requestBody(cfg, payload));
    status = res.status;
    // Some OpenAI-compatible gateways reject response_format. Retry once relaxed.
    if (!res.ok && cfg.provider !== 'ollama') {
      const relaxed = requestBody(cfg, payload);
      delete relaxed.response_format;
      res = await send(relaxed);
      status = res.status;
    }
    if (!res.ok) return { triage: ruleTriage, used: 'rules', reason: `model HTTP ${status}` };
    raw = extractContent(cfg, await res.json());
  } catch (e) {
    return { triage: ruleTriage, used: 'rules', reason: 'model unreachable: ' + e.name };
  }

  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw.replace(/^```(?:json)?|```$/g, '').trim() : raw);
  } catch {
    return { triage: ruleTriage, used: 'rules', reason: 'model returned non-JSON' };
  }

  const shapeError = validateShape(parsed);
  if (shapeError) return { triage: ruleTriage, used: 'rules', reason: shapeError };

  const { triage, notes } = enforceFloors(parsed, { ruleTriage, context, incidentId: incident.id });
  return { triage, used: 'llm', reason: notes.length ? notes.join('; ') : 'accepted', notes };
}

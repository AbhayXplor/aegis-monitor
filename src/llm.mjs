// Gemma / Gemini model adapter.
//
// Disabled unless AEGIS_LLM=1 AND AEGIS_LLM_URL is set. The key is read from the
// server environment only — never from the browser, never logged, never returned.
//
// Design rules:
//  - The system prompt is read from contracts/Modelfile, so there is exactly one copy.
//  - Output must parse as JSON and pass the §3 schema, or we fall back to rules.
//  - A model chain is tried in order (primary, then AEGIS_LLM_FALLBACK), so a 503
//    on one model does not take the demo down.
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
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

export function llmConfig(env = process.env) {
  const provider = (env.AEGIS_LLM_PROVIDER || 'ollama').toLowerCase();
  // Ollama Cloud is the brief's target. A local Ollama (http://localhost:11434/api/chat)
  // or any OpenAI-compatible endpoint can be selected with AEGIS_LLM_URL / _PROVIDER.
  const url = env.AEGIS_LLM_URL || (provider === 'ollama' ? 'https://ollama.com/api/chat' : '');
  const primary = env.AEGIS_LLM_MODEL || 'gemma4';
  const fallbacks = (env.AEGIS_LLM_FALLBACK || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled: env.AEGIS_LLM === '1' && !!url,
    url,
    provider,
    model: primary,
    models: [primary, ...fallbacks.filter((m) => m !== primary)],
    keyPresent: !!(env.AEGIS_LLM_KEY || env.OLLAMA_API_KEY || env.OPENAI_API_KEY),
    timeoutMs: Number(env.AEGIS_LLM_TIMEOUT_MS || 12000),
  };
}

export function systemPrompt() {
  const file = path.join(HERE, '..', 'contracts', 'Modelfile');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/SYSTEM\s+"""([\s\S]*?)"""/);
  if (!m) throw new Error('SYSTEM block missing from contracts/Modelfile');
  return m[1].trim();
}

function requestBody(cfg, payload, model) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: JSON.stringify(payload) },
  ];
  if (cfg.provider === 'ollama') {
    return { model, messages, stream: false, format: 'json', options: { temperature: 0 } };
  }
  return { model, messages, temperature: 0, response_format: { type: 'json_object' } };
}

function extractContent(cfg, body) {
  if (cfg.provider === 'ollama') return body?.message?.content ?? body?.response ?? '';
  return body?.choices?.[0]?.message?.content ?? '';
}

const stripFences = (s) => String(s).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

/** Apply hard floors the model is not allowed to override. */
export function enforceFloors(modelTriage, { ruleTriage, context, incidentId, silentMode = false }) {
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
  const names = new Set([...(context?.hospitals || []), ...(context?.assets || [])].map((x) => x.name));
  const plan = String(out.deconflicted_route_plan || '');
  const via = [...plan.matchAll(/via\s+([^().]+?)\s*(?:\(|\.|$)/gi)].map((m) => m[1].trim());
  const invented = via.filter((v) => !names.has(v));
  if (invented.length) {
    notes.push(`invented asset rejected: ${invented.join(', ')}`);
    out.deconflicted_route_plan = ruleTriage.deconflicted_route_plan;
  }

  // downlink discipline
  let reply = String(out.user_satellite_reply || '');
  if (out.triage_category === 'HOSTAGE_COVERT' || silentMode) reply = 'HAPTIC_ACK_ONLY';
  reply = reply.replace(/[^\x20-\x7E]/g, '').slice(0, 160);
  if (!reply) {
    notes.push('empty reply, using rule value');
    reply = ruleTriage.user_satellite_reply;
  }
  out.user_satellite_reply = reply;

  // a covert incident's checklist must never tell a dispatcher to transmit to the device
  const covertNow = out.triage_category === 'HOSTAGE_COVERT' || silentMode;
  if (covertNow && Array.isArray(out.dispatcher_checklist) &&
      out.dispatcher_checklist.some((c) => /\b(send|transmit|text|sms|message|downlink)\b/i.test(String(c)) && !/\b(do not|don't|never|no|not)\b/i.test(String(c)))) {
    notes.push('covert checklist told dispatcher to transmit: using rule checklist');
    out.dispatcher_checklist = ruleTriage.dispatcher_checklist;
  }
  if (silentMode) out.user_satellite_reply = 'HAPTIC_ACK_ONLY';

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

async function callModel(cfg, payload, model, headers, relaxed = false) {
  const body = requestBody(cfg, payload, model);
  if (relaxed) delete body.response_format;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  return res;
}

export async function enhance({ incident, ruleTriage, grounding, context, deconfliction }) {
  const cfg = llmConfig();
  if (!cfg.enabled) return { triage: ruleTriage, used: 'rules', reason: 'llm disabled', model: null };

  const payload = {
    incident_id: incident.id,
    beacon: {
      device_id: incident.device_id,
      sos_code: incident.sos_code,
      position: incident.position,
      vitals: incident.vitals,
      duress_flag: !!incident.vitals?.duress_flag,
      silent_mode: !!incident.silent_mode,
      beacon_age_s: incident.age_s || 0,
      packets_received: incident.history?.length || 1,
      trend: incident.trend || null,
      received_at: incident.received_at,
    },
    geo_context_25km: context,
    route_options: deconfliction ? { recommended: deconfliction.recommended ? { mode: deconfliction.recommended.mode, asset: deconfliction.recommended.asset.name, eta_min: deconfliction.recommended.eta_min, approach: deconfliction.recommended.approach } : null, avoid: deconfliction.avoid } : null,
    protocol_chunks: grounding.filter((g) => g.role !== 'environment').map((g) => ({ id: g.chunk_id, topic: g.topic, text: g.quote })),
    required_output_schema: KEYS,
  };

  const headers = { 'content-type': 'application/json' };
  const key = process.env.AEGIS_LLM_KEY || process.env.OLLAMA_API_KEY || process.env.OPENAI_API_KEY;
  if (key) headers.authorization = `Bearer ${key}`;

  const failures = [];
  for (const model of cfg.models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await callModel(cfg, payload, model, headers);
        if (!res.ok && cfg.provider !== 'ollama') {
          res = await callModel(cfg, payload, model, headers, true);
        }
      } catch (e) {
        failures.push(`${model}: unreachable (${e.name})`);
        break;
      }

      if (!res.ok) {
        failures.push(`${model}: HTTP ${res.status}`);
        if (TRANSIENT.has(res.status) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
        break;
      }

      let parsed;
      try {
        parsed = JSON.parse(stripFences(extractContent(cfg, await res.json())));
      } catch {
        failures.push(`${model}: non-JSON`);
        break;
      }

      const shapeError = validateShape(parsed);
      if (shapeError) {
        failures.push(`${model}: ${shapeError}`);
        break;
      }

      const { triage, notes } = enforceFloors(parsed, { ruleTriage, context, incidentId: incident.id, silentMode: !!incident.silent_mode });
      return { triage, used: 'llm', model, reason: notes.length ? notes.join('; ') : 'accepted', notes };
    }
  }

  return { triage: ruleTriage, used: 'rules', reason: failures.join(' | ') || 'no model responded', model: null };
}

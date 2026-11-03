// Clinical & tactical RAG for the triage engine.
//
// Retrieval is deterministic: the query is composed from the incident (SOS code,
// vitals flags, hazards, weather) and ranked against the embedded vector store built
// from kb/protocols.json at boot. The engine never answers a medical question from
// anywhere else; whatever it says is traceable to a returned chunk_id.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VectorStore } from './rag-core.mjs';
import { SOS_NAME } from './proto.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KB_FILE = path.join(HERE, '..', 'kb', 'protocols.json');

const kb = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
const byId = new Map(kb.chunks.map((c) => [c.id, c]));
const store = new VectorStore().build(
  kb.chunks.map((c) => ({ id: c.id, text: `${c.topic} ${c.keywords} ${c.text}` })),
);

export const kbInfo = () => ({ version: kb.version, chunks: kb.chunks.length, provenance: kb.provenance, embedding: 'hashed-tfidf-512 (lexical)' });
export const kbChunks = () => kb.chunks;
export const getChunk = (id) => byId.get(id);

const SOS_TERMS = {
  UNSPECIFIED: 'unknown unspecified lost search rescue welfare',
  MEDICAL: 'medical illness collapse unwell emergency',
  TRAUMA: 'trauma injury wound bleeding hemorrhage',
  HOSTILE: 'hostile combat extraction attack cover',
  EVACUATION: 'evacuation transport urgent',
  WATER: 'water thirst dehydration supply',
  CHILDBIRTH: 'childbirth labour delivery birth pregnant',
  CANCEL: 'unknown',
};

// Environmental hazards map to a fixed chunk. They are never mixed into the incident
// query: a flood nearby must not turn a hypoxia reply into flood advice.
const KIND_CHUNK = {
  WILDFIRE: 'WEMS-FIRE-01',
  FLOOD: 'WEMS-FLOOD-01',
  SEISMIC: 'WEMS-ENTRAP-01',
};
const NEAR_KM = 2; // a hazard counts as "at the survivor" if it reaches within this distance

/** Facts about the incident, as retrieval terms. Pure and deterministic. */
export function queryFor({ sos_code, vitals = {}, category = null }) {
  const terms = [SOS_TERMS[SOS_NAME[sos_code]] || SOS_TERMS.UNSPECIFIED];
  if (category === 'HOSTAGE_COVERT') terms.push('duress hostage covert');
  if (category === 'COMBAT_EXTRACTION') terms.push('hostile combat extraction cover');
  if (category === 'SUPPLY_DROP') terms.push('supply water drop');
  if (Number.isFinite(vitals.spo2) && vitals.spo2 > 0 && vitals.spo2 < 90) terms.push('hypoxia low oxygen breathless respiratory distress');
  if (Number.isFinite(vitals.heart_rate) && vitals.heart_rate > 130) terms.push('tachycardia fast heart rate shock bleeding');
  if (Number.isFinite(vitals.heart_rate) && vitals.heart_rate > 0 && vitals.heart_rate < 45) terms.push('bradycardia slow heart rate cold');
  return terms.join(' ');
}

/** Chunks that must accompany certain findings regardless of ranking. */
function required({ category, vitals = {} }) {
  const ids = [];
  if (category === 'HOSTAGE_COVERT') ids.push('SEC-DURESS-01');
  if (Number.isFinite(vitals.spo2) && vitals.spo2 > 0 && vitals.spo2 < 90) ids.push('WHO-HYPOX-01');
  if (Number.isFinite(vitals.heart_rate) && vitals.heart_rate > 0 && vitals.heart_rate < 45) ids.push('WHO-BRADY-01');
  if (Number.isFinite(vitals.heart_rate) && vitals.heart_rate > 130) ids.push('WHO-TACHY-01');
  return ids;
}

/** Environment chunks for hazards/weather that actually reach the survivor. */
function environmentChunks(context) {
  const ids = [];
  for (const h of context?.hazards || []) {
    const id = KIND_CHUNK[h.kind];
    if (id && h.distance_km - h.radius_km <= NEAR_KM && !ids.includes(id)) ids.push(id);
  }
  const t = context?.weather?.temp_c;
  if (Number.isFinite(t) && t >= 38) ids.push('WEMS-HEAT-01');
  if (Number.isFinite(t) && t <= 2) ids.push('WEMS-HYPO-01');
  return ids;
}

/**
 * Retrieve grounding for an incident.
 * Each item: { source, chunk_id, topic, quote, reply, score, why, role } where role is
 *   'finding'     required by a vital sign or duress
 *   'primary'     ranked against the incident's own facts (SOS code, vitals, category)
 *   'environment' a hazard or weather condition at the survivor's position
 * The casualty-facing reply is built from finding/primary only.
 */
export function retrieve(input, k = 3) {
  const query = queryFor(input);
  const out = [];
  const seen = new Set();
  const push = (chunk, score, why, role) => {
    if (!chunk || seen.has(chunk.id)) return;
    seen.add(chunk.id);
    out.push({ source: chunk.source, chunk_id: chunk.id, topic: chunk.topic, quote: chunk.text, reply: chunk.reply, score, why, role });
  };
  for (const id of required(input)) push(byId.get(id), 1, 'required by finding', 'finding');
  for (const r of store.query(query, k, { minScore: 0.08 })) push(byId.get(r.doc.id), r.score, 'retrieved', 'primary');
  if (!out.length) push(byId.get('WEMS-LOST-01'), 0, 'default for unknown situation', 'primary');
  for (const id of environmentChunks(input.context)) push(byId.get(id), 1, 'hazard at survivor position', 'environment');
  return { query, grounding: out };
}

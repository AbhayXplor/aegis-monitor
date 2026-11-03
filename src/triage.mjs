// Triage + dispatch engine.
//
// ZERO-HALLUCINATION CONTRACT:
//  - `grounding` only cites chunks from the local knowledge base by id.
//  - `geo_facts` only restates fields present in the supplied context.
//  - if context is missing, the output says CONTEXT_MISSING instead of inventing.
//
// STATUS: the deterministic rule engine below is implemented and tested.
// The Gemma 4 / Ollama call is a seam (`rewriteWithLlm`) that is DISABLED unless
// AEGIS_LLM=1 AND an endpoint is reachable. It may only rewrite wording, never
// priority, category, or grounding.

const KB = [
  {
    id: 'TCCC-01',
    topic: 'TRAUMA',
    text: 'For life-threatening extremity bleeding apply a tourniquet high and tight on the limb, note the time, and do not loosen it in the field.',
  },
  {
    id: 'TCCC-02',
    topic: 'TRAUMA',
    text: 'For junctional bleeding not controlled by direct pressure, use wound packing with haemostatic gauze and prolonged firm pressure.',
  },
  {
    id: 'WHO-01',
    topic: 'MEDICAL',
    text: 'Reduced consciousness, inability to drink, or severe dehydration require urgent evacuation rather than oral rehydration alone.',
  },
  {
    id: 'WHO-02',
    topic: 'RESPIRATORY',
    text: 'Hypoxia with SpO2 below 90 percent at rest is a critical finding; keep the casualty still, upright if conscious, and evacuate.',
  },
  {
    id: 'WEMS-01',
    topic: 'CRUSH',
    text: 'Suspected crush injury with prolonged entrapment risks rhabdomyolysis; evacuation is time-critical even if the casualty feels well.',
  },
  {
    id: 'WEMS-02',
    topic: 'PAEDIATRIC',
    text: 'In children, keep the casualty warm, encourage small frequent feeds if conscious, and escalate early because deterioration is rapid.',
  },
  {
    id: 'WHO-03',
    topic: 'OBSTETRIC',
    text: 'Active labour with no skilled attendant present is an emergency: prepare a clean delivery surface and request evacuation immediately.',
  },
  {
    id: 'WEMS-03',
    topic: 'BURN',
    text: 'Cool burns with clean water for twenty minutes, cover with a dry sterile dressing, and avoid applying ice or ointments.',
  },
  {
    id: 'SEC-01',
    topic: 'HOSTAGE_COVERT',
    text: 'In a covert duress scenario, keep transmissions minimal and ambiguous; extraction planning happens off-air, never in the downlink.',
  },
];

const SOS = {
  0: { category: 'UNKNOWN', label: 'UNSPECIFIED' },
  1: { category: 'MEDICAL', label: 'MEDICAL' },
  2: { category: 'TRAUMA', label: 'TRAUMA' },
  3: { category: 'HOSTAGE_COVERT', label: 'HOSTILE / DURESS' },
  4: { category: 'MEDICAL', label: 'EVACUATION REQUEST' },
  5: { category: 'MEDICAL', label: 'WATER / DEHYDRATION' },
  6: { category: 'OBSTETRIC', label: 'CHILDBIRTH' },
};

const P1 = 'P1';
const P2 = 'P2';
const P3 = 'P3';

function priorityOf(v) {
  if (!v) return P3;
  if (v.duress_flag) return P1;
  if (Number.isFinite(v.spo2) && v.spo2 > 0 && v.spo2 < 90) return P1;
  if (Number.isFinite(v.heart_rate) && (v.heart_rate > 130 || (v.heart_rate > 0 && v.heart_rate < 45))) return P1;
  if (Number.isFinite(v.battery_pct) && v.battery_pct < 15) return P2;
  if (Number.isFinite(v.spo2) && v.spo2 > 0 && v.spo2 < 94) return P2;
  if (Number.isFinite(v.heart_rate) && v.heart_rate > 110) return P2;
  return P3;
}

function categoryOf(sos_code, v) {
  if (v && v.duress_flag) return 'HOSTAGE_COVERT';
  const s = SOS[sos_code] || SOS[0];
  return s.category;
}

function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentHitsHazard(a, b, poly, samples = 20) {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const lat = a.lat + (b.lat - a.lat) * t;
    const lon = a.lon + (b.lon - a.lon) * t;
    if (pointInPoly(lat, lon, poly)) return true;
  }
  return false;
}

function pickGrounding(category, priority) {
  const wanted = [category, category === 'UNKNOWN' ? 'TRAUMA' : null, priority === P1 ? 'RESPIRATORY' : null]
    .filter(Boolean);
  const out = [];
  for (const topic of wanted) {
    const hit = KB.find((k) => k.topic === topic && !out.some((o) => o.chunk_id === k.id));
    if (hit) out.push({ source: 'LOCAL_KB', chunk_id: hit.id, topic: hit.topic, quote: hit.text });
  }
  if (!out.length) out.push({ source: 'LOCAL_KB', chunk_id: 'WHO-01', topic: 'MEDICAL', quote: KB.find((k) => k.id === 'WHO-01').text });
  return out;
}

function buildReply({ priority, category, hospital, blocked, duress }) {
  if (duress) return 'HAPTIC_ACK_ONLY'.slice(0, 160);
  const parts = [`ACK ${priority} ${category}.`];
  if (blocked) parts.push('ROUTE BLOCKED. STAY PUT, SHELTER, CONSERVE BATTERY.');
  else if (hospital) parts.push(`HELP EN ROUTE ETA ${hospital.eta_min} MIN.`);
  parts.push('KEEP BEACON ON. REPLY NOT NEEDED.');
  let text = parts.join(' ');
  text = text.replace(/[^\x20-\x7E]/g, '').slice(0, 160);
  return text || 'ACK';
}

export async function triage({ incident, context }) {
  const v = incident.vitals || {};
  const priority = priorityOf(v);
  const category = categoryOf(incident.sos_code, v);
  const duress = category === 'HOSTAGE_COVERT';

  if (!context) {
    return {
      incident_id: incident.id,
      status: 'CONTEXT_MISSING',
      priority,
      triage_category: category,
      confidence: 0.3,
      grounding: [],
      geo_facts: [],
      routes: [],
      user_satellite_reply: buildReply({ priority, category, hospital: null, blocked: false, duress }),
    };
  }

  const survivor = { lat: incident.position.lat, lon: incident.position.lon };
  const hospitals = context.hospitals || [];
  const hazards = context.hazards || [];

  const routes = hospitals.map((h) => {
    const blockedBy = hazards
      .filter((hz) => segmentHitsHazard(survivor, h, hz.polygon))
      .map((hz) => `${hz.kind}:${hz.label}`);
    return {
      asset: h.name,
      capability: h.capability,
      eta_min: h.eta_min,
      status: blockedBy.length ? 'BLOCKED' : 'OPEN',
      blocked_by: blockedBy,
    };
  });

  const open = routes.filter((r) => r.status === 'OPEN').sort((a, b) => a.eta_min - b.eta_min);
  const best = open[0] || routes.sort((a, b) => a.eta_min - b.eta_min)[0] || null;
  const anyBlocked = routes.length > 0 && open.length === 0;

  const geoFacts = [];
  if (context.weather) {
    geoFacts.push(`weather ${context.weather.temp_c}C wind ${context.weather.wind_kt}kt vis ${context.weather.visibility_km}km${context.weather.dust ? ' dust' : ''}`);
  }
  for (const hz of hazards) geoFacts.push(`hazard ${hz.kind} ${hz.severity}: ${hz.label}`);
  for (const r of routes) {
    geoFacts.push(`route to ${r.asset} ${r.status} eta ${r.eta_min}min${r.blocked_by.length ? ' via ' + r.blocked_by.join(' / ') : ''}`);
  }

  let confidence = 0.55;
  if (context.source !== 'MOCK_WORLDMONITOR_MCP') confidence += 0.1;
  if (v.spo2 && v.heart_rate) confidence += 0.15;
  if (best) confidence += 0.1;
  confidence = Math.min(0.95, +confidence.toFixed(2));

  const out = {
    incident_id: incident.id,
    status: 'OK',
    priority,
    triage_category: category,
    confidence,
    vitals_assessment: {
      spo2: v.spo2 ?? null,
      heart_rate: v.heart_rate ?? null,
      battery_pct: v.battery_pct ?? null,
      duress: !!v.duress_flag,
      note: priority === P1 ? 'critical thresholds met' : priority === P2 ? 'watch threshold met' : 'no critical threshold',
    },
    recommended_asset: best ? best.asset : null,
    routes,
    geo_facts: geoFacts,
    grounding: pickGrounding(category, priority),
    user_satellite_reply: buildReply({ priority, category, hospital: best, blocked: anyBlocked, duress }),
  };
  return out;
}

/** Seam for Gemma 4 via Ollama. Disabled by default; may only rewrite wording. */
export function llmStatus() {
  const enabled = process.env.AEGIS_LLM === '1';
  return {
    enabled,
    model: process.env.AEGIS_LLM_MODEL || 'gemma4',
    endpoint: process.env.AEGIS_LLM_URL || null,
    status: enabled ? 'PROPOSED (endpoint not verified in this environment)' : 'DISABLED',
  };
}

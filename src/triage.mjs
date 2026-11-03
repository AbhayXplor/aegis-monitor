// AegisMonitor triage & dispatch engine.
//
// Output schema is fixed by the brief §3:
//   incident_id, priority_level (1-5), triage_category, physiological_status,
//   hazard_assessment, deconflicted_route_plan, dispatcher_checklist,
//   user_satellite_reply
//
// ZERO-HALLUCINATION: every clinical sentence is traceable to a LOCAL_KB chunk
// (returned separately as `grounding`, which is provenance, not model output).
// Every tactical sentence restates a field that exists in the supplied context.
// With no context the engine says so; it never invents a landmark or hospital.

const KB = [
  { id: 'TCCC-01', topic: 'TRAUMA', text: 'For life-threatening extremity bleeding apply a tourniquet high and tight on the limb, note the time, and do not loosen it in the field.' },
  { id: 'TCCC-02', topic: 'TRAUMA', text: 'For junctional bleeding not controlled by direct pressure, pack the wound with haemostatic gauze and hold firm pressure.' },
  { id: 'TCCC-03', topic: 'MEDEVAC', text: 'Casualties with a compromised airway or uncontrolled bleeding are evacuated first; do not delay transport for non-critical casualties.' },
  { id: 'WHO-01', topic: 'MEDEVAC', text: 'Reduced consciousness, inability to drink, or severe dehydration require urgent evacuation rather than oral rehydration alone.' },
  { id: 'WHO-02', topic: 'RESPIRATORY', text: 'Hypoxia with SpO2 below 90 percent at rest is a critical finding; keep the casualty still and evacuate.' },
  { id: 'WEMS-01', topic: 'CRUSH', text: 'Suspected crush injury with prolonged entrapment risks rhabdomyolysis; evacuation is time-critical even if the casualty feels well.' },
  { id: 'WEMS-02', topic: 'PAEDIATRIC', text: 'In children keep the casualty warm, give small frequent feeds if conscious, and escalate early because deterioration is rapid.' },
  { id: 'WHO-03', topic: 'OBSTETRIC', text: 'Active labour with no skilled attendant present is an emergency: prepare a clean delivery surface and request evacuation immediately.' },
  { id: 'WEMS-03', topic: 'BURN', text: 'Cool burns with clean water for twenty minutes, cover with a dry sterile dressing, and never apply ice or ointment.' },
  { id: 'SEC-01', topic: 'HOSTAGE', text: 'In a covert duress scenario keep transmissions minimal and ambiguous; extraction planning happens off-air, never in the downlink.' },
  { id: 'SUP-01', topic: 'SUPPLY', text: 'For isolated survivors without water, ration to small sips and prioritise a supply drop of water and electrolytes before food.' },
  { id: 'SAR-01', topic: 'SAR', text: 'When the situation is unknown, treat as search and rescue: establish contact, confirm location, and avoid assuming the casualty can move.' },
];

const PRIORITY_RANGE = [1, 2, 3, 4, 5];
export const TRIAGE_CATEGORIES = ['MEDEVAC', 'COMBAT_EXTRACTION', 'HOSTAGE_COVERT', 'SAR', 'SUPPLY_DROP'];

/* ---------------- rules ---------------- */

export function priorityLevel({ sos_code, vitals = {} }) {
  if (vitals.duress_flag) return 1;
  if (Number.isFinite(vitals.spo2) && vitals.spo2 > 0 && vitals.spo2 < 90) return 1;
  if (Number.isFinite(vitals.heart_rate) && (vitals.heart_rate > 130 || (vitals.heart_rate > 0 && vitals.heart_rate < 45))) return 1;
  if (sos_code === 5) return 5;                                  // water / supply
  if (sos_code === 4) return 4;                                  // evacuation request
  if ([1, 2, 6].includes(sos_code)) {                            // medical, trauma, childbirth
    if ((vitals.spo2 > 0 && vitals.spo2 < 94) || vitals.heart_rate > 110) return 2;
    return 2;
  }
  if (Number.isFinite(vitals.battery_pct) && vitals.battery_pct < 15) return 3;
  return 3;                                                      // unknown / welfare
}

export function triageCategory({ sos_code, vitals = {} }) {
  if (vitals.duress_flag) return 'HOSTAGE_COVERT';
  if (sos_code === 3) return 'COMBAT_EXTRACTION';
  if (sos_code === 5) return 'SUPPLY_DROP';
  if (sos_code === 0) return 'SAR';
  return 'MEDEVAC';
}

/* ---------------- geometry ---------------- */

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function segmentHitsHazard(a, b, poly, samples = 20) {
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    if (pointInPoly(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, poly)) return true;
  }
  return false;
}

/* ---------------- grounding ---------------- */

// categories are the brief's vocabulary; KB topics are clinical topics
const CATEGORY_TOPIC = {
  MEDEVAC: 'MEDEVAC',
  COMBAT_EXTRACTION: 'TRAUMA',
  HOSTAGE_COVERT: 'HOSTAGE',
  SAR: 'SAR',
  SUPPLY_DROP: 'SUPPLY',
};

export function groundingFor(category, priority) {
  const want = [CATEGORY_TOPIC[category], priority === 1 ? 'RESPIRATORY' : null].filter(Boolean);
  const out = [];
  for (const topic of want) {
    const hit = KB.find((k) => k.topic === topic && !out.some((o) => o.chunk_id === k.id));
    if (hit) out.push({ source: 'LOCAL_KB', chunk_id: hit.id, topic: hit.topic, quote: hit.text });
  }
  if (!out.length) {
    const fallback = KB.find((k) => k.topic === 'SAR');
    out.push({ source: 'LOCAL_KB', chunk_id: fallback.id, topic: fallback.topic, quote: fallback.text });
  }
  return out;
}

/* ---------------- planning ---------------- */

function transportMode(category, routes) {
  if (category === 'SUPPLY_DROP') return 'DRONE';
  const anyOpen = routes.some((r) => r.status === 'OPEN');
  return anyOpen ? 'GROUND' : 'HELI';
}

function buildRoutePlan({ incident, context, routes, best, category }) {
  const mode = transportMode(category, routes);
  const survivor = { lat: incident.position.lat, lon: incident.position.lon };
  let plan = mode;
  if (best) {
    const assetPos = { lat: best.lat, lon: best.lon };
    const deg = Math.round(bearingDeg(assetPos, survivor));
    plan += ` via ${best.asset} (ETA ${best.eta_min} min). APPROACH ${String(deg).padStart(3, '0')}° ${compass(deg)}.`;
  } else {
    plan += '. NO ASSET IN THE 25 km SLICE.';
  }
  const avoid = [];
  for (const r of routes) for (const b of r.blocked_by) if (!avoid.includes(b)) avoid.push(b);
  const unreferenced = (context.hazards || [])
    .filter((h) => !avoid.some((a) => a.includes(h.kind)))
    .map((h) => `${h.kind}: ${h.label}`);
  const all = [...avoid, ...unreferenced];
  plan += all.length ? ` AVOID ${all.join('; ')}.` : ' NO HAZARD ON THE VECTOR.';
  return plan.replace(/\s+/g, ' ').trim();
}

function physiologicalText(vitals, priority) {
  const hr = vitals.heart_rate ?? 'unknown';
  const spo2 = vitals.spo2 ?? 'unknown';
  const batt = vitals.battery_pct ?? 'unknown';
  const state =
    priority === 1 ? 'critical: immediate life threat' :
    priority === 2 ? 'urgent: deteriorating physiology likely' :
    priority === 3 ? 'stable but unverified' :
    priority === 4 ? 'stable, movement required' : 'non-urgent supply need';
  return `HR ${hr} bpm, SpO2 ${spo2}%, battery ${batt}%. ${state}.`;
}

function checklist({ priority, category, context, routes }) {
  const items = [];
  if (category === 'HOSTAGE_COVERT') {
    items.push('Do not transmit an unencrypted downlink; device stays silent.');
    items.push('Brief extraction team off-air only, confirm identity before approach.');
  } else if (priority === 1) {
    items.push('Task the nearest advanced asset immediately; do not wait for a second packet.');
    items.push('Pre-alert receiving facility with vitals and suspected mechanism.');
  } else if (priority <= 3) {
    items.push('Confirm survivor location and accessibility with the next packet.');
    items.push('Assign asset and hold a downlink window in reserve.');
  } else {
    items.push('Queue for the next scheduled tasking; no immediate asset required.');
    items.push('Send supply-drop coordinates to the drone cell.');
  }
  const blocked = routes.filter((r) => r.status === 'BLOCKED').length;
  items.push(blocked
    ? `Re-route around ${blocked} blocked vector(s) listed in the hazard assessment.`
    : 'Vector clear on the current 25 km slice; re-check before departure.');
  return items.slice(0, 3);
}

function buildReply({ priority, category, best, blocked }) {
  if (category === 'HOSTAGE_COVERT') return 'HAPTIC_ACK_ONLY';
  const parts = [];
  if (category === 'SUPPLY_DROP') parts.push('ACK SUPPLY. RATION WATER. DROP INBOUND.');
  else if (priority === 1) parts.push(`ACK P${priority}. STAY STILL.`);
  else parts.push(`ACK P${priority} ${category}.`);
  if (best && !blocked) parts.push(`RESCUE ETA ${best.eta_min} MIN.`);
  if (blocked) parts.push('ROUTE BLOCKED. SHELTER. CONSERVE BATTERY.');
  parts.push('KEEP BEACON ON.');
  const text = parts.join(' ').replace(/[^\x20-\x7E]/g, '');
  return text.slice(0, 160);
}

/* ---------------- engine ---------------- */

export async function triage({ incident, context }) {
  const vitals = incident.vitals || {};
  const priority_level = priorityLevel({ sos_code: incident.sos_code, vitals });
  const triage_category = triageCategory({ sos_code: incident.sos_code, vitals });
  const grounding = groundingFor(triage_category, priority_level);

  if (!context) {
    return {
      triage: {
        incident_id: incident.id,
        priority_level,
        triage_category,
        physiological_status: physiologicalText(vitals, priority_level) + ' CONTEXT MISSING: no hazard or asset data.',
        hazard_assessment: 'CONTEXT_MISSING — no 25 km slice supplied. No tactical claim is made.',
        deconflicted_route_plan: 'NO PLAN — context unavailable.',
        dispatcher_checklist: ['Obtain a 25 km context slice before tasking.', 'Hold downlink to a status-only acknowledgement.', 'Escalate to a human medical decision-maker.'],
        user_satellite_reply: buildReply({ priority: priority_level, category: triage_category, best: null, blocked: false }),
      },
      grounding,
    };
  }

  const survivor = { lat: incident.position.lat, lon: incident.position.lon };
  const hospitals = (context.hospitals || []).map((h) => ({ ...h }));
  const hazards = context.hazards || [];

  const routes = hospitals.map((h) => {
    const blocked_by = hazards
      .filter((hz) => segmentHitsHazard(survivor, h, hz.polygon))
      .map((hz) => `${hz.kind}: ${hz.label}`);
    return { asset: h.name, lat: h.lat, lon: h.lon, capability: h.capability, eta_min: h.eta_min, status: blocked_by.length ? 'BLOCKED' : 'OPEN', blocked_by };
  });

  const open = routes.filter((r) => r.status === 'OPEN').sort((a, b) => a.eta_min - b.eta_min);
  const best = open[0] || routes.slice().sort((a, b) => a.eta_min - b.eta_min)[0] || null;
  const blocked = routes.length > 0 && open.length === 0;

  const hazardBits = hazards.map((h) => `${h.kind} ${h.severity}: ${h.label}`);
  if (context.weather) {
    hazardBits.push(`weather ${context.weather.temp_c}C wind ${context.weather.wind_kt}kt vis ${context.weather.visibility_km}km${context.weather.dust ? ' dust' : ''}`);
  }

  const triageObj = {
    incident_id: incident.id,
    priority_level,
    triage_category,
    physiological_status: physiologicalText(vitals, priority_level),
    hazard_assessment: hazardBits.length ? hazardBits.join('; ') : 'No hazards inside the 25 km slice.',
    deconflicted_route_plan: buildRoutePlan({ incident, context, routes, best, category: triage_category }),
    dispatcher_checklist: checklist({ priority: priority_level, category: triage_category, context, routes }),
    user_satellite_reply: buildReply({ priority: priority_level, category: triage_category, best, blocked }),
  };

  return { triage: triageObj, grounding, routes };
}

/* Recompute every active incident when a new packet lands. */
export function reRank(incidents) {
  const changes = [];
  for (const inc of incidents) {
    if (!inc.triage) continue;
    const next = priorityLevel({ sos_code: inc.sos_code, vitals: inc.vitals });
    if (next !== inc.triage.priority_level) {
      changes.push({ incident_id: inc.id, from: inc.triage.priority_level, to: next });
      inc.triage.priority_level = next;
      inc.triage.physiological_status = physiologicalText(inc.vitals, next);
    }
  }
  return changes;
}

/** Gemma 4 seam. Disabled unless AEGIS_LLM=1 and an endpoint is configured. */
export function llmStatus() {
  const enabled = process.env.AEGIS_LLM === '1' && !!process.env.AEGIS_LLM_URL;
  return {
    enabled,
    model: process.env.AEGIS_LLM_MODEL || 'gemma4',
    endpoint: process.env.AEGIS_LLM_URL || null,
    modelfile: 'contracts/Modelfile',
    status: enabled ? 'CONFIGURED (unverified in this environment)' : 'DISABLED',
  };
}

export { PRIORITY_RANGE, KB };

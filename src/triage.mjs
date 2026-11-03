// AegisMonitor triage & dispatch engine (deterministic rules floor).
//
// Output schema is fixed by the brief §3 (eight keys, nothing else). Provenance
// (RAG chunks, deconfliction detail) is returned beside it, never inside it.
//
// ZERO-HALLUCINATION: every clinical instruction comes from a retrieved KB chunk; every
// tactical statement restates a field of the supplied 25 km context. With no context the
// engine says so and makes no tactical claim.

import { SOS } from './proto.mjs';
import { retrieve } from './rag.mjs';
import { deconflict, planText } from './deconflict.mjs';

export { bearingDeg, compass } from './geomath.mjs';
export const PRIORITY_RANGE = [1, 2, 3, 4, 5];
export const TRIAGE_CATEGORIES = ['MEDEVAC', 'COMBAT_EXTRACTION', 'HOSTAGE_COVERT', 'SAR', 'SUPPLY_DROP'];

const known = (n) => Number.isFinite(n) && n > 0;

/* ---------------- trend ---------------- */

// ENGINEERING DEFAULTS, not clinically validated: who signs off is an open question.
export const TREND = { SPO2_DROP: 3, HR_RISE: 20, HR_RISE_MIN: 100, HR_COLLAPSE_FROM: 80, HR_COLLAPSE_TO: 60, HR_COLLAPSE_DROP: 25, WINDOW_S: 30 * 60 };

/** Compare the two newest samples (device time). history: [{ts, heart_rate, spo2}] */
export function trendOf(history = []) {
  if (history.length < 2) return { deteriorating: false, reasons: [] };
  const a = history[history.length - 2];
  const b = history[history.length - 1];
  if (b.ts - a.ts > TREND.WINDOW_S || b.ts <= a.ts) return { deteriorating: false, reasons: [] };
  const reasons = [];
  if (known(a.spo2) && known(b.spo2) && b.spo2 - a.spo2 <= -TREND.SPO2_DROP) reasons.push(`SpO2 fell ${a.spo2}->${b.spo2}%`);
  if (known(a.heart_rate) && known(b.heart_rate)) {
    if (b.heart_rate - a.heart_rate >= TREND.HR_RISE && b.heart_rate > TREND.HR_RISE_MIN) reasons.push(`HR rose ${a.heart_rate}->${b.heart_rate} bpm`);
    if (a.heart_rate >= TREND.HR_COLLAPSE_FROM && b.heart_rate < TREND.HR_COLLAPSE_TO && a.heart_rate - b.heart_rate >= TREND.HR_COLLAPSE_DROP) reasons.push(`HR fell sharply ${a.heart_rate}->${b.heart_rate} bpm`);
  }
  return { deteriorating: reasons.length > 0, reasons };
}

/* ---------------- priority & category ---------------- */

/**
 * Priority 1-5 with the reasons for it.
 * `floor` is the most urgent priority this incident has already had: urgency never
 * relaxes on its own, a dispatcher must lower it.
 */
export function assess({ sos_code, vitals = {}, trend = { deteriorating: false, reasons: [] }, floor = null, override = null }) {
  const reasons = [];
  let p;
  if (vitals.duress_flag) {
    p = 1;
    reasons.push('duress flag set');
  } else if (known(vitals.spo2) && vitals.spo2 < 90) {
    p = 1;
    reasons.push(`SpO2 ${vitals.spo2}% < 90`);
  } else if (known(vitals.heart_rate) && vitals.heart_rate > 130) {
    p = 1;
    reasons.push(`HR ${vitals.heart_rate} > 130`);
  } else if (known(vitals.heart_rate) && vitals.heart_rate < 45) {
    p = 1;
    reasons.push(`HR ${vitals.heart_rate} < 45`);
  } else if (sos_code === SOS.WATER) p = 5;
  else if (sos_code === SOS.EVACUATION) p = 4;
  else if ([SOS.MEDICAL, SOS.TRAUMA, SOS.CHILDBIRTH, SOS.HOSTILE].includes(sos_code)) p = 2;
  else p = 3;

  if (p > 1 && trend.deteriorating) {
    p -= 1;
    reasons.push(`deteriorating: ${trend.reasons.join('; ')}`);
  }
  if (floor !== null && floor < p) {
    p = floor;
    reasons.push(`held at earlier urgency P${floor}`);
  }
  if (override !== null && override > p) {
    // a dispatcher may lower urgency, but never below what the vitals themselves demand
    const vitalsDemand = reasons.some((r) => /SpO2|HR|duress/.test(r) && !r.startsWith('held'));
    if (!vitalsDemand) {
      p = override;
      reasons.push(`dispatcher set P${override}`);
    }
  }
  return { priority: p, reasons };
}

export const priorityLevel = (input) => assess(input).priority;

export function triageCategory({ sos_code, vitals = {} }) {
  if (vitals.duress_flag) return 'HOSTAGE_COVERT';
  if (sos_code === SOS.HOSTILE) return 'COMBAT_EXTRACTION';
  if (sos_code === SOS.WATER) return 'SUPPLY_DROP';
  if (sos_code === SOS.UNSPECIFIED) return 'SAR';
  return 'MEDEVAC';
}

/** Duress or device silent mode: the downlink may only ever be a haptic acknowledgement. */
export const isCovert = (incident) => !!(incident.vitals?.duress_flag || incident.silent_mode);

/* ---------------- text builders ---------------- */

function suspectedState(vitals, sos_code) {
  if (known(vitals.spo2) && vitals.spo2 < 90) return 'hypoxia: respiratory compromise (airway, chest injury or illness)';
  if (known(vitals.heart_rate) && vitals.heart_rate > 130) return 'marked tachycardia: possible shock or haemorrhage, or severe pain';
  if (known(vitals.heart_rate) && vitals.heart_rate < 45) return 'bradycardia: possible severe cold, cardiac cause or head injury';
  if (known(vitals.heart_rate) && vitals.heart_rate > 100 && sos_code === SOS.TRAUMA) return 'possible compensated shock after trauma';
  if (known(vitals.heart_rate) && known(vitals.spo2)) return 'vitals within alert thresholds; severity not visible to sensors';
  return 'vitals unavailable (no PPG lock): condition unassessed';
}

function physiologicalText({ vitals, sos_code, trend, age_s }) {
  const hr = known(vitals.heart_rate) ? `${vitals.heart_rate} bpm` : 'unknown';
  const sp = known(vitals.spo2) ? `${vitals.spo2}%` : 'unknown';
  const batt = Number.isFinite(vitals.battery_pct) ? `${vitals.battery_pct}%` : 'unknown';
  const parts = [`HR ${hr}, SpO2 ${sp}, battery ${batt}.`, `Suspected: ${suspectedState(vitals, sos_code)}.`];
  if (trend.deteriorating) parts.push(`Trend: ${trend.reasons.join('; ')}.`);
  if (vitals.duress_flag && !(known(vitals.spo2) && vitals.spo2 < 90) && !(known(vitals.heart_rate) && (vitals.heart_rate > 130 || vitals.heart_rate < 45))) {
    parts.push('Covert duress: sensors show no physical emergency; risk is from captors.');
  }
  if (age_s > 600) parts.push(`Beacon is ${Math.round(age_s / 60)} min old.`);
  return parts.join(' ').slice(0, 400);
}

function hazardText(context, age_s) {
  if (!context) return 'CONTEXT_MISSING: no 25 km slice supplied. No tactical claim is made.';
  const bits = (context.hazards || []).map((h) => `${h.kind} ${h.severity}: ${h.label} (${h.distance_km} km)`);
  const w = context.weather;
  if (w) {
    bits.push(`weather ${w.temp_c}C wind ${w.wind_kt}kt${Number.isFinite(w.visibility_km) ? ` vis ${w.visibility_km}km` : ''}${w.dust ? ' dust' : ''}${w.storm ? ' THUNDERSTORM' : ''}`);
  }
  if (!bits.length) bits.push('No hazards inside the 25 km slice');
  const gaps = Object.entries(context.coverage || {}).filter(([, v]) => String(v).startsWith('unavailable')).map(([k]) => k);
  if (gaps.length) bits.push(`NO DATA for: ${gaps.join(', ')}`);
  if (age_s > 600) bits.push(`position is ${Math.round(age_s / 60)} min old`);
  const text = bits.join('; ');
  return text.length > 600 ? text.slice(0, 597) + '...' : text;
}

function checklistFor({ priority, category, covert, d, age_s, incident }) {
  const r = d?.recommended;
  const a = [];
  if (covert) a.push('Do NOT send any unencrypted or text downlink; HAPTIC_ACK_ONLY is the only permitted message.');
  else if (priority === 1) a.push(r ? `Task ${r.asset.name} now (${r.mode}, ETA ${r.eta_min} min); do not wait for a second packet.` : 'Task the nearest advanced asset immediately; no safe vector is confirmed yet.');
  else if (priority <= 3) a.push('Confirm survivor location and condition with the next packet; assign an asset.');
  else a.push('Queue for the next scheduled tasking; no immediate asset required.');

  const b = [];
  if (!d) b.push('Obtain a 25 km context slice before tasking; escalate to a human medical decision-maker.');
  else if (!r) b.push('No safe vector: hold, request hazard clearance or an alternative asset.');
  else if (r.approach.kind === 'DOGLEG') b.push(`Use the dogleg: direct vector is blocked by ${r.blocked_by.join('; ')}.`);
  else b.push(`Vector clear for ${r.mode} (HDG ${String(r.approach.heading_deg).padStart(3, '0')}); re-check hazards before departure.`);

  const c = [];
  if (covert) c.push(r ? `Plan extraction off-air only (${r.mode}, ETA ${r.eta_min} min); confirm identity before approach.` : 'Plan extraction off-air only; confirm identity before approach.');
  else if (d?.evac && category !== 'SUPPLY_DROP') c.push(`Pre-alert ${d.evac.hospital.name}${d.evac.hospital.status === 'UNVERIFIED' ? ' (operating status unverified: confirm by phone)' : ''}${d.evac.blocked ? '; evac leg is blocked, re-plan' : ''}.`);
  else if (category === 'SUPPLY_DROP') c.push('Send supply-drop coordinates to the drone cell.');
  else if (age_s > 600) c.push(`Beacon is ${Math.round(age_s / 60)} min old: assume the survivor has moved or worsened.`);
  else c.push('Hold a downlink window in reserve and watch for the next packet.');

  void incident;
  return [a[0], b[0], c[0]];
}

function replyFor({ priority, covert, grounding, d, category, incident_sos }) {
  if (covert) return 'HAPTIC_ACK_ONLY';
  // Only chunks driven by the casualty's own facts speak to the casualty. For trauma and
  // hostile contact, bleeding control (M in MARCH) outranks the respiratory finding.
  const own = grounding.filter((g) => g.role !== 'environment');
  const bleedingFirst = (category === 'MEDEVAC' && incident_sos === SOS.TRAUMA) || category === 'COMBAT_EXTRACTION';
  const findings = own.filter((g) => g.role === 'finding');
  const top = own.find((g) => g.role === 'primary');
  // Lead with the top-ranked incident chunk (bleeding control for trauma), else the
  // finding chunk; add the other one only if it fits. Lower-ranked chunks are noise.
  const lead = bleedingFirst ? [top, findings[0]] : [findings[0], top];
  const aid = lead.filter(Boolean).map((g) => g.reply).filter((x) => x && x !== 'HAPTIC_ACK_ONLY');
  const r = d?.recommended;
  const tail = r ? `RESCUE ETA ${r.eta_min} MIN.` : d ? 'RESCUE ROUTING, ETA TBD.' : '';
  const beacon = aid.some((x) => /BEACON/.test(x)) ? '' : 'KEEP BEACON ON.';
  const sets = [[`P${priority}.`, aid[0], aid[1], tail, beacon], [`P${priority}.`, aid[0], tail, beacon], [`P${priority}.`, aid[0], beacon], [`P${priority}.`, aid[0]]];
  const ascii = (s) => s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  for (const parts of sets) {
    const text = ascii(parts.filter(Boolean).join(' '));
    if (text.length <= 160) return text;
  }
  return ascii(`P${priority}. ${category}. KEEP BEACON ON.`).slice(0, 160);
}

/* ---------------- engine ---------------- */

/**
 * @param {object} p
 * @param {object} p.incident  needs id, sos_code, vitals, position, silent_mode, age_s?, history?, peak_priority?, priority_override?
 * @param {object|null} p.context geo slice or null
 */
export async function triage({ incident, context }) {
  const vitals = incident.vitals || {};
  const trend = trendOf(incident.history || []);
  const { priority, reasons } = assess({ sos_code: incident.sos_code, vitals, trend, floor: incident.peak_priority ?? null, override: incident.priority_override ?? null });
  const category = triageCategory({ sos_code: incident.sos_code, vitals });
  const covert = isCovert(incident);
  const age_s = incident.age_s || 0;

  const { query, grounding } = retrieve({ sos_code: incident.sos_code, vitals, context, category });
  const survivor = { lat: incident.position.lat, lon: incident.position.lon };
  const d = context ? deconflict({ survivor, context, category }) : null;

  const triageObj = {
    incident_id: incident.id,
    priority_level: priority,
    triage_category: category,
    physiological_status: physiologicalText({ vitals, sos_code: incident.sos_code, trend, age_s }),
    hazard_assessment: hazardText(context, age_s),
    deconflicted_route_plan: d ? planText(d, { category }) : 'NO PLAN: context unavailable.',
    dispatcher_checklist: checklistFor({ priority, category, covert, d, age_s, incident }),
    user_satellite_reply: replyFor({ priority, covert, grounding, d, category, incident_sos: incident.sos_code }),
  };

  return { triage: triageObj, grounding, deconfliction: d, assessment: { reasons, trend, covert, rag_query: query } };
}

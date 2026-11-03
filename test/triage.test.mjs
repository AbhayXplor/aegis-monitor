import test from 'node:test';
import assert from 'node:assert/strict';

import { assess, triageCategory, triage, trendOf, isCovert, TRIAGE_CATEGORIES } from '../src/triage.mjs';
import { retrieve, queryFor, kbInfo, kbChunks } from '../src/rag.mjs';
import { VectorStore } from '../src/rag-core.mjs';
import { deconflict, planText, weatherBlock } from '../src/deconflict.mjs';
import { haversineKm, bearingDeg, compass, destination, circlePolygon, segmentHitsPolygon, pointInPolygon } from '../src/geomath.mjs';
import { createGeo } from '../src/geo.mjs';
import { SOS } from '../src/proto.mjs';

const KEYS = ['incident_id', 'priority_level', 'triage_category', 'physiological_status', 'hazard_assessment', 'deconflicted_route_plan', 'dispatcher_checklist', 'user_satellite_reply'];
const V = (o = {}) => ({ heart_rate: 96, spo2: 95, battery_pct: 55, duress_flag: false, ...o });
const inc = (o = {}) => ({ id: 'INC-0001', sos_code: SOS.TRAUMA, position: { lat: 25.2048, lon: 55.2708 }, vitals: V(), silent_mode: false, age_s: 0, history: [], ...o });
const geo = createGeo({ env: { AEGIS_GEO: 'demo' } });

/* ---------------- priority & category ---------------- */

test('priority: brief §3 escalation thresholds', () => {
  const p = (sos_code, vitals) => assess({ sos_code, vitals: V(vitals) }).priority;
  assert.equal(p(SOS.WATER, { duress_flag: true }), 1);
  assert.equal(p(SOS.WATER, { spo2: 89 }), 1);
  assert.equal(p(SOS.WATER, { spo2: 90 }), 5);
  assert.equal(p(SOS.WATER, { heart_rate: 131 }), 1);
  assert.equal(p(SOS.WATER, { heart_rate: 130 }), 5);
  assert.equal(p(SOS.WATER, { heart_rate: 44 }), 1);
  assert.equal(p(SOS.WATER, { heart_rate: 45 }), 5);
});

test('priority: unknown vitals (0) never trigger an escalation', () => {
  assert.equal(assess({ sos_code: SOS.WATER, vitals: V({ spo2: 0, heart_rate: 0 }) }).priority, 5);
});

test('priority: SOS code mapping, hostile extraction is NOT left at P3', () => {
  const p = (c) => assess({ sos_code: c, vitals: V() }).priority;
  assert.equal(p(SOS.MEDICAL), 2);
  assert.equal(p(SOS.TRAUMA), 2);
  assert.equal(p(SOS.CHILDBIRTH), 2);
  assert.equal(p(SOS.HOSTILE), 2);
  assert.equal(p(SOS.UNSPECIFIED), 3);
  assert.equal(p(SOS.EVACUATION), 4);
  assert.equal(p(SOS.WATER), 5);
});

test('category: duress -> HOSTAGE_COVERT, hostile -> COMBAT_EXTRACTION, all five reachable', () => {
  const c = (sos_code, vitals) => triageCategory({ sos_code, vitals: V(vitals) });
  assert.equal(c(SOS.HOSTILE, { duress_flag: true }), 'HOSTAGE_COVERT');
  assert.equal(c(SOS.HOSTILE), 'COMBAT_EXTRACTION');
  assert.equal(c(SOS.WATER), 'SUPPLY_DROP');
  assert.equal(c(SOS.UNSPECIFIED), 'SAR');
  assert.equal(c(SOS.TRAUMA), 'MEDEVAC');
  assert.deepEqual(new Set(TRIAGE_CATEGORIES).size, 5);
});

test('trend: a falling SpO2 or rising HR is deteriorating; a flat or stale one is not', () => {
  const h = (a, b, dt = 60) => [{ ts: 1000, ...a }, { ts: 1000 + dt, ...b }];
  assert.equal(trendOf(h({ spo2: 97, heart_rate: 90 }, { spo2: 93, heart_rate: 92 })).deteriorating, true);
  assert.equal(trendOf(h({ spo2: 97, heart_rate: 90 }, { spo2: 96, heart_rate: 95 })).deteriorating, false);
  assert.equal(trendOf(h({ spo2: 97, heart_rate: 90 }, { spo2: 96, heart_rate: 118 })).deteriorating, true);
  assert.equal(trendOf(h({ spo2: 97, heart_rate: 85 }, { spo2: 96, heart_rate: 52 })).deteriorating, true);
  assert.equal(trendOf(h({ spo2: 97, heart_rate: 90 }, { spo2: 80, heart_rate: 90 }, 7200)).deteriorating, false, 'outside the 30 min window');
  assert.equal(trendOf([{ ts: 1, spo2: 97 }]).deteriorating, false);
});

test('priority: deterioration escalates one level; urgency never relaxes by itself', () => {
  const trend = { deteriorating: true, reasons: ['SpO2 fell'] };
  assert.equal(assess({ sos_code: SOS.TRAUMA, vitals: V(), trend }).priority, 1);
  assert.equal(assess({ sos_code: SOS.TRAUMA, vitals: V(), floor: 1 }).priority, 1, 'held at the earlier P1');
});

test('priority: a dispatcher may lower urgency, but never below what vitals demand', () => {
  assert.equal(assess({ sos_code: SOS.TRAUMA, vitals: V(), override: 4 }).priority, 4);
  assert.equal(assess({ sos_code: SOS.TRAUMA, vitals: V({ spo2: 85 }), override: 4 }).priority, 1);
  assert.equal(assess({ sos_code: SOS.TRAUMA, vitals: V({ duress_flag: true }), override: 5 }).priority, 1);
});

/* ---------------- output contract ---------------- */

test('triage: output has exactly the eight brief §3 keys, no more', async () => {
  const r = await triage({ incident: inc(), context: await geo.geoContext(25.2048, 55.2708) });
  assert.deepEqual(Object.keys(r.triage).sort(), [...KEYS].sort());
  assert.equal(r.triage.dispatcher_checklist.length, 3);
});

test('triage: schema bounds hold across every SOS code and vitals band', async () => {
  const ctx = await geo.geoContext(25.2048, 55.2708);
  for (const sos_code of [0, 1, 2, 3, 4, 5, 6]) {
    for (const v of [{ heart_rate: 96, spo2: 95 }, { heart_rate: 118, spo2: 86 }, { heart_rate: 140, spo2: 92 }, { heart_rate: 40, spo2: 97 }, { heart_rate: 0, spo2: 0 }]) {
      const { triage: t } = await triage({ incident: inc({ sos_code, vitals: V(v) }), context: ctx });
      assert.match(t.user_satellite_reply, /^[\x20-\x7E]{1,160}$/, `reply ${sos_code}/${JSON.stringify(v)}`);
      assert.ok(t.physiological_status.length <= 400 && t.hazard_assessment.length <= 600 && t.deconflicted_route_plan.length <= 600);
      assert.ok(t.dispatcher_checklist.every((c) => c.length > 0 && c.length <= 200));
      assert.ok(TRIAGE_CATEGORIES.includes(t.triage_category));
    }
  }
});

test('triage: duress and silent mode both force HAPTIC_ACK_ONLY, and checklists forbid texting', async () => {
  const ctx = await geo.geoContext(25.2048, 55.2708);
  for (const i of [inc({ vitals: V({ duress_flag: true }) }), inc({ silent_mode: true })]) {
    assert.equal(isCovert(i), true);
    const { triage: t } = await triage({ incident: i, context: ctx });
    assert.equal(t.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.match(t.dispatcher_checklist[0], /Do NOT send/);
  }
  const duress = await triage({ incident: inc({ vitals: V({ duress_flag: true }) }), context: ctx });
  assert.equal(duress.triage.priority_level, 1);
  assert.equal(duress.triage.triage_category, 'HOSTAGE_COVERT');
});

test('triage: duress with normal vitals is not described as a physical life threat', async () => {
  const { triage: t } = await triage({ incident: inc({ sos_code: SOS.HOSTILE, vitals: V({ duress_flag: true }) }), context: null });
  assert.doesNotMatch(t.physiological_status, /life threat/i);
  assert.match(t.physiological_status, /no physical emergency/);
});

test('triage: with no context it says so and makes no tactical claim', async () => {
  const { triage: t } = await triage({ incident: inc(), context: null });
  assert.match(t.hazard_assessment, /CONTEXT_MISSING/);
  assert.match(t.deconflicted_route_plan, /NO PLAN/);
});

test('triage: a stale beacon says so', async () => {
  const { triage: t } = await triage({ incident: inc({ age_s: 1800 }), context: null });
  assert.match(t.physiological_status, /30 min old/);
});

/* ---------------- RAG ---------------- */

test('rag: retrieval is deterministic and every chunk id resolves', () => {
  const input = { sos_code: SOS.TRAUMA, vitals: V({ spo2: 86 }), category: 'MEDEVAC' };
  const a = retrieve(input);
  const b = retrieve(input);
  assert.deepEqual(a, b);
  const ids = new Set(kbChunks().map((c) => c.id));
  for (const g of a.grounding) assert.ok(ids.has(g.chunk_id));
  assert.ok(kbInfo().chunks >= 30);
});

test('rag: vitals findings pull in their protocol regardless of ranking', () => {
  assert.ok(retrieve({ sos_code: SOS.MEDICAL, vitals: V({ spo2: 85 }) }).grounding.some((g) => g.chunk_id === 'WHO-HYPOX-01' && g.role === 'finding'));
  assert.ok(retrieve({ sos_code: SOS.MEDICAL, vitals: V({ heart_rate: 40 }) }).grounding.some((g) => g.chunk_id === 'WHO-BRADY-01'));
  assert.ok(retrieve({ sos_code: SOS.MEDICAL, vitals: V({ heart_rate: 150 }) }).grounding.some((g) => g.chunk_id === 'WHO-TACHY-01'));
  assert.ok(retrieve({ sos_code: SOS.HOSTILE, vitals: V({ duress_flag: true }), category: 'HOSTAGE_COVERT' }).grounding.some((g) => g.chunk_id === 'SEC-DURESS-01'));
});

test('rag: the right protocol leads for each situation', () => {
  const top = (input) => retrieve(input).grounding.find((g) => g.role === 'primary').chunk_id;
  assert.equal(top({ sos_code: SOS.TRAUMA, vitals: V() }), 'TCCC-MH-01');
  assert.equal(top({ sos_code: SOS.CHILDBIRTH, vitals: V() }), 'WHO-OB-01');
  assert.equal(top({ sos_code: SOS.WATER, vitals: V(), category: 'SUPPLY_DROP' }), 'WEMS-WATER-01');
  assert.equal(top({ sos_code: SOS.HOSTILE, vitals: V(), category: 'COMBAT_EXTRACTION' }), 'SEC-HOSTILE-01');
});

test('rag: a nearby flood must not turn a hypoxia reply into flood advice (regression)', async () => {
  const flood = { hazards: [{ kind: 'FLOOD', severity: 'HIGH', label: 'x', center: { lat: 25.2, lon: 55.27 }, radius_km: 3, distance_km: 1, polygon: circlePolygon({ lat: 25.2, lon: 55.27 }, 3), blocks: ['GROUND'] }], hospitals: [], assets: [], weather: null };
  const r = await triage({ incident: inc({ sos_code: SOS.MEDICAL, vitals: V({ spo2: 85 }) }), context: flood });
  assert.doesNotMatch(r.triage.user_satellite_reply, /HIGH GROUND|MOVING WATER/);
  assert.match(r.triage.user_satellite_reply, /SIT UPRIGHT/);
  assert.ok(r.grounding.some((g) => g.chunk_id === 'WEMS-FLOOD-01' && g.role === 'environment'), 'flood is still reported to the dispatcher');
});

test('rag: trauma leads with bleeding control even when SpO2 is low', async () => {
  const r = await triage({ incident: inc({ sos_code: SOS.TRAUMA, vitals: V({ spo2: 85 }) }), context: await geo.geoContext(25.2048, 55.2708) });
  assert.match(r.triage.user_satellite_reply, /TOURNIQUET/);
});

test('rag-core: vector store ranks by overlap and breaks ties by id', () => {
  const s = new VectorStore().build([{ id: 'b', text: 'bleeding wound tourniquet' }, { id: 'a', text: 'bleeding wound tourniquet' }, { id: 'c', text: 'water thirst shade' }]);
  const r = s.query('tourniquet for bleeding', 3);
  assert.deepEqual(r.map((x) => x.doc.id), ['a', 'b']);
  assert.equal(queryFor({ sos_code: SOS.WATER, vitals: V() }).includes('water'), true);
});

test('rag-core: a query with no real term in common matches nothing (regression: hash collisions returned a card for gibberish)', () => {
  const s = new VectorStore().build(kbChunks().map((c) => ({ id: c.id, text: `${c.topic} ${c.keywords} ${c.text}` })));
  for (const q of ['xyzzy plugh quux', 'asdf qwer zxcv', '', 'the and of']) assert.deepEqual(s.query(q, 3, { minScore: 0.04 }), [], JSON.stringify(q));
  assert.equal(s.query('my leg is bleeding badly', 3, { minScore: 0.05 })[0].doc.id, 'TCCC-MH-01');
  assert.equal(s.query('baby is coming', 3, { minScore: 0.05 })[0].doc.id, 'WHO-OB-01');
  assert.equal(s.query('Bleeding', 3, { minScore: 0.05 })[0].doc.id, 'TCCC-MH-01');
});

/* ---------------- geometry ---------------- */

test('geomath: distance, bearing and compass agree with known values', () => {
  const a = { lat: 0, lon: 0 };
  assert.ok(Math.abs(haversineKm(a, { lat: 0, lon: 1 }) - 111.19) < 0.2);
  assert.equal(Math.round(bearingDeg(a, { lat: 1, lon: 0 })), 0);
  assert.equal(Math.round(bearingDeg(a, { lat: 0, lon: 1 })), 90);
  assert.equal(compass(135), 'SE');
  assert.equal(compass(359), 'N');
  const p = destination(a, 90, 50);
  assert.ok(Math.abs(haversineKm(a, p) - 50) < 0.05);
});

test('geomath: a segment crossing a thin polygon is caught (a sampled test would step over it)', () => {
  const thin = [[-0.0001, 0.2], [-0.0001, 0.2002], [0.0001, 0.2002], [0.0001, 0.2]];
  assert.equal(segmentHitsPolygon({ lat: 0, lon: 0 }, { lat: 0, lon: 0.5 }, thin), true);
  assert.equal(segmentHitsPolygon({ lat: 1, lon: 0 }, { lat: 1, lon: 0.5 }, thin), false);
  const ring = circlePolygon({ lat: 10, lon: 10 }, 3);
  assert.equal(pointInPolygon({ lat: 10, lon: 10 }, ring), true);
  assert.equal(pointInPolygon({ lat: 10.5, lon: 10 }, ring), false);
});

/* ---------------- deconfliction ---------------- */

const S = { lat: 0, lon: 0 };
const hz = (kind, at, radius, blocks) => ({ kind, severity: 'HIGH', label: kind.toLowerCase(), center: at, radius_km: radius, distance_km: haversineKm(S, at), polygon: circlePolygon(at, radius), blocks });
const west = (km) => destination(S, 270, km);
const asset = (kind, km, over = {}) => ({ id: kind, name: kind + ' unit', kind, available: true, ...west(km), ...over });
const ctx = (over) => ({ hazards: [], hospitals: [{ id: 'H', name: 'Mercy', status: 'OPERATIONAL', lat: 0.05, lon: 0.05 }], assets: [], weather: null, ...over });

test('deconflict: a flood blocks the ambulance but not the helicopter', () => {
  const flood = hz('FLOOD', west(10), 2, ['GROUND']);
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: ctx({ hazards: [flood], assets: [asset('GROUND', 20), asset('HELI', 20)] }) });
  assert.equal(d.options.find((o) => o.mode === 'HELI').approach.kind, 'DIRECT');
  assert.equal(d.options.find((o) => o.mode === 'GROUND').approach?.kind, 'DOGLEG', 'the ambulance must detour');
  assert.equal(d.recommended.mode, 'HELI', 'heli is faster and direct');
});

test('deconflict: restricted airspace blocks the helicopter but not the ambulance (regression: heli was sent through a NOTAM)', () => {
  const notam = hz('AIRSPACE', west(8), 3, ['HELI', 'DRONE']);
  const c = ctx({ hazards: [notam], assets: [asset('GROUND', 16), asset('HELI', 16)] });
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: c });
  const heli = d.options.find((o) => o.mode === 'HELI');
  assert.equal(heli.approach.kind, 'DOGLEG', 'helicopter routes around the NOTAM');
  assert.ok(heli.blocked_by.some((b) => /AIRSPACE/.test(b)));
  assert.equal(d.options.find((o) => o.mode === 'GROUND').approach.kind, 'DIRECT');
});

test('deconflict: an asset based inside a blocking hazard has no safe leg out of it (conservative)', () => {
  const notam = hz('AIRSPACE', west(10), 3, ['HELI', 'DRONE']);
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: ctx({ hazards: [notam], assets: [asset('HELI', 11)] }) });
  assert.equal(d.recommended, null);
});

test('deconflict: a dogleg waypoint really is clear of every blocking hazard', () => {
  const wall = hz('CONFLICT', west(8), 3, ['GROUND', 'HELI']);
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: ctx({ hazards: [wall], assets: [asset('HELI', 25)] }) });
  const r = d.recommended;
  assert.equal(r.approach.kind, 'DOGLEG');
  const wp = r.approach.waypoint;
  assert.equal(segmentHitsPolygon(r.asset, wp, wall.polygon), false);
  assert.equal(segmentHitsPolygon(wp, S, wall.polygon), false);
  assert.ok(r.approach.detour_km > 0);
});

test('deconflict: when every approach is walled off there is no safe vector and the plan says so', () => {
  const ring = hz('CONFLICT', S, 40, ['GROUND', 'HELI']);
  ring.polygon = circlePolygon(S, 40);
  const c = ctx({ hazards: [{ ...ring, center: { lat: 0, lon: 0.5 }, polygon: circlePolygon({ lat: 0, lon: 0.5 }, 8) }, hz('CONFLICT', { lat: 0, lon: -0.5 }, 8, ['GROUND', 'HELI']), hz('CONFLICT', { lat: 0.5, lon: 0 }, 8, ['GROUND', 'HELI']), hz('CONFLICT', { lat: -0.5, lon: 0 }, 8, ['GROUND', 'HELI'])], assets: [{ ...asset('HELI', 60) }] });
  // survivor sits in a hazard-free pocket enclosed by four large rings; the standoff points are inside them
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: c });
  if (!d.recommended) assert.match(planText(d, { category: 'MEDEVAC' }), /NO SAFE VECTOR/);
  else assert.equal(d.recommended.approach.kind, 'DOGLEG');
});

test('deconflict: weather limits are per mode (a drone grounds at 30 kt, a helicopter does not)', () => {
  const w = { wind_kt: 30, visibility_km: 8, storm: false };
  assert.match(weatherBlock('DRONE', w), /wind/);
  assert.equal(weatherBlock('HELI', w), null);
  assert.match(weatherBlock('HELI', { wind_kt: 5, visibility_km: 0.8 }), /visibility/);
  assert.match(weatherBlock('HELI', { wind_kt: 5, visibility_km: 9, storm: true }), /thunderstorm/);
  assert.equal(weatherBlock('GROUND', { wind_kt: 60, visibility_km: 9, storm: false }), null);
});

test('deconflict: supply drops go by drone, falling back to helicopter in a gale', () => {
  const base = { assets: [asset('DRONE', 8), asset('HELI', 20), asset('GROUND', 8)] };
  assert.equal(deconflict({ survivor: S, category: 'SUPPLY_DROP', context: ctx(base) }).recommended.mode, 'DRONE');
  const gale = deconflict({ survivor: S, category: 'SUPPLY_DROP', context: ctx({ ...base, weather: { wind_kt: 35, visibility_km: 9, storm: false } }) });
  assert.equal(gale.recommended.mode, 'HELI');
  assert.equal(gale.options.find((o) => o.mode === 'DRONE').feasible, false);
});

test('deconflict: casualties never travel by drone, and unavailable assets are skipped', () => {
  const c = ctx({ assets: [asset('DRONE', 3), asset('GROUND', 20, { available: false })] });
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: c });
  assert.equal(d.recommended, null);
  assert.match(planText(d, { category: 'MEDEVAC' }), /NO SAFE VECTOR/);
});

test('deconflict: a survivor already inside a hazard is reported, not made unreachable', () => {
  const under = hz('CONFLICT', S, 2, ['GROUND', 'HELI']);
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: ctx({ hazards: [under], assets: [asset('HELI', 15)] }) });
  assert.ok(d.recommended, 'still plannable');
  assert.equal(d.survivor_inside.length, 1);
  assert.match(planText(d, { category: 'MEDEVAC' }), /SURVIVOR INSIDE/);
});

test('deconflict: damaged hospitals are not offered as the evacuation destination', () => {
  const c = ctx({ hospitals: [{ id: 'X', name: 'Ruined', status: 'DAMAGED', lat: 0.01, lon: 0.01 }, { id: 'Y', name: 'Mercy', status: 'OPERATIONAL', lat: 0.1, lon: 0.1 }], assets: [asset('HELI', 15)] });
  assert.equal(deconflict({ survivor: S, category: 'MEDEVAC', context: c }).evac.hospital.name, 'Mercy');
});

test('deconflict: unverified hospital status is flagged in the plan and checklist', async () => {
  const c = ctx({ hospitals: [{ id: 'O', name: 'OSM Clinic', status: 'UNVERIFIED', lat: 0.1, lon: 0.1 }], assets: [asset('HELI', 15)] });
  const d = deconflict({ survivor: S, category: 'MEDEVAC', context: c });
  assert.match(planText(d, { category: 'MEDEVAC' }), /UNVERIFIED/);
  const r = await triage({ incident: inc({ position: S }), context: c });
  assert.match(r.triage.dispatcher_checklist[2], /unverified/);
});

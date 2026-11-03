// 25 km geo-context slice for an SOS at (lat, lon).
//
// Two modes (AEGIS_GEO):
//   demo (default)  deterministic synthetic scenario around the survivor, every field
//                   labelled source=DEMO_SCENARIO. Used for the simulator and tests.
//   live            real sources, each independent and soft-failing:
//                     conflict, natural hazards  WorldMonitor MCP  get_conflict_events /
//                                                get_natural_disasters (lat, lon, radius_km)
//                                                needs AEGIS_WM_KEY; AEGIS_WM_MCP_URL
//                                                defaults to https://worldmonitor.app/mcp
//                     weather                    Open-Meteo (no key)
//                     hospitals                  OpenStreetMap via Overpass (no key)
//                     rescue assets              AEGIS_UNITS_FILE (JSON), CAD-owned
//
// WHAT IS NOT AVAILABLE, and is reported as such instead of invented: WorldMonitor
// exposes no airspace-restriction polygons (its NOTAM data is airport closure flags),
// no road/bridge damage layer and no hospital layer. OSM hospitals carry no
// operational status, so they are marked UNVERIFIED.
//
// The slice is bounded on purpose (hazards, hospitals, assets are capped): the model
// never receives a raw global feed.

import fs from 'node:fs';
import { haversineKm, circlePolygon, destination, bearingDeg } from './geomath.mjs';

export const RADIUS_KM = 25;
const TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const CAPS = { hazards: 24, hospitals: 6, assets: 8 };

/** Which transport modes each hazard kind makes unsafe. */
export const HAZARD_BLOCKS = {
  CONFLICT: ['GROUND', 'HELI'],
  AIRSPACE: ['HELI', 'DRONE'],
  FLOOD: ['GROUND'],
  INFRASTRUCTURE: ['GROUND'],
  WILDFIRE: ['GROUND', 'HELI'],
  SEISMIC: [],
};

const UA = 'aegis-core-service/0.2 (research prototype)';

/* ---------------- demo scenario ---------------- */

function hash01(str, salt = 0) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

function demoSlice(lat, lon) {
  const origin = { lat, lon };
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const r = (salt) => hash01(key, salt);
  const at = (salt, minKm, maxKm) => destination(origin, r(salt) * 360, minKm + r(salt + 50) * (maxKm - minKm));
  const mid = (a, b, jitterSalt) => {
    const m = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    return destination(m, r(jitterSalt) * 360, r(jitterSalt + 9) * 1.2);
  };

  const heli = { id: 'AS-HELI-1', name: 'Rescue Helicopter H1', kind: 'HELI', ...at(1, 18, 40), available: true };
  const ambulance = { id: 'AS-GND-1', name: 'Ambulance Unit A1', kind: 'GROUND', ...at(2, 7, 20), available: true };
  const drone = { id: 'AS-DRN-1', name: 'Supply Drone D1', kind: 'DRONE', ...at(3, 5, 15), available: true };

  const hazards = [];
  const add = (kind, severity, label, center, radius) =>
    hazards.push({ kind, severity, label, center: { lat: +center.lat.toFixed(5), lon: +center.lon.toFixed(5) }, radius_km: radius, source: 'DEMO_SCENARIO', confidence: 0.7 });

  // Hazards are placed so that roughly half the scenarios have a blocked direct vector.
  if (r(4) > 0.25) add('CONFLICT', r(5) > 0.6 ? 'HIGH' : 'MODERATE', 'Active small-arms engagement (synthetic)', at(6, 3, 12), r(5) > 0.6 ? 4 : 2.5);
  if (r(7) > 0.35) add('AIRSPACE', 'HIGH', 'Temporary restricted airspace, rotary ops (synthetic NOTAM)', mid(heli, origin, 8), 3);
  if (r(9) > 0.45) add('FLOOD', 'MODERATE', 'Standing water over wadi crossing (synthetic)', mid(ambulance, origin, 10), 1.6);
  if (r(11) > 0.6) add('INFRASTRUCTURE', 'HIGH', 'Bridge reported impassable (synthetic)', at(12, 4, 14), 0.8);
  if (r(13) > 0.8) add('WILDFIRE', 'MODERATE', 'Active fire front (synthetic)', at(14, 8, 18), 2.2);

  const hospitals = [
    { id: 'HOSP-1', name: 'Field Hospital ' + (1 + Math.floor(r(15) * 3)), ...at(16, 6, 22), capability: ['TRAUMA', 'SURGERY'], status: 'OPERATIONAL' },
    { id: 'HOSP-2', name: 'District Clinic ' + (1 + Math.floor(r(17) * 4)), ...at(18, 4, 20), capability: ['BLS', 'PAEDIATRIC'], status: 'OPERATIONAL' },
    { id: 'HOSP-3', name: 'General Hospital (damaged)', ...at(19, 2, 9), capability: ['TRAUMA'], status: 'DAMAGED' },
  ];

  return {
    mode: 'demo',
    source: 'DEMO_SCENARIO',
    weather: {
      temp_c: 20 + Math.round(r(20) * 22),
      wind_kt: 4 + Math.round(r(21) * 26),
      visibility_km: +(1.2 + r(22) * 9).toFixed(1),
      precip_mm: 0,
      dust: r(23) > 0.75,
      storm: false,
      source: 'DEMO_SCENARIO',
    },
    hazards,
    hospitals,
    assets: [heli, ambulance, drone],
    coverage: { conflict: 'demo', natural: 'demo', airspace: 'demo', infrastructure: 'demo', weather: 'demo', medical: 'demo', assets: 'demo' },
    warnings: ['DEMO SCENARIO: synthetic hazards, facilities and assets. Not real-world data.'],
  };
}

/* ---------------- live providers ---------------- */

async function timedFetch(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': UA, ...(init.headers || {}) } });
}

/** One WorldMonitor MCP tools/call. Returns the structured envelope or throws. */
async function wmCall(fetchImpl, env, name, args) {
  const key = env.AEGIS_WM_KEY;
  if (!key) throw new Error('AEGIS_WM_KEY not set');
  const url = env.AEGIS_WM_MCP_URL || 'https://worldmonitor.app/mcp';
  const res = await timedFetch(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-WorldMonitor-Key': key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = await res.text();
  const sse = text.match(/^data:\s*(\{[\s\S]*\})\s*$/m);
  if (sse) text = sse[1];
  const rpc = JSON.parse(text);
  if (rpc.error) throw new Error(rpc.error.message || 'rpc error');
  const result = rpc.result || {};
  if (result.isError) throw new Error('tool error');
  if (result.structuredContent) return result.structuredContent;
  const c = result.content?.[0]?.text;
  return c ? JSON.parse(c) : {};
}

const loc = (e) => {
  const l = e?.location;
  return l && Number.isFinite(l.latitude) && Number.isFinite(l.longitude) ? { lat: l.latitude, lon: l.longitude } : null;
};

export function normaliseConflict(envelope, origin) {
  const d = envelope?.data || envelope || {};
  const rows = [...(d['ucdp-events']?.events || []), ...(d.events?.events || [])];
  const out = [];
  for (const e of rows) {
    const p = loc(e);
    if (!p) continue;
    const dist = haversineKm(origin, p);
    if (dist > RADIUS_KM) continue;
    const deaths = e.deathsBest ?? e.fatalities ?? 0;
    const high = deaths >= 10;
    out.push({
      kind: 'CONFLICT',
      severity: high ? 'HIGH' : 'MODERATE',
      label: `Conflict event${e.violenceType ? ` (${e.violenceType})` : ''}${deaths ? `, ${deaths} fatalities` : ''}${e.country ? `, ${e.country}` : ''}`,
      center: p,
      radius_km: high ? 5 : 3,
      source: 'WORLDMONITOR_MCP',
      confidence: 0.6,
      _rank: deaths,
    });
  }
  return out.sort((a, b) => b._rank - a._rank).slice(0, 12);
}

export function normaliseNatural(envelope, origin) {
  const d = envelope?.data || envelope || {};
  const out = [];
  for (const q of d.earthquakes?.earthquakes || []) {
    const p = loc(q);
    if (!p || haversineKm(origin, p) > RADIUS_KM) continue;
    out.push({ kind: 'SEISMIC', severity: q.magnitude >= 6 ? 'HIGH' : 'MODERATE', label: `M${q.magnitude} earthquake${q.place ? `, ${q.place}` : ''}`, center: p, radius_km: Math.min(10, Math.max(2, 2 * (q.magnitude - 3))), source: 'WORLDMONITOR_MCP', confidence: 0.9 });
  }
  const seen = new Set();
  for (const f of d.fires?.fireDetections || []) {
    const p = loc(f);
    if (!p || haversineKm(origin, p) > RADIUS_KM) continue;
    const cell = `${Math.round(p.lat / 0.03)}:${Math.round(p.lon / 0.03)}`;
    if (seen.has(cell)) continue;
    seen.add(cell);
    out.push({ kind: 'WILDFIRE', severity: 'MODERATE', label: 'Satellite fire detection', center: p, radius_km: 1.5, source: 'WORLDMONITOR_MCP', confidence: f.confidence === 'high' ? 0.8 : 0.5 });
  }
  return out.slice(0, 12);
}

export function normaliseWeather(json) {
  const c = json?.current;
  if (!c || !Number.isFinite(c.temperature_2m)) return null;
  const code = c.weather_code;
  return {
    temp_c: Math.round(c.temperature_2m),
    wind_kt: Math.round(c.wind_speed_10m ?? 0),
    visibility_km: Number.isFinite(c.visibility) ? +(c.visibility / 1000).toFixed(1) : null,
    precip_mm: c.precipitation ?? 0,
    dust: false,
    storm: code >= 95 && code <= 99,
    source: 'OPEN_METEO',
  };
}

export function normaliseHospitals(json, origin) {
  const out = [];
  for (const el of json?.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const t = el.tags || {};
    const name = t['name:en'] || t.name;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) continue;
    if (t.disused || t.abandoned || t['abandoned:amenity'] || t['was:amenity']) continue;
    out.push({
      id: `OSM-${el.type}-${el.id}`,
      name,
      lat,
      lon,
      capability: t.emergency === 'yes' ? ['EMERGENCY'] : ['UNKNOWN'],
      status: 'UNVERIFIED',
      source: 'OPENSTREETMAP',
      _d: haversineKm(origin, { lat, lon }),
    });
  }
  return out.sort((a, b) => a._d - b._d).slice(0, CAPS.hospitals).map(({ _d, ...h }) => h);
}

function loadUnits(env) {
  if (!env.AEGIS_UNITS_FILE) return null;
  const j = JSON.parse(fs.readFileSync(env.AEGIS_UNITS_FILE, 'utf8'));
  return (Array.isArray(j) ? j : j.units || []).filter((u) => Number.isFinite(u.lat) && Number.isFinite(u.lon) && ['GROUND', 'HELI', 'DRONE'].includes(u.kind));
}

async function liveSlice(lat, lon, fetchImpl, env) {
  const origin = { lat, lon };
  const slice = {
    mode: 'live',
    source: 'LIVE',
    weather: null,
    hazards: [],
    hospitals: [],
    assets: [],
    coverage: {
      conflict: 'unavailable', natural: 'unavailable', weather: 'unavailable', medical: 'unavailable', assets: 'unconfigured',
      airspace: 'unavailable (WorldMonitor exposes no airspace-restriction polygons)',
      infrastructure: 'unavailable (no road/bridge damage layer upstream)',
    },
    warnings: [],
  };

  const area = { lat, lon, radius_km: RADIUS_KM };
  const jobs = [
    ['conflict', async () => normaliseConflict(await wmCall(fetchImpl, env, 'get_conflict_events', { ...area, since_days: 30, limit: 40 }), origin), (v) => slice.hazards.push(...v), 'worldmonitor-mcp'],
    ['natural', async () => normaliseNatural(await wmCall(fetchImpl, env, 'get_natural_disasters', { ...area, since_days: 14, active_only: true, limit: 40 }), origin), (v) => slice.hazards.push(...v), 'worldmonitor-mcp'],
    ['weather', async () => {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,visibility,precipitation,weather_code&wind_speed_unit=kn`;
      const res = await timedFetch(fetchImpl, env.AEGIS_WEATHER_URL || u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const w = normaliseWeather(await res.json());
      if (!w) throw new Error('no current conditions');
      return w;
    }, (v) => { slice.weather = v; }, 'open-meteo'],
    ['medical', async () => {
      const q = `[out:json][timeout:20];(nwr["amenity"="hospital"](around:${RADIUS_KM * 1000},${lat},${lon}););out center tags 40;`;
      const res = await timedFetch(fetchImpl, env.AEGIS_OVERPASS_URL || 'https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return normaliseHospitals(await res.json(), origin);
    }, (v) => slice.hospitals.push(...v), 'openstreetmap'],
  ];

  await Promise.all(jobs.map(async ([layer, run, apply, label]) => {
    try {
      apply(await run());
      slice.coverage[layer] = label;
    } catch (e) {
      slice.warnings.push(`${layer}: ${e.message}`);
    }
  }));

  try {
    const units = loadUnits(env);
    if (units) {
      slice.assets = units.map((u) => ({ id: u.id, name: u.name, kind: u.kind, lat: u.lat, lon: u.lon, available: u.available !== false }));
      slice.coverage.assets = 'units-file';
    }
  } catch (e) {
    slice.warnings.push(`assets: ${e.message}`);
  }
  return slice;
}

/* ---------------- shared finishing ---------------- */

function finish(slice, lat, lon, radiusKm) {
  const origin = { lat, lon };
  const hazards = slice.hazards
    .map((h, i) => ({
      id: h.id || `HZ-${i + 1}`,
      ...h,
      polygon: h.polygon || circlePolygon(h.center, h.radius_km),
      blocks: HAZARD_BLOCKS[h.kind] || [],
      distance_km: +haversineKm(origin, h.center).toFixed(1),
    }))
    .filter((h) => h.distance_km - h.radius_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, CAPS.hazards)
    .map(({ _rank, ...h }) => h);
  const hospitals = slice.hospitals
    .map((h) => ({ ...h, distance_km: +haversineKm(origin, h).toFixed(1) }))
    .filter((h) => h.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, CAPS.hospitals);
  const assets = slice.assets
    .map((a) => ({ ...a, distance_km: +haversineKm(origin, a).toFixed(1), bearing_to_survivor: Math.round(bearingDeg(a, origin)) }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, CAPS.assets);
  return {
    center: { lat, lon },
    radius_km: radiusKm,
    generated_at: new Date().toISOString(),
    ...slice,
    hazards,
    hospitals,
    assets,
  };
}

/**
 * Geo-context factory. `fetch` and `env` are injectable so the live path is testable
 * without the network.
 */
export function createGeo({ fetch: fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const cache = new Map();
  return {
    async geoContext(lat, lon, radiusKm = RADIUS_KM) {
      const mode = (env.AEGIS_GEO || 'demo').toLowerCase();
      const key = `${mode}:${lat.toFixed(2)},${lon.toFixed(2)},${radiusKm}`;
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return { ...hit.value, cache: 'HIT' };
      const raw = mode === 'live' ? await liveSlice(lat, lon, fetchImpl, env) : demoSlice(lat, lon);
      const value = finish(raw, lat, lon, radiusKm);
      // A slice with warnings is not cached long: a transient provider failure must not stick.
      cache.set(key, { value, expires: Date.now() + (value.warnings.length && mode === 'live' ? 30_000 : TTL_MS) });
      return { ...value, cache: 'MISS' };
    },
    clearCache: () => cache.clear(),
    mode: () => (env.AEGIS_GEO || 'demo').toLowerCase(),
  };
}

const defaultGeo = createGeo();
export const geoContext = defaultGeo.geoContext;
export const _clearCache = defaultGeo.clearCache;

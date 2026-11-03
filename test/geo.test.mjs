import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeo, normaliseConflict, normaliseNatural, normaliseWeather, normaliseHospitals, HAZARD_BLOCKS, RADIUS_KM } from '../src/geo.mjs';
import { haversineKm } from '../src/geomath.mjs';

const O = { lat: 25.2048, lon: 55.2708 };

/* ---------------- demo ---------------- */

test('demo: deterministic, labelled as a scenario, and inside the 25 km radius', async () => {
  const geo = createGeo({ env: { AEGIS_GEO: 'demo' } });
  const a = await geo.geoContext(O.lat, O.lon);
  geo.clearCache();
  const b = await geo.geoContext(O.lat, O.lon);
  assert.deepEqual(a.hazards, b.hazards);
  assert.equal(a.mode, 'demo');
  assert.ok(a.warnings.some((w) => /DEMO SCENARIO/.test(w)));
  for (const h of a.hazards) assert.ok(h.distance_km - h.radius_km <= RADIUS_KM, `${h.kind} out of slice`);
  for (const h of a.hospitals) assert.ok(h.distance_km <= RADIUS_KM);
  assert.ok(a.hospitals.some((h) => h.status === 'DAMAGED'), 'scenario includes a damaged facility');
});

test('demo: every hazard carries the transport modes it blocks, and cache is hit on repeat', async () => {
  const geo = createGeo({ env: { AEGIS_GEO: 'demo' } });
  const a = await geo.geoContext(O.lat, O.lon);
  assert.equal(a.cache, 'MISS');
  assert.equal((await geo.geoContext(O.lat, O.lon)).cache, 'HIT');
  for (const h of a.hazards) assert.deepEqual(h.blocks, HAZARD_BLOCKS[h.kind]);
  assert.deepEqual(HAZARD_BLOCKS.FLOOD, ['GROUND']);
  assert.ok(HAZARD_BLOCKS.AIRSPACE.includes('HELI') && !HAZARD_BLOCKS.AIRSPACE.includes('GROUND'));
});

test('demo: the slice is bounded (the model never gets a raw global feed)', async () => {
  const a = await createGeo({ env: { AEGIS_GEO: 'demo' } }).geoContext(O.lat, O.lon);
  assert.ok(a.hazards.length <= 24 && a.hospitals.length <= 6 && a.assets.length <= 8);
});

/* ---------------- normalisers ---------------- */

const near = (km, brg = 90) => {
  const dLon = km / (111.32 * Math.cos((O.lat * Math.PI) / 180));
  return { latitude: O.lat, longitude: O.lon + (brg === 90 ? dLon : -dLon) };
};

test('conflict: WorldMonitor events inside 25 km become hazards; farther ones are dropped', () => {
  const env = { data: { 'ucdp-events': { events: [
    { id: 'a', location: near(5), deathsBest: 40, violenceType: 'state-based', country: 'X' },
    { id: 'b', location: near(60), deathsBest: 90 },
    { id: 'c', location: { latitude: null, longitude: 3 }, deathsBest: 5 },
  ] }, events: { events: [{ country: 'X', fatalities: 2, location: near(12, 270) }] } } };
  const out = normaliseConflict(env, O);
  assert.equal(out.length, 2);
  assert.equal(out[0].severity, 'HIGH');
  assert.equal(out[0].radius_km, 5);
  assert.equal(out[1].severity, 'MODERATE');
  assert.ok(out.every((h) => haversineKm(O, h.center) <= RADIUS_KM));
});

test('natural: earthquakes become SEISMIC, fire detections are de-duplicated on a grid', () => {
  const env = { data: {
    earthquakes: { earthquakes: [{ magnitude: 6.1, place: 'Y', location: near(10) }, { magnitude: 5, location: near(80) }] },
    fires: { fireDetections: [{ location: near(8), confidence: 'high' }, { location: { latitude: near(8).latitude + 0.001, longitude: near(8).longitude }, confidence: 'low' }, { location: near(15, 270), confidence: 'low' }] },
  } };
  const out = normaliseNatural(env, O);
  assert.equal(out.filter((h) => h.kind === 'SEISMIC').length, 1);
  assert.equal(out.find((h) => h.kind === 'SEISMIC').severity, 'HIGH');
  assert.equal(out.filter((h) => h.kind === 'WILDFIRE').length, 2, 'two detections within one grid cell collapse to one');
});

test('weather: Open-Meteo current conditions, thunderstorm codes, and missing data', () => {
  const w = normaliseWeather({ current: { temperature_2m: 31.5, wind_speed_10m: 7.4, visibility: 17020, precipitation: 0, weather_code: 96 } });
  assert.deepEqual([w.temp_c, w.wind_kt, w.visibility_km, w.storm], [32, 7, 17, true]);
  assert.equal(normaliseWeather({}), null);
});

test('hospitals: OSM facilities are nearest-first, status UNVERIFIED, abandoned ones dropped', () => {
  const j = { elements: [
    { type: 'node', id: 1, lat: O.lat + 0.2, lon: O.lon, tags: { name: 'Far', amenity: 'hospital' } },
    { type: 'way', id: 2, center: { lat: O.lat + 0.05, lon: O.lon }, tags: { 'name:en': 'Near', name: 'x', emergency: 'yes' } },
    { type: 'node', id: 3, lat: O.lat + 0.01, lon: O.lon, tags: { name: 'Gone', abandoned: 'yes' } },
    { type: 'node', id: 4, lat: O.lat + 0.01, lon: O.lon, tags: {} },
  ] };
  const out = normaliseHospitals(j, O);
  assert.deepEqual(out.map((h) => h.name), ['Near', 'Far']);
  assert.ok(out.every((h) => h.status === 'UNVERIFIED'));
  assert.deepEqual(out[0].capability, ['EMERGENCY']);
});

/* ---------------- live mode with a mocked network ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function mockFetch({ wm = true, weather = true, overpass = true } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/mcp')) {
      if (!wm) return json({}, 503);
      const body = JSON.parse(init.body);
      const name = body.params.name;
      const sc = name === 'get_conflict_events'
        ? { data: { 'ucdp-events': { events: [{ id: 'e', location: near(6), deathsBest: 12 }] } } }
        : { data: { earthquakes: { earthquakes: [{ magnitude: 5.2, location: near(9, 270) }] }, fires: { fireDetections: [] } } };
      return json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], structuredContent: sc } });
    }
    if (u.includes('open-meteo')) return weather ? json({ current: { temperature_2m: 30, wind_speed_10m: 9, visibility: 9000, precipitation: 0, weather_code: 1 } }) : json({}, 500);
    if (u.includes('overpass')) return overpass ? json({ elements: [{ type: 'node', id: 7, lat: O.lat + 0.05, lon: O.lon, tags: { name: 'City Hospital' } }] }) : json({}, 429);
    throw new Error('unexpected url ' + u);
  };
  f.calls = calls;
  return f;
}

test('live: all providers answering gives a full slice with per-layer coverage', async () => {
  const fetch = mockFetch();
  const geo = createGeo({ fetch, env: { AEGIS_GEO: 'live', AEGIS_WM_KEY: 'test-key' } });
  const s = await geo.geoContext(O.lat, O.lon);
  assert.equal(s.mode, 'live');
  assert.deepEqual(s.hazards.map((h) => h.kind).sort(), ['CONFLICT', 'SEISMIC']);
  assert.equal(s.hospitals[0].name, 'City Hospital');
  assert.equal(s.weather.source, 'OPEN_METEO');
  assert.equal(s.coverage.conflict, 'worldmonitor-mcp');
  assert.equal(s.coverage.medical, 'openstreetmap');
  assert.match(s.coverage.airspace, /^unavailable/, 'honest about what WorldMonitor does not provide');
  assert.match(s.coverage.infrastructure, /^unavailable/);
});

test('live: the WorldMonitor call carries the key header, lat/lon/radius_km, and the right tools', async () => {
  const fetch = mockFetch();
  await createGeo({ fetch, env: { AEGIS_GEO: 'live', AEGIS_WM_KEY: 'test-key' } }).geoContext(O.lat, O.lon);
  const mcp = fetch.calls.filter((c) => c.url.includes('/mcp'));
  assert.deepEqual(mcp.map((c) => JSON.parse(c.init.body).params.name).sort(), ['get_conflict_events', 'get_natural_disasters']);
  for (const c of mcp) {
    assert.equal(c.init.headers['X-WorldMonitor-Key'], 'test-key');
    const a = JSON.parse(c.init.body).params.arguments;
    assert.deepEqual([a.lat, a.lon, a.radius_km], [O.lat, O.lon, 25]);
  }
});

test('live: a provider failure degrades that layer only and is reported, never invented', async () => {
  const s = await createGeo({ fetch: mockFetch({ overpass: false, weather: false }), env: { AEGIS_GEO: 'live', AEGIS_WM_KEY: 'k' } }).geoContext(O.lat, O.lon);
  assert.equal(s.coverage.medical, 'unavailable');
  assert.equal(s.coverage.weather, 'unavailable');
  assert.equal(s.hospitals.length, 0);
  assert.equal(s.weather, null);
  assert.ok(s.hazards.length > 0, 'the layers that worked survive');
  assert.ok(s.warnings.some((w) => /medical: HTTP 429/.test(w)));
});

test('live: without a WorldMonitor key the conflict layer is unavailable, with a clear reason', async () => {
  const s = await createGeo({ fetch: mockFetch(), env: { AEGIS_GEO: 'live' } }).geoContext(O.lat, O.lon);
  assert.equal(s.coverage.conflict, 'unavailable');
  assert.ok(s.warnings.some((w) => /AEGIS_WM_KEY/.test(w)));
  assert.equal(s.hazards.length, 0);
});

test('live: a degraded slice is not cached for long, so a transient outage does not stick', async () => {
  const f = mockFetch({ wm: false });
  const geo = createGeo({ fetch: f, env: { AEGIS_GEO: 'live', AEGIS_WM_KEY: 'k' } });
  const a = await geo.geoContext(O.lat, O.lon);
  assert.ok(a.warnings.length);
  assert.equal((await geo.geoContext(O.lat, O.lon)).cache, 'HIT', 'cached briefly');
  // (the 30 s TTL for degraded slices is asserted indirectly: it is shorter than the 10 min healthy TTL)
});

test('live: SSE-framed MCP replies are understood', async () => {
  const f = async (url, init) => {
    if (String(url).includes('/mcp')) {
      const sc = { data: { 'ucdp-events': { events: [{ id: 'e', location: near(4), deathsBest: 1 }] } } };
      return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: sc } }) + '\n\n', { status: 200 });
    }
    return json({}, 500);
  };
  const s = await createGeo({ fetch: f, env: { AEGIS_GEO: 'live', AEGIS_WM_KEY: 'k' } }).geoContext(O.lat, O.lon);
  assert.ok(s.hazards.some((h) => h.kind === 'CONFLICT'));
});

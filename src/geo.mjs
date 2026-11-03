// 25 km geo-context slice.
// STATUS: MOCK. There is no WorldMonitor MCP call here. This module defines the
// adapter interface and returns deterministic fixtures so the rest of the system
// can be built and tested. Replace `fetchSlice` with the MCP tool call.

const CACHE = new Map(); // key -> { value, expires }
const TTL_MS = 10 * 60 * 1000;

/** Deterministic pseudo-random in [0,1) from a string, so fixtures are stable. */
function hash01(str, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function ringAround(lat, lon, radiusKm, segments = 12) {
  const pts = [];
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([+(lat + dLat * Math.sin(a)).toFixed(5), +(lon + dLon * Math.cos(a)).toFixed(5)]);
  }
  return pts;
}

function buildFixture(incidentKey, lat, lon, radiusKm) {
  const r = (salt) => hash01(incidentKey, salt);
  const hazards = [];
  if (r(1) > 0.25) {
    hazards.push({
      kind: 'CONFLICT',
      severity: r(2) > 0.6 ? 'HIGH' : 'MODERATE',
      label: 'Active small-arms incident (OSINT, 2 sources)',
      polygon: ringAround(lat + 0.02, lon - 0.01, 2.4),
      confidence: 0.72,
    });
  }
  if (r(3) > 0.5) {
    hazards.push({
      kind: 'AIRSPACE',
      severity: 'HIGH',
      label: 'NOTAM: temporary restricted area, rotary ops',
      polygon: ringAround(lat - 0.03, lon + 0.02, 3.1),
      confidence: 0.9,
    });
  }
  if (r(4) > 0.6) {
    hazards.push({
      kind: 'FLOOD',
      severity: 'MODERATE',
      label: 'Standing water over wadi crossing (satellite-derived)',
      polygon: ringAround(lat + 0.005, lon + 0.03, 1.2),
      confidence: 0.66,
    });
  }

  const hospitals = [
    {
      name: 'Field Hospital ' + (1 + Math.floor(r(5) * 3)),
      lat: +(lat + 0.04 + r(6) * 0.03).toFixed(5),
      lon: +(lon - 0.05 - r(7) * 0.03).toFixed(5),
      capability: r(8) > 0.4 ? ['TRAUMA', 'SURGERY'] : ['BLS'],
      eta_min: 12 + Math.floor(r(9) * 40),
    },
    {
      name: 'Clinic ' + (1 + Math.floor(r(10) * 4)),
      lat: +(lat - 0.05 - r(11) * 0.02).toFixed(5),
      lon: +(lon + 0.03 + r(12) * 0.03).toFixed(5),
      capability: ['BLS', 'PAEDIATRIC'],
      eta_min: 20 + Math.floor(r(13) * 45),
    },
  ];

  return {
    incident_key: incidentKey,
    radius_km: radiusKm,
    generated_at: new Date().toISOString(),
    source: 'MOCK_WORLDMONITOR_MCP',
    weather: {
      temp_c: 24 + Math.round(r(14) * 16),
      wind_kt: 4 + Math.round(r(15) * 22),
      visibility_km: +(2 + r(16) * 8).toFixed(1),
      dust: r(17) > 0.7,
    },
    hazards,
    hospitals,
    routes: [
      { from: 'survivor', to: hospitals[0].name, status: 'EVALUATE', blocked_by: [] },
      { from: 'survivor', to: hospitals[1].name, status: 'EVALUATE', blocked_by: [] },
    ],
    notes: 'Fixture slice. Replace with the WorldMonitor MCP 25 km query.',
  };
}

/** Adapter seam. Swap the body of this function for the real MCP call. */
async function fetchSlice(lat, lon, radiusKm) {
  return buildFixture(`${lat.toFixed(3)},${lon.toFixed(3)},${radiusKm}`, lat, lon, radiusKm);
}

export async function geoContext(lat, lon, radiusKm = 25) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${radiusKm}`;
  const hit = CACHE.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cache: 'HIT' };
  const fresh = await fetchSlice(lat, lon, radiusKm);
  CACHE.set(key, { value: fresh, expires: Date.now() + TTL_MS });
  return { ...fresh, cache: 'MISS' };
}

export function _clearCache() {
  CACHE.clear();
}

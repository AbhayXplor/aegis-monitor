// Spherical and local-planar geometry helpers. Pure functions, no state.
// Distances are kilometres, bearings are degrees clockwise from north.

const R = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearingDeg(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Point at `distKm` along `bearing` from `p`. */
export function destination(p, bearing, distKm) {
  const d = distKm / R;
  const br = toRad(bearing);
  const lat1 = toRad(p.lat);
  const lon1 = toRad(p.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 = lon1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/** Closed-ring approximation of a circle as [[lat, lon], ...]. */
export function circlePolygon(center, radiusKm, segments = 16) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const p = destination(center, (360 * i) / segments, radiusKm);
    pts.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]);
  }
  return pts;
}

/** Equirectangular projection to km around an origin: good to ~0.5% inside 50 km. */
export function toXY(origin, p) {
  return { x: (p.lon - origin.lon) * 111.32 * Math.cos(toRad(origin.lat)), y: (p.lat - origin.lat) * 110.57 };
}

const polyXY = (origin, poly) => poly.map(([lat, lon]) => toXY(origin, { lat, lon }));

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p, poly) {
  return pointInRing(toXY(p, p), polyXY(p, poly));
}

function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Does the straight segment a->b touch the polygon? Exact test: an endpoint inside,
 * or a crossing with any polygon edge. (A sampled test can step over a thin polygon.)
 */
export function segmentHitsPolygon(a, b, poly) {
  const o = a;
  const ring = polyXY(o, poly);
  const A = toXY(o, a);
  const B = toXY(o, b);
  if (pointInRing(A, ring) || pointInRing(B, ring)) return true;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segIntersect(A, B, ring[j], ring[i])) return true;
  }
  return false;
}

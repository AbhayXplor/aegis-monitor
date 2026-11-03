// Route deconfliction: which asset, by which transport mode, along which vector.
//
// Hazards block modes selectively (see HAZARD_BLOCKS in geo.mjs): a flooded crossing
// stops an ambulance but not a helicopter; a restricted-airspace NOTAM stops a
// helicopter or drone but not an ambulance. Weather applies per-mode limits. For every
// available asset the engine tests the straight leg to the survivor; if it is blocked
// it searches for a single-waypoint dogleg that arrives from a hazard-free bearing.
//
// ENGINEERING DEFAULTS, not operational limits: speeds, standoff distances and weather
// minima below are placeholders that a flight/ground operations authority must set.

import { haversineKm, bearingDeg, compass, destination, segmentHitsPolygon, pointInPolygon } from './geomath.mjs';

export const MODE_SPEED_KMH = { GROUND: 40, HELI: 180, DRONE: 60 };
export const MODE_MOBILIZE_MIN = { GROUND: 5, HELI: 10, DRONE: 3 };
export const GROUND_CIRCUITY = 1.35;
export const STANDOFF_KM = { GROUND: 3, HELI: 5, DRONE: 4 };
export const WEATHER_LIMITS = {
  HELI: { max_wind_kt: 45, min_vis_km: 1.5, storm: false },
  DRONE: { max_wind_kt: 22, min_vis_km: 1.0, storm: false },
  GROUND: { max_wind_kt: Infinity, min_vis_km: 0.2, storm: true },
};

const pad3 = (n) => String(Math.round(n) % 360).padStart(3, '0');

export function weatherBlock(mode, w) {
  if (!w) return null;
  const lim = WEATHER_LIMITS[mode];
  if (w.storm && !lim.storm) return 'thunderstorm in the area';
  if (Number.isFinite(w.wind_kt) && w.wind_kt > lim.max_wind_kt) return `wind ${w.wind_kt} kt exceeds ${lim.max_wind_kt} kt`;
  if (Number.isFinite(w.visibility_km) && w.visibility_km < lim.min_vis_km) return `visibility ${w.visibility_km} km below ${lim.min_vis_km} km`;
  return null;
}

const hazardLabel = (h) => `${h.kind}: ${h.label}`;

function legBlockers(a, b, blockers) {
  return blockers.filter((h) => segmentHitsPolygon(a, b, h.polygon));
}

function planLeg(asset, survivor, blockers, mode) {
  const direct = legBlockers(asset, survivor, blockers);
  const speed = MODE_SPEED_KMH[mode];
  const circ = mode === 'GROUND' ? GROUND_CIRCUITY : 1;
  const eta = (km) => Math.round(MODE_MOBILIZE_MIN[mode] + ((km * circ) / speed) * 60);

  if (!direct.length) {
    const km = haversineKm(asset, survivor);
    return { feasible: true, approach: { kind: 'DIRECT', heading_deg: Math.round(bearingDeg(asset, survivor)) }, distance_km: +km.toFixed(1), eta_min: eta(km), blocked_by: [] };
  }

  // One waypoint, searched over bearing x standoff distance. Several standoffs matter:
  // a hazard 10 km out cannot be cleared by a waypoint 3 km from the survivor.
  const directKm = haversineKm(asset, survivor);
  const base = STANDOFF_KM[mode];
  const standoffs = [...new Set([base, base * 2, 12, 18, 24].filter((k) => k < directKm))];
  let best = null;
  for (const standoff of standoffs) {
    for (let brg = 0; brg < 360; brg += 10) {
      const wp = destination(survivor, brg, standoff);
      if (legBlockers(wp, survivor, blockers).length || legBlockers(asset, wp, blockers).length) continue;
      const km = haversineKm(asset, wp) + standoff;
      if (!best || km < best.km) best = { wp, km, brg, standoff };
    }
  }
  if (!best) return { feasible: false, approach: null, distance_km: +directKm.toFixed(1), eta_min: null, blocked_by: direct.map(hazardLabel) };
  return {
    feasible: true,
    approach: {
      kind: 'DOGLEG',
      waypoint: { lat: +best.wp.lat.toFixed(5), lon: +best.wp.lon.toFixed(5), bearing_from_survivor: best.brg, standoff_km: best.standoff },
      heading_deg: Math.round(bearingDeg(best.wp, survivor)),
      detour_km: +(best.km - directKm).toFixed(1),
    },
    distance_km: +best.km.toFixed(1),
    eta_min: eta(best.km),
    blocked_by: direct.map(hazardLabel),
  };
}

/**
 * @param {object} p
 * @param {{lat:number, lon:number}} p.survivor
 * @param {object} p.context  geo slice (hazards, hospitals, assets, weather)
 * @param {string} p.category triage category
 */
export function deconflict({ survivor, context, category }) {
  const hazards = context?.hazards || [];
  const insideNow = hazards.filter((h) => pointInPolygon(survivor, h.polygon));
  const considered = hazards.filter((h) => !insideNow.includes(h));

  // People travel by GROUND or HELI; DRONE moves supplies only.
  const wantSupply = category === 'SUPPLY_DROP';
  const modes = wantSupply ? ['DRONE', 'HELI'] : ['GROUND', 'HELI'];

  const options = [];
  for (const asset of (context?.assets || []).filter((a) => a.available !== false && modes.includes(a.kind))) {
    const wx = weatherBlock(asset.kind, context?.weather);
    const blockers = considered.filter((h) => h.blocks.includes(asset.kind));
    if (wx) {
      options.push({ mode: asset.kind, asset, feasible: false, approach: null, distance_km: +haversineKm(asset, survivor).toFixed(1), eta_min: null, blocked_by: [`WEATHER: ${wx}`] });
      continue;
    }
    options.push({ mode: asset.kind, asset, ...planLeg(asset, survivor, blockers, asset.kind) });
  }

  const feasible = options.filter((o) => o.feasible);
  // Preferred mode first for supply drops (drone), else fastest wins.
  feasible.sort((a, b) => (wantSupply ? modes.indexOf(a.mode) - modes.indexOf(b.mode) : 0) || a.eta_min - b.eta_min);
  const recommended = feasible[0] || null;

  // Casualty transport leg to a receiving facility, tested for the chosen mode.
  let evac = null;
  if (!wantSupply && recommended) {
    const blockers = considered.filter((h) => h.blocks.includes(recommended.mode));
    const open = (context?.hospitals || []).filter((h) => !['DAMAGED', 'CLOSED'].includes(h.status));
    for (const h of open) {
      const hit = legBlockers(survivor, h, blockers);
      if (!hit.length) {
        const km = haversineKm(survivor, h);
        evac = { hospital: h, distance_km: +km.toFixed(1), blocked: false, blocked_by: [] };
        break;
      }
      evac ||= { hospital: h, distance_km: +haversineKm(survivor, h).toFixed(1), blocked: true, blocked_by: hit.map(hazardLabel) };
    }
  }

  const relevantModes = recommended ? [recommended.mode] : modes;
  const avoid = considered.filter((h) => h.blocks.some((m) => relevantModes.includes(m))).slice(0, 4).map(hazardLabel);

  return {
    options: options.sort((a, b) => Number(b.feasible) - Number(a.feasible) || (a.eta_min ?? 1e9) - (b.eta_min ?? 1e9)),
    recommended,
    evac,
    avoid,
    survivor_inside: insideNow.map(hazardLabel),
  };
}

/** Route plan text for the triage schema field `deconflicted_route_plan`. */
export function planText(d, { category }) {
  const parts = [];
  const r = d.recommended;
  if (!r) {
    const blocked = d.options.length ? d.options.map((o) => `${o.mode} ${o.asset.name}: ${o.blocked_by.join(', ') || 'no safe vector'}`).join(' | ') : 'no available rescue asset in the registry';
    parts.push(`NO SAFE VECTOR (${blocked}). Hold and request hazard clearance.`);
  } else {
    parts.push(`${r.mode} via ${r.asset.name} (ETA ${r.eta_min} min, ${r.distance_km} km).`);
    if (r.approach.kind === 'DIRECT') {
      parts.push(`Direct vector clear, inbound HDG ${pad3(r.approach.heading_deg)} (${compass(r.approach.heading_deg)}).`);
    } else {
      const w = r.approach.waypoint;
      parts.push(`Direct vector BLOCKED (${r.blocked_by.join('; ')}). Fly/drive via waypoint ${w.standoff_km} km ${compass(w.bearing_from_survivor)} of survivor (+${r.approach.detour_km} km), final HDG ${pad3(r.approach.heading_deg)} (${compass(r.approach.heading_deg)}).`);
    }
    if (d.evac) {
      parts.push(d.evac.blocked
        ? `Evac leg to ${d.evac.hospital.name} (${d.evac.distance_km} km) crosses ${d.evac.blocked_by.join('; ')}; re-plan.`
        : `Evac to ${d.evac.hospital.name} (${d.evac.distance_km} km${d.evac.hospital.status === 'UNVERIFIED' ? ', status UNVERIFIED' : ''}).`);
    } else if (category !== 'SUPPLY_DROP') {
      parts.push('No operational receiving facility in the 25 km slice.');
    }
  }
  if (d.avoid.length) parts.push(`AVOID ${d.avoid.join('; ')}.`);
  if (d.survivor_inside.length) parts.push(`SURVIVOR INSIDE ${d.survivor_inside.join('; ')}: dispatcher risk decision required.`);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 600 ? text.slice(0, 597) + '...' : text;
}

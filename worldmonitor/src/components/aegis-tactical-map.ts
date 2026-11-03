// AGPL-3.0: this file is part of the AegisMonitor extension to WorldMonitor (github.com/koala73/worldmonitor)
// and, as a derivative of that AGPL-3.0 work, is licensed AGPL-3.0. It talks to aegis-core-service
// over REST/WebSocket only. See worldmonitor/VENDORED.md.
// Tactical map for one AegisMonitor incident: the survivor, 5/10/25 km range rings,
// hazard polygons coloured by kind, hospitals, rescue assets, every route option and
// the recommended vector (with its dogleg waypoint when the direct leg is blocked).
//
// Pure: incident in, SafeHtml out. No DOM access, so it is unit-testable. All
// interpolated text goes through safeHtml, which escapes it.

import { joinSafeHtml, safeHtml, type SafeHtml } from '@/utils/sanitize';
import type { AegisIncidentFull, AegisIncidentSummary } from '@/services/aegis-cad';

export const AEGIS_PRIORITY_COLOR: Record<number, string> = { 1: '#ff2f43', 2: '#ff7a1a', 3: '#ffb020', 4: '#38d9c0', 5: '#7aa2ff' };
export const AEGIS_HAZARD_COLOR: Record<string, string> = {
  CONFLICT: '#ff3b4d',
  AIRSPACE: '#a57bff',
  FLOOD: '#3b9cff',
  INFRASTRUCTURE: '#ff8a3b',
  WILDFIRE: '#ffc43b',
  SEISMIC: '#9aa6b2',
};

const W = 400;
const H = 300;
const KM_PX = 5.1; // 25 km ring fills ~130 px of the 300 px height at zoom 1

export function projector(center: { lat: number; lon: number }, zoom = 1) {
  const k = KM_PX * zoom;
  const cos = Math.cos((center.lat * Math.PI) / 180);
  return (lat: number, lon: number): [number, number] => [W / 2 + (lon - center.lon) * 111.32 * cos * k, H / 2 - (lat - center.lat) * 110.57 * k];
}

const fmt = (n: number): string => n.toFixed(1);

function polygonPoints(project: ReturnType<typeof projector>, poly: Array<[number, number]>): string {
  return poly.map(([lat, lon]) => project(lat, lon).map(fmt).join(',')).join(' ');
}

export function renderTacticalMap(inc: AegisIncidentFull, others: AegisIncidentSummary[] = [], zoom = 1): SafeHtml {
  const c = inc.position;
  const project = projector(c, zoom);
  const [sx, sy] = project(c.lat, c.lon);
  const k = KM_PX * zoom;
  const ctx = inc.context;
  const d = inc.deconfliction;
  const parts: SafeHtml[] = [];

  for (const km of [5, 10, 25]) {
    parts.push(safeHtml`<circle cx="${fmt(sx)}" cy="${fmt(sy)}" r="${fmt(km * k)}" fill="none" stroke="${km === 25 ? '#2a4258' : '#18293a'}" stroke-dasharray="${km === 25 ? '' : '3 4'}"/><text x="${fmt(sx + 3)}" y="${fmt(sy - km * k - 2)}" fill="#4d6073" font-size="7">${km} km</text>`);
  }

  for (const h of ctx?.hazards ?? []) {
    const col = AEGIS_HAZARD_COLOR[h.kind] ?? '#999999';
    const [hx, hy] = project(h.center.lat, h.center.lon);
    parts.push(safeHtml`<polygon points="${polygonPoints(project, h.polygon)}" fill="${col}2a" stroke="${col}" stroke-width="1" stroke-dasharray="${h.severity === 'HIGH' ? '' : '3 2'}"><title>${h.kind} ${h.severity}: ${h.label} (blocks ${h.blocks.join(', ') || 'nothing'})</title></polygon><text x="${fmt(hx)}" y="${fmt(hy + 2)}" fill="${col}" font-size="6.5" text-anchor="middle" font-weight="700">${h.kind.slice(0, 4)}</text>`);
  }

  for (const o of d?.options ?? []) {
    const [ax, ay] = project(o.asset.lat, o.asset.lon);
    const rec = d?.recommended?.asset.id === o.asset.id;
    const stroke = rec ? '#38d9a0' : '#2c6a5a';
    const width = rec ? 2 : 1.1;
    if (o.feasible && o.approach?.kind === 'DOGLEG' && o.approach.waypoint) {
      const [wx, wy] = project(o.approach.waypoint.lat, o.approach.waypoint.lon);
      parts.push(safeHtml`<polyline points="${fmt(ax)},${fmt(ay)} ${fmt(wx)},${fmt(wy)} ${fmt(sx)},${fmt(sy)}" fill="none" stroke="${stroke}" stroke-width="${width}"/><circle cx="${fmt(wx)}" cy="${fmt(wy)}" r="2.6" fill="#070b10" stroke="#38d9a0"/><line x1="${fmt(ax)}" y1="${fmt(ay)}" x2="${fmt(sx)}" y2="${fmt(sy)}" stroke="#ff5a6b" stroke-dasharray="2 4" opacity=".5"/>`);
    } else if (o.feasible) {
      parts.push(safeHtml`<line x1="${fmt(ax)}" y1="${fmt(ay)}" x2="${fmt(sx)}" y2="${fmt(sy)}" stroke="${stroke}" stroke-width="${width}"/>`);
    } else {
      parts.push(safeHtml`<line x1="${fmt(ax)}" y1="${fmt(ay)}" x2="${fmt(sx)}" y2="${fmt(sy)}" stroke="#ff5a6b" stroke-dasharray="2 4" opacity=".5"/>`);
    }
  }

  if (d?.evac) {
    const [hx, hy] = project(d.evac.hospital.lat, d.evac.hospital.lon);
    parts.push(safeHtml`<line x1="${fmt(sx)}" y1="${fmt(sy)}" x2="${fmt(hx)}" y2="${fmt(hy)}" stroke="${d.evac.blocked ? '#ff5a6b' : '#38d9c0'}" stroke-dasharray="5 3" opacity=".8"/>`);
  }

  for (const h of ctx?.hospitals ?? []) {
    const [x, y] = project(h.lat, h.lon);
    const dead = h.status === 'DAMAGED' || h.status === 'CLOSED';
    const col = dead ? '#6b7a88' : '#4aa8ff';
    parts.push(safeHtml`<g><title>${h.name} · ${h.status}</title><rect x="${fmt(x - 4)}" y="${fmt(y - 4)}" width="8" height="8" rx="1.5" fill="none" stroke="${col}"/><path d="M${fmt(x - 2)},${fmt(y)} H${fmt(x + 2)} M${fmt(x)},${fmt(y - 2)} V${fmt(y + 2)}" stroke="${col}" stroke-width="1.2"/></g>`);
  }

  for (const a of ctx?.assets ?? []) {
    const [x, y] = project(a.lat, a.lon);
    const assigned = inc.assigned_unit?.id === a.id;
    const fill = assigned ? '#38d9a0' : '#0b1118';
    const shape = a.kind === 'HELI'
      ? safeHtml`<path d="M${fmt(x)},${fmt(y - 5)} L${fmt(x + 5)},${fmt(y + 4)} L${fmt(x - 5)},${fmt(y + 4)} z"/>`
      : a.kind === 'DRONE'
        ? safeHtml`<path d="M${fmt(x)},${fmt(y - 5)} L${fmt(x + 5)},${fmt(y)} L${fmt(x)},${fmt(y + 5)} L${fmt(x - 5)},${fmt(y)} z"/>`
        : safeHtml`<rect x="${fmt(x - 4)}" y="${fmt(y - 4)}" width="8" height="8"/>`;
    parts.push(safeHtml`<g fill="${fill}" stroke="${assigned ? '#38d9a0' : '#e4edf6'}" stroke-width="1.1"><title>${a.name} (${a.kind})</title>${shape}</g>`);
  }

  for (const o of others) {
    if (o.id === inc.id || !o.queue_rank) continue;
    const [x, y] = project(o.position.lat, o.position.lon);
    if (x < -10 || x > W + 10 || y < -10 || y > H + 10) continue;
    const col = AEGIS_PRIORITY_COLOR[o.priority_level ?? 3] ?? '#999999';
    parts.push(safeHtml`<circle data-aegis-incident="${o.id}" cx="${fmt(x)}" cy="${fmt(y)}" r="3.5" fill="${col}55" stroke="${col}" style="cursor:pointer"><title>${o.device_label} P${o.priority_level ?? '?'}</title></circle>`);
  }

  const col = AEGIS_PRIORITY_COLOR[inc.triage?.priority_level ?? 3] ?? '#38d9a0';
  parts.push(safeHtml`<circle cx="${fmt(sx)}" cy="${fmt(sy)}" r="5" fill="${col}"/><text x="${fmt(sx + 8)}" y="${fmt(sy - 6)}" fill="#ffffff" font-size="8" font-weight="700">${inc.device_label}</text>`);

  return safeHtml`<svg class="aegis-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tactical map: ${inc.device_label} and its 25 km context"><rect width="${W}" height="${H}" fill="#070b10"/>${joinSafeHtml(parts)}</svg>`;
}

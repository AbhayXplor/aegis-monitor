// AGPL-3.0: this file is part of the AegisMonitor extension to WorldMonitor (github.com/koala73/worldmonitor)
// and, as a derivative of that AGPL-3.0 work, is licensed AGPL-3.0. It talks to aegis-core-service
// over REST/WebSocket only. See worldmonitor/VENDORED.md.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { AEGIS_HAZARD_COLOR, AEGIS_PRIORITY_COLOR, projector, renderTacticalMap } from '../src/components/aegis-tactical-map.ts';
import { AegisAuthError, AegisCadClient } from '../src/services/aegis-cad.ts';
import type { AegisIncidentFull, AegisIncidentSummary } from '../src/services/aegis-cad.ts';

const ring = (lat: number, lon: number, r: number): Array<[number, number]> =>
  Array.from({ length: 8 }, (_, i) => [lat + (r / 111) * Math.sin((i * Math.PI) / 4), lon + (r / 111) * Math.cos((i * Math.PI) / 4)] as [number, number]);

const asset = (id: string, kind: 'GROUND' | 'HELI' | 'DRONE', lat: number, lon: number) => ({ id, name: `${kind} ${id}`, kind, lat, lon });

function incident(over: Partial<AegisIncidentFull> = {}): AegisIncidentFull {
  const heli = asset('H1', 'HELI', 25.3, 55.0);
  const gnd = asset('G1', 'GROUND', 25.1, 55.4);
  return {
    id: 'INC-0001', device_id: 1, device_label: 'ALPHA-1', state: 'AI_TRIAGED', received_at: '', updated_at: '',
    position: { lat: 25.2, lon: 55.27, altitude_m: 10 },
    vitals: { heart_rate: 118, spo2: 91, battery_pct: 40, duress_flag: false },
    source: 'DEV', packets: 1, age_s: 0, priority_level: 2, category: 'MEDEVAC', queue_rank: 1, deteriorating: false, covert: false,
    battery: { eta_min: 100, model: 'assumed' }, assigned_unit: null, cancel_request: null, reply: null,
    silent_mode: false,
    triage: { incident_id: 'INC-0001', priority_level: 2, triage_category: 'MEDEVAC', physiological_status: '', hazard_assessment: '', deconflicted_route_plan: '', dispatcher_checklist: [], user_satellite_reply: '' },
    context: {
      mode: 'demo', radius_km: 25, coverage: {},
      hazards: [{ kind: 'FLOOD', severity: 'HIGH', label: 'Standing water', radius_km: 2, distance_km: 5, center: { lat: 25.22, lon: 55.3 }, polygon: ring(25.22, 55.3, 2), blocks: ['GROUND'] }],
      hospitals: [{ id: 'X', name: 'Mercy', lat: 25.25, lon: 55.3, status: 'OPERATIONAL' }, { id: 'Y', name: 'Ruin', lat: 25.15, lon: 55.2, status: 'DAMAGED' }],
      assets: [heli, gnd],
    },
    deconfliction: {
      options: [
        { mode: 'HELI', asset: heli, feasible: true, eta_min: 17, distance_km: 22, blocked_by: [], approach: { kind: 'DIRECT', heading_deg: 120 } },
        { mode: 'GROUND', asset: gnd, feasible: true, eta_min: 40, distance_km: 18, blocked_by: ['FLOOD: Standing water'], approach: { kind: 'DOGLEG', heading_deg: 270, detour_km: 2.1, waypoint: { lat: 25.15, lon: 55.3, standoff_km: 6 } } },
      ],
      recommended: null, evac: { hospital: { id: 'X', name: 'Mercy', lat: 25.25, lon: 55.3, status: 'OPERATIONAL' }, blocked: false }, survivor_inside: [],
    },
    history: [], audit: [],
    ...over,
  } as AegisIncidentFull;
}

describe('aegis tactical map', () => {
  it('puts the survivor at the centre with north up and a 25 km ring of the right size', () => {
    const p = projector({ lat: 25.2, lon: 55.27 });
    assert.deepEqual(p(25.2, 55.27).map(Math.round), [200, 150]);
    const [, yN] = p(25.3, 55.27);
    assert.ok(yN < 150, 'north is up');
    const [xE] = p(25.2, 55.37);
    assert.ok(xE > 200, 'east is right');
    const svg = renderTacticalMap(incident()).toString();
    const r25 = Number(svg.match(/r="([\d.]+)" fill="none" stroke="#2a4258"/)?.[1]);
    assert.ok(Math.abs(r25 - 25 * 5.1) < 0.2, `25 km ring radius ${r25}`);
    for (const km of ['5 km', '10 km', '25 km']) assert.ok(svg.includes(km));
  });

  it('draws every hazard polygon in its kind colour, with the modes it blocks in the tooltip', () => {
    const svg = renderTacticalMap(incident()).toString();
    assert.match(svg, new RegExp(`<polygon points="[^"]+" fill="${AEGIS_HAZARD_COLOR.FLOOD}2a" stroke="${AEGIS_HAZARD_COLOR.FLOOD}"`));
    assert.match(svg, /FLOOD HIGH: Standing water \(blocks GROUND\)/);
  });

  it('draws a dogleg as a polyline through its waypoint, and a blocked direct leg dashed red', () => {
    const svg = renderTacticalMap(incident()).toString();
    assert.match(svg, /<polyline points="[\d., -]+"/);
    assert.match(svg, /stroke="#ff5a6b" stroke-dasharray="2 4"/);
  });

  it('marks an infeasible option as a blocked leg only', () => {
    const inc = incident();
    inc.deconfliction!.options[0]!.feasible = false;
    const svg = renderTacticalMap(inc).toString();
    assert.ok(!svg.includes('<line x1') || !/<line [^>]*stroke="#38d9a0" stroke-width="2"/.test(svg), 'an infeasible recommended option is never drawn as a usable green route');
    assert.match(svg, /<line [^>]*stroke="#ff5a6b" stroke-dasharray="2 4" opacity="\.5"/);
  });

  it('shows damaged hospitals greyed, and the assigned unit filled', () => {
    const svg = renderTacticalMap(incident({ assigned_unit: { id: 'H1', name: 'HELI H1', kind: 'HELI' } })).toString();
    assert.ok(svg.includes('stroke="#6b7a88"'));
    assert.ok(svg.includes('<g fill="#38d9a0" stroke="#38d9a0"'));
  });

  it('shows other open incidents as clickable pins coloured by priority, and skips closed ones', () => {
    const others = [
      { ...incident(), id: 'INC-0002', device_label: 'BRAVO', priority_level: 1, queue_rank: 2, position: { lat: 25.21, lon: 55.28, altitude_m: 0 } },
      { ...incident(), id: 'INC-0003', device_label: 'GONE', priority_level: 3, queue_rank: null, position: { lat: 25.21, lon: 55.26, altitude_m: 0 } },
    ] as AegisIncidentSummary[];
    const svg = renderTacticalMap(incident(), others).toString();
    assert.ok(svg.includes('data-aegis-incident="INC-0002"'));
    assert.ok(svg.includes(`stroke="${AEGIS_PRIORITY_COLOR[1]}"`));
    assert.ok(!svg.includes('INC-0003'));
  });

  it('renders with no context, no hazards and no assets without throwing', () => {
    const svg = renderTacticalMap(incident({ context: null, deconfliction: null })).toString();
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('ALPHA-1'));
  });

  it('cannot be used to inject markup through device labels, hazard labels or asset names', () => {
    const evil = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const inc = incident({ device_label: evil });
    inc.context!.hazards[0]!.label = evil;
    inc.context!.hospitals[0]!.name = evil;
    inc.context!.assets[0]!.name = evil;
    inc.deconfliction!.options[0]!.asset.name = evil;
    const svg = renderTacticalMap(inc, [{ ...incident(), id: 'INC-9', device_label: evil, queue_rank: 3 } as AegisIncidentSummary]).toString();
    assert.ok(!svg.includes('<script'), 'no script element');
    assert.ok(!/<img/i.test(svg), 'no img element');
    assert.ok(svg.includes('aria-label="Tactical map: &quot;&gt;&lt;script&gt;'), 'a quote in a label cannot break out of the aria-label attribute');
    assert.ok(svg.includes('&lt;script&gt;'), 'text is escaped');
  });
});

describe('aegis client', () => {
  const realFetch = globalThis.fetch;
  const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
  });

  const mockFetch = (status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []) => {
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return calls;
  };

  it('lists incidents from the configured base, trimming trailing slashes', async () => {
    const calls = mockFetch(200, { incidents: [{ id: 'INC-0001' }] });
    const list = await new AegisCadClient('http://core.example:3001//').listIncidents();
    assert.equal(list[0]?.id, 'INC-0001');
    assert.equal(calls[0]?.url, 'http://core.example:3001/api/v1/incidents');
  });

  it('sends the dispatcher token as a bearer header, and an auth failure is a typed error', async () => {
    const calls = mockFetch(200, { incidents: [] });
    const c = new AegisCadClient('http://x');
    c.setToken('tok');
    await c.listIncidents();
    assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, 'Bearer tok');
    mockFetch(401, { error: 'dispatcher token required' });
    await assert.rejects(new AegisCadClient('http://x').listIncidents(), AegisAuthError);
  });

  it('posts transitions and downlinks as JSON, and url-encodes the incident id', async () => {
    const calls = mockFetch(200, {});
    const c = new AegisCadClient('http://x');
    await c.transition('INC-0001', 'UNIT_ASSIGNED');
    await c.downlink('INC/../0002', 'HAPTIC_ACK_ONLY');
    await c.resolveCancel('INC-0001', true);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { to: 'UNIT_ASSIGNED', actor: 'dispatcher', reason: 'WorldMonitor CAD panel' });
    assert.ok(calls[1]?.url.endsWith('/incidents/INC%2F..%2F0002/downlink'));
    assert.equal(JSON.parse(String(calls[1]?.init.body)).text, 'HAPTIC_ACK_ONLY');
    assert.equal(JSON.parse(String(calls[2]?.init.body)).accept, true);
  });

  it('surfaces the server error message for refused actions (e.g. covert downlink)', async () => {
    mockFetch(409, { error: 'covert incident (duress or silent mode): only HAPTIC_ACK_ONLY may be downlinked' });
    await assert.rejects(new AegisCadClient('http://x').downlink('INC-0001', 'hello'), /only HAPTIC_ACK_ONLY/);
  });

  it('opens the event stream on ws://, carries the token, and ignores malformed frames', () => {
    const made: Array<{ url: string; ws: Record<string, unknown> }> = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
      constructor(public url: string) { made.push({ url, ws: this as unknown as Record<string, unknown> }); }
      close() { this.onclose?.(); }
    };
    const events: unknown[] = [];
    const states: string[] = [];
    const c = new AegisCadClient('https://core.example');
    c.setToken('a b');
    c.connect((e) => events.push(e), (s) => states.push(s));
    assert.equal(made[0]?.url, 'wss://core.example/ws?token=a%20b');
    (made[0]!.ws.onopen as () => void)();
    (made[0]!.ws.onmessage as (e: { data: string }) => void)({ data: '{not json' });
    (made[0]!.ws.onmessage as (e: { data: string }) => void)({ data: JSON.stringify({ type: 'INCIDENT_CREATED' }) });
    assert.deepEqual(states, ['connecting', 'live']);
    assert.deepEqual(events, [{ type: 'INCIDENT_CREATED' }]);
    c.close();
    assert.equal(states.at(-1), 'live', 'an intentional close does not report offline or reconnect');
  });
});

// AGPL-3.0: this file is part of the AegisMonitor extension to WorldMonitor (github.com/koala73/worldmonitor)
// and, as a derivative of that AGPL-3.0 work, is licensed AGPL-3.0. It talks to aegis-core-service
// over REST/WebSocket only. See worldmonitor/VENDORED.md.
// Client for aegis-core-service, the AegisMonitor rescue-dispatch backend.
//
// AGPL decoupling: this file is the ONLY integration surface between WorldMonitor and
// the proprietary-side core service, and it speaks documented REST + WebSocket only
// (contracts/openapi.yaml in the AegisMonitor repo). No core-service code is imported.
//
// Defaults to http://127.0.0.1:3001; override at build time with VITE_AEGIS_URL.
// The dispatcher token (when the core service requires one) is held in memory only:
// it is never written to localStorage and never baked into the bundle.

export interface AegisVitals {
  heart_rate: number;
  spo2: number;
  battery_pct: number;
  duress_flag: boolean;
}

export interface AegisUnitRef {
  id: string;
  name: string;
  kind: 'GROUND' | 'HELI' | 'DRONE';
}

export interface AegisIncidentSummary {
  id: string;
  device_id: number;
  device_label: string;
  state: string;
  received_at: string;
  updated_at: string;
  position: { lat: number; lon: number; altitude_m: number };
  vitals: AegisVitals;
  source: string;
  packets: number;
  age_s: number;
  priority_level: number | null;
  category: string | null;
  queue_rank: number | null;
  deteriorating: boolean;
  covert: boolean;
  battery: { eta_min: number | null; model: string };
  assigned_unit: AegisUnitRef | null;
  cancel_request: { pending: boolean; possibly_coerced: boolean } | null;
  reply: string | null;
}

export interface AegisHazard {
  kind: string;
  severity: string;
  label: string;
  radius_km: number;
  distance_km: number;
  polygon: Array<[number, number]>;
  center: { lat: number; lon: number };
  blocks: string[];
}

export interface AegisAsset {
  id: string;
  name: string;
  kind: 'GROUND' | 'HELI' | 'DRONE';
  lat: number;
  lon: number;
}

export interface AegisHospital {
  id: string;
  name: string;
  lat: number;
  lon: number;
  status: string;
}

export interface AegisRouteOption {
  mode: string;
  asset: AegisAsset;
  feasible: boolean;
  eta_min: number | null;
  distance_km: number;
  blocked_by: string[];
  approach: null | {
    kind: 'DIRECT' | 'DOGLEG';
    heading_deg: number;
    detour_km?: number;
    waypoint?: { lat: number; lon: number; standoff_km: number };
  };
}

export interface AegisTriage {
  incident_id: string;
  priority_level: number;
  triage_category: string;
  physiological_status: string;
  hazard_assessment: string;
  deconflicted_route_plan: string;
  dispatcher_checklist: string[];
  user_satellite_reply: string;
}

export interface AegisIncidentFull extends AegisIncidentSummary {
  triage: AegisTriage;
  silent_mode: boolean;
  context: {
    mode: string;
    radius_km: number;
    hazards: AegisHazard[];
    hospitals: AegisHospital[];
    assets: AegisAsset[];
    coverage: Record<string, string>;
  } | null;
  deconfliction: {
    options: AegisRouteOption[];
    recommended: AegisRouteOption | null;
    evac: { hospital: AegisHospital; blocked: boolean } | null;
    survivor_inside: string[];
  } | null;
  history: Array<{ ts: number; heart_rate: number; spo2: number; battery_pct: number }>;
  audit: Array<{ from: string | null; to: string; actor: string; reason: string; at: string }>;
}

export type AegisEvent = { type: string; incident_id?: string; [k: string]: unknown };
export type AegisLinkState = 'connecting' | 'live' | 'offline' | 'auth';

function envUrl(): string {
  const v = (import.meta as { env?: Record<string, unknown> }).env?.VITE_AEGIS_URL;
  return typeof v === 'string' && v ? v : 'http://127.0.0.1:3001';
}

export class AegisCadClient {
  private readonly base: string;
  private token = '';
  private ws: WebSocket | null = null;
  private retry = 1000;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(base: string = envUrl()) {
    this.base = base.replace(/\/+$/, '');
  }

  public setToken(token: string): void {
    this.token = token;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401) throw new AegisAuthError(data.error ?? 'dispatcher token required');
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  public async listIncidents(): Promise<AegisIncidentSummary[]> {
    return (await this.call<{ incidents: AegisIncidentSummary[] }>('/api/v1/incidents')).incidents;
  }

  public getIncident(id: string): Promise<AegisIncidentFull> {
    return this.call<AegisIncidentFull>(`/api/v1/incidents/${encodeURIComponent(id)}`);
  }

  public transition(id: string, to: string, unit?: string): Promise<unknown> {
    return this.call(`/api/v1/incidents/${encodeURIComponent(id)}/transition`, { to, actor: 'dispatcher', reason: 'WorldMonitor CAD panel', unit });
  }

  public downlink(id: string, text: string): Promise<unknown> {
    return this.call(`/api/v1/incidents/${encodeURIComponent(id)}/downlink`, { text, actor: 'dispatcher' });
  }

  public resolveCancel(id: string, accept: boolean): Promise<unknown> {
    return this.call(`/api/v1/incidents/${encodeURIComponent(id)}/cancel`, { accept, actor: 'dispatcher', reason: accept ? 'confirmed in CAD panel' : 'rejected: verify off-air' });
  }

  /** Open the event stream; reconnects with backoff until close(). */
  public connect(onEvent: (e: AegisEvent) => void, onState: (s: AegisLinkState) => void): void {
    this.closed = false;
    onState('connecting');
    const url = `${this.base.replace(/^http/, 'ws')}/ws${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      onState('offline');
      this.scheduleReconnect(onEvent, onState);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      onState('live');
    };
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)) as AegisEvent);
      } catch {
        /* a malformed frame must not take the panel down */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      onState('offline');
      this.scheduleReconnect(onEvent, onState);
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(onEvent: (e: AegisEvent) => void, onState: (s: AegisLinkState) => void): void {
    if (this.closed) return;
    this.timer = setTimeout(() => this.connect(onEvent, onState), this.retry);
    this.retry = Math.min(15000, this.retry * 2);
  }

  public close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}

export class AegisAuthError extends Error {}

// AGPL-3.0: this file is part of the AegisMonitor extension to WorldMonitor (github.com/koala73/worldmonitor)
// and, as a derivative of that AGPL-3.0 work, is licensed AGPL-3.0. It talks to aegis-core-service
// over REST/WebSocket only. See worldmonitor/VENDORED.md.
// AegisMonitor CAD workspace, as a WorldMonitor panel.
//
// Turns the passive dashboard into an active dispatch surface for the aegis-core-service
// backend (REST + WebSocket only, see services/aegis-cad.ts): a re-ranking incident
// queue, live vitals, a tactical map with the 25 km hazard rings and the deconflicted
// vector, one-click state transitions, and satellite downlink that obeys the covert lock.
//
// The panel flies WorldMonitor's own map to an incident when its row is clicked.

import { Panel } from './Panel';
import { renderTacticalMap, AEGIS_PRIORITY_COLOR } from './aegis-tactical-map';
import { AegisAuthError, AegisCadClient, type AegisEvent, type AegisIncidentFull, type AegisIncidentSummary, type AegisLinkState } from '@/services/aegis-cad';
import { joinSafeHtml, safeHtml, type SafeHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';

const QUICK_REPLIES = ['STAY STILL. HELP IS ON THE WAY.', 'KEEP BEACON ON. SAVE BATTERY.', 'MOVE TO COVER. STAY QUIET.', 'SIP WATER. REST IN SHADE.'];
const HAPTIC_ONLY = 'HAPTIC_ACK_ONLY';

const ageText = (s: number): string => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const etaText = (m: number | null): string => (m == null ? '—' : m > 180 ? `${(m / 60).toFixed(1)} h` : `${m} min`);

export class AegisCadPanel extends Panel {
  private readonly client: AegisCadClient;
  private incidents: AegisIncidentSummary[] = [];
  private full: AegisIncidentFull | null = null;
  private selected: string | null = null;
  private link: AegisLinkState = 'connecting';
  private notice = '';
  private needsToken = false;
  private readonly drafts = new Map<string, string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private onLocate?: (lat: number, lon: number) => void;

  constructor(client: AegisCadClient = new AegisCadClient()) {
    super({
      id: 'aegis-cad',
      title: 'Aegis CAD',
      showCount: true,
      trackActivity: false,
      defaultRowSpan: 3,
      infoTooltip: 'Satellite rescue dispatch (AegisMonitor core service). Synthetic data in demo mode.',
    });
    this.client = client;
    this.showLoading('Connecting to aegis-core-service…');

    // One delegated listener set on the stable content node: setSafeContent debounces the
    // DOM write, so per-element binding after render would race the flush.
    this.content.addEventListener('click', (e) => void this.onClick(e));
    this.content.addEventListener('input', (e) => {
      const ta = e.target as HTMLTextAreaElement | null;
      if (ta?.matches?.('textarea[data-aegis-draft]') && this.selected) this.drafts.set(this.selected, ta.value);
    });
    this.content.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.matches?.('input[data-aegis-token]')) {
        this.client.setToken(el.value.trim());
        this.needsToken = false;
        this.restart();
      }
    });
    bindActivationKeys(this.content, '[data-aegis-select]');

    this.start();
  }

  public setLocateHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocate = handler;
  }

  public hasData(): boolean {
    return this.incidents.length > 0 || this.link === 'live';
  }

  public override destroy(): void {
    this.client.close();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    super.destroy();
  }

  /* ---------------- data ---------------- */

  private start(): void {
    this.client.connect((e) => this.onEvent(e), (s) => {
      this.link = s;
      if (s === 'live') void this.refresh();
      else this.render();
    });
    void this.refresh();
  }

  private restart(): void {
    this.client.close();
    this.start();
  }

  private onEvent(e: AegisEvent): void {
    if (e.type === 'INCIDENT_RERANKED') {
      const changes = (e.changes ?? []) as Array<{ incident_id: string; from_priority: number; to_priority: number }>;
      this.notice = `Re-ranked: ${changes.map((c) => `${c.incident_id} P${c.from_priority}→P${c.to_priority}`).join(', ')}`;
    } else if (e.type === 'INCIDENT_CANCEL_REQUEST') {
      this.notice = `Cancel requested on ${e.incident_id ?? 'an incident'}${e.possibly_coerced ? ' (possibly coerced)' : ''}`;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 150);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.incidents = await this.client.listIncidents();
      if (this.selected && !this.incidents.some((i) => i.id === this.selected)) this.selected = null;
      this.selected ??= this.incidents.find((i) => i.queue_rank)?.id ?? this.incidents[0]?.id ?? null;
      this.full = this.selected ? await this.client.getIncident(this.selected) : null;
      this.needsToken = false;
      this.setCount(this.incidents.filter((i) => i.queue_rank).length);
    } catch (err) {
      this.needsToken = err instanceof AegisAuthError;
      if (!this.needsToken && this.link === 'live') this.notice = err instanceof Error ? err.message : 'request failed';
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  private async act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    try {
      await fn();
      this.notice = ok;
    } catch (err) {
      this.notice = `Refused: ${err instanceof Error ? err.message : 'failed'}`;
    }
    await this.refresh();
  }

  /* ---------------- events ---------------- */

  private async onClick(e: Event): Promise<void> {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-aegis-select],[data-aegis-incident],[data-aegis-to],[data-aegis-quick],[data-aegis-send],[data-aegis-cancel]');
    if (!el || !this.content.contains(el)) return;
    const id = el.dataset.aegisSelect ?? el.dataset.aegisIncident;
    if (id) {
      this.selected = id;
      this.full = await this.client.getIncident(id).catch(() => null);
      const inc = this.incidents.find((i) => i.id === id);
      if (inc) this.onLocate?.(inc.position.lat, inc.position.lon);
      this.render();
      return;
    }
    const cur = this.full;
    if (!cur) return;
    if (el.dataset.aegisTo) {
      const to = el.dataset.aegisTo;
      await this.act(() => this.client.transition(cur.id, to), `${cur.id} → ${to}`);
    } else if (el.dataset.aegisQuick) {
      const text = el.dataset.aegisQuick;
      await this.act(() => this.client.downlink(cur.id, text), `Downlink queued (${text.length} chars)`);
    } else if (el.dataset.aegisSend !== undefined) {
      const text = this.drafts.get(cur.id) ?? cur.triage?.user_satellite_reply ?? '';
      await this.act(async () => { await this.client.downlink(cur.id, text); this.drafts.delete(cur.id); }, `Downlink queued (${text.length} chars)`);
    } else if (el.dataset.aegisCancel !== undefined) {
      const accept = el.dataset.aegisCancel === '1';
      await this.act(() => this.client.resolveCancel(cur.id, accept), accept ? 'Cancel confirmed, incident closed' : 'Cancel rejected, incident stays open');
    }
  }

  /* ---------------- render ---------------- */

  private render(): void {
    if (this.link !== 'live' && this.incidents.length === 0) {
      const msg = this.needsToken
        ? safeHtml`<div class="panel-empty"><p>The core service requires a dispatcher token.</p><input data-aegis-token type="password" placeholder="dispatcher token" autocomplete="off"/></div>`
        : safeHtml`<div class="panel-empty">Not connected to aegis-core-service (${this.link}). Start it with <code>npm start</code> in the AegisMonitor repo. It retries automatically.</div>`;
      this.setSafeContent(msg);
      return;
    }
    const head = safeHtml`<div class="aegis-bar"><span class="aegis-link aegis-${this.link}">${this.link === 'live' ? '● LIVE' : '○ ' + this.link.toUpperCase()}</span><span class="aegis-notice">${this.notice}</span></div>`;
    const list = this.incidents.length
      ? joinSafeHtml(this.incidents.map((i) => this.row(i)))
      : safeHtml`<div class="panel-empty">No incidents.</div>`;
    const detail = this.full ? this.detail(this.full) : safeHtml``;
    this.setSafeContent(safeHtml`${head}<div class="aegis-list">${list}</div>${detail}`);
  }

  private row(i: AegisIncidentSummary): SafeHtml {
    const col = AEGIS_PRIORITY_COLOR[i.priority_level ?? 3] ?? '#999999';
    const sel = i.id === this.selected;
    const v = i.vitals;
    return safeHtml`<div class="aegis-row${sel ? ' aegis-sel' : ''}${i.queue_rank ? '' : ' aegis-closed'}" role="button" tabindex="0" data-aegis-select="${i.id}">
      <span class="aegis-rank">${i.queue_rank ?? '·'}</span>
      <b class="aegis-pri" style="color:${col};border-color:${col}">P${i.priority_level ?? '–'}</b>
      <span class="aegis-name">${i.device_label}</span>
      ${i.deteriorating ? safeHtml`<span class="aegis-tag aegis-det" title="vitals worsening">▼</span>` : safeHtml``}
      ${i.covert ? safeHtml`<span class="aegis-tag aegis-cov" title="covert: haptic acknowledgement only">COVERT</span>` : safeHtml``}
      ${i.cancel_request?.pending ? safeHtml`<span class="aegis-tag aegis-can">CANCEL?</span>` : safeHtml``}
      <span class="aegis-state">${i.state}</span>
      <span class="aegis-meta">${i.category ?? 'untriaged'} · HR ${v.heart_rate || '—'} · SpO₂ ${v.spo2 || '—'} · ${i.packets} pkt · ${ageText((Date.now() - Date.parse(i.updated_at)) / 1000)}</span>
    </div>`;
  }

  private detail(inc: AegisIncidentFull): SafeHtml {
    const t0 = inc.triage;
    const covert = inc.covert;
    const closed = inc.state === 'CLOSED';
    const draft = this.drafts.get(inc.id) ?? (covert ? HAPTIC_ONLY : t0?.user_satellite_reply ?? '');
    const opts = (inc.deconfliction?.options ?? []).map((o) => safeHtml`<tr class="${inc.deconfliction?.recommended?.asset.id === o.asset.id ? 'aegis-rec' : ''}"><td>${o.mode}</td><td>${o.asset.name}</td><td>${o.feasible ? etaText(o.eta_min) : 'NO'}</td><td>${o.feasible ? (o.approach?.kind === 'DIRECT' ? `direct HDG ${String(o.approach.heading_deg).padStart(3, '0')}` : `dogleg +${o.approach?.detour_km} km`) : ''}${o.blocked_by.length ? safeHtml`<div class="aegis-why">${o.blocked_by.join(' / ')}</div>` : safeHtml``}</td></tr>`);
    const btn = (to: string, label: string, enabled: boolean) => safeHtml`<button type="button" data-aegis-to="${to}" ${enabled ? '' : 'disabled'}>${label}</button>`;
    const quick = covert
      ? safeHtml`<button type="button" data-aegis-quick="${HAPTIC_ONLY}">SEND HAPTIC ACK</button>`
      : joinSafeHtml(QUICK_REPLIES.map((q) => safeHtml`<button type="button" data-aegis-quick="${q}" ${closed ? 'disabled' : ''}>${q.split('.')[0] ?? q}</button>`));
    return safeHtml`<div class="aegis-detail">
      <div class="aegis-title"><b>${inc.device_label}</b> · ${t0?.triage_category ?? '—'} · ${inc.state} · P${t0?.priority_level ?? '–'}</div>
      ${inc.cancel_request?.pending ? safeHtml`<div class="aegis-banner">Wristband cancel requested${inc.cancel_request.possibly_coerced ? ' — POSSIBLY COERCED, verify off-air' : ''}. <button type="button" data-aegis-cancel="1">Confirm &amp; close</button> <button type="button" data-aegis-cancel="0">Reject</button></div>` : safeHtml``}
      ${covert ? safeHtml`<div class="aegis-banner aegis-covert">Covert: only a haptic acknowledgement may be sent. Plan extraction off-air.</div>` : safeHtml``}
      ${renderTacticalMap(inc, this.incidents)}
      <div class="aegis-kv"><span>HR ${inc.vitals.heart_rate || '—'} bpm</span><span>SpO₂ ${inc.vitals.spo2 || '—'}%</span><span>batt ${inc.vitals.battery_pct}% (${etaText(inc.battery.eta_min)}, ${inc.battery.model})</span></div>
      <p><b>Physiology.</b> ${t0?.physiological_status}</p>
      <p><b>Hazards.</b> ${t0?.hazard_assessment}</p>
      <p><b>Route.</b> ${t0?.deconflicted_route_plan}</p>
      <ol>${joinSafeHtml((t0?.dispatcher_checklist ?? []).map((c) => safeHtml`<li>${c}</li>`))}</ol>
      <table class="aegis-opt"><tr><th>MODE</th><th>ASSET</th><th>ETA</th><th>VECTOR</th></tr>${joinSafeHtml(opts)}</table>
      <div class="aegis-actions">${btn('UNIT_ASSIGNED', 'ASSIGN', inc.state === 'AI_TRIAGED')}${btn('EN_ROUTE', 'EN ROUTE', inc.state === 'UNIT_ASSIGNED')}${btn('EXTRACTED', 'EXTRACTED', inc.state === 'EN_ROUTE')}${btn('CLOSED', 'CLOSE', !closed)}</div>
      <textarea data-aegis-draft maxlength="400" aria-label="downlink text" ${closed ? 'disabled' : ''}>${draft}</textarea>
      <div class="aegis-actions">${quick}<button type="button" data-aegis-send ${closed ? 'disabled' : ''}>QUEUE TEXT</button></div>
    </div>`;
  }
}

// Incident database (embedded SQLite via node:sqlite, no dependencies).
//
// Holds what must survive a restart: raw telemetry (the sealed envelope as received),
// incidents, replay state, the device registry and the downlink outbox. Incidents are
// stored as JSON documents with a few indexed columns; the service keeps the working
// set in memory and writes through on every mutation.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, device_id INTEGER NOT NULL,
  state TEXT NOT NULL, priority INTEGER, doc TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_device ON incidents(device_id, state);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, device_id INTEGER NOT NULL,
  device_ts INTEGER NOT NULL, received_at TEXT NOT NULL, via TEXT NOT NULL, format TEXT NOT NULL,
  envelope BLOB NOT NULL, decoded TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_incident ON telemetry(incident_id);
CREATE TABLE IF NOT EXISTS replay (device_id INTEGER PRIMARY KEY, last_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS envelopes (envelope_id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  device_id INTEGER PRIMARY KEY, label TEXT, silent_mode INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0, first_seen TEXT
);
CREATE TABLE IF NOT EXISTS downlinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT, device_id INTEGER NOT NULL,
  kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS downlinks_device ON downlinks(device_id, delivered_at);
`;

export function openStore(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);

  const q = {
    upsertIncident: db.prepare(`INSERT INTO incidents (id, seq, device_id, state, priority, doc, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, priority=excluded.priority, doc=excluded.doc, updated_at=excluded.updated_at`),
    allIncidents: db.prepare('SELECT doc FROM incidents ORDER BY seq'),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM incidents'),
    insTelemetry: db.prepare(`INSERT INTO telemetry (incident_id, device_id, device_ts, received_at, via, format, envelope, decoded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    telemetryFor: db.prepare('SELECT id, device_ts, received_at, via, format, length(envelope) AS envelope_bytes, decoded FROM telemetry WHERE incident_id = ? ORDER BY id'),
    telemetryCount: db.prepare('SELECT COUNT(*) AS n FROM telemetry'),
    getReplay: db.prepare('SELECT last_ts FROM replay WHERE device_id = ?'),
    setReplay: db.prepare('INSERT INTO replay (device_id, last_ts) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_ts=excluded.last_ts'),
    getEnvelope: db.prepare('SELECT incident_id FROM envelopes WHERE envelope_id = ?'),
    setEnvelope: db.prepare('INSERT INTO envelopes (envelope_id, incident_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(envelope_id) DO UPDATE SET incident_id=excluded.incident_id'),
    getDevice: db.prepare('SELECT device_id, label, silent_mode, revoked, first_seen FROM devices WHERE device_id = ?'),
    putDevice: db.prepare(`INSERT INTO devices (device_id, label, silent_mode, revoked, first_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET label=excluded.label, silent_mode=excluded.silent_mode, revoked=excluded.revoked`),
    allDevices: db.prepare('SELECT device_id, label, silent_mode, revoked, first_seen FROM devices ORDER BY device_id'),
    insDownlink: db.prepare('INSERT INTO downlinks (incident_id, device_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)'),
    pendingDownlinks: db.prepare('SELECT id, incident_id, kind, body, created_at FROM downlinks WHERE device_id = ? AND delivered_at IS NULL ORDER BY id'),
    markDelivered: db.prepare('UPDATE downlinks SET delivered_at = ? WHERE id = ?'),
    downlinksFor: db.prepare('SELECT id, kind, body, created_at, delivered_at FROM downlinks WHERE incident_id = ? ORDER BY id'),
  };

  const deviceRow = (r) => (r ? { device_id: r.device_id, label: r.label, silent_mode: !!r.silent_mode, revoked: !!r.revoked, first_seen: r.first_seen } : null);

  return {
    file,
    close: () => db.close(),

    nextSeq: () => q.maxSeq.get().m + 1,
    saveIncident(inc, seq) {
      q.upsertIncident.run(inc.id, seq, inc.device_id, inc.state, inc.triage?.priority_level ?? null, JSON.stringify(inc), new Date().toISOString());
    },
    loadIncidents: () => q.allIncidents.all().map((r) => JSON.parse(r.doc)),

    saveTelemetry({ incident_id, device_id, device_ts, received_at, via, format, envelope, decoded }) {
      q.insTelemetry.run(incident_id, device_id, device_ts, received_at, via, format, envelope, JSON.stringify(decoded));
    },
    telemetryFor: (id) => q.telemetryFor.all(id).map((r) => ({ ...r, decoded: JSON.parse(r.decoded) })),
    telemetryCount: () => q.telemetryCount.get().n,

    lastTimestamp: (deviceId) => q.getReplay.get(deviceId)?.last_ts ?? null,
    setLastTimestamp: (deviceId, ts) => q.setReplay.run(deviceId, ts),
    envelopeSeen: (id) => q.getEnvelope.get(id)?.incident_id ?? null,
    markEnvelope: (id, incidentId) => q.setEnvelope.run(id, incidentId, new Date().toISOString()),

    getDevice: (id) => deviceRow(q.getDevice.get(id)),
    putDevice({ device_id, label = null, silent_mode = false, revoked = false }) {
      const prev = q.getDevice.get(device_id);
      q.putDevice.run(device_id, label, silent_mode ? 1 : 0, revoked ? 1 : 0, prev?.first_seen ?? new Date().toISOString());
      return deviceRow(q.getDevice.get(device_id));
    },
    listDevices: () => q.allDevices.all().map(deviceRow),

    enqueueDownlink({ incident_id, device_id, kind, body }) {
      const r = q.insDownlink.run(incident_id ?? null, device_id, kind, JSON.stringify(body), new Date().toISOString());
      return Number(r.lastInsertRowid);
    },
    pullDownlinks(deviceId, now = new Date().toISOString()) {
      const rows = q.pendingDownlinks.all(deviceId).map((r) => ({ ...r, body: JSON.parse(r.body) }));
      for (const r of rows) q.markDelivered.run(now, r.id);
      return rows;
    },
    pendingCount: (deviceId) => q.pendingDownlinks.all(deviceId).length,
    downlinksFor: (incidentId) => q.downlinksFor.all(incidentId).map((r) => ({ ...r, body: JSON.parse(r.body) })),
  };
}

// Envelope: [version:1][keyId:1][iv:12][tag:16][ciphertext:n]
// AES-256-GCM provides both confidentiality and authenticity: the GCM tag IS the
// signature check. We do not add a second signature because a second MAC over the
// same bytes adds nothing an attacker cannot replay (replay is handled by timestamp).
//
// DEV ONLY: keys are generated in-process at boot. A real deployment loads a
// pre-shared keyring from a KMS or secure element; see TODO in README.

import crypto from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const REPLAY_WINDOW_S = 300;

const keyring = new Map();
for (const [id, byte] of [['k1', 0x11], ['k2', 0x22]]) {
  keyring.set(id, Buffer.alloc(32, byte));
}

const keyIdToByte = new Map([...keyring.keys()].map((id, i) => [id, i + 1]));
const byteToKeyId = new Map([...keyIdToByte].map(([id, b]) => [b, id]));

const lastSeen = new Map(); // device_id -> timestamp

export function listKeyIds() {
  return [...keyring.keys()];
}

export function encrypt(payload, keyId = 'k1') {
  const key = keyring.get(keyId);
  if (!key) throw new Error('unknown key id');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION, keyIdToByte.get(keyId)]), iv, tag, ct]);
}

export function decrypt(envelope) {
  if (envelope.length < 2 + IV_BYTES + TAG_BYTES) throw new Error('envelope too short');
  const version = envelope[0];
  if (version !== VERSION) throw new Error('unsupported envelope version');
  const keyId = byteToKeyId.get(envelope[1]);
  if (!keyId) throw new Error('unknown key id byte');
  const key = keyring.get(keyId);
  const iv = envelope.subarray(2, 2 + IV_BYTES);
  const tag = envelope.subarray(2 + IV_BYTES, 2 + IV_BYTES + TAG_BYTES);
  const ct = envelope.subarray(2 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on tamper
  return { keyId, payload: pt };
}

/** Reject replays and stale beacons. Returns { ok, reason }. */
export function checkReplay(device_id, timestamp, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'timestamp missing' };
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_S) {
    return { ok: false, reason: `timestamp outside ±${REPLAY_WINDOW_S}s window` };
  }
  const prev = lastSeen.get(device_id);
  if (prev !== undefined && timestamp <= prev) {
    return { ok: false, reason: `replay: timestamp ${timestamp} <= last seen ${prev}` };
  }
  lastSeen.set(device_id, timestamp);
  return { ok: true };
}

export function _resetReplayState() {
  lastSeen.clear();
}

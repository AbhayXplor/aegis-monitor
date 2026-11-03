// Beacon envelope v2.
//
//   [version:1][device_id:4 BE][epoch:2 BE][iv:12][gcm_tag:16][ciphertext:n]
//
// - AES-256-GCM. The 7-byte header is bound as AAD, so a flipped device_id or epoch
//   fails authentication. The tag IS the signature check: only a holder of the
//   device's key can produce a valid envelope for that device_id.
// - Keys are per device and per epoch: HKDF-SHA256(master, salt=device_id,
//   info="aegis/v2/epoch/<n>"). A device holds only its own derived PSK; the server
//   derives it on demand from the master. Epoch = floor(timestamp / KEY_EPOCH_S),
//   so keys rotate on the device clock with no extra round trip.
// - The master comes from AEGIS_MASTER_KEY (64 hex chars). If absent it is generated
//   in memory at boot (EPHEMERAL): every restart rotates every device key. That is
//   fine for the simulator and wrong for a deployment; health reports which mode.
//
// Overhead is 35 bytes, so a ~30 byte protobuf beacon seals to ~65 bytes (< 100).

import crypto from 'node:crypto';

export const VERSION = 2;
const HEADER_BYTES = 7;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const OVERHEAD_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES;

export const KEY_EPOCH_S = Number(process.env.AEGIS_KEY_EPOCH_S || 86400);
export const FUTURE_SKEW_S = 300;
export const MAX_AGE_S = Number(process.env.AEGIS_MAX_AGE_S || 86400);

let master = null;
let masterMode = 'EPHEMERAL';

export function initMaster(hex = process.env.AEGIS_MASTER_KEY) {
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('AEGIS_MASTER_KEY must be 64 hex characters');
    master = Buffer.from(hex, 'hex');
    masterMode = 'ENV';
  } else {
    master = crypto.randomBytes(32);
    masterMode = 'EPHEMERAL';
  }
}
initMaster();

export function keyMode() {
  return masterMode;
}

export const epochFor = (timestamp) => Math.floor(timestamp / KEY_EPOCH_S) & 0xffff;

function deviceKey(deviceId, epoch) {
  const salt = Buffer.alloc(4);
  salt.writeUInt32BE(deviceId >>> 0);
  return Buffer.from(crypto.hkdfSync('sha256', master, salt, `aegis/v2/epoch/${epoch}`, 32));
}

function header(deviceId, epoch) {
  const h = Buffer.alloc(HEADER_BYTES);
  h[0] = VERSION;
  h.writeUInt32BE(deviceId >>> 0, 1);
  h.writeUInt16BE(epoch, 5);
  return h;
}

/** Seal a payload as device `deviceId`, keyed for the epoch of `timestamp`. */
export function encrypt(payload, { deviceId, timestamp }) {
  if (!Number.isInteger(deviceId) || !Number.isInteger(timestamp)) throw new Error('deviceId and timestamp required');
  const epoch = epochFor(timestamp);
  const h = header(deviceId, epoch);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deviceKey(deviceId, epoch), iv);
  cipher.setAAD(h);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([h, iv, cipher.getAuthTag(), ct]);
}

/** Peek at the unauthenticated header (used only to pick a key and route errors). */
export function peekHeader(envelope) {
  if (envelope.length < OVERHEAD_BYTES) throw new Error('envelope too short');
  if (envelope[0] !== VERSION) throw new Error('unsupported envelope version');
  return { deviceId: envelope.readUInt32BE(1), epoch: envelope.readUInt16BE(5) };
}

export function decrypt(envelope) {
  const { deviceId, epoch } = peekHeader(envelope);
  const h = envelope.subarray(0, HEADER_BYTES);
  const iv = envelope.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
  const tag = envelope.subarray(HEADER_BYTES + IV_BYTES, OVERHEAD_BYTES);
  const ct = envelope.subarray(OVERHEAD_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deviceKey(deviceId, epoch), iv);
  decipher.setAAD(h);
  decipher.setAuthTag(tag);
  const payload = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on tamper
  return { deviceId, epoch, payload };
}

/** Stable identity of an envelope, for duplicate suppression across mesh paths. */
export const envelopeId = (envelope) => crypto.createHash('sha256').update(envelope).digest('hex').slice(0, 32);

/**
 * Freshness is not replay protection. A mesh packet may legitimately arrive hours
 * late, so age is bounded by MAX_AGE_S (default 24 h) and reported, not rejected at
 * five minutes. Timestamps from the future are rejected beyond clock skew.
 */
export function checkFreshness(timestamp, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'timestamp missing' };
  if (timestamp - now > FUTURE_SKEW_S) return { ok: false, reason: `timestamp ${timestamp - now}s in the future (skew limit ${FUTURE_SKEW_S}s)` };
  const age = Math.max(0, now - timestamp);
  if (age > MAX_AGE_S) return { ok: false, reason: `beacon is ${age}s old (limit ${MAX_AGE_S}s)` };
  return { ok: true, age_s: age };
}

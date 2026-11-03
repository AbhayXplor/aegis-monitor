// Wire codecs for telemetry.proto: a minimal Protocol Buffers codec and a minimal
// CBOR codec for the same single message. No dependencies, no codegen.
//
// Protobuf: varint (wire type 0) and length-delimited (2). Unknown fields skipped.
// CBOR:     one definite-length map with small integer keys (the same field numbers),
//           unsigned/negative ints, booleans and byte strings.
// decodePayload() tells them apart by the first byte: a CBOR map starts 0xA0-0xBF,
// a protobuf message from encode() always starts with the device_id tag (0x08).

export const FIELD = {
  device_id: 1,
  timestamp: 2,
  lat: 3,
  lon: 4,
  altitude_m: 5,
  sos_code: 6,
  heart_rate: 7,
  spo2: 8,
  battery_pct: 9,
  duress_flag: 10,
  ext: 11,
};

// sos_code is a 3-bit enum (0..7).
export const SOS = {
  UNSPECIFIED: 0,
  MEDICAL: 1,
  TRAUMA: 2,
  HOSTILE: 3,
  EVACUATION: 4,
  WATER: 5,
  CHILDBIRTH: 6,
  CANCEL: 7,
};
export const SOS_NAME = Object.fromEntries(Object.entries(SOS).map(([k, v]) => [v, k]));

export const MAX_PACKET_BYTES = 100;

const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

/* ---------------- protobuf ---------------- */

function varint(n) {
  let v = BigInt(Math.trunc(n));
  if (v < 0n) throw new Error('varint: negative');
  const out = [];
  while (v > 127n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('varint: truncated');
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint: too long');
  }
  return { value, offset: i };
}

const zigzag = (n) => (n << 1) ^ (n >> 31);
const unzigzag = (u) => (u >>> 1) ^ -(u & 1);

function tag(field, wire) {
  return varint((field << 3) | wire);
}

export function encode(msg) {
  const parts = [];
  const pushVarint = (field, value) => {
    if (value === undefined || value === null) return;
    parts.push(tag(field, WIRE_VARINT), varint(value));
  };

  pushVarint(FIELD.device_id, msg.device_id);
  pushVarint(FIELD.timestamp, msg.timestamp);
  if (msg.lat !== undefined) {
    parts.push(tag(FIELD.lat, WIRE_VARINT), varint(zigzag(msg.lat)));
    parts.push(tag(FIELD.lon, WIRE_VARINT), varint(zigzag(msg.lon)));
  }
  if (msg.altitude_m !== undefined) {
    parts.push(tag(FIELD.altitude_m, WIRE_VARINT), varint(zigzag(msg.altitude_m)));
  }
  pushVarint(FIELD.sos_code, msg.sos_code);
  pushVarint(FIELD.heart_rate, msg.heart_rate);
  pushVarint(FIELD.spo2, msg.spo2);
  pushVarint(FIELD.battery_pct, msg.battery_pct);
  if (msg.duress_flag !== undefined) pushVarint(FIELD.duress_flag, msg.duress_flag ? 1 : 0);

  if (msg.ext) {
    const ext = Buffer.isBuffer(msg.ext) ? msg.ext : Buffer.from(String(msg.ext));
    parts.push(tag(FIELD.ext, WIRE_BYTES), varint(ext.length), ext);
  }
  return Buffer.concat(parts);
}

export function decode(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const t = readVarint(buf, i);
    i = t.offset;
    const key = Number(t.value);
    const field = key >>> 3;
    const wire = key & 7;

    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, i);
      i = v.offset;
      const n = Number(v.value);
      if (field === FIELD.device_id) out.device_id = n;
      else if (field === FIELD.timestamp) out.timestamp = n;
      else if (field === FIELD.lat) out.lat = unzigzag(n);
      else if (field === FIELD.lon) out.lon = unzigzag(n);
      else if (field === FIELD.altitude_m) out.altitude_m = unzigzag(n);
      else if (field === FIELD.sos_code) out.sos_code = n;
      else if (field === FIELD.heart_rate) out.heart_rate = n;
      else if (field === FIELD.spo2) out.spo2 = n;
      else if (field === FIELD.battery_pct) out.battery_pct = n;
      else if (field === FIELD.duress_flag) out.duress_flag = n === 1;
    } else if (wire === WIRE_BYTES) {
      const len = readVarint(buf, i);
      i = len.offset;
      const end = i + Number(len.value);
      if (end > buf.length) throw new Error('length-delimited: truncated');
      if (field === FIELD.ext) out.ext = buf.subarray(i, end);
      i = end;
    } else {
      throw new Error('unsupported wire type ' + wire);
    }
  }
  return out;
}

/* ---------------- CBOR ---------------- */

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n >>> 0, 1);
  return b;
}

function cborInt(n) {
  if (!Number.isInteger(n) || Math.abs(n) > 0xffffffff) throw new Error('cbor: int out of 32-bit range');
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
}

export function encodeCbor(msg) {
  const entries = [];
  const put = (field, value) => {
    if (value === undefined || value === null) return;
    const v = typeof value === 'boolean' ? Buffer.from([value ? 0xf5 : 0xf4]) : cborInt(value);
    entries.push(cborInt(field), v);
  };
  for (const name of ['device_id', 'timestamp', 'lat', 'lon', 'altitude_m', 'sos_code', 'heart_rate', 'spo2', 'battery_pct']) {
    put(FIELD[name], msg[name]);
  }
  put(FIELD.duress_flag, msg.duress_flag === undefined ? undefined : !!msg.duress_flag);
  if (msg.ext) {
    const ext = Buffer.isBuffer(msg.ext) ? msg.ext : Buffer.from(String(msg.ext));
    entries.push(cborInt(FIELD.ext), cborHead(2, ext.length), ext);
  }
  return Buffer.concat([cborHead(5, entries.length / 2), ...entries]);
}

function cborRead(buf, i) {
  if (i >= buf.length) throw new Error('cbor: truncated');
  const ib = buf[i++];
  const major = ib >> 5;
  const info = ib & 31;
  if (major === 7) {
    if (info === 20) return { v: false, i };
    if (info === 21) return { v: true, i };
    throw new Error('cbor: unsupported simple value');
  }
  let n;
  if (info < 24) n = info;
  else if (info === 24) { if (i + 1 > buf.length) throw new Error('cbor: truncated'); n = buf[i]; i += 1; }
  else if (info === 25) { if (i + 2 > buf.length) throw new Error('cbor: truncated'); n = buf.readUInt16BE(i); i += 2; }
  else if (info === 26) { if (i + 4 > buf.length) throw new Error('cbor: truncated'); n = buf.readUInt32BE(i); i += 4; }
  else throw new Error('cbor: unsupported length form');
  if (major === 0) return { v: n, i };
  if (major === 1) return { v: -1 - n, i };
  if (major === 2) {
    if (i + n > buf.length) throw new Error('cbor: truncated');
    return { v: buf.subarray(i, i + n), i: i + n };
  }
  if (major === 5) return { map: n, i };
  throw new Error('cbor: unsupported major type ' + major);
}

export function decodeCbor(buf) {
  const head = cborRead(buf, 0);
  if (head.map === undefined) throw new Error('cbor: top level must be a map');
  const byField = Object.fromEntries(Object.entries(FIELD).map(([k, v]) => [v, k]));
  const out = {};
  let i = head.i;
  for (let n = 0; n < head.map; n++) {
    const k = cborRead(buf, i); i = k.i;
    const v = cborRead(buf, i); i = v.i;
    const name = byField[k.v];
    if (name && v.map === undefined) out[name] = v.v;
  }
  if (i !== buf.length) throw new Error('cbor: trailing bytes');
  return out;
}

/** Decode either codec. Returns { msg, format }. */
export function decodePayload(buf) {
  if (!buf.length) throw new Error('empty payload');
  if (buf[0] >= 0xa0 && buf[0] <= 0xbf) return { msg: decodeCbor(buf), format: 'cbor' };
  return { msg: decode(buf), format: 'protobuf' };
}

/* ---------------- validation ---------------- */

const isUint = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;

export function validatePacket(msg, byteLength) {
  const errors = [];
  if (byteLength >= MAX_PACKET_BYTES) errors.push(`packet is ${byteLength} bytes, cap is <${MAX_PACKET_BYTES}`);
  for (const f of ['device_id', 'timestamp', 'lat', 'lon', 'sos_code']) {
    if (msg[f] === undefined || msg[f] === null) errors.push(`missing ${f}`);
  }
  if (msg.device_id !== undefined && !isUint(msg.device_id, 0xffffffff)) errors.push('device_id range');
  if (msg.timestamp !== undefined && !isUint(msg.timestamp, 0xffffffff)) errors.push('timestamp range');
  if (msg.sos_code !== undefined && !isUint(msg.sos_code, 7)) errors.push('sos_code is a 3-bit enum (0-7)');
  if (msg.lat !== undefined && !(Number.isInteger(msg.lat) && Math.abs(msg.lat) <= 90_000_000)) errors.push('lat out of range');
  if (msg.lon !== undefined && !(Number.isInteger(msg.lon) && Math.abs(msg.lon) <= 180_000_000)) errors.push('lon out of range');
  if (msg.altitude_m !== undefined && !(Number.isInteger(msg.altitude_m) && msg.altitude_m >= -32768 && msg.altitude_m <= 32767)) errors.push('altitude_m is int16');
  if (msg.heart_rate !== undefined && !isUint(msg.heart_rate, 255)) errors.push('heart_rate range');
  if (msg.spo2 !== undefined && msg.spo2 !== 0 && !(Number.isInteger(msg.spo2) && msg.spo2 >= 50 && msg.spo2 <= 100)) errors.push('spo2 range');
  if (msg.battery_pct !== undefined && !isUint(msg.battery_pct, 100)) errors.push('battery_pct range');
  return errors;
}

// Minimal Protocol Buffers wire-format codec for telemetry.proto.
// Scope: this one message. Supports varint (wire type 0) and length-delimited (2).
// No dependencies, no codegen. Unknown fields are skipped on decode.

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

export const MAX_PACKET_BYTES = 100;

const WIRE_VARINT = 0;
const WIRE_BYTES = 2;

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

export function validatePacket(msg, byteLength) {
  const errors = [];
  if (byteLength >= MAX_PACKET_BYTES) errors.push(`packet is ${byteLength} bytes, cap is <${MAX_PACKET_BYTES}`);
  for (const f of ['device_id', 'timestamp', 'lat', 'lon', 'sos_code']) {
    if (msg[f] === undefined || msg[f] === null) errors.push(`missing ${f}`);
  }
  if (msg.lat !== undefined && Math.abs(msg.lat) > 90_000_000) errors.push('lat out of range');
  if (msg.lon !== undefined && Math.abs(msg.lon) > 180_000_000) errors.push('lon out of range');
  if (msg.heart_rate !== undefined && (msg.heart_rate < 0 || msg.heart_rate > 255)) errors.push('heart_rate range');
  if (msg.spo2 !== undefined && msg.spo2 !== 0 && (msg.spo2 < 50 || msg.spo2 > 100)) errors.push('spo2 range');
  return errors;
}

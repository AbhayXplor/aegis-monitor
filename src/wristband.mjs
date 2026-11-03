// Wristband + edge layer: gesture machine, haptics, covert policy, PPG poll,
// and the BLE/LoRa store-and-forward relay stub.
//
// STATUS: logic is implemented and unit-tested. There is no firmware here and no
// radio driver. Anything that touches hardware is marked STUB.
//
// DUAL-USE FLAG: covert burst-timing randomisation exists to stop hostile radio
// direction finding of a captive. The same property makes the beacon harder to
// locate by lawful search. Exposed as a policy object with a fixed seedable clock
// so it is auditable; no RF behaviour is implemented in this repository.

export const GESTURE = {
  MEDICAL_SOS: 'MEDICAL_SOS',
  HOSTILE_EXTRACTION: 'HOSTILE_EXTRACTION',
  CANCEL: 'CANCEL',
};

export const PRESS_WINDOW_MS = 1800;
export const HOLD_CANCEL_MS = 10_000;

/**
 * Classify a button episode.
 * @param {number} presses   number of presses inside PRESS_WINDOW_MS
 * @param {number} heldMs    total hold time of the final press
 */
export function classifyGesture(presses, heldMs = 0) {
  if (heldMs >= HOLD_CANCEL_MS) return GESTURE.CANCEL;
  if (presses === 3) return GESTURE.MEDICAL_SOS;
  if (presses === 5) return GESTURE.HOSTILE_EXTRACTION;
  return null; // 1, 2, 4+ presses are ignored: no accidental kill switch
}

export function sosCodeForGesture(gesture) {
  if (gesture === GESTURE.HOSTILE_EXTRACTION) return 3; // HOSTILE
  if (gesture === GESTURE.MEDICAL_SOS) return 2; // TRAUMA
  return 0;
}

export function gestureToBeacon({ gesture, device_id, timestamp, lat, lon, altitude_m = 0, heart_rate = 0, spo2 = 0, battery_pct = 0 }) {
  if (!gesture || gesture === GESTURE.CANCEL) return null;
  return {
    device_id,
    timestamp,
    lat,
    lon,
    altitude_m,
    sos_code: sosCodeForGesture(gesture),
    heart_rate,
    spo2,
    battery_pct,
    duress_flag: gesture === GESTURE.HOSTILE_EXTRACTION,
  };
}

/* ---------------- haptics ---------------- */

// Screenless feedback. Distinct rhythms so the wearer can tell them apart by feel.
const PATTERNS = {
  SENT: [{ ms: 90, amp: 1 }],
  ACK: [{ ms: 60, amp: 1 }, { gap: 70 }, { ms: 60, amp: 1 }],
  DISPATCHED: [{ ms: 250, amp: 1 }, { gap: 120 }, { ms: 250, amp: 1 }],
  CANCELLED: [{ ms: 400, amp: 0.4 }],
};

export function hapticPattern(event) {
  const p = PATTERNS[event];
  if (!p) throw new Error('unknown haptic event: ' + event);
  return p.map((step) => ({ ...step }));
}

/* ---------------- covert mode ---------------- */

export function covertPolicy({ duress = false } = {}) {
  if (!duress) {
    return { silent: false, leds: true, sound: true, burstIntervalS: [300, 300], wipeLocalLog: false };
  }
  return { silent: true, leds: false, sound: false, burstIntervalS: [90, 260], wipeLocalLog: true };
}

/** Deterministic jitter so a replay is auditable. rng defaults to a seeded LCG. */
export function nextBurstSeconds(policy, rng = seededRng(0x5eed)) {
  const [min, max] = policy.burstIntervalS;
  if (min === max) return min;
  return Math.round(min + rng() * (max - min));
}

export function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ---------------- PPG ---------------- */

/**
 * STUB: no sensor here. Returns a deterministic sample from the seed so the
 * payload path and tests are exercised. Replace with a real PPG read.
 */
export function pollPPG(seed = 42) {
  const rng = seededRng(seed);
  const heart_rate = 62 + Math.round(rng() * 70);
  const spo2 = 88 + Math.round(rng() * 11);
  return { heart_rate, spo2, quality: +rng().toFixed(2), source: 'PPG_STUB' };
}

/* ---------------- mesh store-and-forward ---------------- */

export const MESH_MAX_HOPS = 3;

/**
 * STUB: LoRa/BLE relay. A packet hops through nearby phones or relay nodes that
 * have sky visibility. Each hop adds metadata but never re-encrypts the payload.
 */
export function meshRelay({ packet, hops = 1, relayedBy = 'phone' }) {
  if (!packet) throw new Error('packet required');
  if (hops > MESH_MAX_HOPS) return { delivered: false, reason: 'hop limit exceeded', hops };
  return {
    delivered: true,
    hops,
    relayedBy,
    remaining: MESH_MAX_HOPS - hops,
    // the ciphertext is untouched; only the transport envelope changes
    envelope: packet,
  };
}

export function meshPathForGateway() {
  return ['wristband', 'phone-a', 'relay-node', 'satellite'];
}

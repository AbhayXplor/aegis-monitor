// Wristband edge layer: button state machine, haptics, covert policy, PPG analysis.
//
// STATUS: logic is implemented and unit-tested. There is no firmware and no radio
// driver. The only stubbed piece is the PPG *sensor read*; the analysis that turns raw
// red/IR samples into heart rate and SpO2 is real and tested on synthetic waveforms.
//
// DUAL-USE FLAG: covert burst-timing randomisation exists to stop hostile radio
// direction finding of a captive. The same property makes the beacon harder to locate
// by lawful search. It is exposed as a policy object, and no RF behaviour is
// implemented in this repository.

import crypto from 'node:crypto';
import { SOS } from './proto.mjs';

export const GESTURE = {
  MEDICAL_SOS: 'MEDICAL_SOS',
  HOSTILE_EXTRACTION: 'HOSTILE_EXTRACTION',
  DURESS: 'DURESS',
  CANCEL: 'CANCEL',
};

/** Rapid presses are at most GAP_MS apart; a sequence ends GAP_MS after the last release. */
export const GAP_MS = 700;
export const HOLD_CANCEL_MS = 10_000;

// ASSUMPTION: the brief names the duress sequence but not its form. Seven rapid presses
// is used: distinct from 3 and 5, and unlikely to happen by accident.
export const PRESSES = { MEDICAL_SOS: 3, HOSTILE_EXTRACTION: 5, DURESS: 7 };

/**
 * Pure classification of a finished button episode.
 * @param {number} presses  presses in the sequence
 * @param {number} heldMs   hold time of the final press
 */
export function classifyGesture(presses, heldMs = 0) {
  if (heldMs >= HOLD_CANCEL_MS) return GESTURE.CANCEL;
  if (presses === PRESSES.MEDICAL_SOS) return GESTURE.MEDICAL_SOS;
  if (presses === PRESSES.HOSTILE_EXTRACTION) return GESTURE.HOSTILE_EXTRACTION;
  if (presses === PRESSES.DURESS) return GESTURE.DURESS;
  return null; // 1, 2, 4, 6 and 8+ presses are ignored: no accidental activation
}

/**
 * Hardware button state machine. Feed it down/up events and clock ticks (all in ms);
 * it emits { gesture, presses } when a sequence completes, or { gesture: null,
 * ignored: presses } for a sequence that matches nothing. A 10 s hold fires CANCEL at
 * the moment the threshold is crossed, while the button is still held.
 */
export class ButtonMachine {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.presses = 0;
    this.downAt = null;
    this.lastUpAt = null;
    this.cancelFired = false;
  }

  _finish(now) {
    const n = this.presses;
    this.presses = 0;
    this.lastUpAt = null;
    if (n === 0) return;
    const gesture = classifyGesture(n, 0);
    this.onEvent(gesture ? { gesture, presses: n, at: now } : { gesture: null, ignored: n, at: now });
  }

  down(t) {
    this.tick(t);
    this.downAt = t;
    this.cancelFired = false;
  }

  tick(t) {
    if (this.downAt !== null && !this.cancelFired && t - this.downAt >= HOLD_CANCEL_MS) {
      this.cancelFired = true;
      this.presses = 0;
      this.onEvent({ gesture: GESTURE.CANCEL, presses: 0, held_ms: t - this.downAt, at: t });
      return;
    }
    if (this.downAt === null && this.presses > 0 && this.lastUpAt !== null && t - this.lastUpAt >= GAP_MS) this._finish(t);
  }

  up(t) {
    this.tick(t);
    if (this.downAt === null) return;
    this.downAt = null;
    if (this.cancelFired) {
      this.cancelFired = false;
      return;
    }
    this.presses += 1;
    this.lastUpAt = t;
  }
}

/** Run a list of timed button events through a fresh machine. Returns emitted events. */
export function runButtonEvents(events, { settleMs = GAP_MS + 50 } = {}) {
  const out = [];
  const m = new ButtonMachine((e) => out.push(e));
  let last = 0;
  for (const e of events) {
    if (e.type === 'down') m.down(e.t);
    else if (e.type === 'up') m.up(e.t);
    else m.tick(e.t);
    last = e.t;
  }
  m.tick(last + settleMs);
  return out;
}

/** Evenly spaced taps (press `pressMs`, release `gapMs`) as machine events. */
export function tapEvents(n, { pressMs = 90, gapMs = 220, start = 0 } = {}) {
  const ev = [];
  let t = start;
  for (let i = 0; i < n; i++) {
    ev.push({ type: 'down', t });
    ev.push({ type: 'up', t: t + pressMs });
    t += pressMs + gapMs;
  }
  return ev;
}

/** A single press held for `ms`. */
export const holdEvents = (ms, start = 0) => [{ type: 'down', t: start }, { type: 'tick', t: start + ms }, { type: 'up', t: start + ms + 10 }];

/* ---------------- gesture -> beacon ---------------- */

export function sosCodeForGesture(gesture) {
  if (gesture === GESTURE.MEDICAL_SOS) return SOS.MEDICAL;
  if (gesture === GESTURE.HOSTILE_EXTRACTION || gesture === GESTURE.DURESS) return SOS.HOSTILE;
  if (gesture === GESTURE.CANCEL) return SOS.CANCEL;
  return SOS.UNSPECIFIED;
}

/**
 * Build the telemetry message for a gesture. CANCEL becomes a packet too (sos_code 7):
 * a cancel the server never hears about cancels nothing. `duress` carries a device that
 * is already in duress through its own cancel, so the dispatcher can see it.
 */
export function gestureToBeacon({ gesture, device_id, timestamp, lat, lon, altitude_m = 0, heart_rate = 0, spo2 = 0, battery_pct = 0, duress = false }) {
  if (!gesture) return null;
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
    duress_flag: gesture === GESTURE.DURESS || !!duress,
  };
}

/* ---------------- haptics ---------------- */

// Screenless feedback. Distinct rhythms so the wearer can tell them apart through fabric.
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

/* ---------------- covert / silent mode ---------------- */

export function covertPolicy({ duress = false, silentMode = false } = {}) {
  if (!duress && !silentMode) return { silent: false, leds: true, sound: true, burstIntervalS: [300, 300], wipeLocalLog: false };
  return {
    silent: true,
    leds: false,
    sound: false,
    burstIntervalS: [90, 260],
    wipeLocalLog: !!duress, // log wipe is a duress action, not part of plain silent mode
  };
}

/** Cryptographically random in [0,1). Tests inject seededRng instead. */
export const secureRng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

/**
 * Seconds until the next burst. Random by default: a fixed seed here would make the
 * schedule predictable and defeat the point of randomising it.
 */
export function nextBurstSeconds(policy, rng = secureRng) {
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

const SPO2_A = 110;
const SPO2_B = 25; // textbook linear calibration SpO2 = 110 - 25 R; a real device calibrates per sensor

/**
 * Synthesize red/IR photoplethysmograms for a target heart rate and SpO2. Used to
 * exercise the analysis path; a real sensor driver would return the same shape.
 */
export function synthPPG({ hr = 75, spo2 = 97, fs = 50, seconds = 10, seed = 1 } = {}) {
  const rng = seededRng(seed);
  const n = Math.round(fs * seconds);
  const f = hr / 60;
  const R = (SPO2_A - spo2) / SPO2_B;
  const acIr = 0.02;
  const red = new Float64Array(n);
  const ir = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.sin(2 * Math.PI * f * (i / fs));
    const noise = (rng() - 0.5) * 0.002;
    ir[i] = 1200 * (1 + acIr * s + noise);
    red[i] = 1000 * (1 + R * acIr * s + noise);
  }
  return { red, ir, fs };
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** Light moving-average smoothing (kills sample noise) then DC removal. */
function condition(x, fs) {
  const w = Math.max(1, Math.round(fs * 0.04));
  const sm = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(x.length - 1, i + w);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += x[j];
    sm[i] = s / (hi - lo + 1);
  }
  const dc = mean(Array.from(sm));
  return { ac: sm.map((v) => v - dc), dc };
}

/**
 * Heart rate (peak interval), SpO2 (ratio of ratios) and a 0..1 quality score.
 * LIMIT: assumes little baseline wander. A real sensor needs a proper band-pass filter
 * and motion-artefact rejection; `quality` is where that rejection would report.
 */
export function analysePPG({ red, ir, fs }) {
  if (!red?.length || red.length !== ir.length || red.length < fs * 4) return { heart_rate: 0, spo2: 0, quality: 0 };
  const { ac, dc: dcIr } = condition(ir, fs);
  const { ac: acRedArr, dc: dcRed } = condition(red, fs);
  const minDist = Math.floor((fs * 60) / 220);
  const edge = Math.round(fs * 0.25);
  const thresh = 0.5 * Math.max(...ac.slice(edge, ac.length - edge));
  const peaks = [];
  for (let i = edge; i < ac.length - edge; i++) {
    if (ac[i] > thresh && ac[i] >= ac[i - 1] && ac[i] > ac[i + 1] && (!peaks.length || i - peaks[peaks.length - 1] >= minDist)) peaks.push(i);
  }
  if (peaks.length < 3) return { heart_rate: 0, spo2: 0, quality: 0 };
  const iv = peaks.slice(1).map((p, k) => (p - peaks[k]) / fs);
  const m = mean(iv);
  const sd = Math.sqrt(mean(iv.map((v) => (v - m) ** 2)));
  const hr = Math.round(60 / m);

  const rms = (v) => Math.sqrt(mean(Array.from(v, (x) => x * x)));
  const R = rms(acRedArr) / dcRed / (rms(ac) / dcIr);
  const spo2 = Math.round(Math.min(100, Math.max(50, SPO2_A - SPO2_B * R)));
  return { heart_rate: Math.min(255, hr), spo2, quality: +Math.max(0, 1 - sd / m).toFixed(2) };
}

/**
 * STUB sensor read. There is no PPG sensor here, so a deterministic reading is
 * synthesized from the seed (or from explicit hr/spo2) and pushed through the real
 * analysis path. Replace the first line with a sensor driver call.
 */
export function pollPPG({ seed = 42, hr, spo2 } = {}) {
  const rng = seededRng(seed);
  const targetHr = hr ?? 62 + Math.round(rng() * 70);
  const targetSpo2 = spo2 ?? 88 + Math.round(rng() * 11);
  const sample = synthPPG({ hr: targetHr, spo2: targetSpo2, seed });
  return { ...analysePPG(sample), source: 'PPG_SYNTHETIC' };
}

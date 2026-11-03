import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GESTURE, ButtonMachine, classifyGesture, runButtonEvents, tapEvents, holdEvents, gestureToBeacon, sosCodeForGesture,
  hapticPattern, covertPolicy, nextBurstSeconds, seededRng, synthPPG, analysePPG, pollPPG, HOLD_CANCEL_MS,
} from '../src/wristband.mjs';
import { MeshNetwork, MESH_MAX_HOPS } from '../src/mesh.mjs';
import { SOS } from '../src/proto.mjs';

const g = (events) => runButtonEvents(events).filter((e) => e.gesture || e.ignored);

/* ---------------- button state machine ---------------- */

test('buttons: 3 = medical, 5 = hostile extraction, 7 = duress', () => {
  assert.equal(g(tapEvents(3))[0].gesture, GESTURE.MEDICAL_SOS);
  assert.equal(g(tapEvents(5))[0].gesture, GESTURE.HOSTILE_EXTRACTION);
  assert.equal(g(tapEvents(7))[0].gesture, GESTURE.DURESS);
});

test('buttons: every other count is ignored (no accidental activation)', () => {
  for (const n of [1, 2, 4, 6, 8, 9]) {
    const [e] = g(tapEvents(n));
    assert.equal(e.gesture ?? null, null, `${n} presses`);
    assert.equal(e.ignored, n);
  }
});

test('buttons: a sequence ends only after the gap, so 5 presses never fires as 3', () => {
  const out = [];
  const m = new ButtonMachine((e) => out.push(e));
  let t = 0;
  for (let i = 0; i < 5; i++) { m.down(t); m.up(t + 80); t += 300; }
  assert.equal(out.length, 0, 'nothing fires mid-sequence');
  m.tick(t + 800);
  assert.deepEqual(out.map((e) => e.gesture), [GESTURE.HOSTILE_EXTRACTION]);
});

test('buttons: a 10 s hold fires CANCEL while still held; 9.5 s does not', () => {
  const out = [];
  const m = new ButtonMachine((e) => out.push(e));
  m.down(0);
  m.tick(HOLD_CANCEL_MS - 1);
  assert.equal(out.length, 0);
  m.tick(HOLD_CANCEL_MS);
  assert.equal(out[0].gesture, GESTURE.CANCEL);
  m.up(HOLD_CANCEL_MS + 50);
  m.tick(HOLD_CANCEL_MS + 2000);
  assert.equal(out.length, 1, 'release after cancel adds nothing');
  assert.equal(g(holdEvents(9500))[0].gesture ?? null, null);
});

test('buttons: two sequences separated by a pause are two gestures', () => {
  const ev = [...tapEvents(3), ...tapEvents(5, { start: 6000 })];
  assert.deepEqual(g(ev).map((e) => e.gesture), [GESTURE.MEDICAL_SOS, GESTURE.HOSTILE_EXTRACTION]);
});

test('buttons: classifyGesture is the pure rule', () => {
  assert.equal(classifyGesture(3), GESTURE.MEDICAL_SOS);
  assert.equal(classifyGesture(1, HOLD_CANCEL_MS), GESTURE.CANCEL);
  assert.equal(classifyGesture(4), null);
});

/* ---------------- gestures -> beacons ---------------- */

const base = { device_id: 9, timestamp: 1, lat: 1, lon: 2 };

test('beacon: medical, hostile and duress map to distinct codes and flags', () => {
  const med = gestureToBeacon({ gesture: GESTURE.MEDICAL_SOS, ...base });
  const hos = gestureToBeacon({ gesture: GESTURE.HOSTILE_EXTRACTION, ...base });
  const dur = gestureToBeacon({ gesture: GESTURE.DURESS, ...base });
  assert.deepEqual([med.sos_code, med.duress_flag], [SOS.MEDICAL, false]);
  assert.deepEqual([hos.sos_code, hos.duress_flag], [SOS.HOSTILE, false], 'hostile extraction is NOT duress');
  assert.deepEqual([dur.sos_code, dur.duress_flag], [SOS.HOSTILE, true]);
});

test('beacon: cancel is transmitted as sos_code 7 (a cancel nobody hears cancels nothing)', () => {
  const c = gestureToBeacon({ gesture: GESTURE.CANCEL, ...base });
  assert.equal(c.sos_code, SOS.CANCEL);
  assert.equal(sosCodeForGesture(GESTURE.CANCEL), 7);
  assert.equal(gestureToBeacon({ gesture: null, ...base }), null);
});

/* ---------------- haptics ---------------- */

test('haptics: the three confirmations are distinct, well formed, and defensive copies', () => {
  const sig = (e) => JSON.stringify(hapticPattern(e));
  assert.equal(new Set([sig('SENT'), sig('ACK'), sig('DISPATCHED')]).size, 3);
  const total = (e) => hapticPattern(e).reduce((s, x) => s + (x.ms || x.gap || 0), 0);
  assert.ok(total('DISPATCHED') > total('ACK') && total('ACK') > total('SENT'));
  hapticPattern('SENT')[0].ms = 9999;
  assert.equal(hapticPattern('SENT')[0].ms, 90);
  assert.throws(() => hapticPattern('NOPE'));
});

/* ---------------- covert / silent ---------------- */

test('covert: duress and silent mode silence the device; only duress wipes the log', () => {
  const normal = covertPolicy();
  assert.deepEqual([normal.silent, normal.leds, normal.sound], [false, true, true]);
  const duress = covertPolicy({ duress: true });
  assert.deepEqual([duress.silent, duress.leds, duress.sound, duress.wipeLocalLog], [true, false, false, true]);
  const silent = covertPolicy({ silentMode: true });
  assert.deepEqual([silent.silent, silent.leds, silent.sound, silent.wipeLocalLog], [true, false, false, false]);
});

test('covert: burst timing is actually random by default and stays in bounds (regression: it returned one fixed value)', () => {
  const p = covertPolicy({ duress: true });
  const seen = new Set(Array.from({ length: 60 }, () => nextBurstSeconds(p)));
  assert.ok(seen.size > 20, `only ${seen.size} distinct values in 60 draws`);
  assert.ok([...seen].every((v) => v >= 90 && v <= 260));
  assert.equal(nextBurstSeconds(covertPolicy()), 300, 'normal mode is a fixed cadence');
});

test('covert: a seeded rng is reproducible for audit', () => {
  const p = covertPolicy({ duress: true });
  const a = Array.from({ length: 5 }, ((r) => () => nextBurstSeconds(p, r))(seededRng(7)));
  const b = Array.from({ length: 5 }, ((r) => () => nextBurstSeconds(p, r))(seededRng(7)));
  assert.deepEqual(a, b);
});

/* ---------------- PPG ---------------- */

test('ppg: heart rate and SpO2 are recovered from raw red/IR waveforms across the clinical range', () => {
  for (const hr of [38, 45, 60, 75, 100, 130, 160, 190]) {
    for (const spo2 of [78, 85, 90, 95, 99]) {
      const r = analysePPG(synthPPG({ hr, spo2, seed: hr + spo2 }));
      assert.ok(Math.abs(r.heart_rate - hr) <= 2, `hr ${hr}/${spo2} -> ${r.heart_rate}`);
      assert.ok(Math.abs(r.spo2 - spo2) <= 2, `spo2 ${hr}/${spo2} -> ${r.spo2}`);
      assert.ok(r.quality > 0.8);
    }
  }
});

test('ppg: too little signal yields zeros (unknown), never a made-up vital', () => {
  assert.deepEqual(analysePPG({ red: new Float64Array(10), ir: new Float64Array(10), fs: 50 }), { heart_rate: 0, spo2: 0, quality: 0 });
  const flat = { red: new Float64Array(500).fill(1000), ir: new Float64Array(500).fill(1200), fs: 50 };
  assert.equal(analysePPG(flat).heart_rate, 0);
});

test('ppg: the stub sensor read is deterministic and labelled synthetic', () => {
  const a = pollPPG({ seed: 3 });
  assert.deepEqual(a, pollPPG({ seed: 3 }));
  assert.equal(a.source, 'PPG_SYNTHETIC');
  const forced = pollPPG({ hr: 142, spo2: 84 });
  assert.ok(Math.abs(forced.heart_rate - 142) <= 2 && Math.abs(forced.spo2 - 84) <= 2);
});

/* ---------------- mesh ---------------- */

function net(sky = []) {
  const delivered = [];
  const n = new MeshNetwork({ uplink: (env, meta) => delivered.push({ env, meta }) });
  for (const id of ['wristband', 'phone-a', 'phone-b', 'relay-node', 'far-relay']) n.addNode(id, { sky: sky.includes(id) });
  n.link('wristband', 'phone-a').link('phone-a', 'phone-b').link('phone-a', 'relay-node').link('phone-b', 'far-relay');
  return { n, delivered };
}
const pkt = (tag = 1) => Buffer.from([tag, 2, 3, 4, 5, 6, 7, 8]);

test('mesh: a packet hops to the nearest node with sky and is delivered untouched', () => {
  const { n, delivered } = net(['relay-node']);
  const p = pkt();
  const r = n.send(p, 'wristband');
  assert.equal(r.delivered, true);
  assert.deepEqual(r.path, ['wristband', 'phone-a', 'relay-node']);
  assert.equal(r.hops, 2);
  assert.deepEqual(delivered[0].env, p, 'ciphertext is never modified in transit');
});

test('mesh: with no sky the packet is stored, then delivered when a node regains sky', () => {
  const { n, delivered } = net([]);
  const r = n.send(pkt(), 'wristband');
  assert.equal(r.delivered, false);
  assert.equal(r.stored, true);
  assert.ok(r.stored_at.includes('phone-a'));
  assert.equal(delivered.length, 0);
  assert.equal(n.pendingPackets().length, 1);

  const flushed = n.setSky('phone-a', true);
  assert.equal(flushed.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].meta.stored, true);
  assert.equal(n.pendingPackets().length, 0, 'delivered packets leave the queues');
});

test('mesh: the hop limit is enforced (a sky node 4 hops away is out of reach)', () => {
  const chain = new MeshNetwork({ uplink: () => assert.fail('must not deliver') });
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => chain.addNode(id, { sky: id === 'e' }));
  chain.link('a', 'b').link('b', 'c').link('c', 'd').link('d', 'e');
  const r = chain.send(pkt(), 'a'); // a->b->c->d->e is 4 transfers; limit is 3
  assert.equal(MESH_MAX_HOPS, 3);
  assert.equal(r.delivered, false);
});

test('mesh: exactly MESH_MAX_HOPS transfers still delivers', () => {
  const chain = new MeshNetwork({ uplink: () => {} });
  ['a', 'b', 'c', 'd'].forEach((id) => chain.addNode(id, { sky: id === 'd' }));
  chain.link('a', 'b').link('b', 'c').link('c', 'd');
  assert.equal(chain.send(pkt(), 'a').delivered, true);
});

test('mesh: a new link also flushes stored packets', () => {
  const { n, delivered } = net([]);
  n.addNode('drone', { sky: true });
  n.send(pkt(), 'wristband');
  assert.equal(delivered.length, 0);
  n.link('phone-b', 'drone');
  assert.equal(delivered.length, 1);
});

test('mesh: sending from an unknown node is an error', () => {
  assert.throws(() => net().n.send(pkt(), 'ghost'), /unknown node/);
});

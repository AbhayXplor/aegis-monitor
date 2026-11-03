# Device layer contract: wristband, haptics, mesh, covert mode

Status: **logic implemented and unit-tested in `src/wristband.mjs` and `src/mesh.mjs`; no
firmware, no radio driver.** Everything hardware-facing is a stub behind a function.

## Button state machine (screenless)

`ButtonMachine` consumes timed `down` / `up` / `tick` events. A sequence of rapid presses ends
**700 ms after the last release** (`GAP_MS`), so five presses never fire as three.

| Input | Gesture | Beacon |
|---|---|---|
| 3 presses | `MEDICAL_SOS` | `sos_code = 1` (MEDICAL), `duress_flag = false` |
| 5 presses | `HOSTILE_EXTRACTION` | `sos_code = 3` (HOSTILE), `duress_flag = false` -> triage `COMBAT_EXTRACTION`, P2 |
| 7 presses | `DURESS` | `sos_code = 3`, `duress_flag = true` -> `HOSTAGE_COVERT`, P1, `HAPTIC_ACK_ONLY` |
| Hold 10 s | `CANCEL` | `sos_code = 7` packet (see below). Fires at the 10 s mark while still held. |

**ASSUMPTION:** the brief names the duress sequence but not its form. Seven rapid presses is used:
distinct from 3 and 5 and unlikely by accident. Change `PRESSES.DURESS` if the product differs.
Hostile extraction and duress are deliberately different gestures (brief §2.A.3 vs §2.A.4): a
hostile-extraction call is audible/visible to the dispatcher; duress is covert.

1, 2, 4, 6 and 8+ presses are ignored on purpose.

### Cancel is a packet

A cancel the server never hears about cancels nothing, so the 10 s hold transmits `sos_code = 7`.
- Before a unit is assigned, from a non-covert device: the incident closes as a false alarm (actor `device`).
- After assignment, **or** from a duress / silent-mode device: it becomes a *cancel request* the
  dispatcher must confirm. A cancel can be coerced; it is never trusted from a covert device.

## Haptics

| Event | Pattern | Meaning | Produced by |
|---|---|---|---|
| `SENT` | 90 ms | packet left the device | device, on gesture |
| `ACK` | 60 ms, 70 ms gap, 60 ms | ground station acknowledged | server, queued on **every** accepted packet |
| `DISPATCHED` | 250 ms, 120 ms gap, 250 ms | a unit was assigned | server, queued on `UNIT_ASSIGNED` |
| `CANCELLED` | 400 ms at 40% | cancel processed | server |

Server-originated events go to the per-device **downlink outbox**, which the satellite gateway
drains with `POST /api/v1/devices/{id}/downlink/pull`. Haptics are always allowed, including on
covert devices (vibration is not a LED or a sound).

## Silent / covert mode

Two independent triggers, both forcing `user_satellite_reply = HAPTIC_ACK_ONLY` and refusing any text downlink:
- `duress_flag` in the packet (per incident);
- `silent_mode` on the device record (`PUT /api/v1/devices/{id}`), the brief's "Silent Beacon" setting.
  `silent_mode` is NOT in the 100-byte packet; it is device provisioning state held by the server.

Policy when covert: LEDs off, sound off, burst interval jittered over **90-260 s** using a
**cryptographically random** draw (a seedable RNG is injectable for audit only). The local log wipe
is a **duress** action, not part of plain silent mode.

**Dual-use note.** Randomised burst timing defeats hostile radio direction finding. It also makes a
beacon harder for lawful search to locate. It is exposed as a policy object; **no RF behaviour is
implemented here**, and enabling it in a product needs legal/export-control review.

## Store-and-forward mesh (`MeshNetwork`)

```
wristband -> phone-a -> relay-node (sky) -> satellite
```

- Hops are transfers between nodes, bounded by `MESH_MAX_HOPS = 3`.
- The ciphertext is never re-encrypted or modified; only transport metadata (hop count, path) is added.
- With **no** sky-visible node in reach, the packet is **stored** at every node holding it and delivered
  later, when a node gains sky (`setSky`) or a new link appears. Delivered packets leave the queues.
- Duplicates (several paths, several gateways) are expected; ingest drops them by envelope id.
- Because delivery can be hours late, the server accepts beacons up to 24 h old (`AEGIS_MAX_AGE_S`) and
  reports the age on the incident; replay is a separate per-device monotonic-timestamp check.
- STUB: no BLE or LoRa driver, no routing table, no collision handling, no duty-cycle budget.

## PPG

`analysePPG({red, ir, fs})` is a real algorithm: mean-removed, lightly smoothed IR peak detection for
heart rate, ratio-of-ratios (`SpO2 = 110 - 25 R`) for oxygen, and a regularity `quality` score. It
recovers HR within 2 bpm and SpO2 within 2 points on synthetic waveforms from 38-190 bpm and 75-99%.
**LIMITS:** it assumes little baseline wander; a real sensor needs a band-pass filter, motion-artefact
rejection, and per-sensor SpO2 calibration. `pollPPG()` is the **stub sensor read**: it synthesizes a
deterministic waveform and pushes it through the real analysis. Unknown vitals are reported as 0, never invented.

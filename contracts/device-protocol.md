# Device layer contract — wristband, haptics, mesh, covert mode

Status: **logic implemented and unit-tested in `src/wristband.mjs`; no firmware, no
radio driver.** Everything hardware-facing is a stub behind a function.

## Gestures (screenless)

| Input | Gesture | Beacon |
|---|---|---|
| 3 presses within 1.8 s | `MEDICAL_SOS` | `sos_code = 2` (TRAUMA), `duress_flag = false` |
| 5 presses within 1.8 s | `HOSTILE_EXTRACTION` | `sos_code = 3` (HOSTILE), `duress_flag = true` |
| Hold 10 s | `CANCEL` | no packet is sent |

1, 2 and 4 presses are ignored on purpose — no accidental activation, no accidental
kill switch.

## Haptics

| Event | Pattern | Meaning |
|---|---|---|
| `SENT` | 90 ms | packet left the device |
| `ACK` | 60 ms · 70 ms gap · 60 ms | satellite/ground station acknowledged |
| `DISPATCHED` | 250 ms · 120 ms gap · 250 ms | rescue tasking confirmed |
| `CANCELLED` | 400 ms at 40% amplitude | user cancelled |

The three confirmation rhythms are deliberately different in length and gap so a
wearer can distinguish them through fabric without a screen.

## Covert mode

When `duress_flag` is set:

- LEDs off, sound off, no visible or audible state change.
- Local device log is wiped after the packet is queued.
- Burst interval moves from a fixed 300 s to a jittered **90–260 s**, driven by a
  seedable PRNG so every interval is reproducible in an audit.

**Dual-use note.** Randomised burst timing defeats hostile radio direction finding.
It also makes a beacon harder for lawful search to locate. The policy object is
exposed and auditable, but **no RF behaviour is implemented here**, and enabling it in
a product needs legal/export-control review.

## Store-and-forward mesh

```
wristband -> phone-a -> relay-node -> satellite
```

- Transport is BLE or LoRa; the **ciphertext is never re-encrypted** in transit.
- Hop limit is **3** (`MESH_MAX_HOPS`); beyond that the packet is dropped, not queued forever.
- Mesh is a fallback for no sky visibility (rubble, indoors, urban canyon).
- STUB: no BLE or LoRa driver, no routing table, no collision handling, no duty-cycle budget.

## PPG

`pollPPG(seed)` is a **stub**: deterministic values so the payload path is exercised.
A real implementation reads the sensor, rejects motion artefacts, and reports quality —
the `quality` field exists for that reason.

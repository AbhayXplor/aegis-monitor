# AegisMonitor — aegis-core-service v0.1

Satellite distress beacons in, triaged dispatch incidents out. Encrypted ingest,
25 km context slice, deterministic triage with citations, CAD state machine with a
full audit trail, and a live panel.

**Everything in here is synthetic.** No live satellite provider, no patient data, no
conflict data, no real credentials. That is a hard rule, not a shortcut.

---

## Quickstart

```bash
cd aegis
npm start          # http://localhost:3001  (panel at /, WebSocket at /ws)
npm test           # 24 tests, node:test, no dependencies
```

Zero third-party packages. Node 20+ only. There is no `npm install` step because
there is nothing to install — `node_modules` does not exist and is not needed.

Then open <http://localhost:3001>, click **▶ SIMULATE BEACON**. A synthetic device
appears with vitals, a 25 km hazard ring, routed assets, grounded guidance and a
160-character downlink. Press **▶ DURESS** to see covert mode.

## Status — read this before believing any claim

| Piece | Status | Where |
|---|---|---|
| Protobuf wire codec, <100 B cap | **IMPLEMENTED + TESTED** | `src/proto.mjs` |
| AES-256-GCM envelope, key ids | **IMPLEMENTED + TESTED** (dev keyring generated in process) | `src/crypto.mjs` |
| Replay guard (±300 s, per device) | **IMPLEMENTED + TESTED** | `src/crypto.mjs` |
| Ingest gateway | **IMPLEMENTED + TESTED** | `src/server.mjs` |
| CAD state machine + audit | **IMPLEMENTED + TESTED** | `src/state.mjs` |
| Deterministic triage + rule priorities | **IMPLEMENTED + TESTED** | `src/triage.mjs` |
| Grounded guidance (local KB) | **IMPLEMENTED** — 9 authored chunks, no copyrighted text | `src/triage.mjs` |
| Route deconfliction vs hazard polygons | **IMPLEMENTED** — geometric, on fixture polygons | `src/triage.mjs` |
| 25 km geo-context | **MOCK** — deterministic fixtures, no WorldMonitor MCP call | `src/geo.mjs` |
| Panel (incident list, ring, downlink) | **IMPLEMENTED** — standalone page, not a WorldMonitor extension | `public/index.html` |
| WebSocket push | **IMPLEMENTED** — minimal RFC6455 server→client | `src/ws.mjs` |
| Gemma 4 / Ollama triage | **DISABLED SEAM** — no key, no endpoint; may only rewrite wording | `src/triage.mjs` |
| RAG vector store (pgvector) | **NOT BUILT** — KB is an array, retrieval is topic match | — |
| PostgreSQL / PostGIS / Redis | **NOT BUILT** — in-memory store, single process | `src/server.mjs` |
| CBOR fallback codec | **NOT BUILT** — seam documented in `contracts/telemetry.proto` | — |
| WorldMonitor UI extension | **NOT BUILT** — AGPL decoupling means REST/WS only | — |
| Wristband firmware, BLE/LoRa relay | **STUB** — gesture machine described, no code | — |
| Offline quantised model on phone | **NOT BUILT** | — |

If it is not in the left column as IMPLEMENTED, do not say it works.

## Contracts (Phase 0)

- `contracts/telemetry.proto` — beacon message, field numbers, enum, envelope layout
- `contracts/triage-output.schema.json` — strict JSON Schema for engine output
- `contracts/openapi.yaml` — REST surface + WebSocket event list
- `contracts/cad-state-machine.md` — states, transition table, actors, side effects

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/sat-ingest` | Binary envelope (`application/octet-stream`) or `{envelope_base64}` |
| POST | `/api/v1/dev/simulate` | **DEV** build + encrypt + ingest a synthetic beacon |
| GET | `/api/v1/incidents` | Panel list |
| GET | `/api/v1/incidents/:id` | Full record: triage, context, audit |
| POST | `/api/v1/incidents/:id/transition` | `{to, actor, reason}` |
| POST | `/api/v1/incidents/:id/downlink` | `{text}` ≤160 ASCII |
| GET | `/api/v1/health` | Counters, key ids, honest feature flags |
| WS | `/ws` | `INCIDENT_CREATED`, `INCIDENT_TRIAGED`, `INCIDENT_STATE`, `DOWNLINK_QUEUED` |

## AGPL decoupling

`worldmonitor` is AGPL-3.0. This service does not link, import, vendor or embed any of
it, and it has no build-time dependency on it. The only allowed integration is:

```
panel  <-- WebSocket / REST -->  aegis-core-service  <-- MCP/REST -->  worldmonitor
```

`src/geo.mjs` holds the single seam (`fetchSlice`). Nothing AGPL-derived is copied into
this repository. If a future version embeds a WorldMonitor component, this repository
inherits AGPL-3.0 and must say so at the top of the file that does it.

## Security notes

- AES-256-GCM provides confidentiality **and** authenticity. The GCM tag is the
  signature check; a second MAC over the same bytes would add nothing.
- Keys are per-device-id (`k1`, `k2` in dev) and generated **in process at boot**, so
  every restart rotates them. A real deployment loads a PSK ring from a KMS or the
  device secure element. **TODO:** key rotation policy, per-key revocation, HSM/KMS.
- Plaintext telemetry and keys are never logged. Audit entries contain state, actor,
  reason and timestamps only.
- Replay protection is a ±300 s window plus a monotonic per-device timestamp.
- **TODO:** no authentication on the transition or downlink endpoints yet. Anyone who
  can reach the port can dispatch. That is acceptable for a local demo and unacceptable
  anywhere else; the fix is signed dispatcher tokens and unit→asset binding.

## Tests

```bash
npm test
```

Covers: protobuf roundtrip (including negative coordinates and zigzag), the <100 B cap,
oversize rejection, range validation, encrypt/decrypt, tamper detection, wrong key id,
replay rejection, stale timestamp rejection, legal and illegal state transitions,
wrong-actor refusal, P1/P2/P3 rules, covert mode, all seven SOS categories producing a
legal ASCII downlink, `CONTEXT_MISSING` behaviour (no invention), geo-context caching,
the HTTP path end to end, tampered-envelope refusal at the gateway, replay refusal at
the gateway, and the health endpoint reporting honest feature flags.

## Assumptions and open questions

1. **WorldMonitor MCP shape is unknown.** `fetchSlice` returns fixtures. What are the
   real tool names, the 25 km query parameters, and the response schema? Until answered,
   everything downstream of `GeoContext` is exercised against a mock.
2. **Iridium / Swarm / NTN specifics are stubbed.** Which constellation, what packet
   budget in bytes per day, what downlink latency, and is there a per-device provisioning
   API? The 100-byte cap is our assumption, not a provider guarantee.
3. **Priority thresholds are engineering defaults** (SpO2 < 90, HR > 130 or < 45,
   battery < 15). They are not clinically validated. Who signs off on triage thresholds
   — a medical director, a TCCC instructor, both?
4. **The KB is authored excerpts**, not the full TCCC/WHO/Wilderness EMS corpus. Full
   texts have licence terms; we deliberately did not copy them.
5. **Per-device key provisioning** to a wristband is unsolved here.

## Dual-use flag

Covert duress mode invites a request for **transmit-timing randomisation** to defeat
direction finding, and for "listen-only" behaviour. Both are dual-use: legitimate for
hostage survival, also useful for evading lawful detection. Not implemented. It needs a
legal/export-control review before anyone builds it, and the `HAPTIC_ACK_ONLY` reply is
deliberate — covert incidents never receive detail over the downlink.

## Build order, honestly

Phase 0 contracts: **done.** Phase 1 ingest: **done.** Phase 2 context: **mocked.**
Phase 3 triage: **deterministic core done, LLM seam disabled.** Phase 4 panel: **done,
standalone.** Phase 5 edge layer: **stub only.**

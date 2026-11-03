# AegisMonitor — aegis-core-service v0.1

Satellite distress beacons in, triaged dispatch incidents out. Encrypted binary ingest,
wristband gesture pipeline, mesh fallback, 25 km context slice, triage to the brief §3
schema, biometric re-ranking, CAD state machine with audit, and a live panel.

**Everything here is synthetic.** No live satellite provider, no patient data, no conflict
data, no real credentials. That is a hard rule, not a shortcut.

---

## Quickstart

```bash
cd aegis
npm start          # http://localhost:3001  (panel at /, WebSocket at /ws)
npm test           # node:test, zero dependencies
```

Node 20+. There is no `npm install` step because there is nothing to install.

Open the panel and press:

- **3-PRESS · MEDICAL** → `MEDICAL_SOS`, `sos_code=2`, PPG sampled, packet sealed, triaged
- **5-PRESS · HOSTILE** → `HOSTILE_EXTRACTION`, `duress_flag=true`, covert mode, `HAPTIC_ACK_ONLY`
- **MESH RELAY (2 HOPS)** → same ciphertext relayed phone → relay node → satellite
- **PLAIN BEACON** → straight ingest with no gesture

## Output contract (brief §3) — exactly these keys

```
incident_id · priority_level (1-5) · triage_category · physiological_status
hazard_assessment · deconflicted_route_plan · dispatcher_checklist[3] · user_satellite_reply
```

`additionalProperties: false` in `contracts/triage-output.schema.json`. The engine may not
add fields. Protocol citations are returned **outside** the triage object as `grounding`,
because provenance is not model output.

| Field | How it is produced |
|---|---|
| `priority_level` | rules: duress → 1; SpO2 < 90 → 1; HR > 130 or < 45 → 1; medical/trauma/childbirth → 2; unknown → 3; evacuation → 4; supply → 5 |
| `triage_category` | rules: duress → `HOSTAGE_COVERT`; hostile → `COMBAT_EXTRACTION`; water → `SUPPLY_DROP`; unknown → `SAR`; else `MEDEVAC` |
| `physiological_status` | HR/SpO2/battery plus a severity phrase |
| `hazard_assessment` | only hazards and weather present in the 25 km slice; `CONTEXT_MISSING` when absent |
| `deconflicted_route_plan` | transport mode (GROUND / HELI / DRONE), chosen asset + ETA, computed compass approach vector, and the exact zones to avoid |
| `dispatcher_checklist` | exactly 3 imperative steps, category and hazard aware |
| `user_satellite_reply` | imperative ASCII ≤ 160, or the literal `HAPTIC_ACK_ONLY` for covert |

## Status — read this before believing any claim

| Piece | Status | Where |
|---|---|---|
| Protobuf codec, <100 B cap | **IMPLEMENTED + TESTED** | `src/proto.mjs` |
| AES-256-GCM envelope, key ids | **IMPLEMENTED + TESTED** (in-process dev keyring) | `src/crypto.mjs` |
| Replay guard (±300 s, per device) | **IMPLEMENTED + TESTED** | `src/crypto.mjs` |
| Ingest gateway | **IMPLEMENTED + TESTED** | `src/server.mjs` |
| Wristband gestures (3 / 5 / hold 10 s) | **IMPLEMENTED + TESTED** | `src/wristband.mjs` |
| Haptic patterns (sent / ack / dispatched / cancelled) | **IMPLEMENTED + TESTED** | `src/wristband.mjs` |
| PPG sampling | **STUB** — deterministic stand-in, no sensor | `src/wristband.mjs` |
| Covert policy (silent, LED/sound off, jitter 90–260 s, log wipe) | **IMPLEMENTED + TESTED** — policy object only, **no RF code** | `src/wristband.mjs` |
| Mesh store-and-forward, hop limit 3 | **STUB + TESTED** — no BLE/LoRa driver | `src/wristband.mjs` |
| 25 km geo-context | **MOCK** — fixtures, no WorldMonitor MCP call | `src/geo.mjs` |
| Triage to brief schema | **IMPLEMENTED + TESTED** | `src/triage.mjs` |
| Route deconfliction + compass vector | **IMPLEMENTED + TESTED** (geometric, fixture polygons) | `src/triage.mjs` |
| Biometric re-ranking | **IMPLEMENTED + TESTED** | `src/triage.mjs` |
| CAD state machine + audit | **IMPLEMENTED + TESTED** | `src/state.mjs` |
| Panel: P1–P5, checklist, route plan, battery ETA, gestures | **IMPLEMENTED** | `public/index.html` |
| WebSocket push (4 event types + re-rank) | **IMPLEMENTED + TESTED end to end** | `src/ws.mjs` |
| Gemma 4 via Ollama, Modelfile | **DISABLED SEAM** — `contracts/Modelfile` ready, no key/endpoint here | `src/triage.mjs` |
| RAG vector store (pgvector) | **NOT BUILT** — KB is an array, retrieval is topic match | — |
| PostgreSQL / PostGIS / Redis | **NOT BUILT** — in-memory, single process | `src/server.mjs` |
| CBOR fallback | **NOT BUILT** — seam noted in `contracts/telemetry.proto` | — |
| WorldMonitor UI extension | **NOT BUILT** — AGPL decoupling means REST/WS only | — |
| Firmware, radio driver, on-device quantised model | **NOT BUILT** | — |

If it is not IMPLEMENTED above, do not claim it works.

## Contracts

- `contracts/telemetry.proto` — beacon message, enums, envelope layout
- `contracts/triage-output.schema.json` — strict brief §3 output schema
- `contracts/Modelfile` — Gemma 4 system prompt, **verbatim from the brief**
- `contracts/cad-state-machine.md` — states, transition table, actors
- `contracts/device-protocol.md` — gestures, haptics, covert policy, mesh, PPG
- `contracts/openapi.yaml` — REST surface + WebSocket event list

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/sat-ingest` | Binary envelope or `{envelope_base64}` |
| POST | `/api/v1/dev/simulate` | **DEV** synthetic beacon |
| POST | `/api/v1/dev/wristband` | **DEV** presses → gesture → PPG → packet → triage |
| POST | `/api/v1/dev/mesh` | **DEV** relay through N hops, then ingest |
| GET | `/api/v1/incidents` · `/api/v1/incidents/:id` | List / full record |
| POST | `/api/v1/incidents/:id/transition` | `{to, actor, reason}` |
| POST | `/api/v1/incidents/:id/downlink` | `{text}` ≤160 ASCII; **refuses anything but `HAPTIC_ACK_ONLY` on covert incidents** |
| GET | `/api/v1/health` | Counters, key ids, honest feature flags |
| WS | `/ws` | `INCIDENT_CREATED`, `INCIDENT_TRIAGED`, `INCIDENT_RERANKED`, `INCIDENT_STATE`, `DOWNLINK_QUEUED` |

## AGPL decoupling

`worldmonitor` is AGPL-3.0. This service does not link, import, vendor or embed any of it.
The only integration surface is REST + WebSocket, and the single seam is `fetchSlice` in
`src/geo.mjs`. Nothing AGPL-derived is copied into this repository. If a future version
embeds a WorldMonitor component, that file inherits AGPL-3.0 and must say so at the top.

## Security notes

- AES-256-GCM gives confidentiality **and** authenticity; the GCM tag is the signature check.
- Keys are per key-id and generated **in process at boot**, so every restart rotates the dev
  ring. **TODO:** KMS/secure-element PSK ring, rotation policy, revocation.
- Plaintext telemetry and keys are never logged. Audit entries hold state, actor, reason, time.
- Replay: ±300 s window plus monotonic per-device timestamp.
- **TODO:** no authentication on transition or downlink endpoints. Anyone who can reach the
  port can dispatch. Local demo only; fix is signed dispatcher tokens + unit→asset binding.

## Tests

```bash
npm test
```

Covers: protobuf roundtrip (including negative coords), the <100 B cap, oversize rejection,
range validation, encrypt/decrypt, tamper and forged-key detection, replay and stale-window
rejection, legal/illegal state transitions, wrong-actor refusal, the exact §3 key set, P1–P5
mapping, all five triage categories, covert haptic-only reply, 3-item checklists, ASCII and
160-char downlink limits on all seven SOS codes, `CONTEXT_MISSING` without invention, compass
bearing correctness, re-ranking escalation, gesture classification (including that 4 presses
does nothing), haptic distinctness, covert policy and jitter bounds, PPG determinism, mesh hop
limits, the full HTTP path, wristband and mesh endpoints, covert downlink refusal, tampered
envelope refusal, replay refusal and honest health flags.

## Assumptions and open questions

1. **WorldMonitor MCP shape unknown** — real tool names, 25 km query parameters and response
   schema are still needed; `fetchSlice` returns fixtures.
2. **Constellation unknown** — Iridium SBD, Swarm, or NTN? Bytes/day budget, downlink latency
   and provisioning API decide whether the 100-byte cap is right.
3. **Priority thresholds are engineering defaults**, not clinically validated. Who signs off?
4. **The KB is 12 authored excerpts** — real TCCC/WHO/Wilderness EMS text has licence terms.
5. **No firmware** — gestures, haptics and covert policy are tested logic, not a device.

## Dual-use flag

Covert mode asks for RF burst randomisation to defeat direction finding, and log wiping.
Both are implemented as **policy objects with a seedable clock** — auditable, with **no RF
code in this repo**. They need legal/export-control review before shipping. Covert incidents
also cannot receive a plaintext downlink at all; the API refuses it.

## Model pass (optional)

Rules run first and act as a safety floor. A model may then improve the write-up,
but it can never lower urgency, unlock a covert incident, or name an asset that is
not in the supplied 25 km context — violations are rejected and the rule plan is
restored.

```bash
AEGIS_LLM=1
AEGIS_LLM_PROVIDER=openai        # or ollama
AEGIS_LLM_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
AEGIS_LLM_MODEL=gemini-3.5-flash-lite
AEGIS_LLM_FALLBACK=gemini-flash-lite-latest,gemini-3.1-flash-lite
AEGIS_LLM_KEY=...                # server-side only, never sent to the browser
```

Verified against Gemini's OpenAI-compatible endpoint: `gemini-3.5-flash-lite`
returns schema-valid JSON in roughly 600 ms. During testing `gemma-4-31b-it`
returned a server-side 500 and `gemini-3.1-flash-lite` was rate-limited (503), so
both are wired as fallbacks instead of defaults. Transient 429/5xx responses are
retried once, then the chain moves on. With no endpoint configured the service is
fully deterministic and the panel header reads RULES ONLY.

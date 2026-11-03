# CAD state machine — v0.1

Every incident has exactly one state. Every transition is recorded in
`incident.audit[]` with `{ incident_id, from, to, actor, reason, at }`.

## States

| State | Meaning |
|---|---|
| `SOS_RECEIVED` | Encrypted beacon authenticated and decoded. Nothing triaged yet. |
| `AI_TRIAGED` | Priority, category, grounding and route assessment attached. |
| `UNIT_ASSIGNED` | A named asset owns the incident. |
| `EN_ROUTE` | Asset has departed toward the survivor. |
| `EXTRACTED` | Survivor is in the asset's care. |
| `CLOSED` | Incident closed, with reason. |

## Transition table

| From | To | Actors | Side effects |
|---|---|---|---|
| `SOS_RECEIVED` | `AI_TRIAGED` | `system` | triage JSON attached, panel event `INCIDENT_TRIAGED` |
| `SOS_RECEIVED` | `CLOSED` | `dispatcher` | reason required (duplicate / false alarm) |
| `AI_TRIAGED` | `UNIT_ASSIGNED` | `dispatcher` | `recommended_asset` may be overridden |
| `AI_TRIAGED` | `CLOSED` | `dispatcher` | reason required |
| `UNIT_ASSIGNED` | `EN_ROUTE` | `unit`, `dispatcher` | ETA starts counting |
| `UNIT_ASSIGNED` | `CLOSED` | `dispatcher` | reason required |
| `EN_ROUTE` | `EXTRACTED` | `unit`, `dispatcher` | extraction timestamp |
| `EN_ROUTE` | `CLOSED` | `dispatcher` | reason required |
| `EXTRACTED` | `CLOSED` | `dispatcher` | incident archived |

## Rules

- Illegal transitions return `409` and do not mutate state.
- Actors are strings in v0.1; there is no auth on the transition endpoint yet.
  **PROPOSED:** signed dispatcher tokens, `unit` bound to a specific asset id.
- A transition never deletes history; `audit[]` is append-only.
- The triage engine may only move `SOS_RECEIVED -> AI_TRIAGED`. It can never
  assign a unit or close an incident.

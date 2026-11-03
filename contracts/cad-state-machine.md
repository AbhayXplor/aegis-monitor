# CAD state machine v0.2

Every incident has exactly one state. Every transition is recorded in `incident.audit[]` with
`{ incident_id, from, to, actor, reason, at }`.

## One living incident per device

A new packet from a device that already has an **open** incident (`SOS_RECEIVED`, `AI_TRIAGED`,
`UNIT_ASSIGNED`, `EN_ROUTE`) **updates** it: the sample is appended to `history`, the incident is
re-triaged, and the queue is re-ranked. After `EXTRACTED` or `CLOSED` a new packet opens a new incident.

## States

| State | Meaning |
|---|---|
| `SOS_RECEIVED` | Beacon authenticated, decoded and stored. Not yet triaged. |
| `AI_TRIAGED` | Priority, category, grounding and route assessment attached. |
| `UNIT_ASSIGNED` | A named asset owns the incident (`assigned_unit`). |
| `EN_ROUTE` | Asset has departed toward the survivor. |
| `EXTRACTED` | Survivor is in the asset's care. |
| `CLOSED` | Incident closed, with a reason. |

## Transition table

| From | To | Actors | Side effects |
|---|---|---|---|
| `SOS_RECEIVED` | `AI_TRIAGED` | `system` | triage attached, `INCIDENT_TRIAGED` |
| `SOS_RECEIVED` | `CLOSED` | `dispatcher`, `device` | `device` = wristband cancel (non-covert only) |
| `AI_TRIAGED` | `UNIT_ASSIGNED` | `dispatcher` | unit recorded (defaults to recommended asset); DISPATCHED haptic queued |
| `AI_TRIAGED` | `CLOSED` | `dispatcher`, `device` | as above |
| `UNIT_ASSIGNED` | `EN_ROUTE` | `unit`, `dispatcher` | |
| `UNIT_ASSIGNED` | `CLOSED` | `dispatcher` | a wristband cancel here is only a *request* |
| `EN_ROUTE` | `EXTRACTED` | `unit`, `dispatcher` | |
| `EN_ROUTE` | `CLOSED` | `dispatcher` | |
| `EXTRACTED` | `CLOSED` | `dispatcher` | |

## Priority and re-ranking

- P1 if: duress; SpO2 < 90; HR > 130; HR < 45. Otherwise by SOS code: medical / trauma / childbirth / hostile = P2,
  unspecified = P3, evacuation = P4, water = P5. (Engineering defaults, **not clinically validated**.)
- **Deterioration** between the two newest packets within 30 min (SpO2 down >= 3, HR up >= 20 and > 100, or HR
  collapse) escalates one level. It is recorded in `priority_log` with its reasons.
- Urgency **never relaxes by itself**. A dispatcher may lower it (`POST .../priority`), but never below what the
  vitals or duress demand.
- The queue orders open incidents by priority, then deteriorating first, then longest waiting. `INCIDENT_RERANKED`
  reports every incident whose priority **or position** changed, including the ones that were displaced.

## Rules

- Illegal transitions return `409` and do not mutate state. `audit[]` is append-only.
- The triage engine may only move `SOS_RECEIVED -> AI_TRIAGED`; it can never assign a unit or close an incident.
- A wristband **cancel** closes an unassigned, non-covert incident; in every other case it sets `cancel_request`
  and a dispatcher confirms or rejects it (`POST .../cancel`).
- **TODO:** `actor` is still a caller-supplied string. With `AEGIS_DISPATCH_TOKEN` set, only token holders can reach the
  endpoints, but there are no per-user identities and no unit-to-asset binding for the `unit` actor.

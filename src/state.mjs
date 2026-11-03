// CAD incident lifecycle. Every transition records actor, timestamp and reason.

export const STATES = [
  'SOS_RECEIVED',
  'AI_TRIAGED',
  'UNIT_ASSIGNED',
  'EN_ROUTE',
  'EXTRACTED',
  'CLOSED',
];

// A state is "open" while the survivor still needs the system (a new packet from the
// same device updates it rather than creating a duplicate incident).
export const OPEN_STATES = ['SOS_RECEIVED', 'AI_TRIAGED', 'UNIT_ASSIGNED', 'EN_ROUTE'];

// from -> to -> allowed actors.
// 'device' may close only before any unit is committed: after assignment a cancel from
// the wristband is a request the dispatcher must confirm (the wearer may be coerced).
export const TRANSITIONS = {
  SOS_RECEIVED: { AI_TRIAGED: ['system'], CLOSED: ['dispatcher', 'device'] },
  AI_TRIAGED: { UNIT_ASSIGNED: ['dispatcher'], CLOSED: ['dispatcher', 'device'] },
  UNIT_ASSIGNED: { EN_ROUTE: ['unit', 'dispatcher'], CLOSED: ['dispatcher'] },
  EN_ROUTE: { EXTRACTED: ['unit', 'dispatcher'], CLOSED: ['dispatcher'] },
  EXTRACTED: { CLOSED: ['dispatcher'] },
  CLOSED: {},
};

export function canTransition(from, to, actor) {
  const allowed = TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: `unknown state ${from}` };
  const actors = allowed[to];
  if (!actors) return { ok: false, reason: `illegal transition ${from} -> ${to}` };
  if (!actors.includes(actor)) {
    return { ok: false, reason: `actor '${actor}' may not perform ${from} -> ${to} (allowed: ${actors.join(', ')})` };
  }
  return { ok: true };
}

export function applyTransition(incident, to, actor, reason, now = new Date().toISOString()) {
  const check = canTransition(incident.state, to, actor);
  if (!check.ok) return { ok: false, reason: check.reason };
  const entry = { incident_id: incident.id, from: incident.state, to, actor, reason, at: now };
  incident.state = to;
  incident.audit.push(entry);
  return { ok: true, entry };
}

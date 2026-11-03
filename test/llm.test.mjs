import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { enhance, llmConfig, systemPrompt, enforceFloors, validateShape } from '../src/llm.mjs';
import { triage } from '../src/triage.mjs';
import { geoContext, _clearCache } from '../src/geo.mjs';

const incident = {
  id: 'INC-0007', device_id: 0x4b21, sos_code: 2,
  position: { lat: 25.2048, lon: 55.2708, altitude_m: 0 },
  vitals: { heart_rate: 141, spo2: 86, battery_pct: 50, duress_flag: false },
  received_at: new Date().toISOString(),
};

const modelOut = (over = {}) => ({
  incident_id: 'INC-0007',
  priority_level: 2,                     // less urgent than the rule floor (1)
  triage_category: 'MEDEVAC',
  physiological_status: 'HR 141, SpO2 86. Critical.',
  hazard_assessment: 'Conflict reported to the north.',
  deconflicted_route_plan: 'HELI via Field Hospital 1 (ETA 20 min). APPROACH 300° WNW. AVOID CONFLICT.',
  dispatcher_checklist: ['Task asset.', 'Pre-alert hospital.', 'Re-check vector.'],
  user_satellite_reply: 'ACK P1. STAY STILL. HELP EN ROUTE.',
  ...over,
});

/** A stub chat endpoint so the adapter is tested without any key. */
async function withStub(replyFn, fn) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const content = replyFn(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const saved = { ...process.env };
  process.env.AEGIS_LLM = '1';
  process.env.AEGIS_LLM_PROVIDER = 'openai';
  process.env.AEGIS_LLM_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.AEGIS_LLM_MODEL = 'stub-model';
  try {
    await fn();
  } finally {
    process.env = saved;
    await new Promise((r) => server.close(r));
  }
}

test('llm: disabled by default, so the rule engine is the only path', () => {
  const cfg = llmConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.keyPresent, false);
});

test('llm: system prompt is read verbatim from the Modelfile', () => {
  const p = systemPrompt();
  assert.match(p, /AegisMonitor Tactical & Medical Rescue AI Core/);
  assert.match(p, /ZERO HALLUCINATION & PROTOCOL ADHERENCE/);
  assert.match(p, /HAPTIC_ACK_ONLY/);
  assert.match(p, /<= 160 ASCII characters/);
});

test('llm: shape validation catches missing and extra keys', () => {
  assert.equal(validateShape(modelOut()), null);
  assert.match(validateShape({ ...modelOut(), extra: 1 }), /extra keys/);
  const { user_satellite_reply, ...missing } = modelOut();
  assert.match(validateShape(missing), /missing keys/);
});

test('llm: a valid model reply is used, with urgency raised to the rules floor', async () => {
  _clearCache();
  const context = await geoContext(incident.position.lat, incident.position.lon);
  const { triage: ruleTriage, grounding } = await triage({ incident, context });
  assert.equal(ruleTriage.priority_level, 1, 'rules floor is P1 for SpO2 86');

  await withStub(() => JSON.stringify(modelOut()), async () => {
    const r = await enhance({ incident, ruleTriage, grounding, context });
    assert.equal(r.used, 'llm');
    assert.equal(r.triage.priority_level, 1, 'model said 2, floor forces 1');
    assert.ok(r.notes.some((n) => /raised/.test(n)));
    assert.equal(r.triage.incident_id, 'INC-0007');
    assert.ok(r.triage.user_satellite_reply.length <= 160);
  });
});

test('llm: an invented asset is rejected and the rule plan is restored', async () => {
  _clearCache();
  const context = await geoContext(incident.position.lat, incident.position.lon);
  const { triage: ruleTriage, grounding } = await triage({ incident, context });

  await withStub(
    () => JSON.stringify(modelOut({ deconflicted_route_plan: 'HELI via Al Noor Trauma Center (ETA 9 min). APPROACH 300° WNW.' })),
    async () => {
      const r = await enhance({ incident, ruleTriage, grounding, context });
      assert.equal(r.used, 'llm');
      assert.ok(r.notes.some((n) => /invented asset/.test(n)));
      assert.ok(!r.triage.deconflicted_route_plan.includes('Al Noor'));
      assert.equal(r.triage.deconflicted_route_plan, ruleTriage.deconflicted_route_plan);
    }
  );
});

test('llm: invalid JSON falls back to rules instead of failing the incident', async () => {
  _clearCache();
  const context = await geoContext(incident.position.lat, incident.position.lon);
  const { triage: ruleTriage, grounding } = await triage({ incident, context });

  await withStub(() => 'Sorry, I cannot help with that.', async () => {
    const r = await enhance({ incident, ruleTriage, grounding, context });
    assert.equal(r.used, 'rules');
    assert.match(r.reason, /non-JSON/);
    assert.deepEqual(r.triage, ruleTriage);
  });
});

test('llm: covert incidents can never be talked out of covert mode', async () => {
  _clearCache();
  const covert = { ...incident, sos_code: 3, vitals: { ...incident.vitals, duress_flag: true, spo2: 95, heart_rate: 100 } };
  const context = await geoContext(incident.position.lat, incident.position.lon);
  const { triage: ruleTriage, grounding } = await triage({ incident: covert, context });
  assert.equal(ruleTriage.triage_category, 'HOSTAGE_COVERT');

  const reply = modelOut({ incident_id: 'INC-0007', triage_category: 'MEDEVAC', priority_level: 4, user_satellite_reply: 'SEND HELI NOW' });
  await withStub(() => JSON.stringify(reply), async () => {
    const r = await enhance({ incident: covert, ruleTriage, grounding, context });
    assert.equal(r.triage.triage_category, 'HOSTAGE_COVERT');
    assert.equal(r.triage.priority_level, 1);
    assert.equal(r.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.ok(r.notes.some((n) => /HOSTAGE_COVERT/.test(n)));
  });
});

test('llm: unreachable endpoint degrades to rules', async () => {
  _clearCache();
  const context = await geoContext(incident.position.lat, incident.position.lon);
  const { triage: ruleTriage, grounding } = await triage({ incident, context });
  const saved = { ...process.env };
  process.env.AEGIS_LLM = '1';
  process.env.AEGIS_LLM_URL = 'http://127.0.0.1:1/v1/chat/completions';
  process.env.AEGIS_LLM_TIMEOUT_MS = '1200';
  try {
    const r = await enhance({ incident, ruleTriage, grounding, context });
    assert.equal(r.used, 'rules');
    assert.match(r.reason, /unreachable/);
  } finally {
    process.env = saved;
  }
});

test('llm: floors clamp a hostile or malformed checklist and reply', () => {
  const ruleTriage = {
    incident_id: 'INC-0007', priority_level: 1, triage_category: 'MEDEVAC',
    physiological_status: 'rule', hazard_assessment: 'rule', deconflicted_route_plan: 'GROUND.',
    dispatcher_checklist: ['a', 'b', 'c'], user_satellite_reply: 'ACK.',
  };
  const { triage, notes } = enforceFloors(
    modelOut({ dispatcher_checklist: ['only one'], user_satellite_reply: 'é'.repeat(400) }),
    { ruleTriage, context: { hospitals: [] }, incidentId: 'INC-0007' }
  );
  assert.deepEqual(triage.dispatcher_checklist, ['a', 'b', 'c']);
  assert.ok(triage.user_satellite_reply.length <= 160);
  assert.match(triage.user_satellite_reply, /^[\x20-\x7E]*$/);
  assert.ok(notes.length >= 2);
});

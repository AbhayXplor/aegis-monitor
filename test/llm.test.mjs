import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { enhance, llmConfig, systemPrompt, enforceFloors, validateShape } from '../src/llm.mjs';
import { triage } from '../src/triage.mjs';
import { createGeo } from '../src/geo.mjs';

const geo = createGeo({ env: { AEGIS_GEO: 'demo' } });
const incident = {
  id: 'INC-0007', device_id: 0x4b21, sos_code: 2,
  position: { lat: 25.2048, lon: 55.2708, altitude_m: 0 },
  vitals: { heart_rate: 141, spo2: 86, battery_pct: 50, duress_flag: false },
  silent_mode: false, age_s: 0, history: [],
  received_at: new Date().toISOString(),
};

const modelOut = (over = {}) => ({
  incident_id: 'INC-0007',
  priority_level: 2, // less urgent than the rules floor (1)
  triage_category: 'MEDEVAC',
  physiological_status: 'HR 141, SpO2 86. Critical.',
  hazard_assessment: 'Conflict reported to the north.',
  deconflicted_route_plan: 'HELI via Rescue Helicopter H1 (ETA 20 min). HDG 300. AVOID CONFLICT.',
  dispatcher_checklist: ['Task asset.', 'Pre-alert hospital.', 'Re-check vector.'],
  user_satellite_reply: 'P1. STAY STILL. HELP EN ROUTE.',
  ...over,
});

async function prepare(inc = incident) {
  const context = await geo.geoContext(inc.position.lat, inc.position.lon);
  const r = await triage({ incident: inc, context });
  return { context, ruleTriage: r.triage, grounding: r.grounding, deconfliction: r.deconfliction };
}

/** A stub chat endpoint so the adapter is tested without any key. */
async function withStub(replyFn, fn, { provider = 'openai' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      seen.push({ headers: req.headers, body: parsed });
      const content = replyFn(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(provider === 'ollama' ? { message: { content } } : { choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const saved = { ...process.env };
  Object.assign(process.env, { AEGIS_LLM: '1', AEGIS_LLM_PROVIDER: provider, AEGIS_LLM_URL: `http://127.0.0.1:${port}/x`, AEGIS_LLM_MODEL: 'stub-model' });
  try {
    await fn(seen);
  } finally {
    process.env = saved;
    await new Promise((r) => server.close(r));
  }
}

/* ---------------- config ---------------- */

test('llm: disabled by default, so the rule engine is the only path', () => {
  const cfg = llmConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.keyPresent, false);
});

test('llm: the default target is Ollama Cloud (the brief), overridable', () => {
  const cfg = llmConfig({ AEGIS_LLM: '1' });
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.url, 'https://ollama.com/api/chat');
  assert.equal(cfg.model, 'gemma4');
  assert.equal(cfg.enabled, true);
  const oa = llmConfig({ AEGIS_LLM: '1', AEGIS_LLM_PROVIDER: 'openai' });
  assert.equal(oa.enabled, false, 'an OpenAI-compatible endpoint needs an explicit URL');
  assert.deepEqual(llmConfig({ AEGIS_LLM_MODEL: 'a', AEGIS_LLM_FALLBACK: 'b, a ,c' }).models, ['a', 'b', 'c']);
  assert.equal(llmConfig({ OLLAMA_API_KEY: 'k' }).keyPresent, true);
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

/* ---------------- accepted replies ---------------- */

test('llm: a valid model reply is used, with urgency raised to the rules floor', async () => {
  const p = await prepare();
  assert.equal(p.ruleTriage.priority_level, 1, 'rules floor is P1 for SpO2 86');
  await withStub(() => JSON.stringify(modelOut()), async () => {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'llm');
    assert.equal(r.triage.priority_level, 1, 'model said 2, floor forces 1');
    assert.ok(r.notes.some((n) => /rules floor/.test(n)));
    assert.equal(r.triage.incident_id, 'INC-0007');
  });
});

test('llm: the request carries the Modelfile prompt, silent_mode, protocol chunks and a bearer key', async () => {
  const p = await prepare();
  await withStub(() => JSON.stringify(modelOut()), async (seen) => {
    process.env.AEGIS_LLM_KEY = 'secret-test-key';
    await enhance({ incident: { ...incident, silent_mode: true }, ...p, context: p.context });
    const { body, headers } = seen[0];
    assert.equal(headers.authorization, 'Bearer secret-test-key');
    assert.match(body.messages[0].content, /Tactical & Medical Rescue AI Core/);
    const user = JSON.parse(body.messages[1].content);
    assert.equal(user.beacon.silent_mode, true);
    assert.ok(user.protocol_chunks.length >= 1 && user.protocol_chunks.every((c) => c.id && c.text));
    assert.ok(user.geo_context_25km.hazards.length >= 0 && user.geo_context_25km.radius_km === 25);
    assert.equal(JSON.stringify(user).includes('secret-test-key'), false, 'the key never goes into the prompt');
  });
});

test('llm: the Ollama response format (message.content) is understood', async () => {
  const p = await prepare();
  await withStub(() => JSON.stringify(modelOut()), async (seen) => {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'llm');
    assert.equal(seen[0].body.format, 'json');
    assert.equal(seen[0].body.stream, false);
  }, { provider: 'ollama' });
});

test('llm: code-fenced JSON is accepted', async () => {
  const p = await prepare();
  await withStub(() => '```json\n' + JSON.stringify(modelOut()) + '\n```', async () => {
    assert.equal((await enhance({ incident, ...p, context: p.context })).used, 'llm');
  });
});

/* ---------------- rejected / clamped replies ---------------- */

test('llm: an invented asset is rejected and the rule plan is restored', async () => {
  const p = await prepare();
  await withStub(() => JSON.stringify(modelOut({ deconflicted_route_plan: 'HELI via Al Noor Trauma Center (ETA 9 min). HDG 300.' })), async () => {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'llm');
    assert.ok(r.notes.some((n) => /invented asset/.test(n)));
    assert.equal(r.triage.deconflicted_route_plan, p.ruleTriage.deconflicted_route_plan);
  });
});

test('llm: any real rescue asset or hospital in the slice is a legitimate "via"', async () => {
  const p = await prepare();
  const name = p.context.assets[0].name;
  await withStub(() => JSON.stringify(modelOut({ deconflicted_route_plan: `GROUND via ${name} (ETA 20 min). HDG 300.` })), async () => {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.ok(!r.notes.some((n) => /invented/.test(n)));
    assert.match(r.triage.deconflicted_route_plan, new RegExp(name));
  });
});

test('llm: invalid JSON falls back to rules instead of failing the incident', async () => {
  const p = await prepare();
  await withStub(() => 'Sorry, I cannot help with that.', async () => {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'rules');
    assert.match(r.reason, /non-JSON/);
    assert.deepEqual(r.triage, p.ruleTriage);
  });
});

test('llm: a reply with extra or missing keys falls back to rules', async () => {
  const p = await prepare();
  await withStub(() => JSON.stringify({ ...modelOut(), diagnosis: 'x' }), async () => {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'rules');
    assert.match(r.reason, /extra keys/);
  });
});

test('llm: duress incidents can never be talked out of covert mode', async () => {
  const covert = { ...incident, sos_code: 3, vitals: { ...incident.vitals, duress_flag: true, spo2: 95, heart_rate: 100 } };
  const p = await prepare(covert);
  assert.equal(p.ruleTriage.triage_category, 'HOSTAGE_COVERT');
  await withStub(() => JSON.stringify(modelOut({ triage_category: 'MEDEVAC', priority_level: 4, user_satellite_reply: 'SEND HELI NOW' })), async () => {
    const r = await enhance({ incident: covert, ...p, context: p.context });
    assert.equal(r.triage.triage_category, 'HOSTAGE_COVERT');
    assert.equal(r.triage.priority_level, 1);
    assert.equal(r.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
    assert.ok(r.notes.some((n) => /HOSTAGE_COVERT/.test(n)));
  });
});

test('llm: silent-mode devices get HAPTIC_ACK_ONLY whatever the model says', async () => {
  const silent = { ...incident, silent_mode: true, vitals: { ...incident.vitals, spo2: 95, heart_rate: 100 } };
  const p = await prepare(silent);
  await withStub(() => JSON.stringify(modelOut({ user_satellite_reply: 'P2. HELP COMING.' })), async () => {
    const r = await enhance({ incident: silent, ...p, context: p.context });
    assert.equal(r.triage.user_satellite_reply, 'HAPTIC_ACK_ONLY');
  });
});

test('llm: a covert checklist that tells a dispatcher to transmit is replaced by the rules', async () => {
  const covert = { ...incident, vitals: { ...incident.vitals, duress_flag: true } };
  const p = await prepare(covert);
  await withStub(() => JSON.stringify(modelOut({ triage_category: 'HOSTAGE_COVERT', dispatcher_checklist: ['Send a text to the device now.', 'b', 'c'] })), async () => {
    const r = await enhance({ incident: covert, ...p, context: p.context });
    assert.deepEqual(r.triage.dispatcher_checklist, p.ruleTriage.dispatcher_checklist);
    assert.ok(r.notes.some((n) => /transmit/.test(n)));
  });
  // a checklist that forbids transmitting is fine
  await withStub(() => JSON.stringify(modelOut({ triage_category: 'HOSTAGE_COVERT', dispatcher_checklist: ['Do not send any downlink.', 'b', 'c'] })), async () => {
    const r = await enhance({ incident: covert, ...p, context: p.context });
    assert.equal(r.triage.dispatcher_checklist[0], 'Do not send any downlink.');
  });
});

test('llm: floors clamp a malformed checklist and a non-ASCII reply', () => {
  const ruleTriage = {
    incident_id: 'INC-0007', priority_level: 1, triage_category: 'MEDEVAC',
    physiological_status: 'rule', hazard_assessment: 'rule', deconflicted_route_plan: 'GROUND.',
    dispatcher_checklist: ['a', 'b', 'c'], user_satellite_reply: 'ACK.',
  };
  const { triage: t, notes } = enforceFloors(
    modelOut({ dispatcher_checklist: ['only one'], user_satellite_reply: 'é'.repeat(400) }),
    { ruleTriage, context: { hospitals: [], assets: [] }, incidentId: 'INC-0007' },
  );
  assert.deepEqual(t.dispatcher_checklist, ['a', 'b', 'c']);
  assert.match(t.user_satellite_reply, /^[\x20-\x7E]{1,160}$/);
  assert.ok(notes.length >= 2);
  const long = enforceFloors(modelOut({ user_satellite_reply: 'x'.repeat(400) }), { ruleTriage, context: {}, incidentId: 'INC-0007' });
  assert.equal(long.triage.user_satellite_reply.length, 160);
});

/* ---------------- failure handling ---------------- */

test('llm: an unreachable endpoint degrades to rules', async () => {
  const p = await prepare();
  const saved = { ...process.env };
  Object.assign(process.env, { AEGIS_LLM: '1', AEGIS_LLM_PROVIDER: 'openai', AEGIS_LLM_URL: 'http://127.0.0.1:1/v1/chat/completions', AEGIS_LLM_TIMEOUT_MS: '1200' });
  try {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'rules');
    assert.match(r.reason, /unreachable/);
  } finally {
    process.env = saved;
  }
});

test('llm: a failing primary falls through the model chain, and a 5xx is retried once', async () => {
  const p = await prepare();
  const tried = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const model = JSON.parse(b).model;
      tried.push(model);
      if (model === 'primary') { res.writeHead(503); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelOut()) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, { AEGIS_LLM: '1', AEGIS_LLM_PROVIDER: 'openai', AEGIS_LLM_URL: `http://127.0.0.1:${server.address().port}/x`, AEGIS_LLM_MODEL: 'primary', AEGIS_LLM_FALLBACK: 'backup' });
  try {
    const r = await enhance({ incident, ...p, context: p.context });
    assert.equal(r.used, 'llm');
    assert.equal(r.model, 'backup');
    assert.ok(tried.filter((m) => m === 'primary').length >= 2, 'transient 503 retried');
  } finally {
    process.env = saved;
    await new Promise((r) => server.close(r));
  }
});

test('llm: when disabled, enhance returns the rule triage untouched', async () => {
  const p = await prepare();
  const r = await enhance({ incident, ...p, context: p.context });
  assert.equal(r.used, 'rules');
  assert.equal(r.triage, p.ruleTriage);
});

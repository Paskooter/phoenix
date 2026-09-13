#!/usr/bin/env node
// S-14 Phoenix contract harness — drives the REAL Phoenix skills HTTP service
// (`createSkillService` / `createSkillsService` + node:http, ephemeral port) with the exact
// requests the pinned original suites send, and emits the same normalized surface as
// `scripts/parity-s14/source-oracle.cjs` so the two can be diffed structurally.
//
// Covers acceptance 1 (example/template launch/action graphs + skill-host malformed/error
// behavior) and acceptance 2 (each replacement on its own port; default `/v1/main` and
// explicit `/v1/<id>/main` route forms).
//
// Usage: node scripts/parity-s14/phoenix-contract.mjs [outPath]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createSkillService, createSkillsService } from '../../packages/skills/src/index.js';
import { exampleSkill } from '../../packages/skills/src/exampleSkill.js';
import { templateSkill } from '../../packages/skills/src/templateSkill.js';

// mockRuntimeData / MOCK_GENERAL_DATA copied from the pinned
// packages/test-utils/src/{mockRuntimeData,skill-test/SkillConversation}.ts.
const MOCK_GENERAL_DATA = {
  accountID: 'some-account-id',
  robotID: 'some-robot-id',
  lang: 'en',
  release: '8.67.5309',
};
function mockRuntimeData() {
  return {
    loop: {
      loopId: 'test-loop-id',
      jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'WHITE' },
      owner: 'test-looper-id-2',
      users: [
        { id: 'test-looper-id-2', accountId: 'test-account-id-2', birthdate: 220924800000, gender: 'male', phoneticName: 'ghoti', lastName: 'Jetson', firstName: 'George' },
        { id: 'test-looper-id-3', accountId: 'test-account-id-3', birthdate: 444528000000, gender: 'female', phoneticName: 'Jane', lastName: 'Jetson', firstName: 'Jane' },
        { id: 'test-looper-id-4', accountId: 'test-account-id-4', birthdate: 983577600000, gender: 'female', phoneticName: 'Judy', lastName: 'Jetson', firstName: 'Judy' },
        { id: 'test-looper-id-5', accountId: 'test-account-id-5', birthdate: 1065139200000, gender: 'male', phoneticName: 'Elroy', lastName: 'Jetson', firstName: 'Elroy' },
        { id: 'test-looper-id-6', accountId: 'test-account-id-6', birthdate: 953251200000, gender: 'female', phoneticName: 'Rosie', lastName: 'Jetson', firstName: 'Rosie' },
        { id: 'test-looper-id-7', accountId: 'test-account-id-7', birthdate: 953078400000, gender: 'male', phoneticName: 'Astro', lastName: 'Jetson', firstName: 'Astro' },
      ],
    },
    location: { lng: -71.1273681, lat: 42.313352, country: 'usa', countryCode: 'US', stateAbbr: 'ma', state: 'Massachusetts', city: 'boston', iso: '2017-12-11T16:05:52.585-05:00' },
    perception: { peoplePresent: [], speaker: 'test-looper-id-3' },
    character: { motivation: { playful: 0.14528444444444447, social: 0.01816055555555556 }, emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent: null },
  };
}

const trimTrace = (trace) => (trace || []).map((t) => ({ nodeID: t.nodeID, transition: t.transition === undefined ? null : t.transition }));

function slimOf(action) {
  if (!action) return action;
  const jcp = action.config && action.config.jcp;
  if (!jcp) return { type: action.type };
  const slim = jcp.type === 'SLIM' ? jcp : (jcp.children || []).find((c) => c.type === 'SLIM');
  if (!slim) return { type: action.type, jcpType: jcp.type };
  return {
    type: action.type,
    jcpType: jcp.type,
    esml: slim.config.play.esml,
    mim_id: slim.config.play.meta && slim.config.play.meta.mim_id,
    prompt_id: slim.config.play.meta && slim.config.play.meta.prompt_id,
  };
}

function snapshot(response) {
  const out = { type: response.type, data: {} };
  if (response.timings !== undefined) out.timings = typeof response.timings.total;
  const data = response.data || {};
  if (data.message !== undefined) out.data.message = data.message;
  if (data.skill) {
    out.data.skill = { id: data.skill.id };
    const s = data.skill.session;
    if (s) out.data.skill.session = { id: typeof s.id, nodeID: s.nodeID, trace: trimTrace(s.trace), dataKeys: Object.keys(s.data || {}) };
    else if (s === null) out.data.skill.session = null;
  }
  if (data.action !== undefined) out.data.action = slimOf(data.action);
  if (data.final !== undefined) out.data.final = data.final;
  if (data.fireAndForget !== undefined) out.data.fireAndForget = data.fireAndForget;
  return out;
}

function rawRequest(port, path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body === null || body === undefined ? '' : body;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { json = { nonJson: buf.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: json, contentType: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const post = (port, path, obj) => rawRequest(port, path, JSON.stringify(obj)).then((r) => r.body);

async function listen(service) {
  const server = await service.listen(0);
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

const launchData = (intent, extra = {}) => ({
  general: MOCK_GENERAL_DATA,
  runtime: mockRuntimeData(),
  skill: { id: 'example-skill' },
  result: { nlu: { rules: [], intent, entities: {} }, asr: { text: '', confidence: 1 }, ...extra },
});

// --- example mode ----------------------------------------------------------------------
async function runExampleSkill() {
  const host = await listen(createSkillService({ name: 'example-skill', skillId: 'example-skill', handler: exampleSkill }));
  const turns = [];
  let invalidIntent;
  let proactiveMemo;
  try {
    let r = await post(host.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: launchData('doesJiboLikeThing') });
    turns.push(snapshot(r));
    for (let i = 0; i < 3; i += 1) {
      r = await post(host.port, '/v1/main', {
        type: 'LISTEN_UPDATE', msgID: 'm', ts: 2,
        data: { ...launchData(null), skill: { id: 'example-skill', session: r.data.skill.session }, result: { nlu: { rules: [], intent: null, entities: {} }, asr: { text: '', confidence: 1 } } },
      });
      turns.push(snapshot(r));
    }
    invalidIntent = snapshot(await post(host.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: launchData('bla') }));
    proactiveMemo = snapshot(await post(host.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: launchData('', { memo: 'Proactive entry 1' }) }));
  } finally {
    await host.close();
  }
  return { skillId: 'example-skill', turns, invalidIntent, proactiveMemo };
}

// --- template mode ---------------------------------------------------------------------
async function runTemplateSkill() {
  const host = await listen(createSkillService({ name: 'template-skill', skillId: 'template-skill', handler: templateSkill }));
  const launch = (memo) => post(host.port, '/v1/main', {
    type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1,
    data: { general: MOCK_GENERAL_DATA, runtime: mockRuntimeData(), skill: { id: 'template-skill' }, result: { nlu: { rules: [], intent: 'TBD', entities: {} }, asr: { text: '', confidence: 1 }, memo } },
  });
  let validMemo; let unknownMemo; let nullMemo;
  try {
    validMemo = snapshot(await launch({ entry: 'SomeThing' }));
    unknownMemo = snapshot(await launch({ entry: 'SomeOtherThing' }));
    nullMemo = snapshot(await launch(null));
  } finally {
    await host.close();
  }
  return { skillId: 'template-skill', validMemo, unknownMemo, nullMemo };
}

// --- host mode -------------------------------------------------------------------------
async function runHostProbes() {
  const probes = {};
  const launchBody = () => ({
    type: 'LISTEN_LAUNCH', msgID: 'probe', ts: 1,
    data: {
      general: MOCK_GENERAL_DATA,
      runtime: { dialog: {} },
      skill: { id: 'example-skill' },
      result: { nlu: { rules: [], intent: 'doesJiboLikeThing', entities: {} }, asr: { text: '', confidence: 1 } },
    },
  });
  const host = await listen(createSkillService({ name: 'example-skill', skillId: 'example-skill', handler: exampleSkill }));
  try {
    probes.unknownRoute = await rawRequest(host.port, '/v1/nope/main', JSON.stringify(launchBody()));
    probes.malformedJson = await rawRequest(host.port, '/v1/main', '{"type":');
    probes.primitiveJson = await rawRequest(host.port, '/v1/main', '"just a string"');
    probes.arrayJson = await rawRequest(host.port, '/v1/main', '[]');
    probes.emptyString = await rawRequest(host.port, '/v1/main', '');
    probes.emptyObject = await rawRequest(host.port, '/v1/main', '{}');
    probes.missingResult = await rawRequest(host.port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' } },
    }));
    probes.nullResult = await rawRequest(host.port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' }, result: null },
    }));
    probes.memoUnknownNoNlu = await rawRequest(host.port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' }, result: { memo: 'unknown-memo' } },
    }));
    probes.unknownRequestType = await rawRequest(host.port, '/v1/main', JSON.stringify({
      type: 'NOT_A_TYPE', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' }, result: null },
    }));
    probes.getRoute = await rawRequest(host.port, '/v1/main', null, 'GET');
    probes.healthcheck = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: host.port, path: '/healthcheck', method: 'GET' }, (res) => {
        let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject); req.end();
    });
  } finally { await host.close(); }

  const tmplHost = await listen(createSkillService({ name: 'template-skill', skillId: 'template-skill', handler: templateSkill }));
  const tBody = (result) => JSON.stringify({
    type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
    data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'template-skill' }, result },
  });
  try {
    probes.templateMissingResult = await rawRequest(tmplHost.port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'template-skill' } },
    }));
    probes.templateNullResult = await rawRequest(tmplHost.port, '/v1/main', tBody(null));
    probes.templateValidMemoNoNlu = await rawRequest(tmplHost.port, '/v1/main', tBody({ memo: { entry: 'SomeThing' } }));
  } finally { await tmplHost.close(); }
  return probes;
}

// --- acceptance 2: route forms ---------------------------------------------------------
async function runRouteForms() {
  const forms = {};
  const exampleLaunch = () => ({ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: launchData('doesJiboLikeThing') });
  const templateLaunch = () => ({ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { general: MOCK_GENERAL_DATA, runtime: mockRuntimeData(), skill: { id: 'template-skill' }, result: { nlu: { rules: [], intent: 'TBD', entities: {} }, asr: { text: '', confidence: 1 }, memo: { entry: 'SomeThing' } } } });

  const standalone = await listen(createSkillService({ name: 'example-skill', skillId: 'example-skill', handler: exampleSkill }));
  try {
    forms['standalone:example-skill /v1/main'] = snapshot(await post(standalone.port, '/v1/main', exampleLaunch()));
    forms['standalone:example-skill /v1/example-skill/main'] = snapshot(await post(standalone.port, '/v1/example-skill/main', exampleLaunch()));
  } finally { await standalone.close(); }

  const tmpl = await listen(createSkillService({ name: 'template-skill', skillId: 'template-skill', handler: templateSkill }));
  try {
    forms['standalone:template-skill /v1/main'] = snapshot(await post(tmpl.port, '/v1/main', templateLaunch()));
    forms['standalone:template-skill /v1/template-skill/main'] = snapshot(await post(tmpl.port, '/v1/template-skill/main', templateLaunch()));
  } finally { await tmpl.close(); }

  const cohost = await listen(createSkillsService({
    name: 's14-cohost', defaultId: 'answer-skill',
    skills: [
      { id: 'example-skill', handler: exampleSkill },
      { id: 'template-skill', handler: templateSkill },
    ],
  }));
  try {
    forms['cohost:example-skill /v1/example-skill/main'] = snapshot(await post(cohost.port, '/v1/example-skill/main', exampleLaunch()));
    forms['cohost:template-skill /v1/template-skill/main'] = snapshot(await post(cohost.port, '/v1/template-skill/main', templateLaunch()));
  } finally { await cohost.close(); }
  return forms;
}

async function main() {
  const report = {
    task: 'S-14',
    runtime: process.version,
    exampleSkill: await runExampleSkill(),
    templateSkill: await runTemplateSkill(),
    hostProbes: await runHostProbes(),
    routeForms: await runRouteForms(),
  };
  const out = process.argv[2];
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(JSON.stringify(report, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err); process.exit(2); });

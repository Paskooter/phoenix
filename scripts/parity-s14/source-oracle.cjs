#!/usr/bin/env node
// S-14 source oracle — drives the PINNED ORIGINAL example-skill / template-skill packages
// through the real pinned `SkillService` / `BaseSkill` host, exactly as the pinned test
// suites do, and records every wire response.
//
// Runs under the archived runtime `node:8.9.4-slim`
// (sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c) against the
// compiled reference tree mounted at /runtime (pinned revision
// jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c).
//
// Modes (one process each, so the source's process-wide GraphManager counter starts at 0
// exactly as it does in a standalone deployment):
//   example  — packages/example-skill/tests/ExampleSkill.test.js (SkillConversation walk)
//   template — packages/template-skill/tests/TemplateSkill.test.ts (launchRequest helper)
//   host     — packages/baseskill/src/SkillService.ts / BaseSkill.ts malformed/error surface
//
// Usage (from the repo root):
//   docker run --rm --network none -e NODE_PATH=/runtime/node_modules \
//     -v "$PWD/scripts/parity-s14:/probe" \
//     -v "$PWD/.parity/reference/5c0a7390539663ba749d360de348a428c088505c:/runtime:ro" \
//     -w /runtime node:8.9.4-slim node /probe/source-oracle.cjs /probe/out.json example

const http = require('http');
const fs = require('fs');

const baseskill = require('@jibo/baseskill');
const utils = require('@jibo/utils');
const ex = require('@jibo/example-skill');
const tmpl = require('@jibo/template-skill');
const { skill_test } = require('@jibo/test-utils');

const outPath = process.argv[2];
const mode = process.argv[3] || 'example';
const MOCK_GENERAL_DATA = {
  accountID: 'some-account-id',
  robotID: 'some-robot-id',
  lang: 'en',
  release: '8.67.5309',
};

function trimTrace(trace) {
  return (trace || []).map((t) => ({ nodeID: t.nodeID, transition: t.transition === undefined ? null : t.transition }));
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

function rawPost(port, path, body, method) {
  return new Promise((resolve, reject) => {
    const payload = body === null || body === undefined ? '' : body;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: method || 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { json = { nonJson: buf.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: json, contentType: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Drive the host through the pinned client, exactly like the source suites: the
// conversation allocates a free port and calls SkillService.init(port).
async function withService(SkillClass, fn) {
  const conversation = new skill_test.SkillConversation(new baseskill.SkillService(new SkillClass()));
  await conversation.init();
  const port = conversation.port;
  try {
    return await fn(port);
  } finally {
    await conversation.close();
  }
}

// --- example mode ----------------------------------------------------------------------
async function runExampleSkill() {
  const conversation = new skill_test.SkillConversation(new baseskill.SkillService(new ex.ExampleSkill()));
  await conversation.init();
  const turns = [];
  try {
    await conversation.launch(utils.test.TestIntents.DOES_LIKE, {});
    turns.push(snapshot(conversation.response));
    await conversation.actionResult(conversation.response.data.skill);
    turns.push(snapshot(conversation.response));
    await conversation.actionResult(conversation.response.data.skill);
    turns.push(snapshot(conversation.response));
    await conversation.actionResult(conversation.response.data.skill);
    turns.push(snapshot(conversation.response));
  } finally {
    await conversation.close();
  }

  const c2 = new skill_test.SkillConversation(new baseskill.SkillService(new ex.ExampleSkill()));
  await c2.init();
  let invalidIntent;
  try {
    await c2.launch('bla');
    invalidIntent = snapshot(c2.response);
  } finally {
    await c2.close();
  }

  // PROACTIVE_LAUNCH memo arm, without NLU (the memo decides before nlu is read)
  const c3 = new skill_test.SkillConversation(new baseskill.SkillService(new ex.ExampleSkill()));
  await c3.init();
  let proactiveMemo;
  try {
    await c3.launch({ intent: null, rules: [], entities: {} }, { id: 'example-skill' }, { memo: 'Proactive entry 1' });
    proactiveMemo = snapshot(c3.response);
  } finally {
    await c3.close();
  }

  return { skillId: new ex.ExampleSkill().name, turns, invalidIntent, proactiveMemo };
}

// --- template mode ---------------------------------------------------------------------
async function runTemplateSkill() {
  const run = async (intent, memoValue) => {
    const cloudSkill = new tmpl.TemplateSkill();
    const conversation = new skill_test.SkillConversation(new baseskill.SkillService(cloudSkill));
    await conversation.init();
    try {
      await conversation.launch(intent, { id: cloudSkill.name }, { memo: memoValue ? { entry: memoValue } : null });
      return snapshot(conversation.response);
    } finally {
      await conversation.close();
    }
  };
  return {
    skillId: new tmpl.TemplateSkill().name,
    validMemo: await run('TBD', 'SomeThing'),
    unknownMemo: await run('TBD', 'SomeOtherThing'),
    nullMemo: await run('TBD'),
  };
}

// --- host mode -------------------------------------------------------------------------
async function runHostProbes() {
  const probes = {};
  const launchBody = (extra) => ({
    type: 'LISTEN_LAUNCH', msgID: 'probe', ts: 1,
    data: {
      general: MOCK_GENERAL_DATA,
      runtime: { dialog: {} },
      skill: { id: 'example-skill' },
      result: { nlu: { rules: [], intent: utils.test.TestIntents.DOES_LIKE, entities: {} }, asr: { text: '', confidence: 1 } },
      ...extra,
    },
  });
  await withService(ex.ExampleSkill, async (port) => {
    probes.unknownRoute = await rawPost(port, '/v1/nope/main', JSON.stringify(launchBody()));
    probes.malformedJson = await rawPost(port, '/v1/main', '{"type":');
    probes.primitiveJson = await rawPost(port, '/v1/main', '"just a string"');
    probes.arrayJson = await rawPost(port, '/v1/main', '[]');
    probes.emptyString = await rawPost(port, '/v1/main', '');
    probes.emptyObject = await rawPost(port, '/v1/main', '{}');
    probes.missingResult = await rawPost(port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' } },
    }));
    probes.nullResult = await rawPost(port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' }, result: null },
    }));
    probes.memoUnknownNoNlu = await rawPost(port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' }, result: { memo: 'unknown-memo' } },
    }));
    probes.unknownRequestType = await rawPost(port, '/v1/main', JSON.stringify({
      type: 'NOT_A_TYPE', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'example-skill' }, result: null },
    }));
    probes.getRoute = await rawPost(port, '/v1/main', null, 'GET');
    probes.healthcheck = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/healthcheck', method: 'GET' }, (res) => {
        let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', reject); req.end();
    });
  });
  // template-skill malformed surface
  await withService(tmpl.TemplateSkill, async (port) => {
    const body = (result) => JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'template-skill' }, result },
    });
    probes.templateMissingResult = await rawPost(port, '/v1/main', JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1,
      data: { general: MOCK_GENERAL_DATA, runtime: { dialog: {} }, skill: { id: 'template-skill' } },
    }));
    probes.templateNullResult = await rawPost(port, '/v1/main', body(null));
    probes.templateValidMemoNoNlu = await rawPost(port, '/v1/main', body({ memo: { entry: 'SomeThing' } }));
  });
  return probes;
}

async function main() {
  let report;
  if (mode === 'example') report = { task: 'S-14', mode, exampleSkill: await runExampleSkill() };
  else if (mode === 'template') report = { task: 'S-14', mode, templateSkill: await runTemplateSkill() };
  else if (mode === 'host') report = { task: 'S-14', mode, hostProbes: await runHostProbes() };
  else throw new Error(`unknown mode '${mode}'`);
  report.runtime = 'node:8.9.4-slim';
  report.revision = '5c0a7390539663ba749d360de348a428c088505c';
  const json = JSON.stringify(report, null, 2) + '\n';
  if (outPath) fs.writeFileSync(outPath, json);
  else process.stdout.write(json);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(2); });

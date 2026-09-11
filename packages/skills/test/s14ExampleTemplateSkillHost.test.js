// S-14 — example/template skills and skill-host compatibility.
//
// Runtime replay of the pinned original example-skill / template-skill suites against the REAL
// Phoenix skills HTTP service (`createSkillService` / `createSkillsService` / `start`), plus the
// pinned `BaseSkill` malformed-request surface. Every expected value below is what the pinned
// compiled original produced under `node:8.9.4-slim`
// (jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c); the receipts live in
// docs/parity/evidence/2026-09-11/s14-example-template/source/ and are re-derived by
// scripts/parity-s14/run.sh.
//
// Source suites replayed:
//   packages/example-skill/tests/ExampleSkill.test.js
//   packages/template-skill/tests/TemplateSkill.test.ts
//   packages/baseskill/src/SkillService.ts + BaseSkill.ts
//
// Absolute node ids are not asserted: the original allocates them from a process-wide
// GraphManager singleton while Phoenix isolates a standalone skill's manager at 0
// (docs/parity/evidence/2026-09-11/s01-graph-sessions/README.md). The relative session-trace
// shape is asserted exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSkillService, createSkillsService, start } from '../src/index.js';
import { exampleSkill } from '../src/exampleSkill.js';
import { templateSkill } from '../src/templateSkill.js';

// MOCK_GENERAL_DATA / mockRuntimeData from the pinned @jibo/test-utils fixtures.
const GENERAL = { accountID: 'some-account-id', robotID: 'some-robot-id', lang: 'en', release: '8.67.5309' };
const RUNTIME = { dialog: {}, perception: { speaker: 'test-looper-id-3' }, loop: { loopId: 'test-loop-id', users: [] } };

async function listen(service) {
  const server = await service.listen(0);
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
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
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const post = (port, path, obj) => rawRequest(port, path, JSON.stringify(obj)).then((r) => r.body);
const esml = (r) => r.data.action.config.jcp.config.play.esml;

const exampleLaunch = (intent, memo) => ({
  type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1,
  data: { general: GENERAL, runtime: RUNTIME, skill: { id: 'example-skill' }, result: { nlu: { rules: [], intent, entities: {} }, asr: { text: '', confidence: 1 }, memo } },
});
const exampleUpdate = (session) => ({
  type: 'LISTEN_UPDATE', msgID: 'm', ts: 2,
  data: { general: GENERAL, runtime: RUNTIME, skill: { id: 'example-skill', session }, result: { nlu: { rules: [], intent: null, entities: {} }, asr: { text: '', confidence: 1 } } },
});
const templateLaunch = (memo) => ({
  type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1,
  data: { general: GENERAL, runtime: RUNTIME, skill: { id: 'template-skill' }, result: { nlu: { rules: [], intent: 'TBD', entities: {} }, asr: { text: '', confidence: 1 }, memo } },
});

const standalone = (skillId, handler) => listen(createSkillService({ name: skillId, skillId, handler }));

// BaseSkill's error envelope adds a generated msgID/ts and no timings; assert the pinned
// fields exactly and ignore the generated ones.
function assertError(response, message, id) {
  assert.equal(response.type, 'ERROR');
  assert.equal(response.data.message, message);
  assert.deepEqual(response.data.skill, { id });
  assert.equal(response.timings, undefined);
}

// The stable per-request surface: everything except generated ids (msgID/ts/session.id/JCP ids).
function stable(response) {
  const action = response.data.action;
  const slim = action && action.config.jcp.config;
  return {
    type: response.type,
    skillId: response.data.skill.id,
    nodeID: response.data.skill.session.nodeID,
    trace: response.data.skill.session.trace,
    dataKeys: Object.keys(response.data.skill.session.data),
    esml: slim && slim.play.esml,
    mim_id: slim && slim.play.meta && slim.play.meta.mim_id,
    prompt_id: slim && slim.play.meta && slim.play.meta.prompt_id,
    final: response.data.final,
    fireAndForget: response.data.fireAndForget,
  };
}

// --- ExampleSkill.test.js: the four-turn intent walk ------------------------------------

test('S-14 example-skill: pinned four-turn walk over the live /v1/main host', async () => {
  const host = await standalone('example-skill', exampleSkill);
  try {
    const r1 = await post(host.port, '/v1/main', exampleLaunch('doesJiboLikeThing'));
    assert.equal(r1.type, 'SKILL_ACTION');
    assert.equal(r1.data.skill.id, 'example-skill');
    assert.equal(esml(r1), "SLIM: 'Node1'");
    assert.equal(r1.data.final, false);
    assert.equal(typeof r1.timings.total, 'number');
    assert.deepEqual(r1.data.skill.session.trace, [
      { nodeID: 0, transition: 'doesJiboLikeThing' },
      { nodeID: 1, transition: null },
    ]);

    const r2 = await post(host.port, '/v1/main', exampleUpdate(r1.data.skill.session));
    assert.equal(esml(r2), "SLIM: 'Node2'");
    assert.deepEqual(r2.data.skill.session.trace, [
      { nodeID: 0, transition: 'doesJiboLikeThing' },
      { nodeID: 1, transition: 'A' },
      { nodeID: 2, transition: null },
    ]);

    const r3 = await post(host.port, '/v1/main', exampleUpdate(r2.data.skill.session));
    assert.equal(esml(r3), "SLIM: 'Node3'");
    assert.deepEqual(r3.data.skill.session.trace, [
      { nodeID: 0, transition: 'doesJiboLikeThing' },
      { nodeID: 1, transition: 'A' },
      { nodeID: 2, transition: 'B' },
      { nodeID: 3, transition: null },
    ]);

    const r4 = await post(host.port, '/v1/main', exampleUpdate(r3.data.skill.session));
    assert.equal(r4.type, 'SKILL_ACTION');
    assert.equal(r4.data.action, null);
    assert.equal(r4.data.final, true);
    assert.equal(r4.data.fireAndForget, true);
    // Terminal exit resolves the last trace element in place; no node is entered.
    assert.deepEqual(r4.data.skill.session.trace, [
      { nodeID: 0, transition: 'doesJiboLikeThing' },
      { nodeID: 1, transition: 'A' },
      { nodeID: 2, transition: 'B' },
      { nodeID: 3, transition: 'A' },
    ]);
  } finally {
    await host.close();
  }
});

test('S-14 example-skill: invalid intent returns the pinned ERROR envelope', async () => {
  const host = await standalone('example-skill', exampleSkill);
  try {
    const r = await post(host.port, '/v1/main', exampleLaunch('bla'));
    assertError(r, "Unknown intent: 'bla'", 'example-skill');
  } finally {
    await host.close();
  }
});

test('S-14 example-skill: the proactive memo arm decides before nlu is read', async () => {
  const host = await standalone('example-skill', exampleSkill);
  try {
    const launched = await post(host.port, '/v1/main', {
      type: 'PROACTIVE_LAUNCH', msgID: 'm', ts: 1,
      data: { general: GENERAL, runtime: RUNTIME, skill: { id: 'example-skill' }, result: { memo: 'Proactive entry 1' } },
    });
    assert.equal(esml(launched), "SLIM: 'ProactiveNode' MEMO: 'Proactive entry 1'");
    assert.equal(launched.data.final, false);
    assert.deepEqual(launched.data.skill.session.trace.map((t) => t.transition), ['PROACTIVE', null]);

    // A memo the node does not know falls back on the intent arm, which is absent here.
    const unknown = await post(host.port, '/v1/main', {
      type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1,
      data: { general: GENERAL, runtime: RUNTIME, skill: { id: 'example-skill' }, result: { memo: 'unknown-memo' } },
    });
    assertError(unknown, "Cannot read property 'intent' of undefined", 'example-skill');
  } finally {
    await host.close();
  }
});

// --- TemplateSkill.test.ts: launch, memo validation -------------------------------------

test('S-14 template-skill: pinned launch plays the template MIM at the pinned graph offset', async () => {
  const host = await standalone('template-skill', templateSkill);
  try {
    const r = await post(host.port, '/v1/main', templateLaunch({ entry: 'SomeThing' }));
    assert.equal(r.type, 'SKILL_ACTION');
    assert.equal(r.data.skill.id, 'template-skill');
    assert.equal(esml(r), 'This is a template skill');
    assert.equal(r.data.action.config.jcp.config.play.meta.mim_id, 'template-mim');
    assert.equal(r.data.action.config.jcp.config.play.meta.prompt_id, 'template-skill_AN_01');
    assert.equal(r.data.final, false);
    assert.equal(r.data.fireAndForget, false);
    // ANFactory's subgraph node is registered before the MemoSplitNode, exactly as the
    // source createGraph() orders it: memoSplit=1, AN node=0, then Complete.
    assert.equal(r.data.skill.session.nodeID, 0);
    assert.deepEqual(r.data.skill.session.trace, [
      { nodeID: 1, transition: 'Reactive' },
      { nodeID: 0, transition: null },
    ]);
    assert.deepEqual(Object.keys(r.data.skill.session.data), ['_mim']);
  } finally {
    await host.close();
  }
});

test('S-14 template-skill: unknown and missing memos return the pinned ERROR messages', async () => {
  const host = await standalone('template-skill', templateSkill);
  try {
    assertError(
      await post(host.port, '/v1/main', templateLaunch({ entry: 'SomeOtherThing' })),
      "Template Skill launched with unknown memo: 'SomeOtherThing'", 'template-skill',
    );
    assertError(
      await post(host.port, '/v1/main', templateLaunch(null)),
      "Template Skill launched with unknown memo: 'null'", 'template-skill',
    );
  } finally {
    await host.close();
  }
});

// --- BaseSkill malformed / error surface ------------------------------------------------

test('S-14 skill host: routing and JSON parser errors match the frozen envelopes', async () => {
  const host = await standalone('example-skill', exampleSkill);
  try {
    const notFound = await rawRequest(host.port, '/v1/nope/main', JSON.stringify(exampleLaunch('x')));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.final, true);
    assert.equal(notFound.body.data.message, 'URL not found: /v1/nope/main');
    assert.equal(notFound.body.data.skill, undefined);

    const get = await rawRequest(host.port, '/v1/main', null, 'GET');
    assert.equal(get.status, 404);
    assert.equal(get.body.data.message, 'URL not found: /v1/main');

    // Node 8 parser wording, kept by the service boundary's legacy JSON messages.
    const truncated = await rawRequest(host.port, '/v1/main', '{"type":');
    assert.equal(truncated.status, 400);
    assert.equal(truncated.body.data.message, 'Unexpected end of JSON input');

    const primitive = await rawRequest(host.port, '/v1/main', '"just a string"');
    assert.equal(primitive.status, 400);
    assert.equal(primitive.body.data.message, 'Unexpected token " in JSON at position 0');

    const health = await rawRequest(host.port, '/healthcheck', null, 'GET');
    assert.equal(health.status, 200);
    assert.equal(health.body.nonJson, 'ok');
  } finally {
    await host.close();
  }
});

test('S-14 skill host: empty and unknown request bodies keep the source error order', async () => {
  const host = await standalone('example-skill', exampleSkill);
  try {
    for (const body of ['', '{}']) {
      const r = await rawRequest(host.port, '/v1/main', body);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data, {
        message: "Cannot read property 'general' of undefined",
        skill: { id: 'example-skill' },
      });
    }
    const unknown = await post(host.port, '/v1/main', {
      type: 'NOT_A_TYPE', msgID: 'p', ts: 1,
      data: { general: GENERAL, runtime: RUNTIME, skill: { id: 'example-skill' }, result: null },
    });
    assertError(unknown, "Unknown request type 'NOT_A_TYPE'", 'example-skill');
  } finally {
    await host.close();
  }
});

test('S-14 skill host: the sources precondition TypeErrors reach the wire verbatim', async () => {
  const exampleHost = await standalone('example-skill', exampleSkill);
  try {
    const base = { general: GENERAL, runtime: RUNTIME, skill: { id: 'example-skill' } };
    assertError(
      await post(exampleHost.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1, data: base }),
      "Cannot read property 'memo' of undefined", 'example-skill',
    );
    assertError(
      await post(exampleHost.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1, data: { ...base, result: null } }),
      "Cannot read property 'memo' of null", 'example-skill',
    );
  } finally {
    await exampleHost.close();
  }

  const templateHost = await standalone('template-skill', templateSkill);
  try {
    const base = { general: GENERAL, runtime: RUNTIME, skill: { id: 'template-skill' } };
    assertError(
      await post(templateHost.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1, data: base }),
      "Cannot read property 'memo' of undefined", 'template-skill',
    );
    assertError(
      await post(templateHost.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1, data: { ...base, result: null } }),
      "Cannot read property 'memo' of null", 'template-skill',
    );
    // MemoSplitNode reads result.nlu.intent for its log line before validating the memo.
    assertError(
      await post(templateHost.port, '/v1/main', { type: 'LISTEN_LAUNCH', msgID: 'p', ts: 1, data: { ...base, result: { memo: { entry: 'SomeThing' } } } }),
      "Cannot read property 'intent' of undefined", 'template-skill',
    );
  } finally {
    await templateHost.close();
  }
});

// --- Acceptance 2: independently deployed skills and both route forms -------------------

test('S-14 acceptance 2: standalone default and explicit routes serve identical bodies', async () => {
  const exampleHost = await standalone('example-skill', exampleSkill);
  try {
    const viaDefault = await post(exampleHost.port, '/v1/main', exampleLaunch('doesJiboLikeThing'));
    const viaExplicit = await post(exampleHost.port, '/v1/example-skill/main', exampleLaunch('doesJiboLikeThing'));
    assert.deepEqual(stable(viaExplicit), stable(viaDefault));
    assert.equal(viaExplicit.data.skill.id, 'example-skill');
  } finally {
    await exampleHost.close();
  }

  const templateHost = await standalone('template-skill', templateSkill);
  try {
    const viaDefault = await post(templateHost.port, '/v1/main', templateLaunch({ entry: 'SomeThing' }));
    const viaExplicit = await post(templateHost.port, '/v1/template-skill/main', templateLaunch({ entry: 'SomeThing' }));
    assert.deepEqual(stable(viaExplicit), stable(viaDefault));
  } finally {
    await templateHost.close();
  }
});

test('S-14 acceptance 2: PHOENIX_SKILL_ID standalone launcher serves the selected skill at /v1/main', async () => {
  const oldSkillID = process.env.PHOENIX_SKILL_ID;
  process.env.PHOENIX_SKILL_ID = 'example-skill';
  const server = await start(0);
  try {
    const r = await post(server.address().port, '/v1/main', exampleLaunch('doesJiboLikeThing'));
    assert.equal(r.type, 'SKILL_ACTION');
    assert.equal(r.data.skill.id, 'example-skill');
    assert.equal(esml(r), "SLIM: 'Node1'");
    assert.deepEqual(r.data.skill.session.trace, [
      { nodeID: 0, transition: 'doesJiboLikeThing' },
      { nodeID: 1, transition: null },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (oldSkillID === undefined) delete process.env.PHOENIX_SKILL_ID;
    else process.env.PHOENIX_SKILL_ID = oldSkillID;
  }
});

test('S-14 acceptance 2: a cohosted host serves both skills on their explicit routes', async () => {
  const host = await listen(createSkillsService({
    name: 's14-cohost',
    defaultId: 'example-skill',
    skills: [
      { id: 'example-skill', handler: exampleSkill },
      { id: 'template-skill', handler: templateSkill },
    ],
  }));
  try {
    const example = await post(host.port, '/v1/example-skill/main', exampleLaunch('doesJiboLikeThing'));
    assert.equal(example.data.skill.id, 'example-skill');
    assert.equal(esml(example), "SLIM: 'Node1'");

    const template = await post(host.port, '/v1/template-skill/main', templateLaunch({ entry: 'SomeThing' }));
    assert.equal(template.data.skill.id, 'template-skill');
    assert.equal(esml(template), 'This is a template skill');

    // defaultId selects which skill answers the back-compat /v1/main route.
    const defaulted = await post(host.port, '/v1/main', exampleLaunch('doesJiboLikeThing'));
    assert.equal(defaulted.data.skill.id, 'example-skill');
  } finally {
    await host.close();
  }
});

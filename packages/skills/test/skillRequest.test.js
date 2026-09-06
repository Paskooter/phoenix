import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSkillService, skillRoute } from '../src/skillService.js';
import { exampleSkill, chitchatSkill, reportSkill } from '../src/index.js';

const GENERAL = { accountID: 'fixture-account', robotID: 'fixture-robot' };
const log = { warn() {}, error() {}, info() {}, debug() {} };

function action() {
  return {
    type: 'SKILL_ACTION',
    msgID: 'fixture-response',
    ts: 0,
    data: { skill: { id: 'fixture-skill' } },
  };
}

function objectBodies(skillId = 'fixture-skill') {
  return [
    {},
    { data: { general: GENERAL, skill: { id: skillId } } },
    { type: 'LISTEN_LAUNCH' },
    { type: 'LISTEN_LAUNCH', data: {} },
    { type: 'NOT_A_REQUEST', data: { general: GENERAL } },
    { type: 'LISTEN_UPDATE', data: { general: GENERAL, skill: { id: skillId } } },
  ];
}

function normalizeResponse(value) {
  const output = structuredClone(value);
  delete output.msgID;
  delete output.ts;
  if (output.timings) output.timings.total = '<timing-number>';
  return output;
}

function request(port, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/main',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

test('skillRoute forwards arbitrary object bodies to the handler', async () => {
  const seen = [];
  const route = skillRoute('fixture-skill', async (body) => {
    seen.push(body);
    return action();
  });

  for (const body of objectBodies()) {
    const result = await route({ body, trace: {}, log });
    assert.equal(result.type, 'SKILL_ACTION');
    assert.equal(result.data.skill.id, 'fixture-skill');
  }
  assert.deepEqual(seen, objectBodies());
});

test('real graph, chitchat, and report handlers retain their own boundary errors', async () => {
  const handlers = [
    ['example-skill', exampleSkill],
    ['chitchat-skill', chitchatSkill],
    ['report-skill', reportSkill],
  ];
  for (const [skillId, handler] of handlers) {
    const invalidType = await skillRoute(skillId, handler)({
      body: { type: 'NOT_A_REQUEST', data: { general: GENERAL, skill: { id: skillId } } },
      trace: {},
      log,
    });
    assert.deepEqual(normalizeResponse(invalidType), {
      type: 'ERROR',
      data: {
        message: "Unknown request type 'NOT_A_REQUEST'",
        skill: { id: skillId },
      },
    });

    const missingSession = await skillRoute(skillId, handler)({
      body: { type: 'LISTEN_UPDATE', data: { general: GENERAL, skill: { id: skillId } } },
      trace: {},
      log,
    });
    // The exact pinned source fixture reaches GraphManager.exitNode and says
    // "Skill session is required".
    assert.deepEqual(normalizeResponse(missingSession), {
      type: 'ERROR',
      data: { message: 'Skill session is required', skill: { id: skillId } },
    });
  }
});

test('HTTP service forwards object bodies while common JSON parsing rejects primitives', async () => {
  const seen = [];
  const service = createSkillService({
    name: 'skill-request-boundary-test',
    skillId: 'fixture-skill',
    handler: async (body) => {
      seen.push(body);
      return action();
    },
  });
  await service.listen(0);
  const port = service.server.address().port;

  try {
    for (const body of objectBodies()) {
      const response = await request(port, JSON.stringify(body));
      assert.equal(response.status, 200);
      assert.equal(response.body.type, 'SKILL_ACTION');
    }
    assert.deepEqual(seen, objectBodies());

    for (const raw of ['null', JSON.stringify('fixture'), '7', '{"type":']) {
      const response = await request(port, raw);
      assert.equal(response.status, 400);
      assert.equal(response.body.type, 'ERROR');
      assert.equal(response.body.final, true);
    }
  } finally {
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
  }
});

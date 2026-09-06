import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/index.js';

const baseRuntime = {
  dialog: {},
  perception: {},
  loop: { users: [] },
  location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' },
};

const requests = {
  'answer-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'answer', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: { dialog: {} },
      skill: { id: 'answer-skill' },
      result: { asr: { text: 'who is ada lovelace' }, nlu: { intent: 'generalWhoQuestions', rules: ['launch'], entities: {} }, memo: { type: 'who' } },
    },
  },
  'report-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'report', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: baseRuntime,
      skill: { id: 'report-skill' },
      result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' },
    },
  },
  'chitchat-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'chitchat', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: { ...baseRuntime, character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } } },
      skill: { id: 'chitchat-skill' },
      result: { nlu: { intent: 'requestDance', entities: {}, rules: [] }, asr: { text: '' }, memo: { mim: 'RA_JBO_SpecificDance', type: 'ScriptedResponse' } },
    },
  },
};

function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

function firstSlim(response) {
  const jcp = response.data.action.config.jcp;
  return jcp.type === 'SLIM' ? jcp : jcp.children.find((child) => child.type === 'SLIM');
}

test('PHOENIX_SKILL_ID selects the real skill at /v1/main', async () => {
  const expectedMims = {
    'answer-skill': 'AnswerReply',
    'report-skill': 'PersonalReportWhoIsThis',
    'chitchat-skill': 'RA_JBO_SpecificDance',
  };

  for (const skillId of Object.keys(requests)) {
    const server = await start(0, { skillId });
    try {
      const port = server.address().port;
      const result = await post(port, '/v1/main', requests[skillId]);
      assert.equal(result.status, 200, skillId);
      assert.equal(result.body.type, 'SKILL_ACTION', skillId);
      assert.equal(result.body.data.skill.id, skillId, `${skillId}/response identity`);
      assert.equal(firstSlim(result.body).config.play.meta.mim_id, expectedMims[skillId], `${skillId}/known response`);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

test('without PHOENIX_SKILL_ID the shared host keeps combined routes', async () => {
  const server = await start(0, { skillId: null });
  try {
    const port = server.address().port;
    const defaultRoute = await post(port, '/v1/main', requests['answer-skill']);
    assert.equal(defaultRoute.status, 200);
    assert.equal(defaultRoute.body.data.skill.id, 'answer-skill');
    const reportRoute = await post(port, '/v1/report-skill/main', requests['report-skill']);
    assert.equal(reportRoute.status, 200);
    assert.equal(reportRoute.body.data.skill.id, 'report-skill');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('unknown PHOENIX_SKILL_ID fails startup instead of silently selecting answer-skill', () => {
  assert.throws(() => start(0, { skillId: 'missing-skill' }), /Unknown PHOENIX_SKILL_ID 'missing-skill'/);
});

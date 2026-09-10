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
  'color-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'color', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: baseRuntime,
      skill: { id: 'color-skill' },
      result: { nlu: { intent: 'favoriteColorChat', entities: {}, rules: [] }, asr: { text: 'my favorite color is blue' }, memo: 'Reactive' },
    },
  },
  'example-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'example', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: baseRuntime,
      skill: { id: 'example-skill' },
      result: { nlu: { intent: 'doesJiboLikeThing', entities: {}, rules: [] }, asr: { text: '' }, memo: null },
    },
  },
  'template-skill': {
    type: 'LISTEN_LAUNCH', msgID: 'template', ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
      runtime: baseRuntime,
      skill: { id: 'template-skill' },
      result: { nlu: { intent: 'x', entities: {}, rules: [] }, asr: { text: '' }, memo: { entry: 'SomeThing' } },
    },
  },
};

// Known first-response identity of each replacement skill. `mim` is the source MIM id for
// the MIM-driven skills; `esml` covers the skeleton skills that emit a literal play.
const expectedIdentity = {
  'answer-skill': { mim: 'AnswerReply' },
  'report-skill': { mim: 'PersonalReportWhoIsThis' },
  'chitchat-skill': { mim: 'RA_JBO_SpecificDance' },
  'color-skill': { mim: 'ColorQN' },
  'example-skill': { esml: "SLIM: 'Node1'" },
  'template-skill': { mim: 'template-mim' },
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

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('PHOENIX_SKILL_ID selects the real skill at /v1/main', async () => {
  for (const skillId of Object.keys(requests)) {
    const server = await start(0, { skillId });
    try {
      const port = server.address().port;
      const result = await post(port, '/v1/main', requests[skillId]);
      assert.equal(result.status, 200, skillId);
      assert.equal(result.body.type, 'SKILL_ACTION', skillId);
      assert.equal(result.body.data.skill.id, skillId, `${skillId}/response identity`);
      const play = firstSlim(result.body).config.play;
      if (expectedIdentity[skillId].mim) {
        assert.equal(play.meta.mim_id, expectedIdentity[skillId].mim, `${skillId}/known response`);
      } else {
        assert.equal(play.esml, expectedIdentity[skillId].esml, `${skillId}/known response`);
      }
    } finally {
      await close(server);
    }
  }
});

test('each selected host retains its namespaced /v1/<id>/main alias', async () => {
  for (const skillId of Object.keys(requests)) {
    const server = await start(0, { skillId });
    try {
      const port = server.address().port;
      const result = await post(port, `/v1/${skillId}/main`, requests[skillId]);
      assert.equal(result.status, 200, skillId);
      assert.equal(result.body.data.skill.id, skillId, `${skillId}/alias identity`);
    } finally {
      await close(server);
    }
  }
});

test('a selected host does not expose another skill at its namespaced alias', async () => {
  const server = await start(0, { skillId: 'report-skill' });
  try {
    const port = server.address().port;
    const cross = await post(port, '/v1/answer-skill/main', requests['answer-skill']);
    assert.equal(cross.status, 404, 'unselected skill alias is not routed');
    assert.equal(cross.body.data.message, 'URL not found: /v1/answer-skill/main');
  } finally {
    await close(server);
  }
});

test('without PHOENIX_SKILL_ID the shared host keeps combined routes', async () => {
  const server = await start(0, { skillId: null });
  try {
    const port = server.address().port;
    const defaultRoute = await post(port, '/v1/main', requests['answer-skill']);
    assert.equal(defaultRoute.status, 200);
    assert.equal(defaultRoute.body.data.skill.id, 'answer-skill');
    for (const skillId of Object.keys(requests)) {
      const route = await post(port, `/v1/${skillId}/main`, requests[skillId]);
      assert.equal(route.status, 200, `${skillId} alias on the shared host`);
      assert.equal(route.body.data.skill.id, skillId, `${skillId} alias identity on the shared host`);
    }
  } finally {
    await close(server);
  }
});

test('unknown PHOENIX_SKILL_ID fails startup instead of silently selecting answer-skill', async () => {
  assert.throws(() => start(0, { skillId: 'missing-skill' }), /Unknown PHOENIX_SKILL_ID 'missing-skill'/);
});

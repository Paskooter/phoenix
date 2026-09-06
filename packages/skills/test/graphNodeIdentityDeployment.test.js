import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/index.js';

const body = {
  type: 'LISTEN_LAUNCH',
  msgID: 'graph-node-deployment',
  ts: 1,
  data: {
    general: { accountID: 'fixture-account', robotID: 'fixture-robot', lang: 'en-US' },
    runtime: {
      loop: {
        loopId: 'fixture-loop',
        users: [{ id: 'fixture-speaker', accountId: 'fixture-account', birthdate: '1990-01-01' }],
      },
      location: { lat: 42.36, lng: -71.06, iso: '2018-05-30T12:00:00+00:00' },
      perception: { speaker: 'fixture-speaker' },
      character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
      dialog: {},
    },
    skill: { id: 'report-skill' },
    result: {
      nlu: { intent: 'launchPersonalReport', entities: {}, rules: ['launch'] },
      asr: { text: 'personal report', confidence: 1 },
      memo: 'Reactive',
    },
  },
};

async function post(server, path = '/v1/main') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('selected report host allocates the source standalone graph from zero', async () => {
  const oldPrefs = process.env.ETCO_report_prefsFromConfig;
  process.env.ETCO_report_prefsFromConfig = 'true';
  const server = await start(0, { skillId: 'report-skill' });
  try {
    const result = await post(server);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.skill.session.nodeID, 31);
  } finally {
    await close(server);
    if (oldPrefs === undefined) delete process.env.ETCO_report_prefsFromConfig;
    else process.env.ETCO_report_prefsFromConfig = oldPrefs;
  }
});

test('combined host allocates chitchat before report in one manager', async () => {
  const oldPrefs = process.env.ETCO_report_prefsFromConfig;
  process.env.ETCO_report_prefsFromConfig = 'true';
  const server = await start(0, { skillId: null });
  try {
    const result = await post(server, '/v1/report-skill/main');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.skill.session.nodeID, 35);
  } finally {
    await close(server);
    if (oldPrefs === undefined) delete process.env.ETCO_report_prefsFromConfig;
    else process.env.ETCO_report_prefsFromConfig = oldPrefs;
  }
});

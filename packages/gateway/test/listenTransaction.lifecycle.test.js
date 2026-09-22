import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ListenTransaction } from '../src/listenTransaction.js';
import { SkillClient, SkillConfigManager } from '../src/skillClient.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

function context(skill = {}) {
  return {
    type: 'CONTEXT',
    data: {
      general: { accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0' },
      runtime: { perception: { speaker: 'person-h04', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
      skill,
    },
  };
}

function listen() {
  return { type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] } };
}

function nlu(intent, entities = {}) {
  return { type: 'CLIENT_NLU', data: { intent, rules: ['launch'], entities, external: {} } };
}

function action(skillID, session, extra = {}) {
  return {
    type: 'SKILL_ACTION',
    msgID: `peer-${session}`,
    ts: 1700000000000,
    data: {
      skill: { id: skillID, session: { id: session, nodeID: 1, data: { session } } },
      action: { kind: 'controlled' },
      fireAndForget: false,
      ...extra,
    },
  };
}

function redirect() {
  return {
    type: 'SKILL_REDIRECT',
    msgID: 'peer-redirect',
    ts: 1700000000000,
    data: {
      skill: { id: 'source', session: { id: 'source-session', nodeID: 1 } },
      skillID: 'destination',
      nlu: { intent: 'redirect-intent', entities: { redirected: true } },
      asr: { text: 'redirect asr' },
      memo: { from: 'source' },
    },
  };
}

async function withPeer(answers, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    const answer = answers[body.data.skill.id].shift();
    res.statusCode = answer.status || 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { return await run(`http://127.0.0.1:${server.address().port}/v1/main`, requests); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function runTurn(url, { headers = {}, skill = {}, intent, entities = {}, transactionLog = log } = {}, responses, requests) {
  const manager = new SkillConfigManager([
    { id: 'source', URL: url, intents: [] },
    { id: 'destination', URL: url, intents: [] },
  ]);
  const client = new SkillClient(manager);
  const emitted = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: headers, _auth: { id: 'account-h04', friendlyId: 'robot-h04' }, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false },
      skillClient: client,
      skillConfigManager: manager,
      intentRouter: { getSkillIDFromNLU(value) { return value.intent === 'launch-intent' ? { skillID: 'source' } : null; } },
    },
    { write(frame) { emitted.push(frame); } },
    transactionLog,
  );
  tx.handleMessage({ json: listen() });
  await new Promise(resolve => setImmediate(resolve));
  tx.handleMessage({ json: context(skill) });
  await new Promise(resolve => setImmediate(resolve));
  tx.handleMessage({ json: nlu(intent, entities) });
  await tx.done;
  return { emitted, requests, trace: tx.trace };
}

test('listen launch supplies source Jibo trace defaults and preserves action fields', async () => {
  await withPeer({ source: [{ body: action('source', 'launch-session', { fireAndForget: true, analytics: { marker: 'kept' } }) }], destination: [] }, async (url, requests) => {
    const result = await runTurn(url, { headers: {}, intent: 'launch-intent' }, null, requests);
    assert.equal(result.trace.transId, 'unknown');
    assert.equal(result.trace.robotId, 'unknown');
    assert.equal(result.trace.loggingConfig, '{}');
    assert.match(result.trace.turnId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(
      Object.fromEntries(['x-jibo-transid', 'x-jibo-robotid', 'x-jibo-logging-config'].map(key => [key, requests[0].headers[key]])),
      { 'x-jibo-transid': 'unknown', 'x-jibo-robotid': 'unknown', 'x-jibo-logging-config': '{}' },
    );
    assert.equal(requests[0].body.type, 'LISTEN_LAUNCH');
    assert.equal(requests[0].headers['x-phoenix-turn-id'], result.trace.turnId);
    assert.equal(requests[0].body.data.result.memo, null);
    assert.equal(result.emitted.at(-1).data.fireAndForget, true);
    assert.deepEqual(result.emitted.at(-1).data.analytics, { marker: 'kept' });
  });
});

test('continued update redirects with the opaque session and keeps redirect/action data', async () => {
  await withPeer({
    source: [{ body: redirect() }],
    destination: [{ body: action('destination', 'destination-session', { fireAndForget: true, analytics: { marker: 'destination' } }) }],
  }, async (url, requests) => {
    const result = await runTurn(url, {
      headers: { 'x-jibo-transid': 'trace-update' },
      skill: { id: 'source', session: { id: 'existing-session', opaque: { keep: true } } },
      intent: 'continue-intent',
    }, null, requests);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.type, 'LISTEN_UPDATE');
    assert.deepEqual(requests[0].body.data.skill.session, { id: 'existing-session', opaque: { keep: true } });
    assert.equal(requests[1].body.type, 'LISTEN_LAUNCH');
    assert.equal('asr' in requests[1].body.data.result, false);
    for (const request of requests) {
      assert.deepEqual(
        Object.fromEntries(['x-jibo-transid', 'x-jibo-robotid', 'x-jibo-logging-config'].map(key => [key, request.headers[key]])),
        { 'x-jibo-transid': 'trace-update', 'x-jibo-robotid': 'unknown', 'x-jibo-logging-config': '{}' },
      );
      assert.equal(request.headers['x-phoenix-turn-id'], result.trace.turnId);
    }
    assert.deepEqual(result.emitted.map(frame => frame.type), ['SOS', 'EOS', 'LISTEN', 'SKILL_REDIRECT', 'SKILL_ACTION']);
    assert.deepEqual(result.emitted[3].data.asr, { text: 'redirect asr' });
    assert.equal(result.emitted[4].data.fireAndForget, true);
    assert.deepEqual(result.emitted[4].data.analytics, { marker: 'destination' });
  });
});

test('voice turn telemetry emits only correlation, stage, duration, and outcome', async () => {
  const records = [];
  const transactionLog = {
    debug() {}, warn() {}, error() {},
    info(message, fields) { records.push({ message, fields }); },
  };
  await withPeer({ source: [{ body: action('source', 'telemetry-session') }], destination: [] }, async (url, requests) => {
    const result = await runTurn(url, {
      intent: 'launch-intent',
      // Deliberately sensitive-looking content: telemetry must not contain it.
      entities: { phrase: 'private transcript and token=do-not-log' },
      transactionLog,
    }, null, requests);
    const spans = records.filter((record) => record.message === 'voice_turn_span');
    assert.deepEqual(spans.map((record) => record.fields.stage), ['context_wait', 'route', 'skill', 'response_ready']);
    for (const { fields } of spans) {
      assert.deepEqual(Object.keys(fields).sort(), ['durationMs', 'event', 'outcome', 'stage', 'turnId']);
      assert.equal(fields.turnId, result.trace.turnId);
      assert.equal(typeof fields.durationMs, 'number');
    }
    const complete = records.find((record) => record.message === 'voice_turn_complete');
    assert.deepEqual(Object.keys(complete.fields).sort(), ['event', 'outcome', 'totalMs', 'turnId']);
    assert.equal(complete.fields.turnId, result.trace.turnId);
    assert.equal(JSON.stringify(records).includes('private transcript'), false);
    assert.equal(JSON.stringify(records).includes('do-not-log'), false);
  });
});

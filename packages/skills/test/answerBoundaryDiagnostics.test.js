// Synthetic offline fixtures only; no production requests or provider credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { recentLogs } from '@phoenix/common';
import { schemas, validate } from '@phoenix/contracts';
import { createSkillService, skillRoute } from '../src/skillService.js';
import { answerSkill } from '../src/answerSkill.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE = 'synthetic-private-speech credential=synthetic-secret https://provider.invalid/household/private';
const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const HEADERS = {
  authorization: 'Bearer synthetic-secret', cookie: 'credential=synthetic-secret',
  'x-jibo-transid': CALLER_ID, 'x-jibo-robotid': 'synthetic-private-robot',
  'x-jibo-logging-config': '{"synthetic-private-namespace":"debug"}',
  'x-amz-target': 'SyntheticPrivateCredential.SyntheticPrivateHousehold',
};
const REQUEST = {
  type: 'LISTEN_LAUNCH', msgID: 'synthetic-private-request', ts: 0,
  data: {
    general: { accountID: 'synthetic-private-account', robotID: 'synthetic-private-robot' },
    skill: { id: 'answer-skill', session: { id: 'synthetic-private-session' } },
    result: { asr: { text: PRIVATE }, nlu: { entities: {} } },
  },
};

async function start(t, name, handler) {
  const service = createSkillService({ name, skillId: 'answer-skill', handler });
  await service.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => service.server.close(resolve)));
  return service;
}

function post(service, { body = JSON.stringify(REQUEST), path = '/v1/main', headers = HEADERS } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: service.server.address().port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function errorEnvelope(response, status, message, serviceError = false) {
  assert.equal(response.status, status);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  const body = JSON.parse(response.body);
  assert.match(body.msgID, UUID);
  assert.equal(typeof body.ts, 'number');
  assert.deepEqual({ ...body, msgID: '<id>', ts: '<time>' }, {
    type: 'ERROR', msgID: '<id>', ts: '<time>',
    ...(serviceError ? { final: true } : {}),
    data: { message, ...(serviceError ? {} : { skill: { id: 'answer-skill' } }) },
  });
}

function failures(since, ns) {
  return recentLogs({ since, ns }).events.filter(e => e.level === 'error' || e.level === 'warn');
}

function safeFailure(event) {
  const allowed = new Set(['t', 'seq', 'level', 'ns', 'msg', 'transId', 'status', 'stage', 'errorClass', 'method', 'route']);
  for (const key of Object.keys(event)) assert.ok(allowed.has(key), `unexpected diagnostic key: ${key}`);
  assert.match(event.transId, UUID);
  assert.notEqual(event.transId, CALLER_ID);
  assert.ok(JSON.stringify(event).length < 600);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-private|synthetic-secret|provider\.invalid|SyntheticPrivate|11111111-1111/i);
}

test('the Answer host classifies parser HTTP 500 before invoking either skill alias', async t => {
  let calls = 0;
  const service = await start(t, 'answer-boundary-parser', () => { calls++; return {}; });
  service.server.prependListener('request', req => req.setEncoding('utf8'));
  const since = recentLogs().cursor;
  for (const path of ['/v1/main', '/v1/answer-skill/main']) {
    errorEnvelope(await post(service, { path }), 500, 'stream encoding should not be set', true);
  }
  assert.equal(calls, 0);
  const events = failures(since, 'answer-boundary-parser');
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual([event.stage, event.errorClass], ['body_parser', 'stream.encoding.set']);
    safeFailure(event);
  }
  assert.notEqual(events[0].transId, events[1].transId);
});

test('caught skill errors retain HTTP 200 envelopes and original handler traces but no raw diagnostics', async t => {
  let error = new TypeError(PRIVATE);
  error.name = PRIVATE;
  error.type = 'entity.parse.failed'; // Must not imply body-parser provenance.
  error.code = PRIVATE;
  const service = await start(t, 'answer-boundary-caught', (_body, context) => {
    assert.equal(context.trace.transId, CALLER_ID);
    assert.equal(context.req.jibo.transID, CALLER_ID);
    assert.equal(context.req.jibo.robotID, HEADERS['x-jibo-robotid']);
    assert.equal(context.req.headers.authorization, HEADERS.authorization);
    throw error;
  });
  const since = recentLogs().cursor;
  for (const [value, message] of [[error, PRIVATE], [PRIVATE, PRIVATE], [{ message: PRIVATE, code: PRIVATE }, PRIVATE]]) {
    error = value;
    errorEnvelope(await post(service), 200, message);
  }
  const events = failures(since, 'answer-boundary-caught');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(e => [e.msg, e.stage, e.errorClass]), [
    ['skill handler threw', 'handler', 'type_error'],
    ['skill handler threw', 'handler', 'unknown'],
    ['skill handler threw', 'handler', 'unknown'],
  ]);
  events.forEach(safeFailure);
});

test('a null throw keeps the existing outer HTTP 500, correlated to the caught skill boundary', async t => {
  const service = await start(t, 'answer-boundary-null', () => { throw null; });
  const since = recentLogs().cursor;
  errorEnvelope(await post(service), 500, "Cannot read property 'message' of null", true);
  const events = failures(since, 'answer-boundary-null');
  assert.deepEqual(events.map(e => [e.msg, e.stage, e.errorClass]), [
    ['skill handler threw', 'handler', 'unknown'],
    ['handler threw', 'handler', 'type_error'],
  ]);
  assert.equal(events[0].transId, events[1].transId);
  assert.equal(events.filter(e => e.status === 500).length, 1, 'one outer HTTP failure, not catch plus finish duplicates');
  events.forEach(safeFailure);
});

test('classification never invokes hostile error descriptors or copies error names and stacks', async t => {
  let inspected = 0;
  const error = new Proxy(new Error(PRIVATE), {
    getOwnPropertyDescriptor() { inspected++; throw new Error(PRIVATE); },
  });
  const service = await start(t, 'answer-boundary-descriptor', () => { throw error; });
  const since = recentLogs().cursor;
  errorEnvelope(await post(service), 200, PRIVATE);
  const events = failures(since, 'answer-boundary-descriptor');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].stage, events[0].errorClass], ['handler', 'unknown']);
  assert.equal(inspected, 1, 'a hostile reflection trap is contained, not serialized');
  safeFailure(events[0]);
});

test('direct skillRoute calls without an HTTP boundary use explicit unknown rather than raw errors', async () => {
  const entries = [];
  const response = await skillRoute('answer-skill', () => { throw new Error(PRIVATE); })({
    body: REQUEST, trace: {}, log: { error: (...args) => entries.push(args) },
  });
  assert.equal(response.data.message, PRIVATE);
  assert.deepEqual(entries, [['skill handler threw', { stage: 'handler', errorClass: 'unknown' }]]);
});

test('a real offline provider failure still gives the normal Answer fallback, not an HTTP boundary error', async t => {
  const providerRequests = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    providerRequests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: PRIVATE, credential: 'synthetic-secret' }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
  const fixtureEnv = {
    ETCO_answer_llmUrl: `http://127.0.0.1:${provider.address().port}/synthetic-private-provider`,
    ETCO_answer_llmApiKey: 'synthetic-secret', ETCO_answer_llmModel: 'synthetic-private-model',
    ETCO_answer_llmTimeoutMs: '1000', ETCO_answer_llmHeaders: '{}', PHOENIX_LLM_HEADERS: '{}',
  };
  const previous = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const service = await start(t, 'answer-boundary-fallback', answerSkill);
  const since = recentLogs().cursor;
  const response = await post(service);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  const validation = validate(schemas.skillResponse, body);
  assert.ok(validation.valid, validation.errors.join('; '));
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.final, true);
  assert.equal(body.data.action.config.jcp.children[0].config.play.esml, "I'm not sure about that one.");
  assert.equal(body.data.skill.session.id, REQUEST.data.skill.session.id);
  assert.equal(body.data.skill.session.data._answerSkill.question, PRIVATE);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].path, '/synthetic-private-provider/chat/completions');
  assert.equal(providerRequests[0].authorization, 'Bearer synthetic-secret');
  assert.equal(providerRequests[0].body.messages[1].content, PRIVATE);
  assert.deepEqual(failures(since, 'answer-boundary-fallback'), [], 'a handled provider fallback is not a diagnosed HTTP failure');
  assert.doesNotMatch(JSON.stringify(recentLogs({ since, ns: 'answer-boundary-fallback' }).events), /synthetic-private|synthetic-secret|provider\.invalid|11111111-1111/);
});

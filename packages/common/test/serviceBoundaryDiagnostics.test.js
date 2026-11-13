// Synthetic offline fixtures only. Exercise Express/body-parser, not a copied classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createService } from '../src/service.js';
import { recentLogs } from '../src/log.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function start(t, options) {
  const service = createService({ failureDiagnostics: true, ...options });
  await service.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => service.server.close(resolve)));
  return service;
}

function request(service, { path = '/v1/main', method = 'POST', body = '{}', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: service.server.address().port,
      method, path,
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

function errorEnvelope(response, status, message) {
  assert.equal(response.status, status);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.body)));
  const body = JSON.parse(response.body);
  assert.match(body.msgID, UUID);
  assert.equal(typeof body.ts, 'number');
  assert.deepEqual({ ...body, msgID: '<id>', ts: '<time>' }, {
    type: 'ERROR', msgID: '<id>', ts: '<time>', final: true, data: { message },
  });
}

function failures(since, ns) {
  return recentLogs({ since, ns }).events.filter(e => ['request rejected', 'handler threw', 'request failed'].includes(e.msg));
}

const HOSTILE = 'synthetic-private-speech credential=synthetic-secret https://provider.invalid/household/private';
const CALLER_UUID = '11111111-1111-4111-8111-111111111111';
const hostileHeaders = {
  authorization: 'Bearer synthetic-secret', cookie: 'credential=synthetic-secret',
  'x-jibo-transid': CALLER_UUID, 'x-phoenix-turn-id': CALLER_UUID,
  'x-jibo-robotid': 'synthetic-private-robot', 'x-jibo-accountid': 'synthetic-private-account',
  'x-amz-target': 'SyntheticPrivateCredential.SyntheticPrivateHousehold',
  'x-jibo-logging-config': '{"boundary-hostile":"error"}',
};

function safeFailure(event) {
  const allowed = new Set(['t', 'seq', 'level', 'ns', 'msg', 'transId', 'status', 'stage', 'errorClass', 'method', 'route']);
  for (const key of Object.keys(event)) assert.ok(allowed.has(key), `unexpected diagnostic key: ${key}`);
  assert.match(event.transId, UUID);
  assert.notEqual(event.transId, CALLER_UUID);
  assert.ok(JSON.stringify(event).length < 600);
  assert.doesNotMatch(JSON.stringify(event), /synthetic-private|synthetic-secret|provider\.invalid|SyntheticPrivate|11111111-1111/i);
}

test('services without the opt-in retain the exact existing handler context', async t => {
  const service = await start(t, { name: 'boundary-disabled', failureDiagnostics: false, routes: {
    'POST /v1/main': context => Object.keys(context),
  } });
  const response = await request(service);
  assert.equal(response.status, 200);
  assert.equal(response.body, '["req","res","url","body","trace","log"]');
});

test('body-parser rejection is classified before the handler without changing its wire envelope', async t => {
  let calls = 0;
  const service = await start(t, { name: 'boundary-parser', routes: {
    'POST /v1/main': () => { calls++; return {}; },
  } });
  const since = recentLogs().cursor;
  const response = await request(service, { body: '{' });
  errorEnvelope(response, 400, 'Unexpected end of JSON input');
  assert.equal(calls, 0);
  const events = failures(since, 'boundary-parser');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].stage, events[0].errorClass], ['body_parser', 'entity.parse.failed']);
  assert.match(events[0].transId, UUID);
});

test('an actual parser stream failure remains HTTP 500 and never enters the handler', async t => {
  let calls = 0;
  const service = await start(t, { name: 'boundary-parser-500', routes: {
    'POST /v1/main': () => { calls++; return {}; },
  } });
  // Exercise raw-body's real stream.encoding.set error; no parser is mocked.
  service.server.prependListener('request', req => req.setEncoding('utf8'));
  const since = recentLogs().cursor;
  const response = await request(service, { headers: hostileHeaders, body: JSON.stringify({ text: HOSTILE }) });
  errorEnvelope(response, 500, 'stream encoding should not be set');
  assert.equal(calls, 0);
  const events = failures(since, 'boundary-parser-500');
  assert.equal(events.length, 1, 'do not double-count catch plus finish as two failures');
  assert.deepEqual([events[0].stage, events[0].errorClass], ['body_parser', 'stream.encoding.set']);
  safeFailure(events[0]);
});

test('a pre-handler option failure is not classified as parsing or a handler invocation', async t => {
  let calls = 0;
  const service = await start(t, { name: 'boundary-pre-handler', jsonStrict: () => { throw new TypeError(HOSTILE); }, routes: {
    'POST /v1/main': () => { calls++; return {}; },
  } });
  const since = recentLogs().cursor;
  errorEnvelope(await request(service, { headers: hostileHeaders }), 500, HOSTILE);
  assert.equal(calls, 0);
  const events = failures(since, 'boundary-pre-handler');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].stage, events[0].errorClass], ['pre_handler', 'type_error']);
  safeFailure(events[0]);
});

test('a handler exception keeps the exact error message on the wire, never in diagnostics', async t => {
  const service = await start(t, { name: 'boundary-handler', routes: {
    'POST /v1/:slot': () => {
      const error = new TypeError(HOSTILE);
      error.name = HOSTILE;
      error.type = 'entity.parse.failed'; // A handler cannot establish parser provenance.
      error.code = HOSTILE;
      error.safeLogMessage = HOSTILE;
      throw error;
    },
  } });
  const since = recentLogs().cursor;
  errorEnvelope(await request(service, { path: '/v1/synthetic-private-slot?credential=synthetic-secret', headers: hostileHeaders }), 500, HOSTILE);
  const events = failures(since, 'boundary-handler');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].stage, events[0].errorClass], ['handler', 'type_error']);
  safeFailure(events[0]);
});

test('a handler-sent 500 has an unknown error class and preserves its exact bytes', async t => {
  const service = await start(t, { name: 'boundary-hostile', routes: {
    'POST /v1/:slot': ({ res }) => res.status(500).type('text/plain').send(HOSTILE),
  } });
  const since = recentLogs().cursor;
  const response = await request(service, { path: '/v1/synthetic-private-slot?credential=synthetic-secret', headers: hostileHeaders });
  assert.equal(response.status, 500);
  assert.equal(response.body, HOSTILE);
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
  const events = failures(since, 'boundary-hostile');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].stage, events[0].errorClass, events[0].route], ['handler', 'unknown', '/v1/:slot']);
  safeFailure(events[0]);
});

test('failure routes are bounded registered templates, never mutable request metadata', async t => {
  const service = await start(t, { name: 'boundary-route', routes: {
    'POST /v1/:slot': ({ req, res }) => {
      req.route.path = HOSTILE.repeat(100);
      res.status(500).send(HOSTILE);
    },
  } });
  const since = recentLogs().cursor;
  const response = await request(service, { path: '/v1/synthetic-private-slot', headers: hostileHeaders });
  assert.equal(response.status, 500);
  assert.equal(response.body, HOSTILE);
  const events = failures(since, 'boundary-route');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '/v1/:slot');
  safeFailure(events[0]);
});

test('overlong configured route templates are not copied into failure diagnostics', async t => {
  const path = '/v1/' + 'synthetic-private-slot'.repeat(100);
  const service = await start(t, { name: 'boundary-long-route', routes: {
    [`POST ${path}`]: ({ res }) => res.status(500).send(HOSTILE),
  } });
  const since = recentLogs().cursor;
  const response = await request(service, { path, headers: hostileHeaders });
  assert.equal(response.status, 500);
  assert.equal(response.body, HOSTILE);
  const events = failures(since, 'boundary-long-route');
  assert.equal(events.length, 1);
  assert.equal(events[0].route, '(other)');
  safeFailure(events[0]);
});

test('an uninstrumented health response reports unknown rather than guessing a failed boundary', async t => {
  const service = await start(t, {
    name: 'boundary-unknown', healthcheckBody: () => ({ statusCode: 500, body: 'synthetic unhealthy' }),
  });
  const since = recentLogs().cursor;
  const response = await request(service, { method: 'GET', path: '/healthcheck', body: '' });
  assert.equal(response.status, 500);
  assert.equal(response.body, 'synthetic unhealthy');
  const events = failures(since, 'boundary-unknown');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].stage, events[0].errorClass], ['unknown', 'unknown']);
});

test('overlapping requests cannot share a caller-selected diagnostic correlation or stage', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const handlerEntered = new Promise(resolve => { entered = resolve; });
  const service = await start(t, { name: 'boundary-overlap', routes: {
    'POST /v1/main': async () => { entered(); await held; throw new Error(HOSTILE); },
  } });
  t.after(release);
  const since = recentLogs().cursor;
  const first = request(service, { headers: hostileHeaders });
  await handlerEntered;
  const second = await request(service, { headers: hostileHeaders, body: '{' });
  release();
  errorEnvelope(await first, 500, HOSTILE);
  errorEnvelope(second, 400, 'Unexpected end of JSON input');
  const events = failures(since, 'boundary-overlap');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => [e.stage, e.errorClass]), [['body_parser', 'entity.parse.failed'], ['handler', 'error']]);
  assert.notEqual(events[0].transId, events[1].transId);
  events.forEach(safeFailure);
});

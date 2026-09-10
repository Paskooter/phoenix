// I-01 route-completeness and error-case tests.
//
// Complements history.http.test.js: that file asserts *payload shapes*; this one asserts that
// EVERY route the pinned Pegasus HistoryService registers is actually served, and pins the
// HTTP-level error cases (404 envelope, unsupported methods, HEAD, trailing slash, casing,
// content type, and the body-parser `{}` default the reference inherits).
//
// Source-of-truth for the route table (pinned 5c0a739...):
//   packages/history/src/HistoryService.ts:24-33      addHttpHandler('/v1/skill/launch'|'/v1/speech')
//   .../skilllaunch/SkillLaunchRequestsHandler.ts:20-29  POST / PUT /payload / GET+POST /latest /count
//   .../speech/SpeechHistoryRequestsHandler.ts:19-20     POST / / PUT /:id
//   .../utils/src/service/BaseService.ts:123,315,319      GET /healthcheck, 404 + error envelope

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryService } from '../src/index.js';
import { HistoryStore } from '../src/store.js';

const TS = Date.now();

async function start() {
  const store = new HistoryStore();
  const svc = createHistoryService(store);
  await svc.listen(0);
  return { store, svc, base: `http://127.0.0.1:${svc.server.address().port}` };
}

async function request(base, method, path, { body, query, raw, headers } = {}) {
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const h = { ...(headers || {}) };
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const res = await fetch(url, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, contentType: res.headers.get('content-type') };
}

const launch = (over = {}) => ({
  timestamp: TS, sessionID: 's', robotID: 'R-route', skillID: 'SK-route', ...over,
});

// Every route the reference registers, with a request a real caller can send.
const ROUTES = [
  ['POST', '/v1/skill/launch', { body: launch() }],
  ['PUT', '/v1/skill/launch/payload', { body: { robotID: 'R-miss', sessionID: 'x', skillID: 'y', payload: { a: 1 } } }],
  ['POST', '/v1/skill/launch/latest', { body: { robotID: 'R-route' } }],
  ['GET', '/v1/skill/launch/latest', { query: 'robotID=R-route' }],
  ['POST', '/v1/skill/launch/count', { body: { robotID: 'R-route' } }],
  ['GET', '/v1/skill/launch/count', { query: 'robotID=R-route' }],
  ['POST', '/v1/speech', { body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS } }],
  ['PUT', '/v1/speech/:id', { body: { audioFileURL: 'http://x' } }],
];

test('every reference history route is served as application/json (never 404)', async () => {
  const { svc, base } = await start();
  try {
    const speech = await request(base, 'POST', '/v1/speech', {
      body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS },
    });
    for (const [method, tmpl, opts] of ROUTES) {
      const path = tmpl.replace(':id', speech.json.id);
      const r = await request(base, method, path, opts);
      assert.notEqual(r.status, 404, `${method} ${path} must be routed`);
      assert.equal(r.contentType, 'application/json; charset=utf-8', `${method} ${path} content-type`);
    }
  } finally { svc.server.close(); }
});

test('unknown path and unsupported methods fall through to the 404 error envelope', async () => {
  const { svc, base } = await start();
  try {
    const cases = [
      ['GET', '/v1/skill/launch/does-not-exist'],
      ['GET', '/nope'],
      ['DELETE', '/v1/skill/launch/latest'],
      ['PATCH', '/v1/skill/launch/count'],
      ['PUT', '/v1/skill/launch/latest'],
    ];
    for (const [method, path] of cases) {
      const r = await request(base, method, path);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.json.type, 'ERROR');
      assert.equal(r.json.final, true);
      assert.equal(r.json.data.message, `URL not found: ${path}`, 'reference 404 message');
    }
  } finally { svc.server.close(); }
});

test('Express routing rules apply: trailing slash, case-insensitive, HEAD via GET', async () => {
  const { svc, base } = await start();
  try {
    const slashed = await request(base, 'POST', '/v1/skill/launch/', { body: launch({ sessionID: 'slash' }) });
    assert.equal(slashed.status, 200, 'trailing slash matches (Express strict routing off)');

    const upper = await request(base, 'GET', '/V1/SKILL/LAUNCH/COUNT', { query: 'robotID=R-route' });
    assert.equal(upper.status, 200, 'routing is case-insensitive');
    assert.equal(upper.json.count, 1, 'sees the record written through the slash form');

    const head = await request(base, 'HEAD', '/v1/skill/launch/count', { query: 'robotID=R-route' });
    assert.equal(head.status, 200, 'HEAD is served by the GET route');
    assert.equal(head.json, null, 'HEAD has no body');
  } finally { svc.server.close(); }
});

test('launch without timestamp defaults to numeric ms (reference `data.timestamp || Date.now()`)', async () => {
  const { svc, base } = await start();
  try {
    const before = Date.now();
    const r = await request(base, 'POST', '/v1/skill/launch', { body: { sessionID: 's', robotID: 'R-ts', skillID: 'SK' } });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.timestamp, 'number');
    assert.ok(r.json.timestamp >= before && r.json.timestamp <= Date.now(), 'timestamp defaulted to now');
  } finally { svc.server.close(); }
});

test('GET latest and count without robotID both fail with the 500 error envelope', async () => {
  const { svc, base } = await start();
  try {
    for (const path of ['/v1/skill/launch/latest', '/v1/skill/launch/count']) {
      const r = await request(base, 'GET', path);
      assert.equal(r.status, 500, `GET ${path}`);
      assert.equal(r.json.type, 'ERROR');
      assert.equal(r.json.final, true);
      assert.ok(r.json.data.message.length > 0);
    }
  } finally { svc.server.close(); }
});

test('PUT /v1/skill/launch/payload without a payload is a 500 (reference requires payload)', async () => {
  const { svc, base } = await start();
  try {
    await request(base, 'POST', '/v1/skill/launch', { body: launch({ sessionID: 'p1', robotID: 'R-pl', skillID: 'SK-pl' }) });
    const r = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'R-pl', sessionID: 'p1', skillID: 'SK-pl' },
    });
    assert.equal(r.status, 500);
    assert.equal(r.json.type, 'ERROR');
    assert.equal(r.json.final, true);
  } finally { svc.server.close(); }
});

// I-01 gap closed: the reference builds the `$set` document EAGERLY as the second argument to
// findOneAndUpdate (SkillLaunchCollection.ts:48-53 -> `payloadSize: Object.keys(data.payload).length`),
// so it throws BEFORE the query is issued and BEFORE any match is evaluated. A missing/null
// payload therefore always 500s - it can never fall through to the 200 `null` no-match result.
// Reference observed with the real compiled collection and the model call counted:
// docs/parity/evidence/2026-09-10/i01-history-routes/w7-ref-routes-oracle.json
// ("PUT ... NO payload key, no match" 500 / "payload null, no match" 500, findOneAndUpdate = 2 for
// five payload cases, i.e. the three malformed ones never reached the model).
test('PUT /v1/skill/launch/payload without payload is 500 even when nothing would match', async () => {
  const { svc, base } = await start();
  try {
    // Empty store: Phoenix previously returned 200 `null` here because it looked up the record first.
    const r = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'R-none', sessionID: 'none', skillID: 'SK-none' },
    });
    assert.equal(r.status, 500, 'reference throws on Object.keys(undefined) before the lookup');
    assert.equal(r.json.type, 'ERROR');
    assert.equal(r.json.final, true);
    assert.equal(r.json.data.message, 'Cannot convert undefined or null to object', 'Node TypeError message');
  } finally { svc.server.close(); }
});

test('PUT /v1/skill/launch/payload with payload null is 500 (reference Object.keys(null))', async () => {
  const { svc, base } = await start();
  try {
    const r = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'R-null', sessionID: 'n', skillID: 'SK-n', payload: null },
    });
    assert.equal(r.status, 500);
    assert.equal(r.json.data.message, 'Cannot convert undefined or null to object');
  } finally { svc.server.close(); }
});

test('PUT /v1/skill/launch/payload success returns the complete record (payload + payloadSize, stable id)', async () => {
  const { svc, base } = await start();
  try {
    const created = await request(base, 'POST', '/v1/skill/launch', {
      body: launch({ sessionID: 's-full', robotID: 'R-full', skillID: 'SK-full', intent: 'intent-x' }),
    });
    const r = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'R-full', sessionID: 's-full', skillID: 'SK-full', payload: { a: 1, b: 2 } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      ...created.json, payload: { a: 1, b: 2 }, payloadSize: 2, id: created.json.id,
    });
  } finally { svc.server.close(); }
});

test('launch id is a stable string and survives the payload update', async () => {
  const { svc, base } = await start();
  try {
    const created = await request(base, 'POST', '/v1/skill/launch', { body: launch({ sessionID: 'sid', robotID: 'R-id', skillID: 'SK-id' }) });
    assert.equal(typeof created.json.id, 'string');
    assert.ok(created.json.id.length > 0);
    const updated = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'R-id', sessionID: 'sid', skillID: 'SK-id', payload: { k: 1 } },
    });
    assert.equal(updated.json.id, created.json.id);
    assert.equal(updated.json.payloadSize, 1);
  } finally { svc.server.close(); }
});

// Reference BaseService behaviour that the candidate report got backwards:
// body-parser@1.18.2 sets `req.body = req.body || {}` (json.js:104 / urlencoded.js:86) before it
// checks content-type, so an empty or non-JSON body reaches the handler as `{}`, NOT `undefined`.
// (Verified executably against the pinned express@4.16.2 + body-parser@1.18.2.)
test('empty / non-JSON bodies reach the handler as {} (reference body-parser default)', async () => {
  const { svc, base } = await start();
  try {
    const speech = await request(base, 'POST', '/v1/speech', {
      body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS },
    });
    const emptyNoType = await request(base, 'PUT', `/v1/speech/${speech.json.id}`, {});
    assert.equal(emptyNoType.status, 200, 'no body / no content-type -> {} -> {id}');
    assert.deepEqual(emptyNoType.json, { id: speech.json.id });

    const textPlain = await request(base, 'PUT', `/v1/speech/${speech.json.id}`, { raw: '', headers: { 'content-type': 'text/plain' } });
    assert.equal(textPlain.status, 200);
    assert.deepEqual(textPlain.json, { id: speech.json.id });

    const speechEmpty = await request(base, 'POST', '/v1/speech', {});
    assert.equal(speechEmpty.status, 200, 'empty speech create still returns an id');
    assert.equal(typeof speechEmpty.json.id, 'string');
  } finally { svc.server.close(); }
});

test('healthcheck is the base-service route (documented history divergence I-01b)', async () => {
  const { svc, base } = await start();
  try {
    // Reference HistoryService overrides getHealthcheckResponse (HistoryService.ts:60-76) with
    // {status, skillLaunchDB, speechHistoryDB}. Phoenix serves the base 'ok' text; DIVERGENCES.md
    // records this as I-01b (reported, not changed). This test pins the CURRENT contract only.
    const r = await request(base, 'GET', '/healthcheck');
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'text/html; charset=utf-8');
    assert.equal(r.json, 'ok');
  } finally { svc.server.close(); }
});

test('bare (non-/v1) aliases are a Phoenix extension the reference 404s', async () => {
  const { svc, base } = await start();
  try {
    // Reference mounts only /v1/skill/launch and /v1/speech (HistoryService.ts:24-33); the pinned
    // express stack 404s /skill/launch/count. Phoenix keeps these aliases for older internal
    // callers — guarded here so the extension remains intentional.
    const bare = await request(base, 'GET', '/skill/launch/count', { query: 'robotID=R-route' });
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.json, { count: 0 });
    const bareSpeech = await request(base, 'POST', '/speech', { body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS } });
    assert.equal(typeof bareSpeech.json.id, 'string');
  } finally { svc.server.close(); }
});

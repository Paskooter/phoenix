// I-01 wire-parity tests: drive the real history service over HTTP with the same URL/query/body
// shapes the Pegasus history-client produces (POST /v1/skill/launch, PUT /v1/skill/launch/payload,
// POST+GET /v1/skill/launch/latest|count, POST /v1/speech, PUT /v1/speech/:id), and assert the
// reference response payloads: full saved records, no-match null (never 404), qs GET parsing,
// the 500 error envelope and speech create/update semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryService } from '../src/index.js';
import { HistoryStore } from '../src/store.js';

const TS = Date.now();

async function startService() {
  const store = new HistoryStore();
  const svc = createHistoryService(store);
  await svc.listen(0);
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  return { store, svc, base };
}

async function startServiceNow() {
  const { store, svc, base } = await startService();
  return { store, svc, base };
}

async function request(base, method, path, { body, query } = {}) {
  const url = query ? `${base}${path}?${new URLSearchParams(query)}` : `${base}${path}`;
  const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

function qs(parts) {
  return parts.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ---------------------------------------------------------------------------
// Skill-launch write + saved-record shape
// ---------------------------------------------------------------------------

test('POST /v1/skill/launch returns the full saved record with sorted personIDs and no payloadSize', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const body = {
      timestamp: TS, sessionID: 'sess-1', robotID: 'Robot-Jibo-Number-One', skillID: 'SKILL-1',
      intent: 'intent-1', personIDs: ['person-2', 'person-1'],
    };
    const r = await request(base, 'POST', '/v1/skill/launch', { body });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.id, 'string');
    assert.equal(r.json.robotID, 'Robot-Jibo-Number-One');
    assert.equal(r.json.sessionID, 'sess-1');
    assert.equal(r.json.skillID, 'SKILL-1');
    assert.equal(r.json.intent, 'intent-1');
    assert.deepEqual(r.json.personIDs, ['person-1', 'person-2'], 'personIDs sorted on write (Preformatter)');
    assert.equal(r.json.timestamp, TS);
    assert.ok(!('payloadSize' in r.json), 'launch write computes no payloadSize');
    assert.ok(!('_id' in r.json) && !('__v' in r.json) && !('type' in r.json));
  } finally { svc.server.close(); }
});

test('POST /v1/skill/launch with payload keeps the payload but still no payloadSize', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const r = await request(base, 'POST', '/v1/skill/launch', {
      body: { timestamp: TS, sessionID: 's', robotID: 'r-1', skillID: 'SK-1', payload: { a: 1 } },
    });
    assert.deepEqual(r.json.payload, { a: 1 });
    assert.ok(!('payloadSize' in r.json), 'payloadSize only comes from PUT /payload');
  } finally { svc.server.close(); }
});

test('PUT /v1/skill/launch/payload attaches payload+payloadSize to the matching launch', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const launch = await request(base, 'POST', '/v1/skill/launch', {
      body: { timestamp: TS, sessionID: 'sess-9', robotID: 'R-9', skillID: 'SK-9' },
    });
    const r = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'R-9', sessionID: 'sess-9', skillID: 'SK-9', payload: { key1: 'value1', key2: 'value2' } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, launch.json.id, 'payload update returns the same record');
    assert.equal(r.json.payloadSize, 2, 'payloadSize = key count');
    assert.deepEqual(r.json.payload, { key1: 'value1', key2: 'value2' });
  } finally { svc.server.close(); }
});

test('PUT /v1/skill/launch/payload with no matching record returns 200 with body null', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const r = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'nobody', sessionID: 'nope', skillID: 'SK-1', payload: { a: 1 } },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json, null, 'no-match payload update body is null (not {id:null})');
  } finally { svc.server.close(); }
});

// ---------------------------------------------------------------------------
// latest + count: POST and GET variants, no-match null, errors
// ---------------------------------------------------------------------------

test('POST /v1/skill/launch/latest returns newest match and null on no match', async () => {
  const { svc, base } = await startServiceNow();
  try {
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'a', robotID: 'R', skillID: 'SK-1', intent: 'i-a' } });
    const b = await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS + 1, sessionID: 'b', robotID: 'R', skillID: 'SK-2', intent: 'i-b' } });
    const hit = await request(base, 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R', rules: [{ field: 'intent', value: 'i-b' }] } });
    assert.equal(hit.json.id, b.json.id);
    assert.equal(hit.json.skillID, 'SK-2');
    const miss = await request(base, 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R', rules: [{ field: 'intent', value: 'i-x' }] } });
    assert.equal(miss.status, 200);
    assert.equal(miss.json, null, 'no match is 200 null, never 404');
  } finally { svc.server.close(); }
});

test('GET /v1/skill/launch/latest accepts the IHQuery from the query string', async () => {
  const { svc, base } = await startServiceNow();
  try {
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'a', robotID: 'R-GET', skillID: 'SK-1', intent: 'intent-1' } });
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS + 1, sessionID: 'b', robotID: 'R-GET', skillID: 'SK-2', intent: 'intent-2' } });

    const url = qs([
      ['robotID', 'R-GET'],
      ['rules[0][field]', 'intent'],
      ['rules[0][value]', 'intent-2'],
      ['rules[0][match]', 'EXACT'],
    ]);
    const hit = await request(base, 'GET', `/v1/skill/launch/latest?${url}`);
    assert.equal(hit.status, 200);
    assert.equal(hit.json.intent, 'intent-2');

    const miss = await request(base, 'GET', `/v1/skill/launch/latest?${qs([['robotID', 'R-GET'], ['rules[0][field]', 'intent'], ['rules[0][value]', 'intent-9']])}`);
    assert.equal(miss.status, 200);
    assert.equal(miss.json, null);
  } finally { svc.server.close(); }
});

test('GET latest without robotID fails with the 500 error envelope', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const r = await request(base, 'GET', '/v1/skill/launch/latest');
    assert.equal(r.status, 500);
    assert.equal(r.json.type, 'ERROR');
    assert.equal(r.json.final, true);
    assert.equal(r.json.data.message, 'Robot ID is required');
  } finally { svc.server.close(); }
});

test('POST and GET /v1/skill/launch/count return { count }', async () => {
  const { svc, base } = await startServiceNow();
  try {
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'c1', robotID: 'R-C', skillID: 'SK-1' } });
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'c2', robotID: 'R-C', skillID: 'SK-2' } });

    const post = await request(base, 'POST', '/v1/skill/launch/count', { body: { robotID: 'R-C' } });
    assert.deepEqual(post.json, { count: 2 });

    const get = await request(base, 'GET', `/v1/skill/launch/count?${qs([['robotID', 'R-C'], ['rules[0][field]', 'skillID'], ['rules[0][value]', 'SK-2']])}`);
    assert.deepEqual(get.json, { count: 1 });
  } finally { svc.server.close(); }
});

test('rule without match defaults to EXACT (reference validator defaulting)', async () => {
  const { svc, base } = await startServiceNow();
  try {
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'd1', robotID: 'R-D', skillID: 'SK-1', intent: 'intent-1' } });
    const hit = await request(base, 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R-D', rules: [{ field: 'intent', value: 'intent-1' }] } });
    assert.equal(hit.status, 200);
    assert.equal(hit.json.intent, 'intent-1', 'missing match defaults to EXACT');
  } finally { svc.server.close(); }
});

test('GET query values inside rules arrive as strings exactly like the reference (qs semantics)', async () => {
  const { svc, base } = await startServiceNow();
  try {
    await request(base, 'POST', '/v1/skill/launch', { body: { timestamp: TS, sessionID: 'e1', robotID: 'R-E', skillID: 'SK-1' } });
    // size to SK-1
    await request(base, 'PUT', '/v1/skill/launch/payload', { body: { robotID: 'R-E', sessionID: 'e1', skillID: 'SK-1', payload: { key4: 0 } } });

    // POST keeps the number type -> match
    const post = await request(base, 'POST', '/v1/skill/launch/latest', { body: { robotID: 'R-E', rules: [{ field: 'payload', key: 'key4', value: 0 }] } });
    assert.equal(post.json.payload.key4, 0);

    // GET decodes the leaf value as the string '0' -> no match (same qs behavior as Pegasus)
    const get = await request(base, 'GET', `/v1/skill/launch/latest?${qs([['robotID', 'R-E'], ['rules[0][field]', 'payload'], ['rules[0][key]', 'key4'], ['rules[0][value]', '0']])}`);
    assert.equal(get.status, 200);
    assert.equal(get.json, null, 'GET string value does not equal stored number 0');
  } finally { svc.server.close(); }
});

test('POST count with an unknown robotID is zero; unknown route is a 404 envelope', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const c = await request(base, 'POST', '/v1/skill/launch/count', { body: { robotID: 'never-here' } });
    assert.deepEqual(c.json, { count: 0 });
    const missing = await request(base, 'GET', '/v1/skill/launch/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.type, 'ERROR');
    assert.equal(missing.json.data.message, 'URL not found: /v1/skill/launch/does-not-exist');
  } finally { svc.server.close(); }
});

// ---------------------------------------------------------------------------
// speech create / update
// ---------------------------------------------------------------------------

test('POST /v1/speech creates a record and returns { id }', async () => {
  const { store, svc, base } = await startServiceNow();
  try {
    const r = await request(base, 'POST', '/v1/speech', {
      body: { robotID: 'r', accountID: 'a', transID: 't', audioFileURL: 'http://a', timestamp: TS },
    });
    assert.equal(r.status, 200);
    assert.ok(typeof r.json.id === 'string');
    const saved = store.speech.get(r.json.id);
    assert.equal(saved.robotID, 'r');
    assert.equal(saved.audioFileURL, 'http://a');
    assert.equal(saved.timestamp, TS);
  } finally { svc.server.close(); }
});

test('PUT /v1/speech/:id updates only whitelisted fields, strips null/undefined, never erases', async () => {
  const { store, svc, base } = await startServiceNow();
  try {
    const created = await request(base, 'POST', '/v1/speech', {
      body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS, asr: { text: 'original' } },
    });
    const id = created.json.id;

    const r = await request(base, 'PUT', `/v1/speech/${id}`, {
      body: {
        asr: null,                       // must be dropped, not erase the saved asr
        nlu: { intent: 'greet' },
        personIDs: ['person1'],
        match: { skillID: 's', launch: true },
        error: { message: 'boom' },
        robotID: 'HACKED',               // not an updatable field
        timestamp: 0,                    // not an updatable field
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { id });

    const rec = store.speech.get(id);
    assert.deepEqual(rec.asr, { text: 'original' }, 'null update value leaves the field untouched');
    assert.deepEqual(rec.nlu, { intent: 'greet' });
    assert.deepEqual(rec.personIDs, ['person1']);
    assert.deepEqual(rec.match, { skillID: 's', launch: true });
    assert.deepEqual(rec.error, { message: 'boom' });
    assert.equal(rec.robotID, 'r', 'robotID is not an updatable field');
  } finally { svc.server.close(); }
});

test('PUT /v1/speech/:id with only non-whitelisted fields still returns { id } and changes nothing', async () => {
  const { store, svc, base } = await startServiceNow();
  try {
    const created = await request(base, 'POST', '/v1/speech', {
      body: { robotID: 'r', accountID: 'a', transID: 't', timestamp: TS },
    });
    const id = created.json.id;
    const r = await request(base, 'PUT', `/v1/speech/${id}`, { body: { robotID: 'hax', nlu: undefined } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { id });
    assert.equal(store.speech.get(id).robotID, 'r');
    assert.ok(!('nlu' in store.speech.get(id)));
  } finally { svc.server.close(); }
});

test('PUT /v1/speech/:id with an unknown id returns the 500 error envelope', async () => {
  const { svc, base } = await startServiceNow();
  try {
    const r = await request(base, 'PUT', '/v1/speech/does-not-exist', { body: { audioFileURL: 'x' } });
    assert.equal(r.status, 500, 'reference null-derefs record._id -> 500');
    assert.equal(r.json.type, 'ERROR');
    assert.equal(r.json.final, true);
    assert.ok(r.json.data.message.length > 0);
  } finally { svc.server.close(); }
});
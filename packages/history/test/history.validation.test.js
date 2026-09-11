// I-02 focused tests: the skill-launch validation matrix, timestamps, identifier constraints,
// failure payloads, and the query semantics that the reference builds out of them.
//
// Every asserted message/status was observed from the pinned reference over real HTTP — see
// docs/parity/evidence/2026-09-10/i02-match-history-validation/ (i02-ref-oracle.json is the
// reference, i02-diff.json is the case-by-case comparison: 125/125 verifiable cases identical).
//
// Source of truth (pinned 5c0a7390539663ba749d360de348a428c088505c):
//   packages/history/src/skilllaunch/validators/rule.ts:15-143   allowed methods, value checks
//   packages/history/src/skilllaunch/validators/query.ts:9-47     joi QueryValidations, conflicts
//   packages/history/src/skilllaunch/validators/event.ts:5-32     joi alternatives (two branches)
//   packages/history/src/skilllaunch/db/SkillLaunchQueryBuilder.ts:18-128  $and document
//   packages/history/src/skilllaunch/utils/Preformatter.ts:24-32  EXACT personIDs rule sort
//   packages/history/src/skilllaunch/SkillLaunchRequestsHandler.ts:32-55  validation call order

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryService } from '../src/index.js';
import { HistoryStore } from '../src/store.js';
import { validateEvent, validateQuery, validateRule, MatchMethod, RuleField } from '../src/index.js';

const TS = 1789084000000;

// ---------------------------------------------------------------------------
// rule validator (validators/rule.ts)
// ---------------------------------------------------------------------------

test('rule: default match is the FIRST allowed method for the field/value type pair', () => {
  assert.equal(validateRule({ field: 'intent', value: 'x' }).match, MatchMethod.EXACT);
  assert.equal(validateRule({ field: 'personIDs', value: 'p1' }).match, MatchMethod.CONTAINS);
  assert.equal(validateRule({ field: 'personIDs', value: ['p1'] }).match, MatchMethod.EXACT);
  assert.equal(validateRule({ field: 'payload', value: { a: 1 } }).match, MatchMethod.EXACT);
  assert.equal(validateRule({ field: 'payload', value: ['a'] }).match, MatchMethod.CONTAINS_ANY);
});

test('rule: every allowed method for personIDs (array:array) is accepted, ONE_OF is not', () => {
  for (const match of ['EXACT', 'NOT', 'CONTAINS_ANY', 'CONTAINS_ALL', 'NOT_CONTAIN']) {
    assert.doesNotThrow(() => validateRule({ field: 'personIDs', value: ['p1'], match }));
  }
  assert.throws(
    () => validateRule({ field: 'personIDs', value: ['p1'], match: 'ONE_OF' }),
    /^Error: Match method ONE_OF cannot be used for personIDs and value p1$/,
  );
});

test('rule: value-type checks reproduce the reference messages', () => {
  assert.throws(() => validateRule({ field: 'skillID', value: '' }), /skillID items must be non-empty strings/);
  assert.throws(() => validateRule({ field: 'skillID', value: '   ' }), /skillID items must be non-empty strings/);
  assert.throws(() => validateRule({ field: 'personIDs', value: [] }), /personIDs arrays must be non-empty/);
  assert.throws(() => validateRule({ field: 'personIDs', value: [null] }), /personIDs items must be non-empty strings/);
  assert.throws(() => validateRule({ field: 'personIDs', value: ['a', ''] }), /personIDs items must be non-empty strings/);
  assert.throws(() => validateRule({ field: 'skillID', value: undefined }), /Unsupported value type: undefined/);
  assert.throws(() => validateRule({ field: 'skillID', value: null }), /Cannot process this rule: \{"field":"skillID","value":null\}/);
  assert.throws(() => validateRule({ field: 'skillID', value: 5 }), /Cannot process this rule/);
  assert.throws(() => validateRule({ field: 'bogus', value: 'x' }), /Unknown field: bogus/);
});

test('rule: array value is interpolated with Array#toString in the disallowed-method message', () => {
  assert.throws(
    () => validateRule({ field: 'skillID', value: 'x', match: 'ONE_OF' }),
    /Match method ONE_OF cannot be used for skillID and value x/,
  );
  assert.throws(
    () => validateRule({ field: 'personIDs', value: ['p1', 'p2'], match: 'CONTAINS' }),
    /Match method CONTAINS cannot be used for personIDs and value p1,p2/,
  );
});

// ---------------------------------------------------------------------------
// event validator (validators/event.ts — joi alternatives)
// ---------------------------------------------------------------------------

test('event: a launch without payload and a payload write without a launch both validate', () => {
  assert.doesNotThrow(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK' }));
  assert.doesNotThrow(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', payload: { a: 1 } }));
  assert.doesNotThrow(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', payload: null }));
});

test('event: both alternatives report, joined by ", "', () => {
  // branch A (launch) fails on the unknown key, branch B (payload) fails on the missing payload
  assert.throws(
    () => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', extra: 1 }),
    (e) => e.name === 'ValidationError'
      && e.message === '"extra" is not allowed, child "payload" fails because ["payload" is required]',
  );
  assert.throws(
    () => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', foo: 1, bar: 2 }),
    (e) => e.message === '"foo" is not allowed, "bar" is not allowed, child "payload" fails because ["payload" is required]',
  );
});

test('event: identifier, timestamp and personIDs constraints', () => {
  assert.throws(() => validateEvent({ sessionID: 's', skillID: 'SK' }),
    (e) => e.message === 'child "robotID" fails because ["robotID" is required], child "robotID" fails because ["robotID" is required]');
  assert.throws(() => validateEvent({ robotID: 'bad id', sessionID: 's', skillID: 'SK' }),
    (e) => e.message.includes('/^[a-zA-Z0-9-]*$/') && e.message.split(', ').length === 2);
  assert.throws(() => validateEvent({ robotID: 'R', sessionID: 'bad id', skillID: 'SK' }), /child "sessionID" fails/);
  assert.throws(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'bad id' }),
    /fails to match the required pattern: \/\^\(@be\\\/\)\?\[a-zA-Z0-9-_\]\*\$\/\], child "skillID"/);
  assert.throws(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: ['bad id'] }),
    (e) => e.message.startsWith('child "personIDs" fails because ["personIDs" at position 0 fails because ["0" with value "bad id" fails to match'));
  assert.throws(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', personIDs: [5] }),
    /"personIDs" at position 0 fails because \["0" must be a string\]/);
  assert.throws(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: Date.now() + 3600e3 }),
    /child "timestamp" fails because \["timestamp" must be less than or equal to "/);
  assert.throws(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: 'SK', timestamp: '2026-01-01T00:00:00Z' }),
    /"timestamp" must be a valid timestamp or number of milliseconds/);
  assert.doesNotThrow(() => validateEvent({ robotID: 'R', sessionID: 's', skillID: '@be/who-am-i', personIDs: [] }));
});

// ---------------------------------------------------------------------------
// query validator (validators/query.ts)
// ---------------------------------------------------------------------------

test('query: robotID is required and identifier-regex constrained', () => {
  assert.throws(() => validateQuery({}),
    (e) => e.message === 'child "robotID" fails because ["robotID" is required]');
  assert.throws(() => validateQuery({ robotID: null }), /"robotID" must be a string/);
  assert.throws(() => validateQuery({ robotID: '' }), /"robotID" is not allowed to be empty/);
  assert.throws(() => validateQuery({ robotID: 'bad id!' }),
    (e) => e.message === 'child "robotID" fails because ["robotID" with value "bad id!" fails to match the required pattern: /^[a-zA-Z0-9-]*$/]');
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1' }));
});

test('query: joi checks children in schema order, then reports EVERY unknown key with ". "', () => {
  // children first: rules is a schema child and comes before unknown keys
  assert.throws(() => validateQuery({ robotID: 'r-1', foo: 1, rules: null }),
    (e) => e.message === 'child "rules" fails because ["rules" must be an array]');
  // unknown keys are all reported, joined by '. '
  assert.throws(() => validateQuery({ robotID: 'r-1', foo: 1, bar: 2 }),
    (e) => e.message === '"foo" is not allowed. "bar" is not allowed');
  // a failing child aborts before the unknown-key pass
  assert.throws(() => validateQuery({ robotID: 'r-1', skillID: 5, foo: 1 }),
    (e) => e.message === 'child "skillID" fails because ["skillID" must be a string]');
});

test('query: timestamps accept ms and numeric strings, reject ISO/garbage/future startTime', () => {
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1', startTime: TS, endTime: TS }));
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1', startTime: String(TS) }));
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1', startTime: '0x10' })); // Number() coercion, as joi
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1', startTime: 0 }));
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1', endTime: Date.now() + 3600e3 }));
  assert.throws(() => validateQuery({ robotID: 'r-1', startTime: '2026-01-01T00:00:00Z' }),
    /"startTime" must be a valid timestamp or number of milliseconds/);
  assert.throws(() => validateQuery({ robotID: 'r-1', startTime: Date.now() + 3600e3 }),
    /"startTime" must be less than or equal to "/);
});

test('query: rule validation and conflicts run only after joi, and only when rules is non-empty', () => {
  assert.doesNotThrow(() => validateQuery({ robotID: 'r-1', rules: [] }));
  assert.throws(() => validateQuery({ robotID: 'bad id', rules: [{ field: 'bogus', value: 'x' }] }), /^ValidationError/);
  assert.throws(() => validateQuery({ rules: [{ field: 'bogus', value: 'x' }] }),
    (e) => e.message === 'child "robotID" fails because ["robotID" is required]');
  assert.throws(() => validateQuery({ robotID: 'r-1', rules: [{ field: 'bogus', value: 'x' }] }), /Unknown field: bogus/);
  assert.throws(() => validateQuery({ robotID: 'r-1', intent: 'i', rules: [{ field: 'intent', value: 'x' }] }),
    (e) => e.message === 'You specified intent both in exact match and rules');
  assert.throws(() => validateQuery({ robotID: 'r-1', skillID: 's', rules: [{ field: 'skillID', value: 'x' }] }),
    (e) => e.message === 'You specified skillID both in exact match and rules');
  assert.throws(() => validateQuery({ robotID: 'r-1', personID: 'p', rules: [{ field: 'personIDs', value: ['a'] }] }),
    (e) => e.message === 'You specified personID(s) both in exact match and rules');
  // a failing rule precedes the conflict check
  assert.throws(() => validateQuery({ robotID: 'r-1', intent: 'i', rules: [{ field: 'intent', value: '' }] }),
    /intent items must be non-empty strings/);
});

// ---------------------------------------------------------------------------
// HTTP: validation is in the handler, so a rejected write is never persisted
// ---------------------------------------------------------------------------

async function start() {
  const store = new HistoryStore();
  const svc = createHistoryService(store);
  await svc.listen(0);
  return { store, svc, base: `http://127.0.0.1:${svc.server.address().port}` };
}

async function request(base, method, path, { body, query } = {}) {
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;
  const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const ENVELOPE = (message) => ({ type: 'ERROR', final: true, data: { message } });

test('HTTP: an invalid launch is a 500 joi envelope AND is not persisted', async () => {
  const { store, svc, base } = await start();
  try {
    const bad = await request(base, 'POST', '/v1/skill/launch', {
      body: { timestamp: TS, sessionID: 'v1', robotID: 'bad id', skillID: 'SK-V' },
    });
    assert.equal(bad.status, 500);
    assert.equal(bad.json.type, 'ERROR');
    assert.equal(bad.json.final, true);
    assert.equal(bad.json.data.message,
      'child "robotID" fails because ["robotID" with value "bad id" fails to match the required pattern: /^[a-zA-Z0-9-]*$/], '
      + 'child "robotID" fails because ["robotID" with value "bad id" fails to match the required pattern: /^[a-zA-Z0-9-]*$/]');
    assert.equal(store.skillLaunches.length, 0, 'validation runs before the collection, so nothing was saved');

    const ok = await request(base, 'POST', '/v1/skill/launch', {
      body: { timestamp: TS, sessionID: 'v1', robotID: 'RV', skillID: 'SK-V', personIDs: ['pv-2', 'pv-1'] },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.personIDs, ['pv-1', 'pv-2'], 'write-side Preformatter still sorts');
  } finally { svc.server.close(); }
});

test('HTTP: query validation errors are the reference envelopes on POST and GET', async () => {
  const { store, svc, base } = await start();
  try {
    const cases = [
      ['POST', '/v1/skill/launch/latest', { body: {} }, 'child "robotID" fails because ["robotID" is required]'],
      ['POST', '/v1/skill/launch/count', { body: { robotID: 'RQ', rules: 'x' } }, 'child "rules" fails because ["rules" must be an array]'],
      ['POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'skillID', value: 'x', match: 'ONE_OF' }] } },
        'Match method ONE_OF cannot be used for skillID and value x'],
      ['POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', startTime: Date.now() + 3600e3 } }, null],
      ['GET', '/v1/skill/launch/count', { query: 'robotID=RQ&rules=foo' }, 'child "rules" fails because ["rules" must be an array]'],
      ['GET', '/v1/skill/launch/latest', { query: 'rules[0][field]=bogus&rules[0][value]=x' },
        'child "robotID" fails because ["robotID" is required]'],
    ];
    for (const [method, path, opts, message] of cases) {
      const r = await request(base, method, path, opts);
      assert.equal(r.status, 500, `${method} ${path}`);
      assert.equal(r.json.type, 'ERROR');
      assert.equal(r.json.final, true);
      if (message) assert.equal(r.json.data.message, message, `${method} ${path}`);
    }
    assert.equal(store.skillLaunches.length, 0, 'no invalid query ever reached the store');
  } finally { svc.server.close(); }
});

test('HTTP: joi runs before the query builder, so an unbuildable rule is still a joi/TypeError envelope', async () => {
  const { svc, base } = await start();
  try {
    // joi rejects the missing robotID before the payload rule is ever compiled
    const joiFirst = await request(base, 'POST', '/v1/skill/launch/latest', { body: { rules: [{ field: 'payload', value: null }] } });
    assert.equal(joiFirst.json.data.message, 'child "robotID" fails because ["robotID" is required]');

    // with a valid robotID the joi layer passes and the real builder throws (SkillLaunchQueryBuilder
    // getPayloadCondition -> Object.keys(null)) exactly as the reference does
    const builder = await request(base, 'POST', '/v1/skill/launch/latest', { body: { robotID: 'RQ', rules: [{ field: 'payload', value: null }] } });
    assert.equal(builder.status, 500);
    assert.equal(builder.json.data.message, 'Cannot convert undefined or null to object');
  } finally { svc.server.close(); }
});

test('HTTP: PUT /skill/launch/payload validates the event before Object.keys(payload)', async () => {
  const { svc, base } = await start();
  try {
    const badRobot = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'bad id', sessionID: 'v1', skillID: 'SK-V', payload: { a: 1 } },
    });
    assert.equal(badRobot.status, 500);
    assert.match(badRobot.json.data.message, /^child "robotID" fails because/);

    const noPayload = await request(base, 'PUT', '/v1/skill/launch/payload', {
      body: { robotID: 'RV', sessionID: 'v1', skillID: 'SK-V' },
    });
    assert.equal(noPayload.status, 500);
    assert.equal(noPayload.json.data.message, 'Cannot convert undefined or null to object');
  } finally { svc.server.close(); }
});

// ---------------------------------------------------------------------------
// Query semantics — the $and document the reference builds, evaluated in memory
// ---------------------------------------------------------------------------

function seeded() {
  const s = new HistoryStore();
  const L = (over) => s.addSkillLaunch({ timestamp: TS, robotID: 'RS', ...over });
  L({ sessionID: 's1', skillID: 'SK-A', intent: 'intent-a', personIDs: ['p1', 'p2'] });
  L({ timestamp: TS + 1000, sessionID: 's2', skillID: 'SK-B', intent: 'intent-b', personIDs: ['p2', 'p3'] });
  L({ timestamp: TS + 2000, sessionID: 's3b', skillID: 'SK-A2', intent: 'intent-a', personIDs: ['p1'] });
  L({ timestamp: TS + 3000, sessionID: 's3', skillID: 'SK-C', personIDs: [] });
  L({ timestamp: TS + 500, sessionID: 's5', skillID: 'SK-A', intent: 'intent-a', personIDs: ['p1', 'p2'] });
  L({ timestamp: TS + 4000, sessionID: 's6', skillID: 'SK-D', personIDs: ['p9'] });
  L({ timestamp: TS + 2500, sessionID: 's7', skillID: 'SK-E', personIDs: ['p1', 'p2'] });
  s.saveSkillPayload({ robotID: 'RS', sessionID: 's1', skillID: 'SK-A', payload: { key1: 'value1', key2: 'value2', key3: ['value3', 'value4'], key4: 0, key5: false } });
  s.saveSkillPayload({ robotID: 'RS', sessionID: 's2', skillID: 'SK-B', payload: { a: { b: 1 } } });
  s.saveSkillPayload({ robotID: 'RS', sessionID: 's3', skillID: 'SK-C', payload: {} });
  s.saveSkillPayload({ robotID: 'RS', sessionID: 's7', skillID: 'SK-E', payload: { 'a.b': 'flat' } });
  return s;
}
const N = (s, rules) => s.getCount({ robotID: 'RS', rules });

test('semantics: EXACT personIDs compares arrays order-independently (Preformatter sorts both sides)', () => {
  const s = seeded();
  const rule = (value) => [{ field: RuleField.PERSON_IDS, match: MatchMethod.EXACT, value }];
  assert.equal(N(s, rule(['p1', 'p2'])), 3, 's1, s5, s7');
  assert.equal(N(s, rule(['p2', 'p1'])), 3, 'the RULE value is sorted in place, like Preformatter does');
  assert.equal(N(s, rule(['p1'])), 1, 'only s3b has exactly [p1]');
});

test('semantics: NOT / CONTAINS / CONTAINS_ANY / CONTAINS_ALL / NOT_CONTAIN on personIDs', () => {
  const s = seeded();
  assert.equal(N(s, [{ field: 'personIDs', match: 'NOT', value: ['p1', 'p2'] }]), 4, 's2, s3b, s3, s6');
  assert.equal(N(s, [{ field: 'personIDs', match: 'CONTAINS', value: 'p2' }]), 4, 's1, s2, s5, s7');
  assert.equal(N(s, [{ field: 'personIDs', match: 'CONTAINS_ANY', value: ['p3', 'p9'] }]), 2, 's2, s6');
  assert.equal(N(s, [{ field: 'personIDs', match: 'CONTAINS_ALL', value: ['p1', 'p2'] }]), 3, 's1, s5, s7');
  assert.equal(N(s, [{ field: 'personIDs', match: 'NOT_CONTAIN', value: ['p1', 'p2'] }]), 2, 's3 (empty) and s6');
});

test('semantics: payload EXACT requires every key plus the exact payloadSize', () => {
  const s = seeded();
  const full = { key1: 'value1', key2: 'value2', key3: ['value3', 'value4'], key4: 0, key5: false };
  assert.equal(N(s, [{ field: 'payload', match: 'EXACT', value: full }]), 1, 's1 only');
  assert.equal(N(s, [{ field: 'payload', match: 'EXACT', value: { key1: 'value1' } }]), 0, 'subset fails the size check');
  assert.equal(N(s, [{ field: 'payload', value: {} }]), 1, 'default EXACT with {} == payloadSize 0 -> s3');
  assert.equal(N(s, [{ field: 'payload', match: 'EXACT', value: { key3: ['value3', 'value4'] } }]), 0, 'array value is only one of five keys');
});

test('semantics: payload operators, empty rule objects and array ordering', () => {
  const s = seeded();
  assert.equal(N(s, [{ field: 'payload', match: 'CONTAINS_ALL', value: { key1: 'value1', key3: ['value3', 'value4'] } }]), 1);
  assert.equal(N(s, [{ field: 'payload', match: 'CONTAINS_ALL', value: { key3: ['value4', 'value3'] } }]), 0, 'array order is significant for $eq');
  assert.equal(N(s, [{ field: 'payload', match: 'CONTAINS_ALL', value: {} }]), 7, '$and [] matches everything');
  assert.equal(N(s, [{ field: 'payload', match: 'CONTAINS_ANY', value: {} }]), 0, '$or [] matches nothing');
  assert.equal(N(s, [{ field: 'payload', match: 'CONTAINS_ANY', value: { key1: 'value1', key8: 'v8' } }]), 1);
  assert.equal(N(s, [{ field: 'payload', match: 'NOT_CONTAIN', value: {} }]), 7, '$and [] matches everything');
  assert.equal(N(s, [{ field: 'payload', match: 'NOT_CONTAIN', value: { key7: 'v7' } }]), 7, 'missing fields satisfy $ne');
  assert.equal(N(s, [{ field: 'payload', match: 'NOT', value: { key1: 'value1', key2: 'value2', key3: ['value4', 'value3'] } }]), 7);
  assert.equal(N(s, [{ field: 'payload', match: 'NOT', value: { key1: 'value1', key2: 'value2', key3: ['value3', 'value4'], key4: 0, key5: false } }]), 6, 'only s1 is an exact copy');
});

test('semantics: payload value coercions mirror Object.keys (primitives) and throw for null', () => {
  const s = seeded();
  assert.equal(N(s, [{ field: 'payload', value: 5 }]), 1, 'Object.keys(5) === [] -> payloadSize 0');
  assert.equal(N(s, [{ field: 'payload', value: true }]), 1, 'Object.keys(true) === []');
  assert.equal(N(s, [{ field: 'payload', value: 'x' }]), 0, "Object.keys('x') === ['0'] -> payload.0");
  assert.throws(() => s.getCount({ robotID: 'RS', rules: [{ field: 'payload', value: null }] }),
    /Cannot convert undefined or null to object/);
});

test('semantics: nested payload paths — dots are Mongo path separators, not literal keys', () => {
  const s = seeded();
  assert.equal(N(s, [{ field: 'payload', key: 'a.b', value: 1 }]), 1, 's2 stores {a:{b:1}}');
  assert.equal(N(s, [{ field: 'payload', key: 'a.b', value: 'flat' }]), 0, "s7's literal 'a.b' key is reachable only as payload.a.b");
  assert.equal(N(s, [{ field: 'payload', match: 'CONTAINS_ALL', value: { 'a.b': 1 } }]), 1, 'object-form rule uses the same path');
});

test('semantics: payload key rules and records with no payload at all', () => {
  const s = seeded();
  assert.equal(N(s, [{ field: 'payload', key: 'key4', value: 0 }]), 1);
  assert.equal(N(s, [{ field: 'payload', key: 'key5', value: false }]), 1);
  assert.equal(N(s, [{ field: 'payload', key: 'key1', value: 'value1', match: 'NOT' }]), 6, 'missing payload satisfies $ne');
  assert.equal(N(s, [{ field: 'payload', key: 'key1', value: 'value1', match: 'CONTAINS' }]), 1, 'CONTAINS wraps in $in [v]');
  assert.equal(N(s, [{ field: 'payload', key: 'key1', value: ['value1'], match: 'NOT_CONTAIN' }]), 6, 's1 holds key1=value1 so $not $in excludes it');
  assert.equal(N(s, [{ field: 'payload', key: 'key1', value: 'value1' }]), 1, 's6 has no payload -> no match');
});

test('semantics: exact-match params, session exclusion and time boundaries', () => {
  const s = seeded();
  assert.equal(s.getCount({ robotID: 'RS', intent: 'intent-a' }), 3);
  assert.equal(s.getCount({ robotID: 'RS', skillID: 'SK-B' }), 1);
  assert.equal(s.getCount({ robotID: 'RS', personID: 'p1' }), 4);
  assert.equal(s.getCount({ robotID: 'RS', personID: 'pz' }), 0);
  assert.equal(s.getCount({ robotID: 'RS', notSessionID: 's1' }), 6);
  assert.equal(s.getCount({ robotID: 'RS', startTime: TS + 1000 }), 5, '$gte is inclusive');
  assert.equal(s.getCount({ robotID: 'RS', endTime: TS + 1000 }), 3, '$lte is inclusive');
  assert.equal(s.getCount({ robotID: 'RS', startTime: TS + 2000, endTime: TS + 2000 }), 1, 'a point window');
  assert.equal(s.getCount({ robotID: 'RS', startTime: 0 }), 7, 'falsy startTime is skipped, like the reference');
});

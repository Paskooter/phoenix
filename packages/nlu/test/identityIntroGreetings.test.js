// N-04 — identity, introduction and greeting follow-up rules.
//
// Acceptance (docs/parity/tasks.json, N-04):
//   1. Cover each named introduction/who-am-i/greeting rule, including
//      no-input/no-match and ambiguous name responses.
//   2. Compare entities/referents and rule names in multi-turn robot
//      transcripts using known and unknown loop members.
//
// Coverage is fixture-driven: test/fixtures/identity-intro-greetings.json holds
// every row with a pinned-source `anchor` under
// pegasus@5c0a739:packages/parser/robust-parser/rules_src (the revision pinned
// by resources/rule-inventory.json). Rows marked `basis:"native"` are
// additionally checked against the vendored native oracle
// (resources/legacy-oracle/golden.jsonl, nativeSourceRevision 91b1bb6).
//
// Three phases, all real code paths:
//   direct  parseRequest()            — the exact entry the HTTP handler calls.
//   http    POST /v1/parse            — a live service on an ephemeral port.
//   oracle  native anchor cross-check — for the rows the archive captured.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../src/requestParser.js';
import { start } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'resources');
const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'identity-intro-greetings.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(RES, 'rule-inventory.json'), 'utf8'));

const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};
const same = (a, b) => stable(a) === stable(b);
const EMPTY = { entities: null, intent: null, rules: [] };

// Every named public rule owned by N-04: the introductions / who-am-i /
// greetings subtrees. The `launch` public rule is a separate union of the twenty
// */launch graphs; its three N-04 sources are exercised through launchIntents.
const N04_PREFIXES = ['introductions/', 'who-am-i/', 'greetings/'];
const subRules = Object.keys(inventory.publicRules).filter(name => N04_PREFIXES.some(p => name.startsWith(p))).sort();

// Native anchor: Input -> { intent, entities } (HTTP drops intent and priority
// from the NLParse; RobustParserClient.ts:253-260).
function nativeOracle() {
  const map = new Map();
  for (const line of readFileSync(join(RES, 'legacy-oracle', 'golden.jsonl'), 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const rows = JSON.parse(text);
    if (!rows.length) continue;
    const { Input, NLParse } = rows[0];
    const { intent, priority, ...entities } = NLParse;
    map.set(Input, { intent, entities });
  }
  return map;
}

// Entity keys the pinned rule source declares, per its `{key=...}` / `{% key=... %}`
// tags. Excludes the native response key and the LoopMemberDetector's outputs.
const NATIVE_KEYS = new Set(['union_original_fst_name']);
const DETECTOR_KEYS = new Set(['loopMemberReferent', 'given-name', 'last-name']);
function declaredKeys(anchor) {
  // The fixture cites the pinned pegasus path; the vendored copy lives under
  // resources/rules-src with the same sub-path.
  const file = anchor
    .replace(/:\d+(-\d+)?$/, '')
    .replace('packages/parser/robust-parser/rules_src', 'rules-src');
  const text = readFileSync(join(RES, file), 'utf8');
  const declared = new Set();
  for (const m of text.matchAll(/\{\s*([A-Za-z_]\w*)\s*[=+]/g)) declared.add(m[1]);
  for (const m of text.matchAll(/\{%\s*([A-Za-z_]\w*)\s*[=+]/g)) declared.add(m[1]);
  return declared;
}

// ---------------------------------------------------------------------------
// 1. fixture shape — every named rule is covered.
// ---------------------------------------------------------------------------

test('N-04 fixture covers every named introduction/who-am-i/greeting rule exactly once', () => {
  assert.equal(fixture.referenceRevision, inventory.referenceRevision, 'fixture and inventory must pin the same reference revision');
  assert.equal(subRules.length, 21, `expected 21 N-04 named rules, found ${subRules.length}`);
  const fixtured = fixture.namedRules.map(row => row.rule).sort();
  assert.deepEqual(fixtured, subRules, 'fixture named-rule set must equal the inventory subtree');
  assert.equal(new Set(fixtured).size, fixtured.length, 'duplicate fixture row');
  for (const row of fixture.namedRules) {
    assert.ok(row.anchors && row.anchors.length && row.anchors.every(a => a.startsWith(fixture.referenceSourceRoot)), `${row.rule}: needs a pinned-source anchor`);
    assert.ok(row.positives.length >= 1, `${row.rule}: needs at least one positive`);
    assert.ok(row.negative || (row.negativeUnavailable && row.negativeUnavailable.length > 10), `${row.rule}: negative fixture missing and no documented reason`);
  }
});

test('N-04 every named-rule positive and negative matches at runtime through parseRequest', () => {
  const failures = [];
  let cases = 0;
  for (const row of fixture.namedRules) {
    for (const positive of row.positives) {
      cases += 1;
      let got;
      try { got = norm(parseRequest({ text: positive.text, rules: [row.rule] })); }
      catch (error) { failures.push(`${row.rule} ${JSON.stringify(positive.text)}: threw ${error.message}`); continue; }
      if (!same(got, positive.expect)) failures.push(`${row.rule} ${JSON.stringify(positive.text)}: expected ${JSON.stringify(positive.expect)} got ${JSON.stringify(got)}`);
    }
    if (row.negative) {
      cases += 1;
      const got = norm(parseRequest({ text: row.negative.text, rules: [row.rule] }));
      if (!same(got, row.negative.expect)) failures.push(`${row.rule} ${JSON.stringify(row.negative.text)}: expected ${JSON.stringify(row.negative.expect)} got ${JSON.stringify(got)}`);
    }
  }
  assert.ok(cases >= 100, `expected a broad fixture set, got ${cases}`);
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// 2. launch intents — greetings / who-am-i / introductions graphs.
// ---------------------------------------------------------------------------

test('N-04 every launch intent matches, and native-anchored rows agree with the pinned oracle', () => {
  const oracle = nativeOracle();
  assert.ok(oracle.size >= 80, `native oracle should be broad, got ${oracle.size}`);
  let nativeChecked = 0;
  const failures = [];
  for (const row of fixture.launchIntents) {
    const got = norm(parseRequest({ text: row.text, rules: row.rules }));
    if (!same(got, row.expect)) failures.push(`${row.id}: expected ${JSON.stringify(row.expect)} got ${JSON.stringify(got)}`);
    if (row.basis === 'native') {
      const anchor = oracle.get(row.text);
      assert.ok(anchor, `${row.id}: claims a native anchor for ${JSON.stringify(row.text)} but the oracle has no such case`);
      nativeChecked += 1;
      if (!same({ entities: row.expect.entities, intent: row.expect.intent }, anchor)) {
        failures.push(`${row.id}: fixture ${JSON.stringify(row.expect)} != native oracle ${JSON.stringify(anchor)}`);
      }
    }
    // A launch winner must always carry the source graph handle it was selected from.
    assert.match(got.entities.union_original_fst_name, /^handle:(greetings|who-am-i|introductions|chitchat)\/launch$/, `${row.id}: launch handle shape`);
  }
  assert.ok(nativeChecked >= 8, `expected several native-anchored launch rows, got ${nativeChecked}`);
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// 3. no input / no match.
// ---------------------------------------------------------------------------

test('N-04 no-input and no-match return the empty NLU result (never a phantom launch)', () => {
  for (const row of fixture.noInput) {
    assert.deepEqual(norm(parseRequest({ text: row.text, rules: row.rules })), EMPTY, row.id);
  }
  // A follow-up rule asked about an utterance outside its vocabulary is an
  // explicit no-match, not a promotion of another arm.
  for (const rule of ['who-am-i/confirm', 'introductions/is_name_right', 'greetings/you_too']) {
    assert.deepEqual(norm(parseRequest({ text: 'qzx florp', rules: [rule] })), EMPTY, rule);
  }
});

// ---------------------------------------------------------------------------
// 4. ambiguous names.
// ---------------------------------------------------------------------------

test('N-04 an ambiguous first name resolves deterministically to the first member', () => {
  for (const row of fixture.ambiguous) {
    assert.deepEqual(norm(parseRequest(row)), row.expect, row.id);
  }
  // Two members share the first name "Jane"; every resolution path must pick the
  // first (LoopMemberDetector.ts:65-68 entity lookup, :81-90 text search).
  const first = fixture.ambiguous[0].loop.users[0];
  assert.equal(first.id, 'u-jane-first');
  for (const row of fixture.ambiguous) {
    assert.equal(row.expect.entities.loopMemberReferent, first.id, `${row.id}: referent must be the first member`);
    assert.equal(row.expect.entities['given-name'], first.firstName);
    assert.equal(row.expect.entities['last-name'], first.lastName);
  }
});

// ---------------------------------------------------------------------------
// 5. multi-turn transcripts with known / unknown loop members.
// ---------------------------------------------------------------------------

const REFERENT_TURNS = {
  'known-member-identity-enrollment': { turn: 1, member: 'u-george' },
  'known-member-introduction': { turn: 0, member: 'u-mary' },
};

test('N-04 multi-turn transcripts replay exactly, with referents only for known members', () => {
  assert.ok(fixture.transcripts.length >= 6, 'expected several multi-turn transcripts');
  const failures = [];
  let turns = 0;
  for (const transcript of fixture.transcripts) {
    const expectReferent = REFERENT_TURNS[transcript.id];
    for (const [index, turn] of transcript.turns.entries()) {
      turns += 1;
      const request = { text: turn.text, rules: turn.rules };
      if (transcript.loop) request.loop = transcript.loop;
      const got = norm(parseRequest(request));
      if (!same(got, turn.expect)) failures.push(`${transcript.id}#${index} ${JSON.stringify(turn.text)}: expected ${JSON.stringify(turn.expect)} got ${JSON.stringify(got)}`);
      // Rule name is part of the turn contract.
      if (got.rules[0] !== turn.rules[0]) failures.push(`${transcript.id}#${index}: winner ${got.rules[0]} != requested ${turn.rules[0]}`);
      // Known member ⇒ referent; unknown/absent member ⇒ no referent.
      const writesReferent = got.entities && Object.prototype.hasOwnProperty.call(got.entities, 'loopMemberReferent');
      if (expectReferent && expectReferent.turn === index) {
        if (!writesReferent) failures.push(`${transcript.id}#${index}: known member ${expectReferent.member} was not resolved to a referent`);
        else if (got.entities.loopMemberReferent !== expectReferent.member) failures.push(`${transcript.id}#${index}: referent ${got.entities.loopMemberReferent} != ${expectReferent.member}`);
      } else if (writesReferent) {
        failures.push(`${transcript.id}#${index}: unexpected referent ${got.entities.loopMemberReferent} for an unknown/absent member`);
      }
    }
  }
  assert.ok(turns >= 18, `expected a multi-turn set, got ${turns}`);
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// 6. entity provenance.
// ---------------------------------------------------------------------------

test('N-04 every expected entity key is declared by the pinned rule source', () => {
  const check = (id, anchor, entities) => {
    const declared = declaredKeys(anchor);
    for (const key of Object.keys(entities || {})) {
      if (NATIVE_KEYS.has(key) || DETECTOR_KEYS.has(key)) continue;
      assert.ok(declared.has(key), `${id}: expected entity '${key}' is not declared by ${anchor}`);
    }
  };
  for (const row of fixture.launchIntents) check(row.id, row.anchor, row.expect.entities);
  for (const row of fixture.namedRules) {
    const anchor = row.anchors[0];
    for (const positive of row.positives) check(`${row.rule} ${JSON.stringify(positive.text)}`, anchor, positive.expect.entities);
  }
});

// ---------------------------------------------------------------------------
// 7. live HTTP.
// ---------------------------------------------------------------------------

let server;
let base;
const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;

before(async () => {
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime;
});

async function parseOverHttp(request) {
  const response = await fetch(`${base}/v1/parse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: request }),
  });
  const body = await response.json();
  return { status: response.status, got: body.data };
}

test('N-04 the identity/introduction/greeting contract holds over live POST /v1/parse', async () => {
  const cases = [];
  for (const row of fixture.launchIntents) cases.push({ id: row.id, request: { text: row.text, rules: row.rules }, expect: row.expect });
  for (const row of fixture.namedRules) {
    for (const positive of row.positives) cases.push({ id: `${row.rule}:${positive.text}`, request: { text: positive.text, rules: [row.rule] }, expect: positive.expect });
  }
  for (const row of fixture.noInput) cases.push({ id: row.id, request: { text: row.text, rules: row.rules }, expect: EMPTY });
  for (const row of fixture.ambiguous) cases.push({ id: row.id, request: row, expect: row.expect });
  for (const transcript of fixture.transcripts) {
    for (const [index, turn] of transcript.turns.entries()) {
      const request = { text: turn.text, rules: turn.rules };
      if (transcript.loop) request.loop = transcript.loop;
      cases.push({ id: `${transcript.id}#${index}`, request, expect: turn.expect });
    }
  }
  const failures = [];
  for (const c of cases) {
    const { status, got } = await parseOverHttp(c.request);
    if (status !== 200 || !same(got, c.expect)) failures.push(`${c.id}: status ${status} expected ${JSON.stringify(c.expect)} got ${JSON.stringify(got)}`);
  }
  assert.ok(cases.length >= 100, `expected a broad HTTP set, got ${cases.length}`);
  assert.deepEqual(failures, []);
});

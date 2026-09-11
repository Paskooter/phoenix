// N-03 — clock, alarm, timer and settings/main-menu follow-up rules.
//
// Fixture-driven acceptance for the 20 named rules in the three N-03 groups
// (`clock/`, `settings/`, `main-menu/`). Every row carries a pinned-source
// citation in the fixture (`source`); the expected intents/entities were derived
// from the pinned .rule sources under
// pegasus@5c0a739:packages/parser/robust-parser/rules_src and are confirmed at
// runtime here through parseRequest AND a live POST /v1/parse.
//
// Two rules (clock/alarm_set_value, clock/alarm_timer_ampm) declare the `time`
// factory, which has no bundled source matcher (rule-inventory.json
// factoryDependencies.time.status === 'unsupported'), and are exercised as a
// documented whole-rule refusal — never a silent no-match. The last tests prove
// why that refusal cannot be narrowed to the non-time arm of
// clock/alarm_timer_ampm while the factory is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../src/requestParser.js';
import { parse as parseRules } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';
import { start } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'resources');
const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'clock-settings-menu.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(RES, 'rule-inventory.json'), 'utf8'));

const N03_GROUP = /^(clock|settings|main-menu)\//;
const n03Rules = Object.keys(inventory.publicRules).filter(name => N03_GROUP.test(name)).sort();
const timeRules = ['clock/alarm_set_value', 'clock/alarm_timer_ampm'];

const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });
// Order-insensitive value comparison: the fixture cites entities/intent/rules in
// source order while parseRequest returns them in wire order.
const stable = value => {
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(value, (key, v) => (
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort())
      : v
  ));
};
const same = (a, b) => stable(a) === stable(b);
const sourceText = name => readFileSync(join(RES, 'rules-src', `${name}.rule`), 'utf8');

// All match rows (positive/boundary, plus the negative rows whose expectation is
// the no-match result) flattened for the runtime phases.
function matchRows() {
  const rows = [];
  for (const row of fixture.namedRules) {
    for (const c of row.cases) {
      rows.push({ id: `${row.rule}:${c.kind}:${c.text}`, rule: row.rule, text: c.text, expect: c.expect });
    }
  }
  return rows;
}

function refusalRows() {
  const rows = [];
  for (const row of fixture.timeRules) {
    for (const text of row.refusalUtterances) {
      rows.push({ id: `${row.rule}:${text}`, rule: row.rule, text, error: row.error });
    }
  }
  return rows;
}

// Mirror of the request-scoped matcher context built by requestParser.js:226-238
// (merged factory rules, strict factory resolution, no factory hook for `time`).
// Used to observe the arm-level outcome of a rule WITHOUT the whole-rule gate so
// the narrowing decision can be measured instead of asserted by hand.
function matchWithoutGate(ruleName, text) {
  const sources = inventory.publicRules[ruleName].sources;
  const merged = {};
  for (const source of sources) Object.assign(merged, parseRules(readFileSync(join(RES, 'rules-src', `${source}.rule`), 'utf8')).rules);
  const factories = {};
  for (const [name, entry] of Object.entries(inventory.factories)) {
    const ast = parseRules(readFileSync(join(RES, entry.path), 'utf8'));
    Object.assign(factories, ast.rules);
  }
  const ctx = {
    rules: Object.assign({}, factories, merged),
    strictFactories: true,
    // `time` is unsupported: the hook resolves nothing, exactly as
    // requestParser.js:233-235 returns undefined for a factory it never loaded.
    factoryHook: name => (inventory.factoryDependencies[name]?.status === 'unsupported' ? null : factories[name]),
  };
  return matchRule(merged.TopRule, tokenize(text), ctx);
}

test('N-03 fixture covers every clock/settings/main-menu named rule with cited cases', () => {
  assert.equal(fixture.referenceRevision, inventory.referenceRevision, 'fixture and inventory must pin the same reference revision');
  const fixtured = [...fixture.namedRules.map(row => row.rule), ...fixture.timeRules.map(row => row.rule)].sort();
  assert.deepEqual(fixtured, n03Rules, 'the fixture must cover exactly the clock/settings/main-menu named rules');
  assert.equal(fixtured.length, 20, 'expected 12 clock + 5 settings + 3 main-menu rules');
  assert.equal(fixture.namedRules.length, 18, 'the eighteen executable rules are fixtured individually');
  assert.deepEqual(fixture.timeRules.map(row => row.rule).sort(), timeRules);
  const kinds = new Set();
  for (const row of fixture.namedRules) {
    assert.equal(row.source.replace(/\.rule$/, ''), inventory.publicRules[row.rule].sources[0], `${row.rule}: fixture/source mismatch`);
    assert.ok(row.source.endsWith('.rule'), `${row.rule}: source must name the .rule file`);
    assert.ok(row.cases.length >= 3, `${row.rule}: needs positive, negative and boundary cases`);
    for (const c of row.cases) {
      kinds.add(c.kind);
      assert.ok(c.source && c.source.includes('.rule:'), `${row.rule}: every case cites a source line`);
    }
    assert.ok(row.cases.some(c => c.kind === 'negative'), `${row.rule}: no negative case`);
    assert.ok(row.cases.some(c => c.kind === 'positive'), `${row.rule}: no positive case`);
  }
  assert.deepEqual([...kinds].sort(), ['boundary', 'negative', 'positive'], 'all three case kinds must be present');
});

test('N-03 every clock/settings/main-menu fixture matches at runtime through parseRequest', () => {
  const rows = matchRows();
  assert.ok(rows.length >= 100, `expected a broad fixture set, got ${rows.length}`);
  const failures = [];
  for (const row of rows) {
    let got;
    try { got = norm(parseRequest({ text: row.text, rules: [row.rule] })); }
    catch (error) { failures.push(`${row.id}: threw ${error.message}`); continue; }
    if (!same(got, row.expect)) failures.push(`${row.id}: expected ${JSON.stringify(row.expect)} got ${JSON.stringify(got)}`);
  }
  assert.deepEqual(failures, []);
});

test('N-03 every fixture matches through a live POST /v1/parse and the time rules refuse', async () => {
  const rows = matchRows();
  const refusals = refusalRows();
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const failures = [];
  try {
    for (const row of rows) {
      const response = await fetch(`${base}/v1/parse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'NLU', data: { text: row.text, rules: [row.rule] } }),
      });
      const body = await response.json().catch(() => null);
      const got = body && body.data ? norm(body.data) : null;
      if (response.status !== 200 || !same(got, row.expect)) {
        failures.push(`${row.id}: status ${response.status} ${JSON.stringify(got)}`);
      }
    }
    for (const row of refusals) {
      const response = await fetch(`${base}/v1/parse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'NLU', data: { text: row.text, rules: [row.rule] } }),
      });
      if (response.status !== 500) failures.push(`${row.id}: expected the loud refusal (500), got ${response.status}`);
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
  assert.deepEqual(failures, []);
});

test('N-03 the time-factory rules refuse loudly for every utterance, never a silent no-match', () => {
  const rows = refusalRows();
  assert.equal(rows.length, 24, 'both time rules must be probed across the whole AM/PM, value and nonsense envelope');
  for (const row of rows) {
    assert.throws(
      () => parseRequest({ text: row.text, rules: [row.rule] }),
      error => error.message === row.error,
      `${row.id}: expected the whole-rule refusal`,
    );
  }
});

test('N-03 the whole-rule gate is retained: the time factory source does not parse, so no arm can be certified', () => {
  const timeSource = readFileSync(join(RES, 'factory-sources', 'time.grm'), 'utf8');
  // The only bundled source for the `time` factory cannot be parsed: the literal
  // colon in `?(?: $minutes_number...)` (time.grm:22,40) lexes as COLON, while
  // compiler.l lists ':' as a word character. Without a parsed factory graph no
  // arm of the requesting rule can be certified against the reference.
  assert.throws(
    () => parseRules(timeSource),
    error => /unexpected COLON/.test(error.message),
    'the time factory source must remain unparseable; if it parses, wire it and drop the gate',
  );
  assert.equal(inventory.factoryDependencies.time.status, 'unsupported');
  assert.equal(inventory.factoryDependencies.time.referencePath, fixture.timeFactoryGate.referenceFactoryFst);
  assert.equal(inventory.factoryDependencies.time.referenceSha256, fixture.timeFactoryGate.referenceFactorySha256);
  // Arm structure of the two gated rules (declaration shape, read from source).
  const ampmArms = sourceText('clock/alarm_timer_ampm').split(/\n/).find(l => l.includes('D_ALARM_TIME_VALUE ='));
  assert.ok(ampmArms.includes('$factory:time') && ampmArms.includes('$AM_PM'), 'ampm rule has a time arm and a non-time AM_PM arm');
  const setArms = /D_ALARM_TIME_VALUE =\n\(([\s\S]*?)\n\);/.exec(sourceText('clock/alarm_set_value'))[1];
  assert.equal((setArms.match(/\$factory:time/g) || []).length, 3, 'alarm_set_value references the time factory three times across its arms');
  for (const row of fixture.timeRules) {
    assert.ok(inventory.ruleDependencies[row.rule].unsupported.includes('time'), `${row.rule}: inventory must record the time dependency`);
  }
});

test('N-03 the non-time AM/PM arm is source-equivalent for bare am/pm but unreachable without the time factory', () => {
  // (a) Arm-for-arm equivalence of the non-time arm — proven from the two pinned
  // sources, not from Phoenix output. alarm_timer_ampm.rule:12-13 declares the
  // AM_PM arm's literal spellings and _ampm value; time.grm:237-252 declares the
  // same spelling->value mapping for the factory arm, so for this envelope the
  // absent time arm and the present AM_PM arm cannot disagree.
  const ampm = sourceText('clock/alarm_timer_ampm');
  const localAM = /\(a\.m\.\|am\|\(a m\)\|\(a\. m\.\)\)\s*\{_ampm='AM'\}/.test(ampm);
  const localPM = /\(p\.m\.\|pm\|\(p m\)\|\(p\. m\.\)\)\s*\{_ampm='PM'\}/.test(ampm);
  assert.ok(localAM && localPM, 'the AM_PM arm must declare AM/PM for the dotted and spaced spellings');
  const time = readFileSync(join(RES, 'factory-sources', 'time.grm'), 'utf8');
  assert.match(time, /\(am\{_nl='AM'\}\)/, 'time.grm AM_PM must agree on AM');
  assert.match(time, /\(pm\{_nl='PM'\}\)/, 'time.grm AM_PM must agree on PM');
  assert.match(time, /AM_ALONE = \(am\) \| \(a m\) \| \(a\. m\.\) \| \(a\.m\.\)/, 'time.grm AM_ALONE must agree on the spaced spelling');

  // (b) The narrowed (gate-free) matcher reproduces the AM_PM arm exactly...
  for (const [text, value] of [['am', 'AM'], ['pm', 'PM'], ['a.m.', 'AM'], ['p.m.', 'PM']]) {
    const match = matchWithoutGate('clock/alarm_timer_ampm', text);
    assert.equal(match?.entities?.ampm, value, `narrowed ${JSON.stringify(text)} must yield ${value}`);
  }
  // ...but it silently NO-MATCHES utterances the absent time factory would have
  // matched ("noon" is a time.grm arm, time.grm:65-66, and the reference's AM_PM
  // arm does not carry it). That is a silent wrong answer, not a refusal.
  for (const text of ['noon', 'morning', 'seven thirty']) {
    assert.equal(matchWithoutGate('clock/alarm_timer_ampm', text), null, `narrowed ${JSON.stringify(text)} must be the silent no-match`);
    assert.throws(
      () => parseRequest({ text, rules: ['clock/alarm_timer_ampm'] }),
      error => error.message === fixture.timeRules.find(r => r.rule === 'clock/alarm_timer_ampm').error,
      `${JSON.stringify(text)}: the shipped tree must still refuse loudly`,
    );
  }
  // clock/alarm_set_value is worse: its two non-time arms ($* ... $D_ALARM_V_INVALID_TIMESCALE
  // ... and `one day from now`) sit behind the same wildcards the time arm could
  // absorb, so a narrowed match is not provably the reference's arm.
  const setNarrowed = matchWithoutGate('clock/alarm_set_value', 'one day from now');
  assert.equal(setNarrowed?.entities?.time, '24h0m0s', 'narrowed alarm_set_value reaches the day arm');
  assert.equal(matchWithoutGate('clock/alarm_set_value', 'seven thirty am'), null, 'narrowed alarm_set_value silently drops a time value');
});

test('N-03 the conditional {% if %} remaps hold for the N-03 subset', () => {
  // N-05 G2 fix, re-pinned against the N-03 rules that use it
  // (clock/alarm_timer_change.rule:12-13, clock/alarm_timer_other_set.rule:12-13).
  for (const [rule, text, intent] of [
    ['clock/alarm_timer_change', 'yes', 'delete'],
    ['clock/alarm_timer_change', 'no', 'keep'],
    ['clock/alarm_timer_other_set', 'yes', 'replace'],
    ['clock/alarm_timer_other_set', 'no', 'keep'],
  ]) {
    assert.equal(parseRequest({ text, rules: [rule] }).intent, intent, `${rule} ${JSON.stringify(text)}`);
  }
});

test('N-03 every expected entity key is declared by the pinned rule source', () => {
  for (const row of fixture.namedRules) {
    const declared = new Set();
    for (const source of inventory.publicRules[row.rule].sources) {
      const text = sourceText(source);
      for (const m of text.matchAll(/\{\s*([A-Za-z_]\w*)\s*[=+]/g)) declared.add(m[1]);
      for (const m of text.matchAll(/\{%\s*([A-Za-z_]\w*)\s*[=+]/g)) declared.add(m[1]);
    }
    for (const c of row.cases) {
      for (const key of Object.keys(c.expect.entities || {})) {
        assert.ok(declared.has(key), `${row.rule}: expected entity '${key}' is not declared by ${row.source}`);
      }
    }
  }
});

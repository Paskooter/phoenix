// N-05 — device/content rules and global commands.
//
// Fixture-driven acceptance for the remaining named rules (everything outside
// N-03's clock/settings/main-menu and N-04's introductions/who-am-i/greetings)
// plus the four global-command graphs. Every row carries a pinned-source
// citation in the fixture (`source` / `anchor`); the expected intents were
// derived from the pinned .rule/.grm sources under
// pegasus@5c0a739:packages/parser/robust-parser/rules_src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../src/requestParser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, '..', 'resources');
const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'device-content-globals.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(RES, 'rule-inventory.json'), 'utf8'));

const norm = result => ({ entities: result.entities, intent: result.intent, rules: result.rules });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Rows that must match a full expected NLU result through parseRequest.
function matchRows() {
  const rows = [];
  for (const row of fixture.globals) rows.push({ id: row.id, text: row.text, rules: [row.rule], expect: row.expect });
  for (const row of fixture.globalNegatives) rows.push({ id: row.id, text: row.text, rules: [row.rule], expect: row.expect });
  for (const row of fixture.namedRules) {
    if (row.positive.unsupported) continue;
    rows.push({ id: `${row.rule}:positive`, text: row.positive.text, rules: [row.rule], expect: row.positive.expect });
    if (row.negative) rows.push({ id: `${row.rule}:negative`, text: row.negative.text, rules: [row.rule], expect: row.negative.expect });
  }
  for (const row of fixture.interruption) rows.push({ id: row.id, text: row.text, rules: row.rules, expect: row.expect });
  for (const row of fixture.overTriggers) rows.push({ id: row.id, text: row.text, rules: row.rules, expect: row.expect });
  return rows;
}

test('N-05 fixture covers every one of the 98 named rules — no named rule without a fixture', () => {
  assert.equal(fixture.referenceRevision, inventory.referenceRevision, 'fixture and inventory must pin the same reference revision');
  const fixtureRules = fixture.namedRules.map(row => row.rule);
  const inventoryRules = Object.keys(inventory.publicRules);
  assert.equal(fixtureRules.length, 98);
  assert.equal(new Set(fixtureRules).size, 98, 'duplicate fixture row');
  const missing = inventoryRules.filter(name => !fixtureRules.includes(name));
  const extra = fixtureRules.filter(name => !inventoryRules.includes(name));
  assert.deepEqual(missing, [], 'named rules left without a fixture');
  assert.deepEqual(extra, [], 'fixture names a rule outside the inventory');
  for (const row of fixture.namedRules) {
    assert.ok(row.positive, `${row.rule}: positive fixture missing`);
    const hasNegative = Boolean(row.negative) || Boolean(row.negativeUnavailable);
    assert.ok(hasNegative, `${row.rule}: negative fixture missing and no documented reason`);
    if (row.negativeUnavailable) assert.ok(row.negativeUnavailable.length > 10, `${row.rule}: negativeUnavailable needs a real reason`);
  }
});

test('N-05 every device/content and global fixture matches at runtime through parseRequest', () => {
  const rows = matchRows();
  assert.ok(rows.length >= 200, `expected a broad fixture set, got ${rows.length}`);
  const failures = [];
  for (const row of rows) {
    let got;
    try { got = norm(parseRequest({ text: row.text, rules: row.rules })); }
    catch (error) { failures.push(`${row.id}: threw ${error.message}`); continue; }
    if (!same(got, row.expect)) failures.push(`${row.id}: expected ${JSON.stringify(row.expect)} got ${JSON.stringify(got)}`);
  }
  assert.deepEqual(failures, []);
});

test('N-05 the two rules with an unsupported factory refuse loudly, never silently no-match', () => {
  const refusals = fixture.namedRules.filter(row => row.positive.unsupported);
  assert.deepEqual(refusals.map(row => row.rule).sort(), ['clock/alarm_set_value', 'clock/alarm_timer_ampm']);
  for (const row of refusals) {
    assert.throws(
      () => parseRequest({ text: row.positive.text || 'five minutes', rules: [row.rule] }),
      (error) => error.message === row.positive.error && error.message.includes(row.positive.unsupported),
    );
  }
});

test('N-05 explicit global stop/repeat/thanks/navigation behavior is exercised', () => {
  const required = {
    'globals/global_commands_launch': ['stop', 'sleep', 'turnAround', 'overHere', 'turnAway', 'volumeUp', 'volumeDown', 'volumeToValue'],
    'globals/mim_repeat': ['repeat'],
    'globals/mim_thanks': ['thanks'],
    'globals/gui_nav': ['left', 'right', 'close', 'selectItem'],
  };
  for (const [rule, intents] of Object.entries(required)) {
    const found = fixture.globals.filter(row => row.rule === rule).map(row => row.expect.intent);
    assert.ok(found.length, `${rule}: no global fixture`);
    for (const intent of intents) assert.ok(found.includes(intent), `${rule}: no fixture for intent ${intent}`);
  }
  // Navigation selectItem must carry the ordinal entity from the source tag.
  const select = fixture.globals.find(row => row.id === 'global:nav-select');
  assert.equal(select.expect.entities.itemPosition, 'first');
});

test('N-05 global interruption and local-rule precedence without false launches', () => {
  assert.ok(fixture.interruption.length >= 6);
  for (const row of fixture.interruption) {
    const got = norm(parseRequest({ text: row.text, rules: row.rules }));
    assert.deepEqual(got, row.expect, row.id);
    assert.ok(row.anchor, `${row.id}: an interruption journey must cite its native anchor`);
    // The winner must be one of the requested rules and must not be a phantom launch.
    assert.ok(row.rules.includes(got.rules[0]), `${row.id}: winner not requested`);
  }
  // Over-trigger guards: a global command graph must never steal a non-command.
  for (const row of fixture.overTriggers) {
    const got = norm(parseRequest({ text: row.text, rules: row.rules }));
    assert.deepEqual(got, row.expect, row.id);
    if (got.rules[0]) assert.ok(!got.rules[0].startsWith('globals/'), `${row.id}: global over-triggered on a non-command`);
  }
  // An explicit global command must still launch the global graph.
  const stop = norm(parseRequest({ text: 'stop it', rules: ['launch', 'globals/global_commands_launch'] }));
  assert.equal(stop.rules[0], 'globals/global_commands_launch');
  assert.equal(stop.intent, 'stop');
});

test('N-05 every expected entity key is declared by the pinned rule source', () => {
  const NATIVE = new Set(['union_original_fst_name']);
  for (const row of fixture.namedRules) {
    if (row.positive.unsupported) continue;
    const sources = inventory.publicRules[row.rule].sources;
    const declared = new Set();
    for (const source of sources) {
      const text = readFileSync(join(RES, 'rules-src', `${source}.rule`), 'utf8');
      for (const m of text.matchAll(/\{\s*([A-Za-z_]\w*)\s*[=+]/g)) declared.add(m[1]);
      for (const m of text.matchAll(/\{%\s*([A-Za-z_]\w*)\s*[=+]/g)) declared.add(m[1]);
    }
    for (const key of Object.keys(row.positive.expect.entities || {})) {
      if (NATIVE.has(key)) continue;
      assert.ok(declared.has(key), `${row.rule}: expected entity '${key}' is not declared by ${sources.join(', ')}`);
    }
  }
});

test('N-05 factory-internal sub-rule names cannot be shadowed by the requesting rule', () => {
  // yes_no.grm declares its own YES/NO; 15 vendored rules also declare YES/NO.
  // The reference compiles each $factory: into a self-contained graph, so the
  // public rule's YES/NO must not leak into the factory. Before the fix,
  // literal "yes"/"no" no-matched these rules (the local YES/NO shadowed the
  // factory's) while "definitely" worked — a silent entity loss.
  const colliding = ['create/take_another_photo', 'friendly-tips/want_more_tdd', 'shared/no_id', 'shared/verify_id'];
  for (const rule of colliding) {
    assert.equal(parseRequest({ text: 'yes', rules: [rule] }).intent, 'yes', `${rule}: yes_no factory literal "yes" was shadowed`);
    assert.equal(parseRequest({ text: 'no', rules: [rule] }).intent, 'no', `${rule}: yes_no factory literal "no" was shadowed`);
  }
  // A rule that owns the workspace rule name "TopRule" for an unrelated factory
  // still resolves the timer factory against the factory's own graph.
  const timer = parseRequest({ text: 'set a timer for five minutes', rules: ['clock/timer_set_value'] });
  assert.equal(timer.intent, 'timerValue');
});

test('N-05 conditional {% if %} semantic actions remap the private intent field', () => {
  // Five pinned rules post-process the factory yes/no into a command-specific
  // intent with a conditional semantic action, e.g.
  // clock/alarm_timer_change.rule:12-18 `if (this._intent == 'yes') {this._intent = 'delete'}`.
  const cases = [
    ['clock/alarm_timer_change', 'yes', 'delete'],
    ['clock/alarm_timer_change', 'no', 'keep'],
    ['clock/alarm_timer_other_set', 'yes', 'replace'],
    ['clock/alarm_timer_other_set', 'no', 'keep'],
    ['word-of-the-day/right_word', 'yes', 'agreement'],
    ['word-of-the-day/right_word', 'no', 'disagreement'],
    ['greetings/proactive_general_question', 'yes', 'good'],
    ['greetings/proactive_general_question', 'no', 'bad'],
    ['greetings/proactive_playful_question', 'yes', 'good'],
    ['greetings/proactive_playful_question', 'no', 'bad'],
  ];
  for (const [rule, text, intent] of cases) {
    assert.equal(parseRequest({ text, rules: [rule] }).intent, intent, `${rule} ${JSON.stringify(text)}`);
  }
  // Every expected remap target must be declared by the pinned source's own
  // conditional block — the fixture cannot invent the value.
  const byRule = new Map();
  for (const [rule, , intent] of cases) {
    if (!byRule.has(rule)) byRule.set(rule, new Set());
    byRule.get(rule).add(intent);
  }
  for (const [rule, targets] of byRule) {
    const source = inventory.publicRules[rule].sources[0];
    const text = readFileSync(join(RES, 'rules-src', `${source}.rule`), 'utf8');
    for (const target of targets) {
      assert.match(text, new RegExp(`this\\._intent\\s*=\\s*'${target}'`), `${rule}: ${target} not declared by the source`);
    }
  }
});

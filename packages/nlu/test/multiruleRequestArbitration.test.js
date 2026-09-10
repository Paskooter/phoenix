// N-01: "Honor complete parser requests and load every named rule".
//
// Two source-backed properties are pinned here:
//
//  1. Every named public rule is imported and hash-verified, and a request for
//     a rule whose factory dependency the AST engine cannot execute is REFUSED
//     with the reason — never silently reduced to a no-match. Source:
//     RobustParserClient.init() compiles every discovered rule before serving
//     (RobustParserClient.ts:40-50) and handleNLU throws
//     `No rules known by Robust Parser: ...` instead of dropping a name
//     (RobustParserClient.ts:66-71).
//
//  2. RobustParserClient.handleNLU sends one request per requested rule and
//     getBestResult picks the highest native `heuristic_score`
//     (RobustParserClient.ts:73-96, 262-288). The grammar `priority` tag is
//     copied onto the winning NLParse AFTER selection and is never a ranking
//     term, so `launch` must beat a HIGH-tagged `globals/*` graph whenever it
//     scores higher — regardless of request order. Pinned by the 42-case
//     original native HTTP capture (suite sha256 2c958166...) whose 8
//     launch-vs-global winner cases regressed while priorityRank * 1e6 leaked
//     into the arbitration score.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRequest, ruleInventory } from '../src/requestParser.js';

const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;
// Both properties belong to the default AST profile; the compiled profile has
// its own byte-exact graph fixtures.
delete process.env.PHOENIX_NLU_RUNTIME;

const inventory = JSON.parse(readFileSync(new URL('../resources/rule-inventory.json', import.meta.url)));
const namedRules = Object.keys(inventory.publicRules).sort();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/multirule-http-42.json', import.meta.url)));
const launchOracle = JSON.parse(readFileSync(new URL('./fixtures/launch-oracle-89.json', import.meta.url)));

test.after(() => {
  if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime;
});

test('imports every named rule and refuses an unsupported dependency loudly', () => {
  assert.deepEqual(ruleInventory(), {
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    sourceRuleCount: 117,
    publicRuleCount: 98,
    factoryCount: 2,
    boundedFactoryCount: 2,
    unsupportedFactoryCount: 6,
    unsupportedRuleCount: 4,
    factoryWordCount: 6,
  });

  // Every public rule name is answered: honoured, or refused with a reason.
  const honored = [];
  const refused = [];
  for (const name of namedRules) {
    try {
      parseRequest({ text: 'five minutes', rules: [name] });
      honored.push(name);
    } catch (error) {
      refused.push([name, error.message]);
    }
  }
  assert.equal(namedRules.length, 98);
  assert.equal(honored.length, 96, `every rule must answer: ${honored.length}/98`);
  // The only refusals are the two rules whose source grammar needs the `time`
  // factory. time.grm uses the native literal-colon form `?(?: $minutes_number)`
  // while the AST matcher compares whole whitespace-delimited tokens
  // (matcher.js:222), so the colon cannot be consumed inside `5:30`. Refusing is
  // the honest boundary; silently matching would fabricate a result.
  assert.deepEqual(refused, [
    ['clock/alarm_set_value', "Unsupported NLU factory dependencies for public rule 'clock/alarm_set_value': time"],
    ['clock/alarm_timer_ampm', "Unsupported NLU factory dependencies for public rule 'clock/alarm_timer_ampm': time"],
  ]);
});

test('selects the native winner for all 42 original multi-rule parser requests', () => {
  assert.equal(fixture.provenance.suiteSha256, '2c958166863314ef96e1b4d2f8a6b3eceb8728f1a6939af10c7418d0b6d60ac8');
  assert.equal(fixture.cases.length, 42);

  const failures = [];
  for (const c of fixture.cases) {
    const result = parseRequest({ text: c.text, rules: c.rules });
    if (c.expectedStatus !== 200) {
      failures.push(`${c.id}: fixture expected status ${c.expectedStatus}`);
      continue;
    }
    if (JSON.stringify(result) !== JSON.stringify(c.expectedData)) {
      failures.push(`${c.id}: expected ${JSON.stringify(c.expectedData)} got ${JSON.stringify(result)}`);
    }
  }
  assert.deepEqual(failures, [], `multi-rule winner mismatches:\n${failures.join('\n')}`);
  assert.equal(fixture.cases.length - failures.length, 42);
});

test('the arbitration change does not disturb the single-rule launch oracle', () => {
  // Removing the priority term must be scoped to multi-entry arbitration: the
  // rules:['launch'] path already scored without it, and the native launch
  // oracle still has to hold for every attributed utterance.
  const failures = [];
  for (const c of launchOracle.cases) {
    const result = parseRequest({ text: c.text, rules: ['launch'] });
    if (result.intent !== c.intent || JSON.stringify(result.entities) !== JSON.stringify(c.entities)) {
      failures.push(`${c.text}: expected ${c.intent}/${JSON.stringify(c.entities)} got ${result.intent}/${JSON.stringify(result.entities)}`);
    }
  }
  assert.equal(launchOracle.cases.length, 89);
  assert.deepEqual(failures, [], `launch oracle mismatches:\n${failures.join('\n')}`);
});

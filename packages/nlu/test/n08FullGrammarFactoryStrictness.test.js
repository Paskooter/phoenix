// N-08 — the legacy multi-skill launch stage must not turn an unserved factory
// dependency into an arbitrary wildcard.
//
// The native launch union is ONE compiled FST: every `$factory:NAME` arm is a
// real sub-graph, so a request whose words only fit a factory slot that the
// grammar cannot fill is a NO-MATCH, never a wildcard match.
// `packages/nlu/src/fullGrammar.js` stands in for that union in the legacy
// `parse()` stage. Before this repair it called `matchRule()` without
// `strictFactories`, so the matcher's historical 1..3-word wildcard fallback
// (packages/nlu/src/grammar/matcher.js, ref case) filled the clock/timer value
// slot from unrelated words.
//
// Contract source (pinned original, jiboV2/pegasus@5c0a739):
//   * RobustParserClient.ts:88-91,108-110 — `rules` is the requested rule name,
//     `entities` is the NLParse minus `intent`/`priority`.
//   * The frozen original parser capture for this exact utterance
//     (case `chitchat:21:0:base` in the pinned corpus) returns
//     `{intent:'canJiboAction', entities:{Action:'GiveUserThing',
//     union_original_fst_name:'handle:chitchat/launch'}, rules:['launch']}`.
//     The HTTP path (`parseRequest`) already reproduced it; the legacy stage did
//     not. See docs/parity/evidence/2026-09-11/n08-pinned-corpus/review.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullParse } from '../src/fullGrammar.js';
import { parse as parseRules } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';
import { loadFactoryWords } from '../src/grammar/factoryWords.js';

const GRAMMAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'grammar');
const PASSWORD_TEXT = "can you give me the password to my brother's computer";

// The clock skill's rule namespace, assembled exactly as fullGrammar.load()
// does it: the shared + globals sub-rules merged under the skill's own rules.
function clockSkill() {
  const shared = {};
  for (const dir of ['globals', 'shared']) {
    const d = join(GRAMMAR_ROOT, dir);
    if (!existsSync(d)) continue;
    for (const g of readdirSync(d)) {
      try { Object.assign(shared, parseRules(readFileSync(join(d, g), 'utf8')).rules); } catch { /* skip as the loader does */ }
    }
  }
  const ast = parseRules(readFileSync(join(GRAMMAR_ROOT, 'skills', 'clock', 'launch.rule'), 'utf8'));
  return { rules: { ...shared, ...ast.rules }, top: ast.rules.TopRule || ast.rules[Object.keys(ast.rules)[0]] };
}

test('N-08 the legacy launch stage returns the original contract for the clock-wildcard text', () => {
  const result = fullParse(PASSWORD_TEXT);
  assert.ok(result, 'fullParse must match (the original matched via chitchat)');
  assert.equal(result.intent, 'canJiboAction');
  assert.equal(result.entities.Action, 'GiveUserThing');
  assert.equal(result.entities.skill, '@be/chitchat');
  // ...and must not report the spurious clock/timer parse.
  assert.notEqual(result.entities.domain, 'timer');
});

test('N-08 the same clock-wildcard mechanism is closed for every affected utterance', () => {
  // The manifest corpus has exactly two rows where the wildcard-filled clock
  // timer-value slot stole the utterance: both are chitchat intents.
  const second = fullParse('give me an example of an np hard problem');
  assert.ok(second);
  assert.equal(second.intent, 'requestJiboGiveThing');
  assert.equal(second.entities.skill, '@be/chitchat');
});

test('N-08 an unserved factory dependency is a no-match, not a wildcard', () => {
  const clock = clockSkill();
  const tokens = tokenize(PASSWORD_TEXT);
  const factoryWords = loadFactoryWords();
  // Historical (non-strict) behaviour: the timer-value slot absorbs unrelated
  // words and the clock grammar claims the utterance.
  const wildcard = matchRule(clock.top, tokens, { rules: clock.rules, factoryWords });
  assert.ok(wildcard, 'control: the non-strict fallback really does match (this is the bug mechanism)');
  assert.equal(wildcard.entities.intent, 'start');
  // Source-faithful behaviour: the same grammar with factory strictness enabled
  // (the flag the HTTP request path already passes) is a no-match.
  const strict = matchRule(clock.top, tokens, { rules: clock.rules, factoryWords, strictFactories: true });
  assert.equal(strict, null);
});

test('N-08 factory strictness keeps genuine clock utterances matching', () => {
  assert.equal(fullParse('what time is it').intent, 'askForTime');
  assert.equal(fullParse('whats the date').intent, 'askForDate');
  assert.equal(fullParse('set a timer for 5 minutes').entities.domain, 'timer');
  assert.equal(fullParse('stop the timer').intent, 'stop');
});

test('N-08 factory strictness does not regress the long-tail launch intents', () => {
  assert.equal(fullParse('sing me a song').intent, 'requestSingSong');
  assert.equal(fullParse('i love you').intent, 'userLovesThing');
  assert.equal(fullParse('turn on the lights').intent, 'lightsOn');
  assert.equal(fullParse('tell me a joke').intent, 'requestTellJiboContent');
  assert.equal(fullParse('how are you').intent, 'emotionQuery');
});

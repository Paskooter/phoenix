import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEqWords, eqEquals } from '../src/grammar/eqWords.js';
import { fullParse } from '../src/fullGrammar.js';

// Homophone-equivalent matching (the `!use_equivalent_words = true` directive).
// eq_words.txt sets are real reference data: "2 two too to", "there their they're".

test('eqEquals: members of a set are equal, non-members are not', () => {
  const map = loadEqWords();
  assert.ok(eqEquals(map, 'two', 'too'));
  assert.ok(eqEquals(map, 'there', 'theyre'.replace('theyre', "they're")));
  assert.ok(!eqEquals(map, 'two', 'three'));
  assert.ok(eqEquals(map, 'same', 'same')); // identity holds even off-map
});

test('fullParse: ASR homophone confusion still parses ("set a timer for too minutes")', () => {
  const clean = fullParse('set a timer for two minutes');
  const fuzzy = fullParse('set a timer for too minutes');
  assert.ok(clean && clean.intent, 'clean phrasing parses');
  assert.equal(fuzzy && fuzzy.intent, clean.intent, 'homophone variant parses to the same intent');
});

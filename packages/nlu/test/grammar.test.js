import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grammarParse } from '../src/grammar.js';

test('who-question -> generalWhoQuestions with person entity, launch rule', () => {
  const r = grammarParse('Who is Ada Lovelace?');
  assert.equal(r.intent, 'generalWhoQuestions');
  assert.deepEqual(r.rules, ['launch']);
  assert.equal(r.entities.person, 'ada lovelace');
});

test('tell me about -> requestTellAboutThing', () => {
  const r = grammarParse('tell me about the moon');
  assert.equal(r.intent, 'requestTellAboutThing');
  assert.equal(r.entities.thing, 'the moon');
});

test('no match -> reference no-match shape (gotcha #7)', () => {
  const r = grammarParse('blurf gnax');
  assert.deepEqual(r, { rules: [], intent: null, entities: {} });
});

test('empty input -> no match', () => {
  assert.deepEqual(grammarParse('  '), { rules: [], intent: null, entities: {} });
});

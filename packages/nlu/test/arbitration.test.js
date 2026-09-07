import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBestNative } from '../src/arbitration.js';
import { loadFactoryWords } from '../src/grammar/factoryWords.js';
import { parseRequest } from '../src/requestParser.js';

function candidate(rule, score, intent) {
  return { rule, score, intent };
}

test('native arbitration uses score before metadata priority', () => {
  const winner = selectBestNative([
    candidate('launch', 7, 'high-label'),
    candidate('clock/launch', 8, 'low-label'),
  ]);
  assert.equal(winner.intent, 'low-label');
});

test('native arbitration preserves the first equal-score non-loser', () => {
  const winner = selectBestNative([
    candidate('chitchat/launch', 8, 'chitchat'),
    candidate('introductions/launch', 8, 'introductions'),
  ]);
  assert.equal(winner.intent, 'chitchat');
});

test('native arbitration removes designated losers only from a tie', () => {
  assert.equal(selectBestNative([
    candidate('launch', 8, 'launch'),
    candidate('chitchat/launch', 8, 'chitchat'),
  ]).intent, 'chitchat');
  assert.equal(selectBestNative([
    candidate('launch', 8, 'launch'),
    candidate('globals/foo', 8, 'global'),
  ]).intent, 'launch');
  assert.equal(selectBestNative([
    candidate('launch', 8, 'launch'),
    candidate('chitchat/launch', 7, 'lower'),
  ]).intent, 'launch');
});

test('native arbitration accepts zero and negative scores and skips empty results', () => {
  assert.equal(selectBestNative([null, candidate('clock/launch', 0, 'zero')]).intent, 'zero');
  assert.equal(selectBestNative([candidate('clock/launch', -3, 'negative')]).intent, 'negative');
  assert.equal(selectBestNative([]), null);
});

test('factory membership prevents a false cross-skill winner for the mom residual', () => {
  const firstNames = loadFactoryWords().get('first_name');
  assert.ok(firstNames);
  assert.equal(firstNames.get('my'), undefined);
  assert.deepEqual(firstNames.get('sally'), [['sally']]);
  const result = parseRequest({ text: 'this is my mom', rules: ['launch'] });
  assert.equal(result.intent, 'requestMeetPerson');
  assert.equal(result.entities.union_original_fst_name, 'handle:chitchat/launch');
  assert.equal(result.entities.FamilyMember, 'SomeFamilyMember');
  assert.equal(result.entities.GivenName, '*');
});

test('valid introductions still win their source-backed utterances', () => {
  for (const [text, name] of [
    ['can i introduce you to sally', 'sally'],
    ['i want to introduce you to bob', 'bob'],
    ['i am jane', 'jane'],
  ]) {
    const result = parseRequest({ text, rules: ['launch'] });
    assert.equal(result.intent, 'enrollment', text);
    assert.equal(result.entities.skill, '@be/introductions', text);
    assert.equal(result.entities.GivenName, name, text);
  }
});

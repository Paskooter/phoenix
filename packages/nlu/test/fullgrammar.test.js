import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/index.js';
import { fullParse } from '../src/fullGrammar.js';

// The full real-grammar fallback stage: every vendored Jibo launch grammar
// (chitchat, hue-control, report, …) parsed by the pure-JS engine with priority
// arbitration. These are utterances the legacy be-skill grammars + question
// grammar miss — they used to NO-MATCH and now route. Expected intents are the
// real engine's (captured by the jibo-nlu oracle in test/oracle/).

test('fullParse: chitchat personality/command intents that used to no-match', () => {
  assert.equal(fullParse('sing me a song').intent, 'requestSingSong');
  assert.equal(fullParse('i love you').intent, 'userLovesThing');
  assert.equal(fullParse('twerk').intent, 'requestTwerk');
  assert.equal(fullParse('beatbox').intent, 'requestBeatbox');
});

test('fullParse: smart-home routes to @be/hue-control', () => {
  const r = fullParse('turn on the lights');
  assert.equal(r.intent, 'lightsOn');
  assert.equal(r.entities.skill, '@be/hue-control');
});

test('fullParse: priority arbitration drops LOW catch-alls for HIGH intents', () => {
  // "how are you" matches both the emotionQuery (HIGH) and the idle deflector
  // (LOW); HIGH must win.
  assert.equal(fullParse('how are you').intent, 'emotionQuery');
});

test('full pipeline: new long-tail intents now resolve', async () => {
  assert.equal((await parse('sing me a song')).intent, 'requestSingSong');
  assert.equal((await parse('marry me')).intent, 'willJiboDoAction');
});

test('full pipeline: source question routing remains the compatibility default', async () => {
  // The original launch union selects the chitchat intent. Phoenix's answer-skill
  // continuity profile is covered separately by n08GqaContinuity.test.js.
  const r = await parse('who is ada lovelace');
  assert.equal(r.intent, 'whoIsPerson');
  assert.equal(r.entities.skill, '@be/chitchat');
  assert.equal(Object.hasOwn(r.entities, 'intent'), false);
  assert.equal(Object.hasOwn(r.entities, 'priority'), false);
});

test('fullParse: pure garbage still returns null', () => {
  assert.equal(fullParse('blurf gnax wibble'), null);
});

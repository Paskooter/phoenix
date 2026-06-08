import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/index.js';

// The full NLU pipeline: be-skill launch grammars (vendored from jibo-web-sim) -> question
// grammar -> LLM. These assert the launch grammars emit the `skill` entity the gateway needs.

test('be-skill: "what time is it" -> askForTime + skill=@be/clock', async () => {
  const r = await parse('what time is it');
  assert.equal(r.intent, 'askForTime');
  assert.equal(r.entities.skill, '@be/clock');
  assert.deepEqual(r.rules, ['launch']);
});

test('be-skill: "open the clock" -> menu + skill=@be/clock', async () => {
  const r = await parse('open the clock');
  assert.equal(r.entities.skill, '@be/clock');
});

test('question still routes to answer-skill intents (no be-skill false match)', async () => {
  const r = await parse('who is ada lovelace');
  assert.equal(r.intent, 'generalWhoQuestions');
  assert.equal(r.entities.skill, undefined);
});

test('garbage -> no match', async () => {
  const r = await parse('blurf gnax wibble');
  assert.equal(r.intent, null);
});

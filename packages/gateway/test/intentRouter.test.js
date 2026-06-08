import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentRouter } from '../src/intentRouter.js';

const registry = [
  {
    id: 'answer-skill',
    intents: [
      { name: 'generalWhoQuestions', memo: { type: 'who' } },
      { name: 'generalWhatQuestions', memo: { type: 'what' } },
    ],
  },
  {
    id: 'weather-skill',
    intents: [
      { name: 'requestWeather', entities: [{ name: 'when', value: 'tomorrow' }], memo: { type: 'forecast' } },
      { name: 'requestWeather', memo: { type: 'today' } },
    ],
  },
];

test('routes a launch intent to its skill and carries memo', () => {
  const r = new IntentRouter(registry);
  const d = r.getSkillIDFromNLU({ intent: 'generalWhoQuestions', rules: ['launch'], entities: {} });
  assert.equal(d.skillID, 'answer-skill');
  assert.deepEqual(d.memo, { type: 'who' });
});

test('does NOT route without the launch rule (gotcha #6)', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: 'generalWhoQuestions', rules: ['global'], entities: {} }), null);
});

test('does NOT route a null intent', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: null, rules: ['launch'], entities: {} }), null);
});

test('entity-constrained registration outweighs the bare one (weight 1 > 0)', () => {
  const r = new IntentRouter(registry);
  const d = r.getSkillIDFromNLU({ intent: 'requestWeather', rules: ['launch'], entities: { when: 'tomorrow' } });
  assert.equal(d.skillID, 'weather-skill');
  assert.deepEqual(d.memo, { type: 'forecast' });
});

test('falls back to the bare registration when entity does not match', () => {
  const r = new IntentRouter(registry);
  const d = r.getSkillIDFromNLU({ intent: 'requestWeather', rules: ['launch'], entities: { when: 'yesterday' } });
  assert.deepEqual(d.memo, { type: 'today' });
});

test('unknown intent returns null', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: 'nope', rules: ['launch'], entities: {} }), null);
});

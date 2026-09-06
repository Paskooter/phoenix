import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IntentRouter } from '../src/intentRouter.js';
import { loadRegistry } from '../src/registry.js';

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

test('launch-by-skill-entity: routes when grammar emits skill but no manifest intent', () => {
  const r = new IntentRouter([{ id: '@be/main-menu', onRobot: true, intents: [{ name: 'launchMainMenu', entities: [{ name: 'skill', value: '@be/main-menu' }] }] }]);
  // grammar emitted skill entity but an empty/non-manifest intent
  const d = r.getSkillIDFromNLU({ intent: '', rules: ['launch'], entities: { skill: '@be/main-menu' } });
  assert.equal(d.skillID, '@be/main-menu');
});

test('launch-by-skill-entity ignores an unknown skill id', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: '', rules: ['launch'], entities: { skill: '@be/nope' } }), null);
});

const wildcardOriginal = JSON.parse(readFileSync(new URL('./fixtures/wildcard-original.json', import.meta.url)));

test('wildcard entity content matches original scalar, array and object controls', () => {
  const router = new IntentRouter([{
    id: 'wildcard-control',
    intents: [{ name: 'wildcard', entities: [{ name: 'value', value: '*' }] }],
  }]);
  for (const control of wildcardOriginal.values) {
    const entities = Object.hasOwn(control, 'value') ? { value: control.value } : {};
    const decision = router.getSkillIDFromNLU({ intent: 'wildcard', rules: ['launch'], entities });
    assert.equal(Boolean(decision), control.matches, control.id);
  }
});

test('empty given names preserve original fallback weights and no-route decisions', async () => {
  const router = new IntentRouter(await loadRegistry({ indexFile: 'skills-local.json', env: {} }));
  for (const control of wildcardOriginal.routes) {
    const decision = router.getSkillIDFromNLU(control.nlu);
    const routing = decision ? { kind: 'match', decision } : { kind: 'no-route' };
    assert.deepEqual(routing, control.routing, control.id);
  }
});

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

test('returns the source no-route value without the launch rule (gotcha #6)', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: 'generalWhoQuestions', rules: ['global'], entities: {} }), undefined);
});

test('returns the source no-route value for a null intent', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: null, rules: ['launch'], entities: {} }), undefined);
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

test('unknown intent returns the source no-route value', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: 'nope', rules: ['launch'], entities: {} }), undefined);
});

test('does not launch from a skill entity without a registered intent', () => {
  const r = new IntentRouter([{ id: '@be/main-menu', onRobot: true, intents: [{ name: 'launchMainMenu', entities: [{ name: 'skill', value: '@be/main-menu' }] }] }]);
  // The reference router considers only the registered intent and launch rule.
  const d = r.getSkillIDFromNLU({ intent: '', rules: ['launch'], entities: { skill: '@be/main-menu' } });
  assert.equal(d, undefined);
});

test('does not launch from a skill entity when the intent is unknown', () => {
  const r = new IntentRouter(registry);
  assert.equal(r.getSkillIDFromNLU({ intent: 'nope', rules: ['launch'], entities: { skill: '@be/nope' } }), undefined);
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

test('matches scalar values case-insensitively and recursively inside arrays', () => {
  const router = new IntentRouter([{
    id: 'source-operators',
    intents: [
      { name: 'ask', entities: [{ name: 'kind', value: 'Pizza' }] },
      { name: 'ask', entities: [{ name: 'kind', value: 'Pizza', matchRule: 'NOT' }] },
    ],
  }]);
  assert.deepEqual(router.getDecisions({ intent: 'ask', entities: { kind: ['salad', 'pizza'] } }), [
    { skillID: 'source-operators', weight: 1 },
  ]);
  assert.deepEqual(router.getDecisions({ intent: 'ask', entities: { kind: '' } }), []);
});

test('resolves dotted paths and keeps bare parent decisions as fallback', () => {
  const router = new IntentRouter([
    { id: 'bare', intents: [{ name: 'ask', memo: { arm: 'bare' } }] },
    { id: 'nested', intents: [{ name: 'ask', entities: [{ name: 'profile.name', value: 'Jane' }] }] },
  ]);
  const matched = router.getSkillIDFromNLU({
    intent: 'ask', rules: ['launch'], entities: { profile: { name: 'jane' } },
  });
  assert.equal(matched.skillID, 'nested');
  const fallback = router.getSkillIDFromNLU({
    intent: 'ask', rules: ['launch'], entities: { profile: { name: 'Alex' } },
  });
  assert.equal(fallback.skillID, 'bare');
});

test('rejects an unknown entity match rule while building the source tree', () => {
  assert.throws(
    () => new IntentRouter([{ id: 'bad', intents: [{ name: 'ask', entities: [{ name: 'kind', value: 'x', matchRule: 'MAYBE' }] }] }]),
    { name: 'Error', message: 'Unknown matchRule for kind: MAYBE' },
  );
});

test('accepts a string rules value using the source indexOf check', () => {
  const router = new IntentRouter([{ id: 'basic', intents: [{ name: 'ask' }] }]);
  assert.equal(router.getSkillIDFromNLU({ intent: 'ask', rules: 'launch', entities: {} }).skillID, 'basic');
});

test('retains Node 8 decision ordering for more than ten equal-weight entries', () => {
  const router = new IntentRouter(Array.from({ length: 20 }, (_, index) => ({
    id: `skill-${String(index).padStart(2, '0')}`,
    intents: [{ name: 'ask', memo: { index } }],
  })));
  const decision = router.getSkillIDFromNLU({ intent: 'ask', rules: ['launch'], entities: {} });
  assert.equal(decision.skillID, 'skill-10');
});

test('groups entity branches in tree traversal order before applying weight sorting', () => {
  const router = new IntentRouter([
    { id: 'path-ab', intents: [{ name: 'ask', entities: [{ name: 'a', value: 'x' }, { name: 'b', value: 'y' }] }] },
    { id: 'path-ba', intents: [{ name: 'ask', entities: [{ name: 'b', value: 'y' }, { name: 'a', value: 'x' }] }] },
    { id: 'path-ac', intents: [{ name: 'ask', entities: [{ name: 'a', value: 'x' }, { name: 'c', value: 'z' }] }] },
  ]);
  assert.deepEqual(router.getDecisions({
    intent: 'ask', entities: { a: 'x', b: 'y', c: 'z' },
  }).map(decision => decision.skillID), ['path-ab', 'path-ac', 'path-ba']);
});

const originalRouter = JSON.parse(readFileSync(new URL('./fixtures/intent-router-original.json', import.meta.url)));

function capturedValue(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return value.map(capturedValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capturedValue(item)]));
  }
  return value;
}

test('matches all original routing controls, including complete decision order and failures', () => {
  for (const control of originalRouter.cases) {
    let route;
    let decisions;
    let errorName = null;
    try {
      const router = new IntentRouter(control.config);
      route = router.getSkillIDFromNLU(control.nlu);
      if (control.nlu?.intent) decisions = router.getDecisions(control.nlu);
    } catch (error) {
      errorName = error.name;
    }
    assert.deepEqual({ route: capturedValue(route), decisions: capturedValue(decisions) }, control.expected, control.id);
    assert.equal(errorName, control.errorName, control.id);
  }
});

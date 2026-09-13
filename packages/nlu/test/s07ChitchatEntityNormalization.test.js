import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/requestParser.js';
import { parse } from '../src/index.js';
import { IntentRouter } from '../../gateway/src/intentRouter.js';
import { loadRegistry } from '../../gateway/src/registry.js';

const sourceCases = [
  {
    text: 'do you want some hot dogs',
    intent: 'doesJiboWantThing',
    entities: { FoodGeneral: 'SomeFoodGeneral' },
    mim: 'RI_JBO_Wants_SS_FoodGeneral',
  },
  {
    text: 'are you depressed',
    intent: 'isJiboDescriptor',
    entities: { Emotion: 'Sad' },
    mim: 'RI_JBO_IsSad',
  },
  {
    text: 'are you bad or are you good',
    intent: 'isJiboDescriptor',
    entities: { JiboDescriptor: 'GoodOrEvil' },
    mim: 'RI_JBO_IsGoodOrEvil',
  },
];

test('normalizes overlapping chitchat entities before source routing', async () => {
  const router = new IntentRouter(await loadRegistry({ indexFile: 'skills-local.json', env: {} }));

  for (const control of sourceCases) {
    const expectedRequestEntities = {
      ...control.entities,
      union_original_fst_name: 'handle:chitchat/launch',
    };
    const nlu = parseRequest({ text: control.text, rules: ['launch'], loop: { users: [] } });
    assert.deepEqual(nlu, {
      rules: ['launch'],
      intent: control.intent,
      entities: expectedRequestEntities,
    }, `${control.text}: parseRequest`);

    const decision = router.getSkillIDFromNLU(nlu);
    assert.equal(decision?.memo?.mim, control.mim, `${control.text}: route`);

    const broad = await parse(control.text);
    assert.equal(broad.intent, control.intent, `${control.text}: parse`);
    assert.deepEqual(broad.entities, {
      ...control.entities,
      skill: '@be/chitchat',
    }, `${control.text}: broad entities`);
  }
});

test('keeps specific food, punctuation fallback, and unrelated descriptors intact', async () => {
  const specific = parseRequest({ text: 'do you want some cornbread', rules: ['launch'] });
  assert.deepEqual(specific.entities, {
    Food: 'Cornbread',
    union_original_fst_name: 'handle:chitchat/launch',
  });
  assert.equal(specific.intent, 'doesJiboWantThing');

  const punctuation = parseRequest({ text: 'are you depressed?', rules: ['launch'] });
  assert.equal(punctuation.intent, 'idle');
  assert.deepEqual(punctuation.entities, {
    union_original_fst_name: 'handle:chitchat/launch',
  });

  const emotion = await parse('are you feeling blue');
  assert.equal(emotion.intent, 'isJiboDescriptor');
  assert.equal(emotion.entities.Emotion, 'Sad');
  assert.equal(emotion.entities.GeneralDescriptor, undefined);
});

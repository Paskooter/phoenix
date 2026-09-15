// A global turn must be able to hear Jibo's global commands.
//
// `launch` is the union of the twenty domain launch.rule grammars and does NOT
// contain the global-command grammars; the parser exposes those as four
// separate public rules. The global-turn default previously asked for a rule
// called `global`, which the parser does not know, so it was silently dropped
// and volume/stop/sleep never reached their own intents.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLOBAL_TURN_RULES } from '../src/listenTransaction.js';
// The gateway does not depend on the NLU package at runtime (it talks to the
// service over HTTP); this test reaches into it directly to prove the rule
// names the gateway sends are ones the parser actually resolves.
import { parseRequest } from '../../nlu/src/requestParser.js';

const inventory = JSON.parse(readFileSync(
  new URL('../../nlu/resources/rule-inventory.json', import.meta.url),
  'utf8',
));

test('every global-turn rule is a rule the parser actually exposes', () => {
  const known = new Set(Object.keys(inventory.publicRules));
  for (const rule of GLOBAL_TURN_RULES) {
    assert.ok(known.has(rule), `${rule} is not a public rule; it would be silently dropped`);
  }
  // The bug this pins: `global` is not a rule name.
  assert.ok(!known.has('global'), 'inventory unexpectedly gained a rule literally named `global`');
});

test('the global-command grammars are not already inside the launch union', () => {
  // If they were, requesting them separately would be redundant rather than
  // necessary, and this whole default could be just ['launch'].
  const union = Object.keys(inventory.publicRules.launch.sourceHandles);
  assert.ok(union.length > 0);
  assert.equal(union.filter((name) => name.startsWith('globals/')).length, 0);
});

test('global commands reach their own intents on a global turn', () => {
  const cases = [
    ['turn up the volume', 'volumeUp'],
    ['set the volume to five', 'volumeToValue'],
    ['go to sleep', 'sleep'],
    ['stop', 'stop'],
  ];
  for (const [text, intent] of cases) {
    const got = parseRequest({ text, rules: [...GLOBAL_TURN_RULES] });
    assert.equal(got.intent, intent, `${text} -> ${intent}`);
  }
});

test('adding the globals does not let them win ties they should lose', () => {
  // RobustParserClient.LOW_PRIORITY_RULES drops ^launch$ and ^globals/ from a
  // tied top score whenever any other rule tied, so a specific skill rule still
  // beats the global-command grammar on the same utterance.
  const cases = [
    ['thank you', 'thankJiboForAction'],
    ['say that again', 'requestRepeat'],
    ['turn on the lights', 'lightsOn'],
    ['what time is it', 'askForTime'],
    ['what year is it', 'generalWhatQuestions'],
  ];
  for (const [text, intent] of cases) {
    const withGlobals = parseRequest({ text, rules: [...GLOBAL_TURN_RULES] });
    const launchOnly = parseRequest({ text, rules: ['launch'] });
    assert.equal(withGlobals.intent, intent, `${text} with globals`);
    assert.equal(launchOnly.intent, intent, `${text} on launch alone (unchanged)`);
  }
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../src/index.js';
import { parseRequestDetailedAsync } from '../src/requestParser.js';
import { decisionKind, setDecisionClientForTest } from '../src/decisionLayer.js';
import { loadRegistry } from '../../gateway/src/registry.js';
import { IntentRouter } from '../../gateway/src/intentRouter.js';

const GLOBAL_RULES = ['launch', 'globals/global_commands_launch', 'globals/gui_nav', 'globals/mim_repeat', 'globals/mim_thanks'];
let server, router, asked;
const originalFetch = globalThis.fetch;

before(async () => {
  // Only the decision-provider boundary is synthetic. Mirror a confident generic
  // game choice, and drive the real HTTP parser plus the shipped skill manifests.
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'offline test must not contact a provider');
    return originalFetch(url, options);
  };
  router = new IntentRouter(await loadRegistry({ indexFile: 'skills-phoenix.json', env: {} }));
  setDecisionClientForTest({
    enabled: true,
    config: { minProbability: 0.5, overrideProbability: 0.9 },
    async choose(text) { asked.push(text); return { choice: 'game', probability: 0.99 }; },
  });
  server = await start(0);
});

after(async () => {
  setDecisionClientForTest(undefined);
  globalThis.fetch = originalFetch;
  if (server) await new Promise(resolve => server.close(resolve));
});

async function parseAndRoute(text, rules = GLOBAL_RULES) {
  asked = [];
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/parse`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text, rules: [...rules] } }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.type, 'NLU');
  return { nlu: envelope.data, route: router.getSkillIDFromNLU(envelope.data) };
}

test('roll the dice keeps its dice response instead of launching Circuit Saver', async () => {
  const grammar = await parseRequestDetailedAsync({ text: 'roll the dice', rules: GLOBAL_RULES });
  assert.equal(grammar.nlu.intent, 'requestRollTwoDice');
  assert.equal(grammar.priority, 'HIGH');
  const { nlu, route } = await parseAndRoute('roll the dice');
  assert.equal(nlu.intent, 'requestRollTwoDice');
  assert.equal(route.skillID, 'chitchat-skill');
  assert.equal(route.memo.mim, 'RA_JBO_RollTwoDice');
  assert.deepEqual(asked, [], 'a recognized game command needs no generic second opinion');
});

for (const [text, intent, mim] of [
  ['roll one die', 'requestRollOneDie', 'RA_JBO_RollOneDie'],
  ['roll a die', 'requestRollOneDie', 'RA_JBO_RollOneDie'],
  ['flip a coin', 'requestFlipCoin', 'RA_JBO_FlipCoin'],
  ['heads or tails', 'requestFlipCoin', 'RA_JBO_FlipCoin'],
  ['play pong', 'requestPlayPong', 'RA_JBO_PlayPong'],
  ['play ping pong', 'requestPlayPingPong', 'RA_JBO_PlayPingPong'],
]) {
  test(`recognized game request keeps its own response: ${text}`, async () => {
    const { nlu, route } = await parseAndRoute(text);
    assert.equal(nlu.intent, intent);
    assert.equal(route.skillID, 'chitchat-skill');
    assert.equal(route.memo.mim, mim);
    assert.deepEqual(asked, []);
  });
}

test('asking what games Jibo can play keeps the game-list answer instead of starting one', async () => {
  const { nlu, route } = await parseAndRoute('what games can you play');
  assert.equal(nlu.intent, 'whatThingDoesJiboHave');
  assert.equal(nlu.entities.JiboContent, 'Game');
  assert.equal(route.skillID, 'chitchat-skill');
  assert.equal(route.memo.mim, 'RI_JBO_WhatGames');
  assert.deepEqual(asked, []);
});

for (const text of ['roll dice', 'roll two dice', 'roll a dice', 'please roll the dice']) {
  test(`dice variants keep the same registered response: ${text}`, async () => {
    const { nlu, route } = await parseAndRoute(text);
    assert.equal(nlu.intent, 'requestRollTwoDice');
    assert.equal(route.skillID, 'chitchat-skill');
    assert.equal(route.memo.mim, 'RA_JBO_RollTwoDice');
    assert.deepEqual(asked, []);
  });
}

for (const text of ['play a game', "let's play a game", 'play Circuit Saver']) {
  test(`a real Circuit Saver launch is unchanged: ${text}`, async () => {
    const { nlu, route } = await parseAndRoute(text);
    assert.equal(nlu.intent, 'launchGame');
    assert.equal(nlu.entities.skill, '@be/circuit-saver');
    assert.equal(route.skillID, '@be/circuit-saver');
    assert.deepEqual(asked, []);
  });
}

test('an unrecognized generic game paraphrase can still use the decision layer', async () => {
  const text = 'i feel like playing something';
  const grammar = await parseRequestDetailedAsync({ text, rules: GLOBAL_RULES });
  assert.notEqual(grammar.nlu.intent, 'launchGame', 'fixture must exercise the model path');
  const { nlu, route } = await parseAndRoute(text);
  assert.equal(nlu.intent, 'launchGame');
  assert.equal(route.skillID, '@be/circuit-saver');
  assert.deepEqual(asked, [text]);
});

test('game protections are limited to HIGH recognized actions and the exact game-list entity', () => {
  for (const intent of ['requestRollOneDie', 'requestRollTwoDice', 'requestFlipCoin', 'requestPlayPong', 'requestPlayPingPong']) {
    assert.equal(decisionKind({ nlu: { intent }, priority: 'HIGH' }, GLOBAL_RULES), null, intent);
    assert.equal(decisionKind({ nlu: { intent }, priority: 'LOW' }, GLOBAL_RULES), 'review', intent);
  }
  const query = { intent: 'whatThingDoesJiboHave', entities: { JiboContent: 'Game' } };
  assert.equal(decisionKind({ nlu: query, priority: 'HIGH' }, GLOBAL_RULES), null);
  assert.equal(decisionKind({ nlu: query, priority: 'LOW' }, GLOBAL_RULES), 'review');
  for (const entities of [{ JiboContent: 'Joke' }, {}, undefined]) {
    assert.equal(decisionKind({ nlu: { ...query, entities }, priority: 'HIGH' }, GLOBAL_RULES), 'second-opinion');
  }
});

test('in-game follow-up rules remain outside the decision layer', async () => {
  const { nlu, route } = await parseAndRoute('yes', ['circuit-saver/play_again']);
  assert.equal(nlu.intent, 'yes');
  assert.deepEqual(nlu.rules, ['circuit-saver/play_again']);
  assert.equal(route, undefined, 'local answers must not launch a different skill');
  assert.deepEqual(asked, []);
});

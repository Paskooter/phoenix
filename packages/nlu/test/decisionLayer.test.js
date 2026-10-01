import test from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../src/index.js';
import { parseRequestDetailedAsync } from '../src/requestParser.js';
import {
  CATCH_ALL_INTENTS,
  DECISION_COMMANDS,
  createDecisionClient,
  decideCommand,
  decisionConfig,
  decisionKind,
  setDecisionClientForTest,
} from '../src/decisionLayer.js';

// The rules a global "Hey Jibo" turn parses against (packages/gateway/src/listenTransaction.js
// GLOBAL_TURN_RULES). A skill waiting for its own answer sends other rules.
const GLOBAL_RULES = ['launch', 'globals/global_commands_launch', 'globals/gui_nav', 'globals/mim_repeat', 'globals/mim_thanks'];

function response(status, body) {
  return { status, json: async () => body };
}

/** A client that answers with a fixed choice and records what it was asked. */
function fakeClient(choice, probability = 1, config = {}) {
  const asked = [];
  return {
    asked,
    enabled: true,
    config: { minProbability: 0.5, overrideProbability: 0.9, ...config },
    async choose(text) {
      asked.push(text);
      return choice ? { choice, probability } : null;
    },
  };
}

const parse = (text, rules = GLOBAL_RULES) => parseRequestDetailedAsync({ text, rules: [...rules] });

test('every command phrase parses, at HIGH, to the intent the command answers with', async () => {
  for (const [key, command] of Object.entries(DECISION_COMMANDS)) {
    if (!command.phrase) continue;
    const parsed = await parse(command.phrase);
    assert.equal(parsed.nlu.intent, command.intent, `${key}: "${command.phrase}"`);
    assert.equal(String(parsed.priority).toUpperCase(), 'HIGH', `${key}: "${command.phrase}"`);
    // Volume is a global command the robot handles itself; everything else launches a skill.
    const rule = key.startsWith('volume_') ? 'globals/global_commands_launch' : 'launch';
    assert.ok(parsed.nlu.rules.includes(rule), `${key} parses under ${rule}`);
  }
  assert.equal((await parse(DECISION_COMMANDS.weather_tomorrow.phrase)).nlu.entities.date, 'tomorrow');
  assert.equal((await parse(DECISION_COMMANDS.joke.phrase)).nlu.entities.JiboContent, 'Joke');
  assert.equal((await parse(DECISION_COMMANDS.fun_fact.phrase)).nlu.entities.JiboContent, 'FunFact');
});

test('the layer is off unless an engine and a key are both configured', () => {
  assert.equal(decisionConfig({}).enabled, false);
  assert.equal(decisionConfig({ ETCO_parser_decisionEngine: 'jev' }).enabled, false);
  assert.equal(decisionConfig({ ETCO_parser_decisionApiKey: 'k' }).enabled, false);
  const on = decisionConfig({ ETCO_parser_decisionEngine: 'jev', ETCO_parser_decisionApiKey: 'k' });
  assert.equal(on.enabled, true);
  assert.equal(on.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(on.model, 'typesafe/jev-1.13');
  assert.deepEqual([on.timeoutMs, on.minProbability, on.overrideProbability], [800, 0.5, 0.9]);
  assert.equal(decisionConfig({ ETCO_parser_decisionEngine: 'JEV', OPENROUTER_API_KEY: 'k' }).enabled, true);
  const bounded = decisionConfig({
    ETCO_parser_decisionEngine: 'jev', ETCO_parser_decisionApiKey: 'k', ETCO_parser_decisionTimeoutMs: '999999',
    ETCO_parser_decisionMinProbability: '2', ETCO_parser_decisionOverrideProbability: '0.95',
  });
  assert.deepEqual([bounded.timeoutMs, bounded.minProbability, bounded.overrideProbability], [800, 0.5, 0.95]);
  assert.equal(createDecisionClient({ enabled: true, apiKey: 'secret' }).config.apiKey, '[configured]');
});

test('a miss, a non-HIGH parse or a catch-all question is reviewed; a command is never second-guessed', async () => {
  assert.equal(decisionKind(await parse('blorp fizzle wump'), GLOBAL_RULES), 'review');
  assert.equal(decisionKind(await parse('how late is it'), GLOBAL_RULES), 'review'); // LOW generalHowQuestions
  assert.equal(decisionKind(await parse('what day is it today'), GLOBAL_RULES), 'review'); // HIGH catch-all
  assert.equal(decisionKind(await parse('turn it up'), GLOBAL_RULES), 'second-opinion'); // HIGH screen command
  assert.equal(decisionKind(await parse('what time is it'), GLOBAL_RULES), null);
  assert.equal(decisionKind(await parse("what's the weather tomorrow"), GLOBAL_RULES), null); // `high`, lower case
  assert.equal(decisionKind(await parse('who is albert einstein'), GLOBAL_RULES), null); // already the knowledge search
  // A skill listening for its own answers is never touched, even alongside launch.
  assert.equal(decisionKind({ nlu: null }, ['clock/yes_no']), null);
  assert.equal(decisionKind({ nlu: null }, ['launch', 'clock/yes_no', 'globals/gui_nav']), null);
  assert.equal(decisionKind({ nlu: null }, ['launch']), 'review');
  assert.equal(decisionKind({ nlu: null }, undefined), null);
  assert.ok(CATCH_ALL_INTENTS.has('generalWhatQuestions'));
});

test('a reviewed paraphrase becomes the grammar parse of the command it means', async () => {
  const client = fakeClient('date');
  const parsed = await parse('what day is it today');
  assert.equal(parsed.nlu.intent, 'generalWhatQuestions');
  const decided = await decideCommand({ text: 'what day is it today', rules: GLOBAL_RULES }, parsed, { client });
  assert.deepEqual(decided, (await parse("what's today's date")).nlu);
  assert.deepEqual(client.asked, ['what day is it today']);

  const weather = await decideCommand({ text: 'do i need an umbrella tomorrow', rules: GLOBAL_RULES },
    await parse('do i need an umbrella tomorrow'), { client: fakeClient('weather_tomorrow') });
  assert.equal(weather.intent, 'requestWeatherPR');
  assert.equal(weather.entities.date, 'tomorrow');
});

test('knowledge, chitchat, none and low probabilities keep the grammar parse', async () => {
  const miss = await parse('blorp fizzle wump');
  const question = await parse('what is the capital of japan');
  const request = (text) => ({ text, rules: GLOBAL_RULES });
  // A question the grammar already sends to the knowledge search stays as it is.
  assert.equal(await decideCommand(request('what is the capital of japan'), question, { client: fakeClient('knowledge') }), null);
  // A miss the engine calls a question goes to the knowledge search.
  assert.deepEqual(await decideCommand(request('blorp fizzle wump'), miss, { client: fakeClient('knowledge') }),
    { intent: 'generalQuestions', entities: {}, rules: ['launch'] });
  for (const choice of ['chitchat', 'none']) {
    assert.equal(await decideCommand(request('blorp fizzle wump'), miss, { client: fakeClient(choice) }), null);
  }
  assert.equal(await decideCommand(request('what day is it today'), await parse('what day is it today'),
    { client: fakeClient('date', 0.49) }), null);
  // An engine failure is a no-decision.
  assert.equal(await decideCommand(request('what day is it today'), await parse('what day is it today'),
    { client: fakeClient(null) }), null);
});

test('a confident non-command parse needs a very sure engine to change', async () => {
  const parsed = await parse('turn it up');
  assert.equal(parsed.nlu.intent, 'close');
  const sure = await decideCommand({ text: 'turn it up', rules: GLOBAL_RULES }, parsed, { client: fakeClient('volume_up', 0.95) });
  assert.equal(sure.intent, 'volumeUp');
  assert.equal(await decideCommand({ text: 'turn it up', rules: GLOBAL_RULES }, parsed, { client: fakeClient('volume_up', 0.8) }), null);
  // A second opinion never turns chitchat into a knowledge search.
  const chitchat = await parse('how old are you');
  assert.equal(await decideCommand({ text: 'how old are you', rules: GLOBAL_RULES }, chitchat, { client: fakeClient('knowledge') }), null);
});

test('a parse that already names a command, a non-global turn or a disabled layer never asks', async () => {
  const client = fakeClient('date');
  assert.equal(await decideCommand({ text: 'what time is it', rules: GLOBAL_RULES }, await parse('what time is it'), { client }), null);
  assert.equal(await decideCommand({ text: 'yes', rules: ['clock/yes_no'] }, { nlu: null }, { client }), null);
  const disabled = { ...fakeClient('date'), enabled: false };
  assert.equal(await decideCommand({ text: 'what day is it today', rules: GLOBAL_RULES }, await parse('what day is it today'),
    { client: disabled }), null);
  assert.deepEqual(client.asked, []);
  assert.deepEqual(disabled.asked, []);
});

test('the Jev client asks one typed choice question and accepts only a well-formed answer', async () => {
  let request;
  const answer = (command) => response(200, { model: 'typesafe/jev-1.13-20260917', answers: { command } });
  const client = (reply) => createDecisionClient({
    enabled: true, apiKey: 'test-key', url: 'https://decisions.test/alpha/decisions', model: 'typesafe/jev-1.13', timeoutMs: 200,
    fetch: async (url, init) => { request = { url, init }; return typeof reply === 'function' ? reply(init) : reply; },
  });

  const good = await client(answer({ type: 'choice', choice: 'date', probabilities: { date: 0.97, time: 0.03 }, confidence: 0.9 }))
    .choose('what day is it today');
  assert.deepEqual(good, { choice: 'date', probability: 0.97 });
  assert.equal(request.url, 'https://decisions.test/alpha/decisions');
  assert.equal(request.init.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'typesafe/jev-1.13');
  assert.deepEqual(body.state, { utterance: 'what day is it today' });
  assert.equal(body.questions.command.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.command.criteria), Object.keys(DECISION_COMMANDS));

  const rejected = [
    answer({ choice: 'order_pizza', probabilities: { order_pizza: 1 } }), // not an option
    answer({ choice: 'date' }), // no probabilities
    answer({ choice: 'date', probabilities: { date: 0.4, time: 0.6 } }), // not the most probable
    answer({ choice: 'date', probabilities: { date: 1.4 } }), // not a probability
    response(200, {}),
    response(429, { error: 'rate limited' }),
    () => { throw new Error('network down'); },
    (init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  ];
  for (const reply of rejected) assert.equal(await client(reply).choose('what day is it today'), null);
  assert.equal(await createDecisionClient({ enabled: false, fetch: async () => { throw new Error('not called'); } }).choose('x'), null);
});

test('POST /v1/parse answers a reviewed paraphrase with the command, and is unchanged without the layer', async () => {
  const post = async (server, data) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/parse`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'NLU', data }),
    });
    return (await res.json()).data;
  };
  const server = await start(0);
  try {
    setDecisionClientForTest(fakeClient('date'));
    assert.equal((await post(server, { text: 'what day is it today', rules: GLOBAL_RULES })).intent, 'askForDate');
    setDecisionClientForTest({ ...fakeClient('date'), enabled: false });
    assert.equal((await post(server, { text: 'what day is it today', rules: GLOBAL_RULES })).intent, 'generalWhatQuestions');
  } finally {
    setDecisionClientForTest(undefined);
    await new Promise((resolve) => server.close(resolve));
  }
});

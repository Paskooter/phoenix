import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, ruleInventory } from '../src/requestParser.js';
import { start } from '../src/index.js';

let server;
let base;
const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;

before(async () => {
  // These assertions preserve the default AST profile. The compiled profile
  // has its own source-response fixtures in compiledFstRuntime.test.js; its
  // native launch winner can differ from this older AST implementation.
  delete process.env.PHOENIX_NLU_RUNTIME;
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime;
});

test('loads the complete source inventory and the timer named rule', () => {
  assert.deepEqual(ruleInventory(), {
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    sourceRuleCount: 117,
    publicRuleCount: 98,
    factoryCount: 2,
    boundedFactoryCount: 2,
    unsupportedFactoryCount: 6,
    unsupportedRuleCount: 4,
  });
  assert.deepEqual(parseRequest({
    text: 'five minutes',
    rules: ['clock/timer_set_value'],
    loop: { users: [] },
  }), {
    rules: ['clock/timer_set_value'],
    intent: 'timerValue',
    entities: { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' },
  });
});

test('evaluates only requested rules and keeps local turns out of launch', () => {
  assert.deepEqual(parseRequest({ text: 'what time is it', rules: ['clock/timer_set_value'] }), {
    rules: [], intent: null, entities: null,
  });
  assert.deepEqual(parseRequest({ text: 'what time is it', rules: ['clock/launch'] }), {
    rules: [], intent: null, entities: null,
  });
  assert.deepEqual(parseRequest({ text: 'tell me a joke', rules: [] }), {
    rules: [], intent: null, entities: null,
  });
  assert.deepEqual(parseRequest({ text: 'tell me a joke', rules: ['audit/nonexistent'] }), {
    rules: [], intent: null, entities: null,
  });
  assert.deepEqual(parseRequest({ text: 'tell me a joke', rules: ['audit/nonexistent', 'launch'] }), {
    rules: ['launch'],
    intent: 'requestTellJiboContent',
    entities: { JiboContent: 'Joke', union_original_fst_name: 'handle:chitchat/launch' },
  });
  assert.throws(
    () => parseRequest({ text: 'blah blah', rules: ['clock/alarm_set_value'] }),
    /Unsupported NLU factory dependencies for public rule 'clock\/alarm_set_value': time/,
  );
  assert.deepEqual(parseRequest({ text: 'open weather', rules: ['main-menu/execute_personal_report'] }), {
    rules: ['main-menu/execute_personal_report'],
    intent: 'loadMenu',
    entities: { destination: 'weather' },
  });
  assert.deepEqual(parseRequest({ text: 'open weather', rules: ['report/launch'] }), {
    rules: [], intent: null, entities: null,
  });

  // The source handler returns before touching external agents for empty text,
  // while a truthy external request on a non-empty result reaches the disabled
  // Dialogflow null.external boundary. Falsey values do not activate it.
  assert.deepEqual(parseRequest({ text: '   ', rules: ['launch'], external: {} }), {
    rules: [], intent: null, entities: null,
  });
  assert.throws(
    () => parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }),
    error => error.message === "Cannot read property 'external' of null",
  );
  assert.throws(
    () => parseRequest({ text: 'set an alarm', rules: ['clock/alarm_set_value'], external: {} }),
    error => error.message === "Cannot read property 'external' of null",
  );
  for (const external of [false, 0, '', null]) {
    assert.equal(parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'], external }).intent, 'timerValue');
  }
});

test('selects a named result across multiple requests and de-duplicates it', () => {
  assert.deepEqual(parseRequest({
    text: 'five minutes',
    rules: ['launch', 'clock/timer_set_value', 'clock/timer_set_value'],
  }), {
    rules: ['clock/timer_set_value'],
    intent: 'timerValue',
    entities: { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' },
  });
  assert.deepEqual(parseRequest({ text: 'go to next page', rules: ['globals/gui_nav'] }), {
    rules: ['globals/gui_nav'],
    intent: 'right',
    entities: { domain: 'gui_command' },
  });
  assert.deepEqual(parseRequest({ text: 'repeat that', rules: ['globals/mim_repeat'] }), {
    rules: ['globals/mim_repeat'],
    intent: 'repeat',
    entities: { domain: 'mim_global' },
  });
  assert.deepEqual(parseRequest({
    text: 'cancel',
    rules: ['clock/timer_set_value', 'globals/gui_nav', 'globals/mim_repeat'],
  }), {
    rules: ['clock/timer_set_value'],
    intent: 'cancel',
    entities: { hours: 'null', minutes: 'null', seconds: 'null', domain: 'timer' },
  });
});

test('applies loop member detection after the named parse', () => {
  assert.deepEqual(parseRequest({
    text: 'who is jane jetson',
    rules: ['launch'],
    loop: { users: [
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
  }), {
    rules: ['launch'],
    // The pinned source corpus selects RULE_WhoIsPerson and then enriches the
    // selected GivenName through LoopMemberDetector. This assertion used to
    // preserve the pre-source-score AST tie result (generalWhoQuestions).
    intent: 'whoIsPerson',
    entities: {
      GivenName: 'jane',
      union_original_fst_name: 'handle:chitchat/launch',
      loopMemberReferent: 'u-jane',
      'given-name': 'Jane',
      'last-name': 'Jetson',
    },
  });
  assert.deepEqual(parseRequest({
    text: 'who is jane',
    rules: ['launch'],
    loop: { users: [
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
  }).entities, {
    GivenName: 'jane',
    union_original_fst_name: 'handle:chitchat/launch',
    loopMemberReferent: 'u-jane',
    'given-name': 'Jane',
    'last-name': 'Jetson',
  });
  assert.deepEqual(parseRequest({
    text: 'who is undefined undefined',
    rules: ['launch'],
    loop: { users: [{ id: 'u-malformed' }] },
  }).entities, {
    union_original_fst_name: 'handle:chitchat/launch',
  });
  assert.deepEqual(parseRequest({
    text: 'jane jetson',
    rules: ['shared/wrong_id'],
    loop: { users: [
      { id: 'u-george', firstName: 'George', lastName: 'Jetson' },
      { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' },
    ] },
  }), {
    rules: ['shared/wrong_id'],
    intent: 'loopmember',
    entities: {
      GivenName: 'jane',
      loopMemberReferent: 'u-jane',
      'given-name': 'Jane',
      'last-name': 'Jetson',
    },
  });
});

test('uses source byte heuristic for wildcard arbitration in the default AST profile', () => {
  const cases = [
    ['can you tell jokes', 'requestTellJiboContent', { JiboContent: 'Joke' }],
    ['are you a natterjack', 'idle', {}],
    ['are you a crane', 'idle', {}],
    ['what are you doing', 'doesJiboHavePlansForEvent', { Timeframe: 'Now' }],
    ['what have you been doing', 'whatDidJiboAction', { Timeframe: 'Day' }],
  ];
  for (const [text, intent, entities] of cases) {
    const result = parseRequest({ text, rules: ['launch'] });
    assert.equal(result.intent, intent, text);
    assert.deepEqual(result.entities, {
      ...entities,
      union_original_fst_name: 'handle:chitchat/launch',
    }, text);
  }
});

test('keeps source priority and punctuation metadata semantic', () => {
  // Report rules use the lower-case spelling of the source priority tag. It
  // must still outrank the launch catch-all rules.
  assert.deepEqual(parseRequest({ text: 'check the weather', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'requestWeatherPR',
    entities: { union_original_fst_name: 'handle:personal-report/launch' },
  });

  // Character classes in the source grammar encode optional punctuation in
  // abbreviations (`u?.s?.`, `b?.e?.t?.`). Typed/ASR text without periods
  // must reach the same source-backed entities.
  assert.deepEqual(parseRequest({ text: 'do you like the us open for golf', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'doesJiboLikeThing',
    entities: {
      Event: 'USOpenGolf',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
  assert.deepEqual(parseRequest({ text: 'i like the bet awards', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'userLikesThing',
    entities: {
      Event: 'BETAwards',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
  assert.deepEqual(parseRequest({ text: 'what do you think of ai', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'doesJiboHaveOpinionAboutThing',
    entities: {
      GeneralLikes: 'AI',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });

  // Source action literals are trimmed by the native parser. These rules
  // contain incidental whitespace inside their quoted action values.
  assert.deepEqual(parseRequest({ text: 'when were you born', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'whenWasEvent',
    entities: {
      Event: 'JiboBirth',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
  assert.deepEqual(parseRequest({ text: 'why did you ask about our day', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'whyDidJiboAction',
    entities: {
      Action: 'AskAboutUserDay',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
});

test('expands optional characters in source person grammar', () => {
  // `[me?et]` is the source spelling for both "met" and "meet". The
  // `?` makes the next `e` optional; the final `t` remains required.
  // The unrelated `me` variant must not be emitted.
  assert.deepEqual(parseRequest({ text: 'have you met alicia yet', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'hasJiboMetPerson',
    entities: {
      GivenName: 'alicia',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
  assert.deepEqual(parseRequest({ text: 'have you met the amazon echo', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'hasJiboMetPerson',
    entities: {
      Person: 'Alexa',
      union_original_fst_name: 'handle:chitchat/launch',
    },
  });
  assert.deepEqual(parseRequest({
    text: 'have you met george',
    rules: ['launch'],
    loop: { users: [{ id: 'test-looper-id-2', firstName: 'George', lastName: 'Jetson' }] },
  }), {
    rules: ['launch'],
    intent: 'hasJiboMetPerson',
    entities: {
      GivenName: 'george',
      union_original_fst_name: 'handle:chitchat/launch',
      loopMemberReferent: 'test-looper-id-2',
      'given-name': 'George',
      'last-name': 'Jetson',
    },
  });
});

test('HTTP parser accepts the complete request data and preserves empty shape', async () => {
  const response = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: {
      text: 'five minutes',
      rules: ['clock/timer_set_value'],
      loop: { users: [] },
    } }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'NLU');
  assert.deepEqual(body.data, {
    rules: ['clock/timer_set_value'],
    intent: 'timerValue',
    entities: { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' },
  });

  const empty = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text: 'tell me a joke', rules: [] } }),
  });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).data, { rules: [], intent: null, entities: null });

  const external = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text: 'five minutes', rules: ['clock/timer_set_value'], external: {} } }),
  });
  assert.equal(external.status, 500);
  assert.equal((await external.json()).data.message, "Cannot read property 'external' of null");

  const blankExternal = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text: ' ', rules: ['launch'], external: {} } }),
  });
  assert.equal(blankExternal.status, 200);
  assert.deepEqual((await blankExternal.json()).data, { rules: [], intent: null, entities: null });

  const unsupported = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text: 'blah blah', rules: ['clock/alarm_set_value'] } }),
  });
  assert.equal(unsupported.status, 500);
  assert.match((await unsupported.json()).data.message, /Unsupported NLU factory dependencies/);
});

test('HTTP parser still rejects malformed text before rule loading', async () => {
  const response = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text: 42, rules: ['launch'] } }),
  });
  assert.equal(response.status, 400);
});

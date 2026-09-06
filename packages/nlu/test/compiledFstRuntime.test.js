import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { start } from '../src/index.js';
import { compiledFstRuntimeConfig, getCompiledFstRuntime, matchCompiledLaunch } from '../src/compiledFstRuntime.js';
import { parseRequest } from '../src/requestParser.js';

const configured = process.env.PHOENIX_NLU_RUNTIME === 'compiled-fst'
  && Boolean(process.env.PHOENIX_NLU_COMPILED_FST)
  && Boolean(process.env.PHOENIX_NLU_COMPILED_FACTORY_DIR)
  && Boolean(process.env.PHOENIX_NLU_COMPILED_RULES_DIR)
  && Boolean(process.env.PHOENIX_NLU_COMPILED_FST_SHA256);
let server;

test('an invalid native winner does not promote a lower-ranked intent', () => {
  // result_fst.cpp processes only the first sorted final; the HTTP handler
  // rejects a missing intent after native selection has already finished.
  const runtime = { executor: { parse: () => ({ results: [
    { outputSymbols: ["N:{} {% marker = 'winner'; %}"], score: 1, heuristic: -1 },
    { outputSymbols: ["N:{} {% intent = 'lower'; %}"], score: 0, heuristic: 0 },
  ] }) } };
  assert.equal(matchCompiledLaunch('hello', runtime), null);
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('compiled rule failures and invalid winners follow the original client boundary', { skip: !configured }, t => {
  // These are transport/interpreter failure seams, not claimed native graph
  // outputs. Source getRuleResponse catches each failed rule independently;
  // ParseRequestHandler validates the chosen result after score arbitration.
  const runtime = getCompiledFstRuntime();
  const globalRule = 'globals/global_commands_launch';
  const executor = runtime.getExecutor(globalRule);
  const originalParse = executor.parse;
  t.after(() => { executor.parse = originalParse; });
  executor.parse = () => { throw new Error('fixture native rule failure'); };
  for (const rules of [[globalRule, 'launch'], ['launch', globalRule]]) {
    const result = parseRequest({ text: 'what time is it', rules });
    assert.equal(result.intent, 'askForTime');
    assert.deepEqual(result.rules, ['launch']);
  }
  assert.deepEqual(parseRequest({ text: 'what time is it', rules: [globalRule] }), {
    intent: null, entities: null, rules: [],
  });
  for (const tags of ["marker = 'missing intent';", "intent = 'skip winner'; priority = 'SKIP';"]) {
    executor.parse = () => ({ results: [{
      outputSymbols: [`N:{} {% ${tags} %}`], score: 999, heuristic: -999,
    }] });
    assert.deepEqual(parseRequest({ text: 'what time is it', rules: [globalRule, 'launch'] }), {
      intent: null, entities: null, rules: [],
    });
  }
});

test('explicit compiled-FST profile connects the real /v1/parse path', { skip: !configured }, async () => {
  assert.deepEqual(compiledFstRuntimeConfig(), {
    runtime: 'compiled-fst',
    fstPath: process.env.PHOENIX_NLU_COMPILED_FST,
    factoryDir: process.env.PHOENIX_NLU_COMPILED_FACTORY_DIR,
    rulesDir: process.env.PHOENIX_NLU_COMPILED_RULES_DIR,
    fstSha256: process.env.PHOENIX_NLU_COMPILED_FST_SHA256,
    ruleCount: 98,
    ruleManifestSha256: '7648a6449f62d7664c7f9a602ec50e9195daeb92e30aaefbf0ebd2d50a0a3142',
    inventoryRevision: '5c0a7390539663ba749d360de348a428c088505c',
    inventorySha256: '4377949617eb3169f1466ddb2844f2f5f9948f43e1942a2e35f38c3664dc4aa5',
    sourceRevision: '91b1bb6dbc702d3072df98a6fa0b76a6bc151d3e',
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    sourceRuntime: 'jibo-nlu v2.8.3',
    nativeParserSha256: '373b6509036c6ab841023fa541b931f1ccc966dee750058cdbbf560ab467ce9b',
    factoryManifestSha256: '4ea19a27acbfaecdb60de0688cb5f3f75ef31c93c2865d2d6710989f98ffe97e',
  });
  assert.deepEqual(parseRequest({ text: 'who is jane jetson', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'whoIsPerson',
    entities: { GivenName: 'jane', union_original_fst_name: 'handle:chitchat/launch' },
  });
  // Original HTTP corpus boundary:loop-full-name returns whoIsPerson and
  // retains GivenName while LoopMemberDetector adds the member's full name.
  assert.deepEqual(parseRequest({
    text: 'who is jane jetson',
    rules: ['launch'],
    loop: { users: [{ id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' }] },
  }), {
    rules: ['launch'],
    intent: 'whoIsPerson',
    entities: {
      GivenName: 'jane',
      union_original_fst_name: 'handle:chitchat/launch',
      loopMemberReferent: 'u-jane',
      'given-name': 'Jane',
      'last-name': 'Jetson',
    },
  });
  assert.deepEqual(parseRequest({ text: '  TELL ME A JOKE  ', rules: ['launch'] }), {
    rules: ['launch'],
    intent: 'requestTellJiboContent',
    entities: { JiboContent: 'Joke', union_original_fst_name: 'handle:chitchat/launch' },
  });
  // The original RobustParserClient sends every requested graph independently and
  // compares native heuristic scores. Launch score 13 must beat the global stop score
  // 7 even when the global graph is listed first.
  for (const rules of [
    ['launch', 'globals/global_commands_launch'],
    ['globals/global_commands_launch', 'launch'],
  ]) {
    assert.deepEqual(parseRequest({ text: 'cancel the timer', rules }), {
      rules: ['launch'],
      intent: 'stop',
      entities: {
        domain: 'timer',
        hours: 'null',
        minutes: 'null',
        seconds: 'null',
        skill: '@be/clock',
        union_original_fst_name: 'handle:clock/launch',
      },
    });
  }
  assert.deepEqual(parseRequest({ text: 'cancel the timer', rules: ['globals/global_commands_launch'] }), {
    rules: ['globals/global_commands_launch'],
    intent: 'stop',
    entities: { domain: 'global_commands' },
  });
  // The timer rule and global rule tie at native score 7; globals is a designated
  // loser, so the non-global result wins regardless of request order.
  assert.deepEqual(parseRequest({
    text: 'cancel the timer',
    rules: ['globals/global_commands_launch', 'clock/timer_set_value'],
  }), {
    rules: ['clock/timer_set_value'],
    intent: 'cancel',
    entities: { hours: 'null', minutes: 'null', seconds: 'null', domain: 'timer' },
  });
  // clock/launch is a component of the public launch union, not a public rule
  // handle in the pinned registry. It remains unknown to this request boundary.
  assert.deepEqual(parseRequest({ text: 'what time is it', rules: ['clock/launch'] }), {
    rules: [], intent: null, entities: null,
  });
  // The compiled graph contains the archived `time` factory even though the
  // AST profile cannot execute that dependency. A configured public graph must
  // reach its own no-match result instead of inheriting the AST guard.
  assert.deepEqual(parseRequest({ text: 'blah blah', rules: ['clock/alarm_set_value'] }), {
    rules: [], intent: null, entities: null,
  });

  server = await start(0);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data: { text: 'check the weather', rules: ['launch'] } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    rules: ['launch'],
    intent: 'requestWeatherPR',
    entities: { union_original_fst_name: 'handle:personal-report/launch' },
  });
});

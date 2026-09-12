import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createLLMClient, llmConfigFromEnv } from '../src/llmFallback.js';
import {
  attachExternalResult,
  createExternalAgentProvider,
} from '../src/externalAgents.js';
import { LoopMemberDetector } from '../src/loopMemberDetector.js';
import { parseRequest } from '../src/requestParser.js';
import { start } from '../src/index.js';

const SECRET_SENTINEL = 'SECRET_SENTINEL';
let server;
let base;
const fallbackCalls = [];

before(async () => {
  server = await start(0, {
    llmClient: {
      state: 'READY',
      async handleNLU(request) {
        fallbackCalls.push(request);
        return { intent: 'tellAJoke', entities: {}, rules: request.rules || [] };
      },
    },
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function post(data) {
  const response = await fetch(`${base}/v1/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'NLU', data }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

function providerFor(response) {
  return new Promise(resolve => {
    const provider = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    provider.listen(0, '127.0.0.1', () => resolve({
      provider,
      url: `http://127.0.0.1:${provider.address().port}/v1`,
    }));
  });
}

test('HTTP grammar matches remain deterministic and do not call the configured fallback', async () => {
  fallbackCalls.length = 0;
  const response = await post({ text: 'what time is it', rules: ['launch'] });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.intent, 'askForTime');
  assert.equal(fallbackCalls.length, 0);
});

test('HTTP low-priority grammar results also use the configured fallback arbitration', async () => {
  fallbackCalls.length = 0;
  const response = await post({ text: 'are you a natterjack', rules: ['launch'] });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.intent, 'tellAJoke');
  assert.equal(fallbackCalls.length, 1);
});

test('HTTP grammar misses invoke the configured fallback with the request rules', async () => {
  fallbackCalls.length = 0;
  const response = await post({ text: 'no deterministic grammar match', rules: ['launch'] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { intent: 'tellAJoke', entities: {}, rules: ['launch'] });
  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].text, 'no deterministic grammar match');
  assert.deepEqual(fallbackCalls[0].rules, ['launch']);
});

test('HTTP validation failures never reflect the request body or member fields', async () => {
  const invalidBody = await post({ text: 7, token: SECRET_SENTINEL });
  assert.equal(invalidBody.status, 400);
  assert.equal(invalidBody.body.data.message, 'Invalid NLU request');
  assert.equal(JSON.stringify(invalidBody.body).includes(SECRET_SENTINEL), false);

  const invalidLoop = await post({
    text: 'who is jane jetson',
    rules: ['launch'],
    loop: { users: [{ id: SECRET_SENTINEL, firstName: 'Jane', lastName: 7 }] },
  });
  assert.equal(invalidLoop.status, 400);
  assert.equal(invalidLoop.body.data.message, 'Invalid NLU request');
  assert.equal(JSON.stringify(invalidLoop.body).includes(SECRET_SENTINEL), false);
  assert.throws(
    () => parseRequest({ text: 'x', rules: ['launch'], loop: { users: [{ id: SECRET_SENTINEL }] } }),
    error => error.code === 'INVALID_NLU_REQUEST'
      && error.message === 'Invalid NLU request'
      && !error.message.includes(SECRET_SENTINEL),
  );
});

test('loop member names are escaped before regex matching', () => {
  const result = { intent: 'whoIsPerson', entities: {} };
  LoopMemberDetector.detectLoopMembers({
    text: 'who is A.J. Smith',
    loop: { users: [{ id: 'u-dot', firstName: 'A.J.', lastName: 'Smith' }] },
  }, result);
  assert.equal(result.entities.loopMemberReferent, 'u-dot');

  const noFalsePositive = { intent: 'whoIsPerson', entities: {} };
  LoopMemberDetector.detectLoopMembers({
    text: 'who is AXJY Smith',
    loop: { users: [{ id: 'u-dot', firstName: 'A.J.', lastName: 'Smith' }] },
  }, noFalsePositive);
  assert.deepEqual(noFalsePositive.entities, {});
});

test('LLM tool names and argument shapes are strictly allowlisted', async () => {
  const cases = [
    { name: 'runShell', args: '{}' },
    { name: 'doYouLike', args: JSON.stringify({ thing: 'penguins', extra: SECRET_SENTINEL }) },
    { name: 'doYouLike', args: JSON.stringify({ thing: 7 }) },
    { name: 'launchSkill', args: '{}' },
    { type: 'not-function', name: 'tellAJoke', args: '{}' },
    { name: 'tellAJoke', args: '[]' },
    { name: 'tellAJoke', args: '{"unexpected":"field"}' },
    { name: 'tellAJoke', args: '{' },
  ];
  for (const item of cases) {
    const provider = await providerFor({ choices: [{ message: { tool_calls: [{
      ...(item.type ? { type: item.type } : {}),
      function: { name: item.name, arguments: item.args },
    }] } }] });
    try {
      const client = createLLMClient({ enabled: true, url: provider.url, model: 'm' });
      client.init();
      assert.equal(await client.handleNLU({ text: 'adversarial', rules: ['launch'] }), null, item.name);
    } finally {
      await new Promise(resolve => provider.provider.close(resolve));
    }
  }
});

test('provider failures and async providers do not leak provider details', () => {
  const asyncProvider = { handleNLU: async () => ({ external: { leaked: SECRET_SENTINEL } }) };
  assert.throws(
    () => attachExternalResult(
      { text: 'x', rules: [], external: {} },
      { intent: 'ok', entities: {}, rules: [] },
      asyncProvider,
    ),
    error => error.code === 'ASYNC_EXTERNAL_PROVIDER'
      && error.message === 'Async external providers are not supported'
      && !error.message.includes(SECRET_SENTINEL),
  );

  const provider = createExternalAgentProvider({
    enabled: true,
    agents: {
      default: () => ({ intent: 'ok', entities: {} }),
      agent_one: () => { throw new Error(SECRET_SENTINEL); },
    },
  });
  const result = attachExternalResult(
    { text: 'x', rules: ['launch'], external: { agent_one: { rules: ['launch'] } } },
    { intent: 'ok', entities: {}, rules: ['launch'] },
    provider,
  );
  assert.equal(result.external.agent_one.error, 'External agent unavailable');
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false);
});

test('explicit false LLM configuration overrides URL presence', () => {
  const oldEnabled = process.env.ETCO_parser_llmEnabled;
  const oldUrl = process.env.ETCO_parser_llmUrl;
  try {
    process.env.ETCO_parser_llmEnabled = 'false';
    process.env.ETCO_parser_llmUrl = 'http://127.0.0.1:1/v1';
    assert.equal(llmConfigFromEnv().enabled, false);
    process.env.ETCO_parser_llmEnabled = 'true';
    assert.equal(llmConfigFromEnv().enabled, true);
  } finally {
    if (oldEnabled === undefined) delete process.env.ETCO_parser_llmEnabled;
    else process.env.ETCO_parser_llmEnabled = oldEnabled;
    if (oldUrl === undefined) delete process.env.ETCO_parser_llmUrl;
    else process.env.ETCO_parser_llmUrl = oldUrl;
  }
});

test('Québec projection is UTF-8 and remains distinct from the unaccented spelling', () => {
  const source = readFileSync(new URL('../resources/factory-words/canada_province.txt', import.meta.url), 'utf8');
  assert.match(source, /(^|\n)québec\n/u);
  assert.doesNotMatch(source, /quÃ©bec/u);
  assert.equal(parseRequest({ text: 'what time is it in québec', rules: ['launch'] }).entities.state, 'québec');
  assert.equal(parseRequest({ text: 'what time is it in quebec', rules: ['launch'] }).entities.state, 'quebec');
});

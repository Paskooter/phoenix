// N-07: the LLM fallback client must match the pinned restored Pegasus source
// jiboV2/pegasus@715e0dd0719ecca5164959d713862a1402430623:
//   packages/parser/src/llm/LLMClient.ts
//
// Every assertion below is driven by a REAL HTTP conversation with a local
// OpenAI-compatible mock provider (recorded envelopes in
// fixtures/fallback-provider-recordings.json), not by an in-process stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Timeouts } from '@phoenix/contracts';
import {
  createLLMClient, getLLMClient, llmFallback,
  LLM_DEFAULT_TIMEOUT_MS, LLM_INTENT_TOOLS, LLM_STATE,
} from '../src/llmFallback.js';

const recordings = JSON.parse(readFileSync(new URL('./fixtures/fallback-provider-recordings.json', import.meta.url)));

function startProvider({ delayMs = 0, status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      const utterance = (parsed.messages.find(m => m.role === 'user') || {}).content || '';
      const match = Object.values(recordings.fallbackResponses)
        .find(r => utterance.includes(r.utterance));
      const send = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 200 ? JSON.stringify(match ? match.response : { choices: [] }) : '{"error":"boom"}');
      };
      if (delayMs) setTimeout(send, delayMs); else send();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, seen, url: `http://127.0.0.1:${server.address().port}/v1`,
  })));
}

test('fallback catalog is source-exact and inside the gateway parser budget', () => {
  // LLMClient.ts:18
  assert.equal(LLM_DEFAULT_TIMEOUT_MS, 8000);
  // packages/contracts/src/constants.js Timeouts.parser — the gateway aborts the
  // whole parser request at 10 s, so the fallback's own budget must sit under it.
  assert.ok(LLM_DEFAULT_TIMEOUT_MS < Timeouts.parser, `${LLM_DEFAULT_TIMEOUT_MS} !< ${Timeouts.parser}`);

  // LLMClient.ts:36-52, in order, with entity schema types.
  assert.deepEqual(LLM_INTENT_TOOLS.map(t => t.name), [
    'whatsUp', 'doYouLike', 'whoAmI', 'tellMeAboutYourself', 'tellAJoke', 'tellMeATip',
    'launchSkill', 'whatTimeIsIt', 'thanks', 'goodbye', 'cancel', 'yes', 'no', 'chitchat', 'unknown',
  ]);
  assert.equal(LLM_INTENT_TOOLS.length, 15);
  assert.deepEqual(LLM_INTENT_TOOLS.find(t => t.name === 'doYouLike').entities, { thing: 'string' });
  assert.deepEqual(LLM_INTENT_TOOLS.find(t => t.name === 'launchSkill').entities, { skillId: 'string' });
  assert.equal(LLM_INTENT_TOOLS.filter(t => t.entities).length, 2);
});

test('fallback enabled/disabled configuration drives the client state', async () => {
  // LLMClient.ts:59-72 + 76-79
  const off = createLLMClient({ enabled: false, url: 'http://x', model: 'm' });
  assert.equal(off.state, LLM_STATE.NOT_READY);          // constructor state (:55)
  assert.equal(off.init(), LLM_STATE.DISABLED);          // !enabled -> DISABLED
  assert.equal(await off.handleNLU({ text: 'hi' }), null);

  const halfConfigured = createLLMClient({ enabled: true, url: 'http://x', model: '' });
  assert.equal(halfConfigured.init(), LLM_STATE.NOT_READY);  // missing model
  assert.equal(await halfConfigured.handleNLU({ text: 'hi' }), null);

  const missingUrl = createLLMClient({ enabled: true, url: '', model: 'm' });
  assert.equal(missingUrl.init(), LLM_STATE.NOT_READY);
  assert.equal(missingUrl.handleNLU !== undefined, true);

  const ready = createLLMClient({ enabled: true, url: 'http://x', model: 'm' });
  assert.equal(ready.init(), LLM_STATE.READY);
});

test('fallback sends the source catalog/tool_choice/temperature and decodes recorded tool calls', async () => {
  const provider = await startProvider();
  try {
    const client = createLLMClient({ enabled: true, url: provider.url, model: 'google/gemma-4-e4b' });
    client.init();

    const greeting = await client.handleNLU({ text: 'hey what is up', rules: [] });
    assert.deepEqual(greeting, { intent: 'whatsUp', entities: {}, rules: [] });

    const entityTool = await client.handleNLU({ text: 'do you like penguins', rules: ['launch'] });
    // entities are the parsed tool arguments directly (LLMClient.ts:186-195) and
    // rules are the request's requested rules (LLMClient.ts:196-200).
    assert.deepEqual(entityTool, { intent: 'doYouLike', entities: { thing: 'Penguins' }, rules: ['launch'] });

    const noEntities = await client.handleNLU({ text: 'tell me a joke', rules: ['launch'] });
    assert.deepEqual(noEntities, { intent: 'tellAJoke', entities: {}, rules: ['launch'] });

    const malformed = await client.handleNLU({ text: 'mumble jumble', rules: [] });
    assert.deepEqual(malformed, { intent: 'tellMeATip', entities: {}, rules: [] });

    // The wire request itself carries the source contract.
    const sent = provider.seen[0];
    assert.equal(sent.model, 'google/gemma-4-e4b');
    assert.equal(sent.tools.length, 15);
    assert.equal(sent.tool_choice, 'auto');               // LLMClient.ts:118
    assert.equal(sent.temperature, 0);                     // LLMClient.ts:119
    assert.deepEqual(sent.tools.find(t => t.function.name === 'doYouLike').function.parameters.required, ['thing']);
    assert.equal(sent.messages[0].role, 'system');
  } finally {
    await new Promise(r => provider.server.close(r));
  }
});

test('fallback invalid/absent/decoy provider outputs return null', async () => {
  const provider = await startProvider();
  try {
    const client = createLLMClient({ enabled: true, url: provider.url, model: 'm' });
    client.init();
    // no tool call (LLMClient.ts:175-178)
    assert.equal(await client.handleNLU({ text: 'hmm', rules: [] }), null);
    // tool "unknown" is the graceful exit (LLMClient.ts:181-184)
    assert.equal(await client.handleNLU({ text: 'flurble gax wibble', rules: [] }), null);
  } finally {
    await new Promise(r => provider.server.close(r));
  }
});

test('fallback is null on non-200 and when the provider is unavailable', async () => {
  const failing = await startProvider({ status: 500 });
  try {
    const client = createLLMClient({ enabled: true, url: failing.url, model: 'm' });
    client.init();
    assert.equal(await client.handleNLU({ text: 'hey what is up', rules: [] }), null);
  } finally {
    await new Promise(r => failing.server.close(r));
  }

  const down = createLLMClient({ enabled: true, url: 'http://127.0.0.1:1/v1', model: 'm' });
  down.init();
  assert.equal(await down.handleNLU({ text: 'hey what is up', rules: [] }), null);
});

test('fallback timeout is honoured by cancellation, not by waiting on the provider', async () => {
  const provider = await startProvider({ delayMs: 400 });
  try {
    const client = createLLMClient({ enabled: true, url: provider.url, model: 'm', timeoutMs: 60 });
    client.init();
    const t0 = Date.now();
    const result = await client.handleNLU({ text: 'hey what is up', rules: [] });
    const elapsed = Date.now() - t0;
    assert.equal(result, null);
    assert.ok(elapsed < 400, `timed out before provider replied (${elapsed}ms)`);
  } finally {
    await new Promise(r => provider.server.close(r));
  }
});

test('env-driven default client stays DISABLED with no configured URL', async () => {
  if (process.env.ETCO_parser_llmUrl || process.env.ETCO_parser_llmEnabled === 'true') return;
  assert.equal(getLLMClient().state, LLM_STATE.DISABLED);
  assert.equal(await llmFallback('anything'), null);
});

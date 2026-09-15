// The external-agent lane, with a live provider behind it.
//
// Dialogflow was the ML backstop behind the rule parser and api.api.ai is gone,
// so this lane has been dark: a truthy `external` request could only ever
// produce the original disabled-client boundary error. These cover widening the
// boundary to admit a provider that answers over the network, without changing
// what the default does.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASYNC_PROVIDER_ERROR,
  DISABLED_EXTERNAL_ERROR,
  DECOY_INTENT,
  attachExternalResult,
  attachExternalResultAsync,
  createLlmExternalAgentProvider,
  resolveExternalAgentProvider,
} from '../src/externalAgents.js';
import { parseRequest, parseRequestAsync } from '../src/requestParser.js';

// The default external-agent provider is env-selected (PHOENIX_NLU_EXTERNAL),
// and @phoenix/common fills process.env from the repo-root .env on import. A
// deployment that enables the live lane would otherwise change what "default"
// means here, so these assertions pin it rather than read the ambient value.
// node --test gives each file its own process, so this cannot leak.
process.env.PHOENIX_NLU_EXTERNAL = 'disabled';

const request = (extra = {}) => ({
  text: 'do you like pizza',
  rules: ['launch'],
  ...extra,
});

test('the default provider is unchanged: the original boundary error still stands', async () => {
  const withExternal = request({ external: { default: { rules: ['launch'] } } });
  assert.throws(() => parseRequest(withExternal), /Cannot read property 'external' of null/);
  await assert.rejects(() => parseRequestAsync(request({ external: { default: { rules: ['launch'] } } })),
    /Cannot read property 'external' of null/);
  assert.equal(resolveExternalAgentProvider(undefined).enabled, false);
  assert.equal(resolveExternalAgentProvider('anything-else').enabled, false);
});

test('a synchronous parse refuses an asynchronous provider instead of attaching undefined', () => {
  // The failure this prevents is silent: a Promise is truthy, so the old code
  // would have set `external` to undefined and returned a successful-looking
  // parse.
  const provider = createLlmExternalAgentProvider({ classify: async () => ({ intent: 'doesJiboLikeThing', entities: {} }) });
  assert.throws(
    () => attachExternalResult(request({ external: { default: {} } }), { entities: {} }, provider),
    new RegExp(ASYNC_PROVIDER_ERROR.slice(0, 40)),
  );
  assert.throws(
    () => parseRequest(request({ external: { default: { rules: ['launch'] } } }), { externalProvider: provider }),
    new RegExp(ASYNC_PROVIDER_ERROR.slice(0, 40)),
  );
});

test('an async provider attaches the agent map in DialogflowClient shape', async () => {
  const provider = createLlmExternalAgentProvider({
    classify: async (text) => ({ intent: 'doesJiboLikeThing', entities: { GeneralLikes: text.split(' ').pop() } }),
  });
  const parsed = await parseRequestAsync(
    request({ external: { default: { rules: ['launch'] }, second: { rules: ['launch'] } } }),
    { externalProvider: provider },
  );
  assert.deepEqual(Object.keys(parsed.external).sort(), ['default', 'second']);
  for (const name of ['default', 'second']) {
    assert.equal(parsed.external[name].intent, 'doesJiboLikeThing');
    assert.deepEqual(parsed.external[name].rules, ['launch']);
    assert.deepEqual(parsed.external[name].entities, { GeneralLikes: 'pizza' });
  }
  // The rule parser's own decision is untouched by the agent.
  assert.equal(parsed.intent, 'doesJiboLikeThing');
});

test('a bad agent is recorded, not thrown, so one cannot lose the others', async () => {
  const provider = createLlmExternalAgentProvider({ classify: async () => ({ intent: 'whatsUp', entities: {} }) });
  const parsed = await parseRequestAsync(
    request({ external: { default: { rules: ['launch'] }, broken: null } }),
    { externalProvider: provider },
  );
  assert.equal(parsed.external.default.intent, 'whatsUp');
  assert.equal(parsed.external.broken.intent, '');
  assert.match(parsed.external.broken.error, /not configured/);
});

test('an unconfident classification becomes the decoy, not a failure', async () => {
  const provider = createLlmExternalAgentProvider({ classify: async () => null });
  const parsed = await parseRequestAsync(
    request({ external: { default: { rules: ['launch'] } } }),
    { externalProvider: provider },
  );
  assert.equal(parsed.external.default.intent, DECOY_INTENT);
});

test('a provider that is not ready still produces the original boundary error', async () => {
  const provider = createLlmExternalAgentProvider({ enabled: false, classify: async () => ({ intent: 'x' }) });
  assert.equal(provider.enabled, false);
  await assert.rejects(
    () => attachExternalResultAsync(request({ external: { default: {} } }), { entities: {} }, provider),
    new RegExp(DISABLED_EXTERNAL_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('a request with no external block never consults the provider', async () => {
  let called = 0;
  const provider = createLlmExternalAgentProvider({ classify: async () => { called += 1; return { intent: 'x' }; } });
  const parsed = await parseRequestAsync(request(), { externalProvider: provider });
  assert.equal(called, 0);
  assert.equal(parsed.external, undefined);
});

test('PHOENIX_NLU_EXTERNAL=llm selects the live provider', (t) => {
  const previous = process.env.PHOENIX_NLU_EXTERNAL;
  process.env.PHOENIX_NLU_EXTERNAL = 'llm';
  t.after(() => {
    if (previous === undefined) delete process.env.PHOENIX_NLU_EXTERNAL;
    else process.env.PHOENIX_NLU_EXTERNAL = previous;
  });
  assert.equal(resolveExternalAgentProvider().enabled, true);
});

test('the live lane names real intents, not the restored catalog\'s invented ones', async () => {
  const { LLM_EXTERNAL_DEFAULT_CATALOG } = await import('../src/externalAgents.js');
  const { resolveIntentCatalog } = await import('../src/llmFallback.js');
  assert.equal(LLM_EXTERNAL_DEFAULT_CATALOG, 'source');

  const live = new Set(resolveIntentCatalog(LLM_EXTERNAL_DEFAULT_CATALOG).map((t) => t.name));
  const restored = new Set(resolveIntentCatalog('restored').map((t) => t.name));

  // What the restored catalog would have answered "do you like pizza" with, and
  // what Jibo actually called it. An agent answering `doYouLike` reaches no
  // handler, so this lane must not inherit that catalog.
  assert.ok(restored.has('doYouLike'));
  assert.ok(!live.has('doYouLike'), 'doYouLike is not a real Jibo intent');
  assert.ok(live.has('doesJiboLikeThing'));
  assert.ok(live.has('doesJiboLikeTasteOfThing'));
  assert.ok(live.has('askForTime') && live.has('lightsOn'));
});

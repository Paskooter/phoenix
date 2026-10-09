// N-07: external-agent behavior must match the pinned Pegasus source
//   jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//     packages/parser/src/dialogflow/DialogflowClient.ts
//     packages/parser/src/handlers/ParseRequestHandler.ts
//
// The matrix is driven by recorded provider outputs
// (fixtures/fallback-provider-recordings.json .external).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRequest } from '../src/requestParser.js';
import {
  createExternalAgentProvider, createDisabledExternalAgentProvider,
  attachExternalResult, ASYNC_PROVIDER_ERROR, DECOY_INTENT, DISABLED_EXTERNAL_ERROR, EXTERNAL_AGENT_ERROR, EXTERNAL_STATE,
  EXTERNAL_ATTACHMENT_REVISION, DEFAULT_EXTERNAL_ATTACHMENT_REVISION, resolveExternalAttachmentRevision,
} from '../src/externalAgents.js';

// The default external-agent provider is env-selected (PHOENIX_NLU_EXTERNAL),
// and @phoenix/common fills process.env from the repo-root .env on import. A
// deployment that enables the live lane would otherwise change what "default"
// means here, so these assertions pin it rather than read the ambient value.
// node --test gives each file its own process, so this cannot leak.
process.env.PHOENIX_NLU_EXTERNAL = 'disabled';

const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;
delete process.env.PHOENIX_NLU_RUNTIME;
test.after(() => { if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime; });

const recordings = JSON.parse(readFileSync(new URL('./fixtures/fallback-provider-recordings.json', import.meta.url)));
const ext = recordings.external;
// DIVERGENCES.md N-hardening-external: a failed agent records one generic
// error instead of the underlying message (the recording keeps the old text).
const expectedExternal = structuredClone(ext.expectedExternal);
expectedExternal.agent_missing.error = 'External agent unavailable';

function recordedProvider() {
  return createExternalAgentProvider({
    enabled: true,
    accessToken: 'recorded-token-0',
    agents: {
      default: () => ext.defaultAgentRecording,
      agent_one: () => ext.agentRecordings.agent_one,
      agent_two: () => ext.agentRecordings.agent_two,
      // agent_missing intentionally has no archived resolver.
    },
  });
}

test('the disabled Dialogflow provider reproduces the original external boundary', () => {
  const provider = createDisabledExternalAgentProvider();
  assert.equal(provider.state, EXTERNAL_STATE.DISABLED);
  assert.equal(provider.handleNLU({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }), null);
  assert.equal(DISABLED_EXTERNAL_ERROR, "Cannot read property 'external' of null");
  assert.throws(
    () => parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }),
    error => error.message === DISABLED_EXTERNAL_ERROR,
  );
  // Empty text returns before the external attachment (ParseRequestHandler.ts:45-49).
  assert.deepEqual(
    parseRequest({ text: '   ', rules: ['launch'], external: {} }),
    { rules: [], intent: null, entities: null },
  );
});

test('a replaceable provider preserves the archived external result structure', () => {
  const result = parseRequest(
    { text: 'five minutes', rules: ['clock/timer_set_value'], external: ext.request.external },
    { externalProvider: recordedProvider() },
  );
  assert.equal(result.intent, 'timerValue');
  assert.deepEqual(result.entities, { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' });
  // DialogflowClient.ts:50-55 — the default agent result plus the external map.
  assert.deepEqual(result.external, expectedExternal);
  // The successful agents carry { rules, intent, entities } (DialogflowClient.ts:100-104).
  assert.deepEqual(result.external.agent_one, { rules: ['launch'], intent: 'doesJiboLikeThing', entities: { GeneralLikes: 'Penguin' } });
  assert.deepEqual(result.external.agent_two, { rules: ['globals/mim_repeat'], intent: 'repeat', entities: { domain: 'mim_global' } });
  // A failed agent access records the error and empty intent/entities (DialogflowClient.ts:68-75).
  assert.deepEqual(result.external.agent_missing, {
    rules: ['clock/timer_set_value'], intent: '', entities: {},
    error: 'External agent unavailable',
  });
});

test('an enabled provider emits the default-agent + external envelope itself', () => {
  const provider = recordedProvider();
  assert.equal(provider.state, EXTERNAL_STATE.READY);
  const envelope = provider.handleNLU(ext.request);
  assert.deepEqual(envelope, {
    rules: ['launch'],
    intent: 'doesJiboLikeThing',
    entities: { GeneralLikes: 'Penguin' },
    external: expectedExternal,
  });
  // Without external agents the envelope is the default agent only (DialogflowClient.ts:52-54).
  const bare = provider.handleNLU({ text: 'do you like penguins', rules: ['launch'] });
  assert.deepEqual(bare, { rules: ['launch'], intent: 'doesJiboLikeThing', entities: { GeneralLikes: 'Penguin' } });
  assert.equal('external' in bare, false);
});

test('no external key is added when the request carries no agents', () => {
  const result = parseRequest(
    { text: 'five minutes', rules: ['clock/timer_set_value'] },
    { externalProvider: recordedProvider() },
  );
  assert.equal(result.intent, 'timerValue');
  assert.equal('external' in result, false);
});

test('a provider whose default agent is unavailable falls back to the null boundary', () => {
  const broken = createExternalAgentProvider({ enabled: true, agents: {} });
  // The source's dialogflowPromise rejects for a failed default agent
  // (DialogflowClient.ts:106-108) and the handler's .catch turns it into null
  // (ParseRequestHandler.ts:59-63), so the disabled boundary still applies.
  assert.throws(
    () => attachExternalResult({ text: 'x', rules: [], external: {} }, { intent: 'a', entities: {}, rules: [] }, broken),
    error => error.message === DISABLED_EXTERNAL_ERROR,
  );
  assert.throws(() => broken.handleNLU({ text: 'x', rules: [] }));
});

test('DECOY_INTENT is the archived decoyIntent name', () => {
  const catalog = JSON.parse(readFileSync(new URL('./fixtures/dialogflow-agent-catalog.json', import.meta.url)));
  assert.equal(DECOY_INTENT, 'decoyIntent');
  assert.ok(catalog.intents.some(i => i.intent === DECOY_INTENT));
});

// N-07-D2 — the union of the two source revisions is explicit and selectable.
test('the external-agent attachment revision is pinned to 5c0a739 and selectable', () => {
  assert.equal(EXTERNAL_ATTACHMENT_REVISION.ATTACH, 'attach');
  assert.equal(EXTERNAL_ATTACHMENT_REVISION.OMIT, 'omit');
  assert.equal(DEFAULT_EXTERNAL_ATTACHMENT_REVISION, EXTERNAL_ATTACHMENT_REVISION.ATTACH);
  assert.equal(resolveExternalAttachmentRevision(undefined), 'attach');
  assert.equal(resolveExternalAttachmentRevision(null), 'attach');
  assert.equal(resolveExternalAttachmentRevision('omit'), 'omit');
  assert.throws(() => resolveExternalAttachmentRevision('attach-external'), /Unsupported external-agent attachment revision/);
});

test('OMIT reproduces the 715e0dd0 handler, whose getNLUResult has no external block', () => {
  const result = () => ({ rules: ['clock/timer_set_value'], intent: 'timerValue', entities: { minutes: '5' } });

  // Disabled provider: ATTACH throws the archived Node 8 boundary; OMIT does not.
  const disabled = createDisabledExternalAgentProvider();
  assert.throws(
    () => attachExternalResult({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }, result(), disabled),
    error => error.message === DISABLED_EXTERNAL_ERROR,
  );
  const omitted = attachExternalResult(
    { text: 'five minutes', rules: ['clock/timer_set_value'], external: {} },
    result(), disabled, EXTERNAL_ATTACHMENT_REVISION.OMIT,
  );
  assert.deepEqual(omitted, result());
  assert.equal('external' in omitted, false);

  // Ready provider: ATTACH attaches the archived map; OMIT returns the result untouched.
  const provider = createExternalAgentProvider({
    enabled: true,
    accessToken: 't',
    agents: {
      default: () => ({ intent: 'doesJiboLikeThing', entities: { GeneralLikes: 'Penguin' } }),
      agent_one: () => ({ intent: 'doesJiboLikeThing', entities: { GeneralLikes: 'Penguin' } }),
    },
  });
  const attached = attachExternalResult(
    { text: 'do you like penguins', rules: ['launch'], external: { agent_one: { rules: ['launch'] } } },
    { rules: ['launch'], intent: 'doesJiboLikeThing', entities: {} }, provider,
  );
  assert.deepEqual(attached.external, {
    agent_one: { rules: ['launch'], intent: 'doesJiboLikeThing', entities: { GeneralLikes: 'Penguin' } },
  });
  const notAttached = attachExternalResult(
    { text: 'do you like penguins', rules: ['launch'], external: { agent_one: { rules: ['launch'] } } },
    { rules: ['launch'], intent: 'doesJiboLikeThing', entities: {} }, provider, EXTERNAL_ATTACHMENT_REVISION.OMIT,
  );
  assert.equal('external' in notAttached, false);
});

test('parseRequest selects the attachment revision per request', () => {
  // Default (ATTACH): the disabled provider reproduces the boundary.
  assert.throws(
    () => parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'], external: {} }),
    error => error.message === DISABLED_EXTERNAL_ERROR,
  );
  // OMIT: the external request is inert and the selected result is returned.
  const omitted = parseRequest(
    { text: 'five minutes', rules: ['clock/timer_set_value'], external: {} },
    { externalAttachmentRevision: EXTERNAL_ATTACHMENT_REVISION.OMIT },
  );
  assert.deepEqual(omitted, { rules: ['clock/timer_set_value'], intent: 'timerValue', entities: { hours: 'null', minutes: '5', seconds: 'null', domain: 'timer' } });
  assert.equal('external' in omitted, false);
  // An unknown revision is rejected before any selection.
  assert.throws(
    () => parseRequest({ text: 'five minutes', rules: ['clock/timer_set_value'] }, { externalAttachmentRevision: 'nope' }),
    /Unsupported external-agent attachment revision/,
  );
});

// Synthetic resolvers; SECRET_SENTINEL stands in for provider-internal detail.
const SECRET_SENTINEL = 'SECRET_SENTINEL';

async function unhandledRejectionsDuring(fn) {
  const seen = [];
  const listener = reason => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    fn();
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

test('a failing agent records a generic error without provider or agent detail', async () => {
  assert.equal(EXTERNAL_AGENT_ERROR, 'External agent unavailable');
  const provider = createExternalAgentProvider({
    enabled: true,
    agents: {
      default: () => ({ intent: 'ok', entities: {} }),
      throws: () => { throw new Error(SECRET_SENTINEL); },
      rejects: () => Promise.reject(new Error(SECRET_SENTINEL)),
      array: () => [{ intent: SECRET_SENTINEL }],
    },
  });
  const request = {
    text: 'synthetic', rules: ['launch'],
    external: { throws: { rules: ['launch'] }, rejects: { rules: ['launch'] }, array: { rules: ['launch'] }, nullAgent: null },
  };
  let result;
  const unhandled = await unhandledRejectionsDuring(() => {
    result = attachExternalResult(request, { intent: 'ok', entities: {}, rules: ['launch'] }, provider);
  });
  assert.deepEqual(unhandled, []);
  for (const name of ['throws', 'rejects', 'array']) {
    assert.deepEqual(result.external[name], { rules: ['launch'], intent: '', entities: {}, error: EXTERNAL_AGENT_ERROR }, name);
  }
  // A null agent entry is a failed agent, not a TypeError for the whole parse.
  assert.deepEqual(result.external.nullAgent, { rules: undefined, intent: '', entities: {}, error: EXTERNAL_AGENT_ERROR });
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false);
});

test('an async provider on the synchronous path fails loudly without an unhandled rejection', async () => {
  const asyncProvider = { handleNLU: () => Promise.reject(new Error(SECRET_SENTINEL)) };
  let thrown;
  const unhandled = await unhandledRejectionsDuring(() => {
    try {
      attachExternalResult({ text: 'synthetic', rules: [], external: {} }, { intent: 'ok', entities: {}, rules: [] }, asyncProvider);
    } catch (error) { thrown = error; }
  });
  assert.equal(thrown?.message, ASYNC_PROVIDER_ERROR);
  assert.deepEqual(unhandled, []);
});

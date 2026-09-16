// X-01 answer-half behavioural differential.
//
// The NLU half of X-01 is verified elsewhere (q01*.test.js).  This file is the
// answer half: it measures BEHAVIOUR of the recovered GQA answer pipeline
// (jiborobot/srv-gqa-ws@ebe1a7d3, exported here through
// createGqaProviderPipeline / createGqaAnswerSkill), not answer text.
//
// Answer-text identity is deliberately NOT asserted anywhere in this file.
// Wikipedia is a live service whose content changes, and the owner's narrowed
// X-01 spec only asks that the answer generally be proper for general
// questions in the same way it was before.  What is verifiable offline is the
// provider plan (group order and deadlines), the output limits, the fallback
// text, the response normalizations, and that the whole pipeline still answers
// inside the gateway's skill budget.
//
// No test in this file uses the network.  The pipeline is driven through its
// provider adapter seams (createGqaProviderPipeline with local functions) and
// the answer handler through its provider seam (createGqaAnswerSkill), exactly
// as the existing gqa*.test.js files inject fetchImpl/provider seams.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeouts } from '@phoenix/contracts';
import {
  createGqaAnswerSkill,
  createGqaProviderPipeline,
} from '../src/gqaAnswerSkill.js';
import {
  GQA_MULTI_PROVIDER_TIMEOUTS,
  readGqaMultiProviderProfileConfig,
} from '../src/gqaMultiProviderService.js';
import { gqaBannedWordPresent } from '../src/gqaBannedWords.js';
import { firstSentence } from '../src/gqaWikipediaProvider.js';
import {
  createDuckDuckGoProvider,
  extractDuckDuckGoAnswer,
} from '../src/gqaDuckDuckGoProvider.js';
import { start } from '../src/index.js';

function sourceRequest({ text = 'what is a fixture fact', intent = 'generalWhatQuestions' } = {}) {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'x01-answer-request',
    ts: 1700000000000,
    data: {
      general: {
        accountID: 'fixture-account',
        robotID: 'fixture-robot',
        lang: 'en',
        remoteAddress: '127.0.0.1',
      },
      runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
      skill: null,
      result: { nlu: { intent, entities: {} }, asr: { text, confidence: 1 } },
    },
  };
}

function providerMap({ bing, wikipedia, wolfram }) {
  return { Bing: bing, Wikipedia: wikipedia, 'Wolfram Alpha': wolfram };
}

function answer(source, payload) {
  return async () => ({ source, response: { type: 'string', payload } });
}

function hang() {
  return new Promise(() => {});
}

function actionText(body) {
  return body.data.action.config.jcp.config.play.esml;
}

function promptId(body) {
  return body.data.action.config.jcp.config.play.meta.prompt_id;
}

// 1. Provider ordering and deadlines -----------------------------------------

test('X-01 answer: GQA_MULTI_PROVIDER_TIMEOUTS is the recovered 3000 ms / 4000 ms group deadline constant', () => {
  assert.deepEqual(GQA_MULTI_PROVIDER_TIMEOUTS, [3000, 4000]);
  assert.deepEqual(readGqaMultiProviderProfileConfig({}).timeouts, [3000, 4000]);
});

test('X-01 answer: the first group starts Bing and Wikipedia together and a slow first group yields to Wolfram at its own deadline', async () => {
  // Both first-group adapters hang; only the group deadline can unblock the
  // pipeline.  That is when the second group (Wolfram Alpha) gets started.
  const calls = [];
  const started = Date.now();
  const pipeline = createGqaProviderPipeline({
    providers: providerMap({
      bing: async () => { calls.push('Bing'); return hang(); },
      wikipedia: async () => { calls.push('Wikipedia'); return hang(); },
      wolfram: async () => {
        calls.push('Wolfram');
        return { source: 'Wolfram Alpha', response: { type: 'string', payload: 'the wolfram fixture answer' } };
      },
    }),
    // Compressed deadlines: the mechanism under test is identical to the
    // GQA_MULTI_PROVIDER_TIMEOUTS defaults, only faster to run.
    timeouts: [40, 60],
  });
  const output = await pipeline({});
  const elapsed = Date.now() - started;

  assert.deepEqual(calls, ['Bing', 'Wikipedia', 'Wolfram']);
  assert.equal(output.source, 'Wolfram Alpha');
  assert.ok(elapsed >= 40, `Wolfram must not start before the ${40}ms first-group deadline (elapsed ${elapsed}ms)`);
  assert.ok(Number.isFinite(output.timestamps.services_timedout), 'group timeout must be recorded');
  assert.ok(Number.isFinite(output.timestamps.timeout_timedout), 'group timeout must be recorded');
});

test('X-01 answer: a first-group answer means Wolfram Alpha is never started', async () => {
  const calls = [];
  const started = Date.now();
  const pipeline = createGqaProviderPipeline({
    providers: providerMap({
      bing: async () => {
        calls.push('Bing');
        return { source: 'Bing', response: { type: 'string', payload: 'the bing fixture answer' } };
      },
      wikipedia: async () => {
        calls.push('Wikipedia');
        // Slow enough that staying on the second group would be observable.
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {};
      },
      wolfram: async () => {
        calls.push('Wolfram');
        return { source: 'Wolfram Alpha', response: { type: 'string', payload: 'never reached' } };
      },
    }),
    timeouts: [30, 30],
  });
  const output = await pipeline({});
  const elapsed = Date.now() - started;

  assert.equal(output.source, 'Bing');
  assert.deepEqual(calls, ['Bing', 'Wikipedia']);
  assert.ok(elapsed < 30, `a ready first-group answer returns before the ${30}ms first-group deadline (elapsed ${elapsed}ms)`);
});

// 2. Output limits -----------------------------------------------------------

test('X-01 answer: the GQA path limits its longest text at the source (Wikipedia first sentence) and does not apply the ordinary 600-char answer cap', async () => {
  // Wikipedia is the GQA source that can return arbitrarily long text.  The
  // documented answer half limit is "no more than a sentence or so at a time"
  // (source gqa.py make_response_for_hub), which the provider enforces by
  // extracting only the first sentence of the extract.
  const extract = 'Augusta Ada King, Countess of Lovelace, was an English mathematician and writer. '
    + 'She was the only legitimate child of the poet Lord Byron. '
    + 'She worked on Charles Babbage\'s proposed mechanical general-purpose computer.';
  assert.equal(
    firstSentence(extract),
    'Augusta Ada King, Countess of Lovelace, was an English mathematician and writer.',
  );

  // The ordinary Phoenix answer-skill cap, MAX_ANSWER_CHARS = 600 at
  // answerSkill.js:11, belongs to the LLM path and is NOT applied by the GQA
  // handler: a provider payload is spoken whole (only a terminating period is
  // added, gqaAnswerSkill.js:641-649).  This test documents that boundary.
  const long = 'A'.repeat(5000);
  const handler = createGqaAnswerSkill({ rng: () => 0, provider: answer('Wikipedia', long) });
  const out = await handler(sourceRequest());
  assert.equal(actionText(out), `${long}.`);
  assert.ok(actionText(out).length > 5000);
});

// 3. Fallback text ------------------------------------------------------------

test('X-01 answer: when no provider answers the caller gets the honest no-answer MIM, with an exact deterministic string', async () => {
  const handler = createGqaAnswerSkill({
    rng: () => 0,
    provider: async () => ({}),
  });
  const out = await handler(sourceRequest());

  // rng()=0 selects the question-type branch and the first prompt of
  // GQA_no_answer_what, so the spoken string is deterministic.
  assert.equal(actionText(out), "I can't seem to find what this is. Sorry.");
  assert.equal(promptId(out), 'GQA_no_answer_what_01');
  assert.deepEqual(out.data.analytics.answer[1].properties, { success: false });
  assert.equal(out.data.action.config.jcp.config.display.type, 'DISPLAY');
  assert.equal(out.data.final, true);
  assert.equal(out.data.fireAndForget, true);
});

// 4. Response normalization ----------------------------------------------------

test('X-01 answer: provider text is terminated with exactly one period before speaking', async () => {
  const handler = createGqaAnswerSkill({
    rng: () => 0,
    provider: answer('Wikipedia', 'fixture fact is Ada Lovelace'),
  });
  const out = await handler(sourceRequest());
  assert.equal(actionText(out), 'fixture fact is Ada Lovelace.');

  const alreadyTerminated = createGqaAnswerSkill({
    rng: () => 0,
    provider: answer('Wikipedia', 'Already a sentence.'),
  });
  const second = await alreadyTerminated(sourceRequest());
  assert.equal(actionText(second), 'Already a sentence.');
});

test('X-01 answer: a banned-word query is normalized to the banned-word MIM and no provider is consulted', async () => {
  assert.equal(gqaBannedWordPresent('what is fuck'), true);
  let calls = 0;
  const handler = createGqaAnswerSkill({
    rng: () => 0,
    provider: async () => { calls += 1; return {}; },
  });
  const out = await handler(sourceRequest({ text: 'what is fuck' }));
  assert.equal(calls, 0);
  assert.equal(promptId(out), 'GQA_banned_word_01');
  assert.match(actionText(out), /bad word/);
  assert.deepEqual(out.data.analytics.answer[1].properties, { success: false });
});

test('X-01 answer: the Unidecode-backed unhelpful-prefix filter rejects boilerplate answers before they are spoken', async () => {
  // gqaUnidecodeFilter.js feeds gqa/bing.py's unidecode predicate: a spoken
  // answer that is empty or starts with one of the fixed unhelpful prefixes
  // after unidecode() must be treated as no answer, never read aloud.
  assert.deepEqual(extractDuckDuckGoAnswer({
    Type: 'A',
    AbstractText: 'Here is what I found online.',
  }), {});
  assert.deepEqual(extractDuckDuckGoAnswer({
    Type: 'A',
    AbstractText: 'Augusta Ada King, Countess of Lovelace, was an English mathematician.',
  }).response.payload, 'Augusta Ada King, Countess of Lovelace, was an English mathematician.');

  // End to end through the provider's fetchImpl seam: an unhelpful answer is
  // never emitted as payload, and the answer handler therefore speaks the
  // no-answer fallback instead of the boilerplate.
  const provider = createDuckDuckGoProvider({
    endpoint: 'http://fixture.invalid/',
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ Type: 'A', AbstractText: 'Here is what I found for you.' }),
    }),
    clock: () => 1000,
  });
  const output = await provider({ queryText: 'what is a fixture fact' });
  assert.equal(output.response, undefined);
  const handler = createGqaAnswerSkill({
    rng: () => 0,
    provider: async () => output,
  });
  const out = await handler(sourceRequest());
  assert.equal(actionText(out), "I can't seem to find what this is. Sorry.");
});

// 5. Skill budget ----------------------------------------------------------------

test('X-01 answer: the recovered pipeline finishes inside the gateway skill budget even when every provider accepts and never answers', async () => {
  // By construction: the two group deadlines are 3000 ms + 4000 ms and the
  // pipeline only ever waits on those deadlines, so the worst case fits the
  // 10000 ms gateway budget with 3000 ms to spare.
  assert.ok(
    GQA_MULTI_PROVIDER_TIMEOUTS[0] + GQA_MULTI_PROVIDER_TIMEOUTS[1] < Timeouts.skill,
    `GQA worst case ${GQA_MULTI_PROVIDER_TIMEOUTS[0] + GQA_MULTI_PROVIDER_TIMEOUTS[1]}ms must be under the skill budget ${Timeouts.skill}ms`,
  );

  // The behavioural half: a backend that accepts the request and never answers
  // must still produce spoken output in time — the shape of the failure that
  // matters, since a refused connection fails fast on its own.  Compressed
  // deadlines prove the deadline mechanism yields output; the constants above
  // prove the real configuration fits the budget.
  const never = async () => hang();
  const pipeline = createGqaProviderPipeline({
    providers: providerMap({ bing: never, wikipedia: never, wolfram: never }),
    timeouts: [1000, 1000],
  });
  const handler = createGqaAnswerSkill({ rng: () => 0, provider: pipeline });
  const started = Date.now();
  const out = await handler(sourceRequest());
  const elapsed = Date.now() - started;

  assert.ok(elapsed < Timeouts.skill, `took ${elapsed}ms, over the ${Timeouts.skill}ms skill budget`);
  assert.ok(elapsed >= 1900, `both group deadlines must fire before output is produced (elapsed ${elapsed}ms)`);
  assert.equal(actionText(out), "I can't seem to find what this is. Sorry.");
});
// 6. Profile separation (X-01 acceptance criterion 2) -------------------------
//
// Criterion 2 asks that the recovered profile's configuration stay separate
// from original Pegasus and that nothing implicitly remaps the original
// profile.  The pre-existing assertion for this
// (q01GqaProfile.test.js:411) only checks that a listener came up on a port,
// which cannot fail for the reason it names.  These two tests instead observe
// WHICH handler the shared skills host actually mounted, through wire
// behaviour that the two handlers do not share.
//
// Discriminators, neither of which touches the network:
//   * the recovered GQA route validates the source request envelope and
//     answers a body with no `type` with the source 500 shape
//     (gqaAnswerSkill.js validateGqaRequestEnvelope), and answers a request
//     with no robot IP with the GQA_error MIM;
//   * the ordinary Pegasus answer-skill port has neither check and, with no
//     LLM configured, speaks its honest placeholder.

async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jibo-transid': 'x01-separation' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function withHost(options, run) {
  const server = await start(0, options);
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('X-01 separation: the shared host mounts the recovered GQA handler by default, not the ordinary answer-skill port', async () => {
  // An environment with no GQA selectors at all: this is what the robot
  // launcher produces (it blanks PHOENIX_GQA_PROFILE and
  // PHOENIX_GQA_DEFAULT_PROFILE rather than setting them).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('ETCO_gqa_')),
  );
  env.PHOENIX_GQA_PROFILE = '';
  env.PHOENIX_GQA_DEFAULT_PROFILE = '';

  await withHost({ gqaProfile: '', gqaDefaultProfile: '', gqaEnvironment: env }, async (port) => {
    // Source envelope validation belongs only to the recovered GQA route.
    const malformed = await postJson(port, '/v1/answer-skill/main', { data: {} });
    assert.equal(malformed.body.message, 'Missing GQA request field type');

    // The robot-IP gate likewise belongs only to the recovered route.  Passing
    // a valid envelope without general.remoteAddress must select GQA_error,
    // which the ordinary handler has no concept of.
    const request = sourceRequest();
    delete request.data.general.remoteAddress;
    const noIp = await postJson(port, '/v1/answer-skill/main', request);
    // The MIM file supplies numbered variants (GQA_error_07, _08, ...); the
    // family is what identifies the branch.
    assert.match(promptId(noIp.body), /^GQA_error(_\d+)?$/);

    // And the ordinary handler's placeholder must never be spoken here.
    assert.ok(!String(actionText(noIp.body)).includes("don't have an answer source"));
  });
});

test('X-01 separation: PHOENIX_GQA_DEFAULT_PROFILE=phoenix-answer selects the original Pegasus port, which never reaches a GQA provider', async () => {
  // answerSkill resolves its LLM endpoint from the ambient process env at call
  // time (resolveLlmProvider reads ETCO_answer_llm* then PHOENIX_LLM_*), not
  // from an injected environment, so a developer machine with a configured
  // model would otherwise make this test both slow and machine-dependent.
  // Clear only those names, and restore them.
  const llmNames = Object.keys(process.env)
    .filter((name) => name.startsWith('PHOENIX_LLM_') || name.startsWith('ETCO_answer_llm')
      || name === 'OPENROUTER_API_KEY');
  const saved = llmNames.map((name) => [name, process.env[name]]);
  for (const name of llmNames) delete process.env[name];

  try {
    await withHost({ gqaProfile: '', gqaDefaultProfile: 'phoenix-answer' }, async (port) => {
      // The ordinary route has no source envelope validation: a body with no
      // `type` is accepted rather than rejected the way the GQA route rejects
      // it.  This is the discriminator that cannot be satisfied by both.
      const malformed = await postJson(port, '/v1/answer-skill/main', { data: {} });
      assert.notEqual(malformed.body.message, 'Missing GQA request field type');

      // Shape: the ordinary port speaks through an AnswerReply SEQUENCE; the
      // recovered GQA route speaks a bare SLIM carrying a prompt_id.
      const out = await postJson(port, '/v1/answer-skill/main', sourceRequest());
      assert.equal(out.body.data.action.config.jcp.type, 'SEQUENCE');
      const play = out.body.data.action.config.jcp.children[0].config.play;
      assert.equal(play.meta.mim_id, 'AnswerReply');
      assert.equal(play.meta.prompt_id, undefined);
      assert.equal(
        play.esml,
        "You asked about what is a fixture fact. I don't have an answer source connected yet.",
      );
    });
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});

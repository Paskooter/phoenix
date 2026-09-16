import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BING_UNHELPFUL_SPOKEN_TEXT,
} from '../src/gqaBingProvider.js';
import {
  createDuckDuckGoProvider,
  duckDuckGoProviderContract,
  DUCKDUCKGO_SOURCE_API,
  DUCKDUCKGO_SOURCE_PARAMS,
  extractDuckDuckGoAnswer,
} from '../src/gqaDuckDuckGoProvider.js';
import { createGqaMultiProviderProfile } from '../src/gqaMultiProviderService.js';

function fetchWith(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (typeof body === 'function') return body(url, options);
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
}

function tickingClock(start = 1000) {
  let tick = start;
  return () => tick++;
}

function noAnswerOutput() {
  return {
    source: 'DuckDuckGo',
    timestamps: { duckduckgo_request: 1000, duckduckgo_response: 1001 },
  };
}

test('DuckDuckGo exports identify the provider contract and API defaults', () => {
  assert.equal(DUCKDUCKGO_SOURCE_API, 'https://api.duckduckgo.com/');
  assert.deepEqual(DUCKDUCKGO_SOURCE_PARAMS, [
    ['format', 'json'],
    ['no_html', '1'],
    ['skip_disambig', '1'],
  ]);
  assert.equal(duckDuckGoProviderContract.source, 'DuckDuckGo');
  assert.ok(duckDuckGoProviderContract.request.includes('q'));
});

test('DuckDuckGo sends the Instant Answer GET request against the configured endpoint', async () => {
  const { fetchImpl, calls } = fetchWith({});
  const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
  const output = await provider({ queryText: 'who is ada lovelace', countryCode: 'US' });
  assert.deepEqual(output, noAnswerOutput());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  const requestUrl = calls[0].url;
  assert.ok(requestUrl instanceof URL || typeof requestUrl === 'object');
  const url = new URL(String(requestUrl));
  assert.equal(url.pathname, '/');
  assert.deepEqual([...url.searchParams.entries()], [
    ['q', 'who is ada lovelace'],
    ['format', 'json'],
    ['no_html', '1'],
    ['skip_disambig', '1'],
  ]);
});

test('DuckDuckGo returns an entity answer from AbstractText as spokenText', async () => {
  const body = {
    Type: 'A',
    Heading: 'Ada Lovelace',
    AbstractSource: 'Wikipedia',
    AbstractURL: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    AbstractText: 'Augusta Ada King, Countess of Lovelace, was an English mathematician.',
    Image: 'https://upload.wikimedia.org/fixture/ada.jpg',
    Infobox: { content: 'fixture infobox' },
  };
  const { fetchImpl } = fetchWith(body);
  const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
  const output = await provider({ queryText: 'who is ada lovelace' });
  assert.equal(output.source, 'DuckDuckGo');
  assert.deepEqual(output.response, { type: 'string', payload: body.AbstractText });
  assert.equal(output.type, 'entities');
  assert.equal(output.message, undefined);
  assert.deepEqual(output.timestamps, { duckduckgo_request: 1000, duckduckgo_response: 1001 });
});

test('DuckDuckGo derives Entities from a present Infobox without a Type A article', async () => {
  const body = {
    Type: 'N',
    AbstractText: 'Ohio is a state in the Midwestern United States.',
    Infobox: { content: 'fixture infobox' },
  };
  assert.deepEqual(extractDuckDuckGoAnswer(body), {
    response: { type: 'string', payload: body.AbstractText },
    type: 'entities',
  });
});

test('DuckDuckGo returns a calc answer as a Computation', async () => {
  const body = { Type: 'E', AnswerType: 'calc', Answer: '4' };
  const { fetchImpl } = fetchWith(body);
  const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
  const output = await provider({ queryText: '2+2' });
  assert.deepEqual(output.response, { type: 'string', payload: '4' });
  assert.equal(output.type, 'computation');
});

test('DuckDuckGo maps recognizable chatter answer types onto Facts', () => {
  assert.deepEqual(extractDuckDuckGoAnswer({ AnswerType: 'color', Answer: '#8B008B' }), {
    response: { type: 'string', payload: '#8B008B' },
    type: 'facts',
  });
  assert.deepEqual(extractDuckDuckGoAnswer({ AnswerType: 'zip', Answer: '02139' }), {
    response: { type: 'string', payload: '02139' },
    type: 'facts',
  });
});

test('DuckDuckGo reports an all-empty response as no answer and never as an error', async () => {
  for (const body of [
    {},
    { Type: 'N', Heading: 'no result', Answer: '', AbstractText: '' },
    { Type: '', AnswerType: '', Answer: undefined, AbstractText: undefined },
  ]) {
    const { fetchImpl } = fetchWith(body);
    const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
    const output = await provider({ queryText: 'how tall is mount everest', countryCode: 'US' });
    assert.deepEqual(output, noAnswerOutput(), JSON.stringify(body));
    assert.equal(output.response, undefined, JSON.stringify(body));
    assert.equal(output.message, undefined, JSON.stringify(body));
  }
});

test('DuckDuckGo treats an unrecognized answer type as NOT whitelisted', async () => {
  const body = { AnswerType: 'madeup', Answer: 'a future answer type' };
  assert.deepEqual(extractDuckDuckGoAnswer(body), {});
});

test('DuckDuckGo rejects the shared unhelpful boilerplate openers', async () => {
  for (const prefix of BING_UNHELPFUL_SPOKEN_TEXT) {
    const body = { AnswerType: 'calc', Answer: `${prefix}'s fixture text.` };
    assert.deepEqual(extractDuckDuckGoAnswer(body), {}, `prefix ${prefix}`);
  }
  const article = { Type: 'A', AbstractText: 'Here is what I found for you.' };
  assert.deepEqual(extractDuckDuckGoAnswer(article), {});
});

test('DuckDuckGo explicit guard refuses a web-page-ish payload', async () => {
  const topLevel = {
    Type: 'A',
    AbstractText: 'A plain web result that must never be spoken.',
    Images: [{ title: 'leaked image result' }],
  };
  assert.deepEqual(extractDuckDuckGoAnswer(topLevel), {});
  const blacklistedType = { AnswerType: 'WebPages', Answer: 'a leaked web result' };
  assert.deepEqual(extractDuckDuckGoAnswer(blacklistedType), {});

  const { fetchImpl } = fetchWith(topLevel);
  const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
  const output = await provider({ queryText: 'what is web' });
  assert.deepEqual(output, noAnswerOutput());
  assert.equal(output.message, undefined);
});

test('DuckDuckGo surfaces url and image_url when present', async () => {
  const body = {
    Type: 'A',
    AbstractText: 'A fact about Ada Lovelace.',
    AbstractURL: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    Image: 'https://upload.wikimedia.org/fixture/ada.jpg',
  };
  const { fetchImpl } = fetchWith(body);
  const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
  const output = await provider({ queryText: 'who is ada lovelace' });
  assert.equal(output.url, body.AbstractURL);
  assert.equal(output.image_url, body.Image);

  const without = extractDuckDuckGoAnswer({ Type: 'A', AbstractText: 'A fact.' });
  assert.equal(without.url, undefined);
  assert.equal(without.image_url, undefined);
});

test('DuckDuckGo never throws on a malformed payload', async () => {
  const malformedBodies = [
    [1, 2, 3],
    null,
    'not an object',
    42,
    { Type: 'A', Answer: { nested: { value: 'not speech' } }, AbstractText: 'Fallback text works.' },
  ];
  for (const body of malformedBodies) {
    const { fetchImpl } = fetchWith(body);
    const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock() });
    const output = await provider({ queryText: 'what is malformed' });
    assert.equal(output.message, undefined, JSON.stringify(body));
    if (Array.isArray(body)) {
      assert.deepEqual(output, noAnswerOutput(), JSON.stringify(body));
    }
  }
  const nestedAnswer = extractDuckDuckGoAnswer({ Type: 'A', Answer: { nested: true }, AbstractText: 'Fallback text works.' });
  assert.deepEqual(nestedAnswer.response, { type: 'string', payload: 'Fallback text works.' });
});

test('DuckDuckGo maps transport failures to a timestamped provider message', async () => {
  const { fetchImpl } = fetchWith({ error: 'upstream unavailable' }, { status: 503 });
  const provider = createDuckDuckGoProvider({ endpoint: 'http://fixture.invalid/', fetchImpl, clock: tickingClock(50) });
  const output = await provider({ queryText: 'what is unavailable', countryCode: 'US' });
  assert.equal(output.source, 'DuckDuckGo');
  assert.deepEqual(Object.keys(output.timestamps), ['duckduckgo_request', 'duckduckgo_response']);
  assert.equal(output.response, undefined);
  assert.match(output.message, /^Unexpected exception: Error: HTTP 503$/);
});

test('DuckDuckGo honors an adapter timeout through the caller AbortSignal', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('DuckDuckGo request timed out')));
  });
  const provider = createDuckDuckGoProvider({
    endpoint: 'http://fixture.invalid/',
    fetchImpl,
    timeoutMs: 15,
    clock: tickingClock(70),
  });
  const output = await provider({ queryText: 'what is late' });
  assert.equal(output.source, 'DuckDuckGo');
  assert.match(output.message, /^Unexpected exception: Error: DuckDuckGo request timed out$/);
});

test('DuckDuckGo provider fills the multi-provider Bing slot when no Bing endpoint is configured', async () => {
  const answerBody = {
    Type: 'A',
    AbstractText: 'The DuckDuckGo fixture answer.',
    AbstractURL: 'https://fixture.invalid/article',
  };
  const { fetchImpl: duckDuckGoFetch } = fetchWith(answerBody);
  const neverCalled = async () => {
    throw new Error('Wikipedia/Wolfram must not run when DuckDuckGo answers');
  };
  const profile = createGqaMultiProviderProfile({
    bing: { fetchImpl: duckDuckGoFetch },
    wikipedia: { endpoint: 'http://fixture.invalid/wiki', fetchImpl: neverCalled },
    wolfram: { endpoint: 'http://fixture.invalid/wolfram', apiKey: 'fixture-wolfram-key', fetchImpl: neverCalled },
    random: () => 0,
  });
  const body = await profile.handler({
    type: 'LISTEN_LAUNCH',
    data: {
      general: { accountID: 'fixture-account', robotID: 'fixture-robot', remoteAddress: '127.0.0.1' },
      runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
      skill: { id: 'answer', session: null },
      result: {
        nlu: { intent: 'generalWhatQuestions', entities: {} },
        asr: { text: 'who is ada lovelace', confidence: 1 },
      },
    },
  });
  assert.equal(body.type, 'SKILL_ACTION');
  assert.equal(body.data.action.config.jcp.config.play.esml, 'The DuckDuckGo fixture answer.');
  assert.deepEqual(body.data.analytics.answer[1].properties, {
    success: true,
    type: 'duckduckgo',
    category: 'entities',
  });
});

test('DuckDuckGo provider factory validates its injectable seams', () => {
  assert.throws(() => createDuckDuckGoProvider({ fetchImpl: 'not a function' }), /DuckDuckGo fetchImpl must be a function/);
  assert.throws(() => createDuckDuckGoProvider({ clock: 'not a function' }), /DuckDuckGo clock must be a function/);
  assert.throws(() => createDuckDuckGoProvider({ headers: [] }), /DuckDuckGo headers must be a mapping/);
});
// Speakable length at the provider edge ---------------------------------------
//
// Found live on Moth, 2026-09-16: "who is ada lovelace" produced a correct GQA
// answer that the robot never said. jibo-tts-service logged
//   "The input prompt is too long and is more than 500 characters in length"
// and spoke nothing at all — the whole DuckDuckGo Abstract had been handed to
// it. Wikipedia's adapter already speaks only the first sentence (GQA's
// documented "no more than a sentence or so at a time"); the Bing slot has to
// apply the same rule to the same kind of prose, or the slot is not
// interchangeable and the robot goes silent.

const ADA_ABSTRACT = 'Augusta Ada King, Countess of Lovelace, also known as Ada Lovelace, '
  + 'was an English mathematician and writer chiefly known for work on Charles Babbage’s '
  + 'proposed mechanical general-purpose computer, the analytical engine. She was the first to '
  + 'recognise the machine had applications beyond pure calculation. Lovelace is often considered '
  + 'the first computer programmer. Lovelace was the only legitimate child of poet Lord Byron and '
  + 'reformer Anne Isabella Milbanke. Lord Byron separated from his wife a month after Ada was '
  + 'born, and died when she was eight.';

test('DuckDuckGo speaks only the first sentence of an Abstract, as the Wikipedia adapter does', () => {
  assert.ok(ADA_ABSTRACT.length > 500, 'the fixture must be long enough to have been refused by TTS');

  const out = extractDuckDuckGoAnswer({
    Type: 'A',
    AbstractText: ADA_ABSTRACT,
    AbstractURL: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
  });

  const spoken = out.response.payload;
  assert.equal(
    spoken,
    'Augusta Ada King, Countess of Lovelace, also known as Ada Lovelace, was an English '
    + 'mathematician and writer chiefly known for work on Charles Babbage’s proposed '
    + 'mechanical general-purpose computer, the analytical engine.',
  );
  // The robot's own ceiling, stated as the number it is.
  assert.ok(spoken.length <= 500, `spoken text is ${spoken.length} chars; jibo-tts-service refuses over 500`);
  // Trimming the spoken text must not cost the attribution URL.
  assert.equal(out.url, 'https://en.wikipedia.org/wiki/Ada_Lovelace');
});

test('DuckDuckGo leaves a short Answer field alone — only Abstract prose is sentence-bounded', () => {
  // `Answer` is the Instant Answer: a calculation or one-liner, already the
  // length Bing's conversation.spokenText was. Trimming it would be wrong.
  const calc = extractDuckDuckGoAnswer({ AnswerType: 'calc', Answer: '3 pounds = 1.360 kilograms' });
  assert.equal(calc.response.payload, '3 pounds = 1.360 kilograms');

  // A multi-sentence Answer is likewise not a Wikipedia lead and stays whole.
  const multi = extractDuckDuckGoAnswer({ AnswerType: 'calc', Answer: 'Yes. Definitely yes.' });
  assert.equal(multi.response.payload, 'Yes. Definitely yes.');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createGqaProviderPipeline,
  createWikipediaProvider,
  WIKIPEDIA_SOURCE_API,
  WIKIPEDIA_SOURCE_REVISION,
  WIKIPEDIA_SOURCE_USER_AGENT,
} from '../src/index.js';
import {
  firstSentence,
  removeInitialStopWords,
} from '../src/gqaWikipediaProvider.js';

function page({ title, extract, categories = [], pageprops, missing } = {}) {
  const value = { title, extract, categories: categories.map((item) => ({ title: `Category:${item}` })) };
  if (pageprops) value.pageprops = pageprops;
  if (missing !== undefined) value.missing = missing;
  return { query: { pages: { '1': value } } };
}

async function withFixtureServer(handler, callback) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    });
    try {
      await handler(request, response, requests);
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/w/api.php`;
  try {
    return await callback({ endpoint, requests });
  } finally {
    // The cancellation case deliberately leaves a server-side handler asleep;
    // close active sockets before waiting for the listener so the fixture does
    // not hold the test process open for the late body.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(response, status, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
  response.end(raw);
}

test('Q-01 Wikipedia adapter follows source success request and result contract', async () => {
  const clock = (() => { let value = 100; return () => value += 1; })();
  await withFixtureServer((_request, response) => {
    sendJson(response, 200, page({
      title: 'John Henry Brooke',
      categories: ['Members of the Victorian Legislative Assembly'],
      extract: 'John Henry Brooke was a colonial Victorian politician. A second sentence follows.',
    }));
  }, async ({ endpoint, requests }) => {
    const provider = createWikipediaProvider({ endpoint, clock, headers: { 'user-agent': 'q01-fixture' } });
    const output = await provider({ queryText: 'who is John Henry Brooke', questionType: 'who' });
    assert.equal(output.source, 'Wikipedia');
    assert.deepEqual(output.response, {
      type: 'string',
      payload: 'John Henry Brooke was a colonial Victorian politician.',
    });
    assert.equal(output.logs.strict_query, 'John Henry Brooke');
    assert.deepEqual(Object.keys(output.timestamps), [
      'wiki_begin_tokenization', 'wiki_request', 'wiki_response',
    ]);
    assert.equal(requests.length, 1);
    const requestUrl = new URL(requests[0].url, endpoint);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, '/w/api.php?prop=info%7Cpageprops%7Cextracts%7Ccategories&cllimit=max&explaintext=&exintro=&list=allcategories&inprop=url&ppprop=disambiguation&redirects=&titles=John+Henry+Brooke&format=json&action=query');
    assert.equal(requestUrl.searchParams.get('prop'), 'info|pageprops|extracts|categories');
    assert.equal(requestUrl.searchParams.get('ppprop'), 'disambiguation');
    assert.equal(requestUrl.searchParams.get('titles'), 'John Henry Brooke');
    assert.equal(requestUrl.searchParams.get('list'), 'allcategories');
    assert.equal(requestUrl.searchParams.get('format'), 'json');
    assert.equal(requests[0].headers['user-agent'], 'q01-fixture');
  });
});

test('Q-01 Wikipedia question gate prevents a source-disallowed request', async () => {
  await withFixtureServer((_request, response) => {
    sendJson(response, 500, { error: 'must not be requested' });
  }, async ({ endpoint, requests }) => {
    const provider = createWikipediaProvider({ endpoint });
    const output = await provider({ queryText: 'how does a fixture work', questionType: 'how' });
    assert.equal(output.message, 'Blocked by WIKIPEDIA_QUESTION_WORDS restriction.');
    assert.equal(output.response, undefined);
    assert.equal(requests.length, 0);
  });
});

test('Q-01 Wikipedia missing page is a no-result source message', async () => {
  await withFixtureServer((_request, response) => {
    sendJson(response, 200, page({ title: 'Unknown fixture', missing: '' }));
  }, async ({ endpoint }) => {
    const provider = createWikipediaProvider({ endpoint });
    const output = await provider({ queryText: 'what is Unknown fixture', questionType: 'what' });
    assert.equal(output.response, undefined);
    assert.equal(output.message, "No match for query 'Unknown fixture'");
  });
});

test('Q-01 Wikipedia preserves source first-page category continuation behavior', async () => {
  await withFixtureServer((_request, response) => {
    const body = page({
      title: 'Continuity Article',
      extract: 'Continuity Article is a controlled article.',
      categories: [],
    });
    // The pinned Python dependency requests categories in the combined page
    // query and does not consume a top-level continuation from that response.
    // Keep this response deliberately shaped like a later blacklisted page so
    // a candidate that silently follows it would change the source result.
    body.continue = {
      clcontinue: 'Continuity Article|later',
      continue: '-||categories',
    };
    sendJson(response, 200, body);
  }, async ({ endpoint, requests }) => {
    const provider = createWikipediaProvider({ endpoint });
    const output = await provider({ queryText: 'what is Continuity Article', questionType: 'what' });
    assert.equal(output.response.payload, 'Continuity Article is a controlled article.');
    assert.equal(output.message, undefined);
    assert.equal(requests.length, 1);
    const requestUrl = new URL(requests[0].url, endpoint);
    assert.equal(requestUrl.searchParams.get('cllimit'), 'max');
    assert.equal(requestUrl.searchParams.get('list'), 'allcategories');
  });
});

test('Q-01 Wikipedia disambiguation follows revision options and skips disambiguation pages', async () => {
  await withFixtureServer((request, response) => {
    const query = new URL(request.url, 'http://fixture.invalid');
    const title = query.searchParams.get('titles');
    const prop = query.searchParams.get('prop');
    if (prop === 'revisions') {
      sendJson(response, 200, {
        query: { pages: { '1': { revisions: [{ '*': '<ul><li class="tocsection-1"><a>TOC-only label</a></li><li><a>Mercury <span>(planet)</span> &amp; family</a></li><li><div><a>Mercury (disambiguation)</a></div></li></ul>' }] } } },
      });
      return;
    }
    if (title === 'Mercury') {
      sendJson(response, 200, page({ title: 'Mercury', pageprops: { disambiguation: '' }, extract: '' }));
      return;
    }
    sendJson(response, 200, page({
      title,
      extract: 'Mercury (planet) & family is the smallest planet in the Solar System.',
    }));
  }, async ({ endpoint, requests }) => {
    const provider = createWikipediaProvider({ endpoint, random: () => 0 });
    const output = await provider({ queryText: 'what is Mercury', questionType: 'what' });
    assert.equal(output.message, undefined);
    assert.equal(output.response.payload, "I found a few things. Here's one of them.  Mercury & family is the smallest planet in the Solar System.");
    assert.deepEqual(requests.map(({ url }) => new URL(url, endpoint).searchParams.get('prop')), [
      'info|pageprops|extracts|categories', 'revisions', 'info|pageprops|extracts|categories',
    ]);
    assert.equal(new URL(requests[0].url, endpoint).searchParams.get('list'), 'allcategories');
    assert.equal(new URL(requests[2].url, endpoint).searchParams.get('list'), 'allcategories');
    assert.equal(new URL(requests[2].url, endpoint).searchParams.get('titles'), 'Mercury (planet) & family');
  });
});

test('Q-01 Wikipedia malformed and HTTP responses remain visible as provider errors', async () => {
  await withFixtureServer((_request, response) => {
    sendJson(response, 502, { error: { info: 'upstream unavailable' } });
  }, async ({ endpoint }) => {
    const provider = createWikipediaProvider({ endpoint });
    const output = await provider({ queryText: 'what is a fixture', questionType: 'what' });
    assert.match(output.message, /Wikipedia query 'fixture' raised unexpected exception/);
    assert.match(output.message, /upstream unavailable/);
  });

  await withFixtureServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{not-json');
  }, async ({ endpoint }) => {
    const provider = createWikipediaProvider({ endpoint });
    const output = await provider({ queryText: 'what is a fixture', questionType: 'what' });
    assert.match(output.message, /invalid JSON response/);
  });
});

test('Q-01 Wikipedia cancellation returns source error and does not await the late body', async () => {
  const started = Date.now();
  await withFixtureServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 90));
    if (!response.destroyed) sendJson(response, 200, page({
      title: 'Fixture fact',
      extract: 'Fixture fact is a fixture fact.',
    }));
  }, async ({ endpoint, requests }) => {
    const controller = new AbortController();
    const provider = createWikipediaProvider({ endpoint });
    const pending = provider({
      queryText: 'what is Fixture fact',
      questionType: 'what',
      signal: controller.signal,
    });
    // Wait for the actual loopback request before cancelling so scheduler
    // load cannot abort the fetch before it reaches the fixture peer.
    for (let attempt = 0; attempt < 50 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    controller.abort();
    const output = await pending;
    assert.equal(output.response, undefined);
    assert.match(output.message, /AbortError|timed out|aborted/i);
    assert.ok(Date.now() - started < 80, 'provider waited for the late fixture body');
    assert.equal(requests.length, 1);
  });
});

test('Q-01 Wikipedia adapter plugs into the existing named provider pipeline', async () => {
  await withFixtureServer((_request, response) => {
    sendJson(response, 200, page({
      title: 'Fixture fact',
      extract: 'Fixture fact is a fixture fact.',
    }));
  }, async ({ endpoint }) => {
    const wikipedia = createWikipediaProvider({ endpoint });
    const pipeline = createGqaProviderPipeline({
      providers: {
        Bing: async () => ({}),
        Wikipedia: wikipedia,
        'Wolfram Alpha': async () => ({}),
      },
      timeouts: [100, 100],
    });
    const output = await pipeline({ queryText: 'Fixture fact', questionType: 'what' });
    assert.equal(output.source, 'Wikipedia');
    assert.equal(output.response.payload, 'Fixture fact is a fixture fact.');
  });
});

test('Q-01 Wikipedia exports identify the source pin and official endpoint', () => {
  assert.equal(WIKIPEDIA_SOURCE_REVISION, 'ebe1a7d38f511570060c1fbf61bec89d58419b26');
  assert.equal(WIKIPEDIA_SOURCE_API, 'https://en.wikipedia.org/w/api.php');
  assert.equal(WIKIPEDIA_SOURCE_USER_AGENT, 'wikipedia (https://github.com/goldsmith/Wikipedia/)');
});

test('Q-01 lexical preprocessing follows the pinned NLTK source vectors', () => {
  const cases = [
    {
      id: 'ordinary',
      query: 'what is the Catcher in the Rye',
      summary: 'The Catcher in the Rye is a coming-of-age novel. It was published in 1951.',
      strictQuery: 'Catcher in the Rye',
      sentence: 'The Catcher in the Rye is a coming-of-age novel.',
    },
    {
      id: 'expanded stopwords',
      query: 'what is about the moon',
      summary: "The Moon is Earth's only natural satellite. It is bright.",
      strictQuery: 'moon',
      sentence: "The Moon is Earth's only natural satellite.",
    },
    {
      id: 'contraction',
      query: "what's an apple",
      summary: 'An apple is a fruit. It grows on trees.',
      strictQuery: 'apple',
      sentence: 'An apple is a fruit.',
    },
    {
      id: 'title abbreviation and initials',
      query: 'who is Dr. A. P. J. Abdul Kalam',
      summary: 'Dr. A. P. J. Abdul Kalam was an Indian aerospace scientist. He served as president.',
      strictQuery: 'Dr. A. P. J. Abdul Kalam',
      sentence: 'Dr. A. P. J. Abdul Kalam was an Indian aerospace scientist.',
    },
    {
      id: 'initialism',
      query: 'what is U.S. history',
      summary: 'U.S. history includes many events. The country was founded in 1776.',
      strictQuery: 'U.S. history',
      sentence: 'U.S. history includes many events.',
    },
    {
      id: 'decimal',
      query: 'what is pi',
      summary: 'The value was 3.14. Next sentence starts here.',
      strictQuery: 'pi',
      sentence: 'The value was 3.14.',
    },
    {
      id: 'nested parentheses',
      query: 'what is a test',
      summary: 'A test (an aside (nested detail)) is an experiment. Next sentence.',
      strictQuery: 'test',
      sentence: 'A test is an experiment.',
    },
    {
      id: 'unicode',
      query: 'who is Beyoncé',
      summary: 'Beyoncé is a singer and songwriter. She performs worldwide.',
      strictQuery: 'Beyoncé',
      sentence: 'Beyoncé is a singer and songwriter.',
    },
    {
      id: 'quote boundary',
      query: 'what happened',
      summary: 'Hello! "Next sentence."',
      strictQuery: 'happened',
      sentence: 'Hello!',
    },
    {
      id: 'ellipsis',
      query: 'what happened',
      summary: 'Wait... maybe this is one thought. Next sentence.',
      strictQuery: 'happened',
      sentence: 'Wait... maybe this is one thought.',
    },
  ];
  for (const entry of cases) {
    assert.equal(removeInitialStopWords(entry.query), entry.strictQuery, entry.id);
    assert.equal(firstSentence(entry.summary), entry.sentence, entry.id);
  }
});

test('Q-01 lexical boundaries preserve Python Punkt Unicode and punctuation semantics', () => {
  const cases = [
    ['adjacent sentence punctuation', 'Hello!! Next sentence.', 'Hello!!'],
    ['mixed adjacent sentence punctuation', 'What?! Really? Next sentence.', 'What?!'],
    ['Python NEXT LINE whitespace', 'End.\u0085Next.', 'End.'],
    ['Python information-separator whitespace', 'End.\u001cNext.', 'End.'],
    ['connector-punctuation initial', '_. Zygmunt is here. Next sentence.', '_. Zygmunt is here.'],
    ['Unicode decimal initial', '١. sentence continues. Later.', '١. sentence continues.'],
  ];
  for (const [id, summary, expected] of cases) {
    assert.equal(firstSentence(summary), expected, id);
  }
});

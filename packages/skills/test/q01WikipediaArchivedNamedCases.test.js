import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWikipediaProvider } from '../src/gqaWikipediaProvider.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/q01-wikipedia-archived-named-cases.json', import.meta.url),
));

assert.equal(fixture.sourceRevision, 'ebe1a7d38f511570060c1fbf61bec89d58419b26');

function responseFor(page) {
  return {
    status: 200,
    text: async () => JSON.stringify({
      query: {
        pages: {
          '1': {
            title: page.title,
            fullurl: `https://en.wikipedia.org/wiki/${page.title}`,
            extract: page.extract,
            categories: page.categories,
          },
        },
      },
    }),
  };
}

function providerFor(control, requests) {
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (control.transportError) {
      const error = new Error(control.transportError.message);
      error.name = control.transportError.name;
      throw error;
    }
    return responseFor(control.page);
  };
  return createWikipediaProvider({ fetchImpl, random: () => 0 });
}

for (const control of fixture.cases) {
  test(`Q-01 archived Wikipedia named case: ${control.id}`, async () => {
    const requests = [];
    const provider = providerFor(control, requests);
    const output = await provider({
      queryText: control.queryText,
      questionType: control.questionType,
    });

    assert.equal(control.strictQuery, control.sourceSearchQuery, control.id);
    assert.equal(output.logs.strict_query, control.strictQuery, control.id);
    assert.equal(requests.length, 1, control.id);
    assert.equal(output.response, undefined, control.id);
    if (control.expectedMessage) assert.equal(output.message, control.expectedMessage, control.id);
    if (control.expectedMessageIncludes) assert.match(output.message || '', new RegExp(
      control.expectedMessageIncludes.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    ), control.id);
  });
}

test('Q-01 archived Wikipedia named cases are semantic falsifiers', async () => {
  const related = fixture.cases.find(({ id }) => id === 'test_carlton_banks');
  const mutatedRelated = {
    ...related,
    page: {
      ...related.page,
      extract: `Carlton Banks is a fictional character. ${related.page.extract}`,
    },
  };
  const relatedRequests = [];
  const relatedOutput = await providerFor(mutatedRelated, relatedRequests)({
    queryText: mutatedRelated.queryText,
    questionType: mutatedRelated.questionType,
  });
  assert.equal(relatedRequests.length, 1);
  assert.equal(relatedOutput.message, undefined);
  assert.match(relatedOutput.response?.payload || '', /Carlton Banks is a fictional character/u);

  const broken = fixture.cases.find(({ id }) => id === 'test_broken_article');
  const mutatedBroken = {
    ...broken,
    page: {
      ...broken.page,
      extract: 'NCAA is a deterministic fixture article.',
    },
  };
  const brokenRequests = [];
  const brokenOutput = await providerFor(mutatedBroken, brokenRequests)({
    queryText: mutatedBroken.queryText,
    questionType: mutatedBroken.questionType,
  });
  assert.equal(brokenRequests.length, 1);
  assert.equal(brokenOutput.message, undefined);
  assert.equal(brokenOutput.response?.payload, 'NCAA is a deterministic fixture article.');

  const noResponse = fixture.cases.find(({ id }) => id === 'test_no_response');
  const emptyPage = {
    ...noResponse,
    transportError: undefined,
    page: {
      title: 'Empty Wikipedia page test',
      extract: '',
      categories: [],
    },
  };
  const emptyRequests = [];
  const emptyOutput = await providerFor(emptyPage, emptyRequests)({
    queryText: emptyPage.queryText,
    questionType: emptyPage.questionType,
  });
  assert.equal(emptyRequests.length, 1);
  assert.equal(emptyOutput.response, undefined);
  assert.equal(emptyOutput.message, "Unexpected empty summary for query 'Empty Wikipedia page test'");
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWikipediaProvider } from '../src/gqaWikipediaProvider.js';

const matrix = JSON.parse(readFileSync(new URL('./fixtures/q01-wikipedia-decision-matrix.json', import.meta.url), 'utf8'));

function fixtureResponse(page) {
  const value = page && {
    title: page.title,
    fullurl: `https://en.wikipedia.org/wiki/${page.title}`,
    extract: page.extract,
  };
  return {
    status: 200,
    text: async () => JSON.stringify({ query: { pages: { '1': value } } }),
  };
}

test('Q-01 archived Wikipedia can_answer matrix is executable through the injected provider', async () => {
  for (const control of matrix.canAnswer) {
    const requests = [];
    const provider = createWikipediaProvider({
      fetchImpl: async (url) => {
        requests.push(url);
        const title = new URL(url).searchParams.get('titles');
        return fixtureResponse({
          title,
          extract: `${title} is a deterministic fixture answer.`,
        });
      },
    });
    const output = await provider({ queryText: control.queryText, questionType: control.questionType });
    assert.equal(requests.length > 0, control.expected, `${control.id}: request gate`);
    if (control.expected) {
      assert.equal(output.message, undefined, control.id);
      assert.ok(output.response?.payload, control.id);
    } else {
      assert.equal(output.response, undefined, control.id);
      assert.equal(output.message, 'Blocked by WIKIPEDIA_QUESTION_WORDS restriction.', control.id);
    }
  }
});

test('Q-01 archived Wikipedia empty-query, endash, and title/list decisions replay on pinned page fixtures', async () => {
  for (const control of matrix.searchDecisions) {
    const requests = [];
    const provider = createWikipediaProvider({
      fetchImpl: async (url) => {
        requests.push(url);
        assert.ok(control.page, `${control.id}: unexpected page request`);
        return fixtureResponse(control.page);
      },
    });
    const output = await provider({ queryText: control.queryText, questionType: control.questionType });
    assert.equal(requests.length, control.expectedRequests, `${control.id}: request count`);
    if (control.expectedAnswer !== undefined) {
      assert.deepEqual(output.response, { type: 'string', payload: control.expectedAnswer }, control.id);
      assert.equal(output.message, undefined, control.id);
    }
    if (control.expectedMessage !== undefined) assert.equal(output.message, control.expectedMessage, control.id);
    if (control.expectedMessageContains !== undefined) assert.match(output.message || '', new RegExp(control.expectedMessageContains.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), control.id);
  }
});

test('Q-01 Wikipedia decision controls are falsifiers, not filename-only claims', async () => {
  const listControl = matrix.searchDecisions.find(({ id }) => id === 'list-capital-of-india');
  const requests = [];
  const provider = createWikipediaProvider({
    fetchImpl: async (url) => {
      requests.push(url);
      return fixtureResponse({
        ...listControl.page,
        title: 'Capital of India',
        extract: 'Capital of India describes capital of India.',
      });
    },
  });
  const output = await provider({ queryText: listControl.queryText, questionType: listControl.questionType });
  assert.equal(requests.length, 1);
  assert.doesNotMatch(output.message || '', /title contains word indicating it's list/u);
  assert.equal(output.response?.payload, 'Capital of India describes capital of India.');

  const gateControl = matrix.canAnswer.find(({ id }) => id === 'explicit-how');
  let gateRequests = 0;
  const gated = createWikipediaProvider({
    fetchImpl: async () => {
      gateRequests += 1;
      return fixtureResponse({ title: 'unexpected', extract: 'unexpected is a fixture.' });
    },
  });
  const gatedOutput = await gated({ queryText: gateControl.queryText, questionType: gateControl.questionType });
  assert.equal(gateRequests, 0);
  assert.equal(gatedOutput.message, 'Blocked by WIKIPEDIA_QUESTION_WORDS restriction.');
});

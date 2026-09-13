import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';
import {
  createGqaMemoryAttributionStore,
  createStructQaHandler,
} from '../../skills/src/index.js';

const NOW = 1700000000000;
const AUTHORIZATION = 'AWS4-HMAC-SHA256 Credential=robot-access-key/20260913/us-east-1/gqa/aws4_request, SignedHeaders=host, Signature=fixture';

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function post(port, target, body) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      authorization: AUTHORIZATION,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: JSON.parse(await response.text()),
  };
}

test('Q-01 Classic Question and ListAttribution use one integrated structQA/account/store path', async () => {
  const accountCalls = [];
  const accountLookup = async (accountId) => {
    accountCalls.push(accountId);
    return accountId === 'robot-access-key' ? 'loop-1' : {};
  };
  const attribution = createGqaMemoryAttributionStore({ clock: () => NOW });
  const structQaHandler = createStructQaHandler({
    clock: () => NOW,
    accountLookup,
    attribution,
    gqaProvider: async ({ loopId, countryCode, queryText }) => {
      assert.equal(loopId, 'loop-1');
      assert.equal(countryCode, 'US');
      assert.equal(queryText, 'what is the fixture');
      return {
        source: 'Bing',
        type: 'Facts',
        url: 'https://fixture.invalid/answer',
        response: { type: 'string', payload: 'The fixture answer' },
      };
    },
  });
  const entrypoint = createClassicEntrypoint({
    gqa: { structQaHandler, accountLookup, attribution },
  });
  const server = await entrypoint.listen(0);
  try {
    const question = await post(server.address().port, 'GQA_20160930.Question', {
      Intent: 'GQA',
      Input: 'what is the fixture',
      Country: 'usa',
    });
    assert.equal(question.status, 200);
    assert.match(question.contentType, /^application\/json(?:; charset=utf-8)?$/u);
    assert.deepEqual(question.body, {
      timestamps: { receive_request: NOW, return_response: NOW },
      input: 'what is the fixture',
      source: 'Bing',
      type: 'Facts',
      url: 'https://fixture.invalid/answer',
      response: { type: 'string', payload: 'The fixture answer.' },
      version: '5.2.15',
      success: true,
    });

    const listed = await post(server.address().port, 'GQA_20160930.ListAttribution', {
      ID: 'required-by-client-model-but-unused-by-source',
      Service: 'Bing',
    });
    assert.equal(listed.status, 200);
    assert.match(listed.contentType, /^application\/json(?:; charset=utf-8)?$/u);
    assert.deepEqual(listed.body, {
      data: [{
        service: 'Bing',
        query: 'The fixture answer.',
        url: 'https://fixture.invalid/answer',
        image_url: null,
        loop_id: 'loop-1',
        timestamp: NOW,
      }],
    });
    assert.deepEqual(accountCalls, ['robot-access-key', 'robot-access-key']);
  } finally {
    await closeServer(server);
  }
});

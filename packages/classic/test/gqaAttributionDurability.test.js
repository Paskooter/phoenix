import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../src/index.js';
import {
  createGqaFileAttributionStore,
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

test('Classic Question persists attribution and a restarted ListAttribution reads it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-q01-classic-attribution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'attribution.json');
  const accountLookup = async (accountId) => (accountId === 'robot-access-key' ? 'loop-1' : {});

  const firstStore = createGqaFileAttributionStore({ file, clock: () => NOW });
  const firstQuestion = createStructQaHandler({
    clock: () => NOW,
    accountLookup,
    attribution: firstStore,
    gqaProvider: async ({ loopId, queryText }) => {
      assert.equal(loopId, 'loop-1');
      assert.equal(queryText, 'what is the durable fixture');
      return {
        source: 'Bing',
        type: 'Facts',
        url: 'https://fixture.invalid/durable',
        response: { type: 'string', payload: 'The durable fixture answer' },
      };
    },
  });
  const firstEntrypoint = createClassicEntrypoint({
    gqa: { structQaHandler: firstQuestion, accountLookup, attribution: firstStore },
  });
  const firstServer = await firstEntrypoint.listen(0);
  try {
    const question = await post(firstServer.address().port, 'GQA_20160930.Question', {
      Intent: 'GQA',
      Input: 'what is the durable fixture',
      Country: 'usa',
    });
    assert.equal(question.status, 200);
    assert.equal(question.contentType, 'application/json; charset=utf-8');
    assert.equal(question.body.response.payload, 'The durable fixture answer.');
  } finally {
    await closeServer(firstServer);
  }

  // A new store instance stands in for the restarted Classic process. Only the
  // persisted file crosses that boundary.
  const restartedStore = createGqaFileAttributionStore({ file, clock: () => NOW });
  const restartedEntrypoint = createClassicEntrypoint({
    gqa: { accountLookup, attribution: restartedStore },
  });
  const restartedServer = await restartedEntrypoint.listen(0);
  try {
    const listed = await post(restartedServer.address().port, 'GQA_20160930.ListAttribution', {
      ID: 'required-by-client-model-but-unused-by-source',
      Service: 'Bing',
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.contentType, 'application/json; charset=utf-8');
    assert.deepEqual(listed.body, {
      data: [{
        service: 'Bing',
        query: 'The durable fixture answer.',
        url: 'https://fixture.invalid/durable',
        image_url: null,
        loop_id: 'loop-1',
        timestamp: NOW,
      }],
    });
  } finally {
    await closeServer(restartedServer);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '@phoenix/common';
import {
  createGqaHttpRoute,
  GQA_BAD_REQUEST_HTML,
  GQA_MISSING_TRANSID_HTML,
} from '../src/gqaAnswerSkill.js';

// Exact Werkzeug 0.12.2 HTTPException.get_body() bytes from the pinned
// Python 3.6.15 / Flask 0.12.2 source control. Host Flask 3 HTML5 pages are
// a different renderer and are not this contract.
const WERKZEUG_BAD_REQUEST_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
  + '<p>The browser (or proxy) sent a request that this server could not understand.</p>\n';
const WERKZEUG_MISSING_TRANSID_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
  + '<p>Missing X-JIBO-transID header</p>\n';

function sourceRequest() {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'framing-request',
    ts: 1700000000000,
    data: {
      general: {
        accountID: 'framing-account',
        robotID: 'framing-robot',
        lang: 'en',
        remoteAddress: '127.0.0.1',
      },
      runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
      skill: null,
      result: {
        nlu: { intent: 'generalWhatQuestions', entities: {} },
        asr: { text: 'what is a framing fixture', confidence: 1 },
      },
    },
  };
}

async function request(server, body, contentType, headers = {}) {
  return fetch(`http://127.0.0.1:${server.address().port}/v1/answer/main`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body,
  });
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

test('Q-01 GQA 400 HTML is Werkzeug 0.12 HTML 3.2, not host Flask 3', () => {
  assert.equal(GQA_BAD_REQUEST_HTML, WERKZEUG_BAD_REQUEST_HTML);
  assert.equal(GQA_MISSING_TRANSID_HTML, WERKZEUG_MISSING_TRANSID_HTML);
});

test('Q-01 GQA source route accepts JSON and vendor +json and returns source HTML media', async () => {
  let calls = 0;
  const service = createService({
    name: 'q01-gqa-framing-success',
    routes: {
      'POST /v1/answer/main': createGqaHttpRoute({
        handler: async () => {
          calls += 1;
          return { type: 'SKILL_ACTION', marker: 'source-framing' };
        },
      }),
    },
  });
  assert.deepEqual([...service.routes || []], []);
  const server = await service.listen(0);
  try {
    for (const contentType of ['application/json', 'application/vnd.jibo+json; charset=utf-8']) {
      const response = await request(
        server,
        JSON.stringify(sourceRequest()),
        contentType,
        { 'x-jibo-transid': 'framing-trans' },
      );
      assert.equal(response.status, 200, contentType);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', contentType);
      assert.deepEqual(parseBody(await response.text()), {
        type: 'SKILL_ACTION',
        marker: 'source-framing',
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(calls, 2);
});

test('Q-01 GQA source parser returns Flask 400 HTML for malformed and empty JSON', async () => {
  let calls = 0;
  const route = createGqaHttpRoute({
    handler: async () => {
      calls += 1;
      return { type: 'SKILL_ACTION' };
    },
  });
  assert.deepEqual(route.jsonTypes, ['application/json', 'application/*+json']);
  assert.equal(route.jsonStrict, false);
  assert.equal(typeof route.parserError, 'function');
  const service = createService({
    name: 'q01-gqa-framing-parser',
    routes: { 'POST /v1/answer/main': route },
  });
  const server = await service.listen(0);
  try {
    for (const [label, contentType, body] of [
      ['json-malformed', 'application/json', '{"type":'],
      ['vendor-malformed', 'application/vnd.jibo+json', '{"type":'],
      ['json-empty', 'application/json', ''],
      ['vendor-empty', 'application/vnd.jibo+json', ''],
    ]) {
      const response = await request(server, body, contentType, { 'x-jibo-transid': 'framing-trans' });
      assert.equal(response.status, 400, label);
      assert.equal(response.headers.get('content-type'), 'text/html', label);
      assert.equal(await response.text(), GQA_BAD_REQUEST_HTML, label);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(calls, 0);
});

test('Q-01 GQA source route leaves AWS JSON outside the Flask parser media set', async () => {
  let calls = 0;
  const service = createService({
    name: 'q01-gqa-framing-aws-boundary',
    routes: {
      'POST /v1/answer/main': createGqaHttpRoute({
        handler: async () => {
          calls += 1;
          return { type: 'SKILL_ACTION' };
        },
      }),
    },
  });
  const server = await service.listen(0);
  try {
    for (const [label, body] of [
      ['aws-malformed', '{"type":'],
      ['aws-valid', JSON.stringify(sourceRequest())],
      ['aws-empty', ''],
    ]) {
      const response = await request(
        server,
        body,
        'application/x-amz-json-1.1',
        { 'x-jibo-transid': 'framing-trans' },
      );
      assert.equal(response.status, 500, label);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label);
      const payload = parseBody(await response.text());
      assert.equal(payload.version, '5.2.15', label);
      assert.equal(typeof payload.message, 'string', label);
      assert.equal(typeof payload.stacktrace, 'string', label);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(calls, 0);
});

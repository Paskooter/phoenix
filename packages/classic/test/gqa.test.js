import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClassicEntrypoint,
  GQA_BAD_REQUEST_HTML,
  GQA_NOT_FOUND_HTML,
} from '../src/index.js';
import { createClassicRouter } from '../src/router.js';
import { createService } from '@phoenix/common';

const CREDENTIALS = JSON.stringify({
  _id: 'account-1',
  id: 'account-1',
  email: 'robot@example.invalid',
  accessKeyId: 'account-1',
  friendlyId: 'fixture-robot',
});

const openServers = new Set();

afterEach(async () => {
  for (const server of openServers) await new Promise((resolve) => server.close(resolve));
  openServers.clear();
});

async function start(gqa = {}) {
  const entrypoint = createClassicEntrypoint({ gqa });
  const server = await entrypoint.listen(0);
  openServers.add(server);
  return { server, port: server.address().port };
}

async function request(port, target, body, {
  contentType = 'application/x-amz-json-1.1',
  credentials = CREDENTIALS,
  authorization = 'AWS4-HMAC-SHA256 Credential=account-1/20260913/us-east-1/gqa/aws4_request, SignedHeaders=host, Signature=fixture',
  raw = false,
} = {}) {
  const headers = { 'content-type': contentType, 'x-amz-target': target };
  if (credentials !== undefined && credentials !== null) headers['x-amz-credentials'] = credentials;
  if (authorization !== undefined && authorization !== null) headers.authorization = authorization;
  const requestBody = raw ? body : JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers,
    body: requestBody,
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { response, status: response.status, contentType: response.headers.get('content-type'), body: parsed, text };
}

test('Question and ListAttribution targets dispatch through explicit source seams', async () => {
  const calls = [];
  const { port } = await start({
    // The parallel /structQA implementation's contract is explicit: (body, metadata).
    structQaHandler: async (body, metadata) => {
      calls.push({ type: 'Question', body, headers: metadata.headers, credentials: metadata.credentials });
      return { success: true, source: 'fixture', response: { type: 'string', payload: 'fixture answer' } };
    },
    accountLookup: async (id) => {
      calls.push({ type: 'account', id });
      return 'loop-1';
    },
    attribution: {
      search: async (...args) => {
        calls.push({ type: 'search', args });
        return [{ service: 'Bing', query: 'fixture', url: 'https://fixture.invalid', timestamp: 1700000000000 }];
      },
    },
  });

  const question = await request(port, 'GQA_20160930.Question', {
    Input: 'what is the fixture', Intent: 'GQA', Country: 'US', Latitude: 1, Longitude: 2,
  });
  assert.equal(question.status, 200);
  assert.equal(question.contentType, 'application/json; charset=utf-8');
  const questionBytes = Buffer.from(question.text, 'utf8');
  assert.equal(question.text, '{"success": true, "source": "fixture", "response": {"type": "string", "payload": "fixture answer"}}');
  assert.deepEqual(questionBytes, Buffer.from('{"success": true, "source": "fixture", "response": {"type": "string", "payload": "fixture answer"}}', 'utf8'));
  assert.equal(question.response.headers.get('content-length'), String(questionBytes.length));
  assert.deepEqual(question.body, {
    success: true,
    source: 'fixture',
    response: { type: 'string', payload: 'fixture answer' },
  });
  assert.equal(calls[0].type, 'Question');
  assert.deepEqual(calls[0].body, {
    Input: 'what is the fixture', Intent: 'GQA', Country: 'US', Latitude: 1, Longitude: 2,
  });
  assert.equal(calls[0].headers['content-type'], 'application/x-amz-json-1.1');
  assert.equal(calls[0].headers['x-amz-target'], 'GQA_20160930.Question');
  assert.equal(calls[0].headers['x-amz-credentials'], CREDENTIALS);
  assert.equal(calls[0].headers.authorization, 'AWS4-HMAC-SHA256 Credential=account-1/20260913/us-east-1/gqa/aws4_request, SignedHeaders=host, Signature=fixture');
  assert.deepEqual(calls[0].credentials, JSON.parse(CREDENTIALS));

  const attribution = await request(port, 'GQA_20160930.ListAttribution', {
    ID: 'model-required-but-source-unused', Service: 'Bing', after: 1, before: 2,
  });
  assert.equal(attribution.status, 200);
  assert.equal(attribution.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(attribution.body, {
    data: [{ service: 'Bing', query: 'fixture', url: 'https://fixture.invalid', timestamp: 1700000000000 }],
  });
  assert.deepEqual(calls.slice(1), [
    { type: 'account', id: 'account-1' },
    { type: 'search', args: ['loop-1', 'Bing', 2, 1] },
  ]);
});

test('the Classic direct face keeps LAN trust while preserving forwarded identity semantics', async () => {
  let observed;
  const { port } = await start({
    structQaHandler: async (body, metadata) => {
      observed = { body, credentials: metadata.credentials, headers: metadata.headers };
      return { success: true };
    },
  });
  const result = await request(port, 'GQA_20160930.Question', { Input: 'fixture' }, { authorization: null });
  assert.equal(result.status, 200);
  assert.deepEqual(observed.credentials, JSON.parse(CREDENTIALS));
  assert.equal(observed.body.Input, 'fixture');
  assert.equal(observed.headers.authorization, undefined);
});

test('Question synthesizes source credentials from a SigV4 access key on the direct Classic face', async () => {
  let accountId;
  let observed;
  const { port } = await start({
    accountLookup: async (id) => {
      accountId = id;
      return 'loop-from-access-key';
    },
    structQaHandler: async (body, metadata) => {
      observed = {
        body,
        credentials: metadata.credentials,
        headerCredentials: metadata.headers['x-amz-credentials'],
      };
      const loopId = await metadata.accountLookup(metadata.credentials.id);
      return { success: true, loopId };
    },
  });

  const result = await request(
    port,
    'GQA_20160930.Question',
    { Input: 'fixture' },
    {
      credentials: null,
      authorization: 'AWS4-HMAC-SHA256 Credential=robot-access-key/20260913/us-east-1/gqa/aws4_request, SignedHeaders=host, Signature=fixture',
    },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { success: true, loopId: 'loop-from-access-key' });
  assert.equal(accountId, 'robot-access-key');
  assert.deepEqual(observed.credentials, {
    id: 'robot-access-key',
    accessKeyId: 'robot-access-key',
  });
  assert.equal(observed.headerCredentials, JSON.stringify({
    id: 'robot-access-key',
    accessKeyId: 'robot-access-key',
  }));
});

test('ListAttribution preserves source header, account, then body error precedence', async () => {
  const calls = [];
  const { port } = await start({
    accountLookup: async (id) => {
      calls.push(['account', id]);
      return {};
    },
    attribution: { search: async () => { calls.push(['search']); return []; } },
  });

  const missingHeader = await request(port, 'GQA_20160930.ListAttribution', {}, { credentials: null, authorization: null });
  assert.equal(missingHeader.status, 500);
  assert.equal(missingHeader.contentType, 'application/json; charset=utf-8');
  assert.equal(missingHeader.body.version, '5.2.15');
  assert.equal(missingHeader.body.message, "Missing 'x-amz-credentials' header");
  assert.deepEqual(calls, []);

  const noLoop = await request(port, 'GQA_20160930.ListAttribution', null);
  assert.equal(noLoop.status, 500);
  assert.equal(noLoop.body.message, 'No robot ID!');
  assert.deepEqual(calls, [['account', 'account-1']]);
});

test('source parser rejects malformed and empty JSON with Flask 400 HTML before dispatch', async () => {
  const calls = [];
  const { port } = await start({
    structQaHandler: async () => { calls.push('question'); return { success: true }; },
    accountLookup: async () => { calls.push('account'); return 'loop-1'; },
    attribution: { search: async () => { calls.push('search'); return []; } },
  });

  const malformed = await request(port, 'GQA_20160930.Question', '{', { raw: true });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.contentType, 'application/json; charset=utf-8');
  assert.equal(malformed.response.headers.get('content-length'), String(Buffer.byteLength(GQA_BAD_REQUEST_HTML)));
  assert.equal(malformed.text, GQA_BAD_REQUEST_HTML);
  assert.deepEqual(calls, []);

  const empty = await request(port, 'GQA_20160930.ListAttribution', '', { raw: true });
  assert.equal(empty.status, 400);
  assert.equal(empty.contentType, 'application/json; charset=utf-8');
  assert.equal(empty.response.headers.get('content-length'), String(Buffer.byteLength(GQA_BAD_REQUEST_HTML)));
  assert.equal(empty.text, GQA_BAD_REQUEST_HTML);
  assert.deepEqual(calls, []);
});

test('the default GQA composition serves source-shaped no-answer and attribution responses', async () => {
  const { port } = await start();
  const question = await request(port, 'GQA_20160930.Question', { Input: 'fixture' });
  assert.equal(question.status, 200);
  assert.equal(question.contentType, 'application/json; charset=utf-8');
  const { timestamps, ...questionWithoutTimestamps } = question.body;
  assert.deepEqual(questionWithoutTimestamps, { message: 'Missing robot_id!', version: '5.2.15', success: false });
  assert.equal(typeof timestamps.receive_request, 'number');
  assert.equal(typeof timestamps.return_response, 'number');

  const attribution = await request(port, 'GQA_20160930.ListAttribution', { ID: 'fixture' });
  assert.equal(attribution.status, 500, 'the default attribution route still resolves Account before requiring an identity');
  assert.equal(attribution.body.version, '5.2.15');
  assert.equal(attribution.body.message, 'No robot ID!');
});

test('unknown GQA operation uses the downstream Flask 404 while unrelated Classic routing is unchanged', async () => {
  const { port } = await start();
  const unknownGqa = await request(port, 'GQA_20160930.Nope', {});
  assert.equal(unknownGqa.status, 404);
  assert.equal(unknownGqa.contentType, 'application/json; charset=utf-8');
  assert.equal(unknownGqa.response.headers.get('content-length'), String(Buffer.byteLength(GQA_NOT_FOUND_HTML)));
  assert.equal(unknownGqa.text, GQA_NOT_FOUND_HTML);

  const unknownMalformed = await request(port, 'GQA_20160930.Nope', '{', { raw: true });
  assert.equal(unknownMalformed.status, 404);
  assert.equal(unknownMalformed.contentType, 'application/json; charset=utf-8');
  assert.equal(unknownMalformed.text, GQA_NOT_FOUND_HTML);

  const unknownEmpty = await request(port, 'GQA_20160930.nope', '', { raw: true });
  assert.equal(unknownEmpty.status, 404);
  assert.equal(unknownEmpty.contentType, 'application/json; charset=utf-8');
  assert.equal(unknownEmpty.text, GQA_NOT_FOUND_HTML);

  const wrongCase = await request(port, 'GQA_20160930.question', {});
  assert.equal(wrongCase.status, 404);
  assert.equal(wrongCase.contentType, 'application/json; charset=utf-8');
  assert.equal(wrongCase.text, GQA_NOT_FOUND_HTML);

  const unrelated = await request(port, 'Nothing_20160101.Nope', {});
  assert.equal(unrelated.status, 400);
  assert.equal(unrelated.body.__type, 'UnknownOperationException');

  const log = await request(port, 'Log_20150309.PutEvents', { events: [] });
  assert.equal(log.status, 200);
  assert.deepEqual(log.body, { result: 'Successfully added events' });
});

test('GQA accepts application/*+json only through its route-scoped parser', async () => {
  const calls = [];
  const { port } = await start({
    structQaHandler: async (body) => {
      calls.push(body);
      return { ok: true, text: 'café 😀', nested: [true, null] };
    },
  });

  const gqa = await request(port, 'GQA_20160930.Question', { Input: 'fixture' }, {
    contentType: 'application/vnd.gqa+json',
  });
  assert.equal(gqa.status, 200);
  assert.equal(gqa.contentType, 'application/json; charset=utf-8');
  assert.deepEqual(calls, [{ Input: 'fixture' }]);
  const expected = '{"ok": true, "text": "caf\\u00e9 \\ud83d\\ude00", "nested": [true, null]}';
  assert.equal(gqa.text, expected);
  assert.deepEqual(Buffer.from(gqa.text, 'utf8'), Buffer.from(expected, 'utf8'));

  const unrelated = await request(port, 'Nothing_20160101.Nope', '{', {
    contentType: 'application/vnd.unrelated+json',
    raw: true,
  });
  assert.equal(unrelated.status, 400);
  assert.equal(unrelated.body.__type, 'UnknownOperationException');
});

test('two Classic registrations keep their resolved JSON type sets independent', async () => {
  const registrations = [
    {
      match: /^gqa_test$/i,
      jsonStrict: false,
      jsonTypes: ['application/json', 'application/vnd.gqa+json'],
      bodyDefault: null,
      preserveBody: true,
      handler: async ({ body }) => ({ family: 'gqa', body }),
    },
    {
      match: /^other_test$/i,
      jsonStrict: false,
      jsonTypes: ['application/json', 'application/vnd.other+json'],
      bodyDefault: null,
      preserveBody: true,
      handler: async ({ body }) => ({ family: 'other', body }),
    },
  ];
  const service = createService({ name: 'gqa-json-type-control', routes: createClassicRouter(registrations) });
  await service.listen(0);
  const port = service.server.address().port;
  try {
    const gqa = await request(port, 'GQA_TEST.Question', { first: true }, {
      contentType: 'application/vnd.gqa+json',
    });
    assert.equal(gqa.status, 200);
    assert.deepEqual(gqa.body, { family: 'gqa', body: { first: true } });

    const other = await request(port, 'OTHER_TEST.Question', { second: true }, {
      contentType: 'application/vnd.other+json',
    });
    assert.equal(other.status, 200);
    assert.deepEqual(other.body, { family: 'other', body: { second: true } });
  } finally {
    await new Promise((resolve, reject) => service.server.close((error) => error ? reject(error) : resolve()));
  }
});

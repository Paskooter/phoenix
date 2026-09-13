import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createService, signSigV4 } from '@phoenix/common';
import {
  createGqaAccountLookup,
  createGqaAttributionStore,
  createGqaAttributionAuthorizer,
  createGqaSigV4CallerVerifier,
  createGqaMemoryAttributionStore,
  createGqaRetrieveAttributionRoute,
  createGqaWipeAttributionRoute,
  readGqaAttributionAuthConfig,
  GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV,
  GQA_ATTRIBUTION_TRUSTED_INTERNAL_ADDRESSES_ENV,
  sourceJsonDumps,
  safeGqaErrorDetail,
  safeGqaErrorCause,
} from '../src/gqaAccountAttribution.js';
import { createGqaAnswerSkill, createGqaHttpRoute } from '../src/gqaAnswerSkill.js';
import { redactProviderUrl } from '../src/gqaProviderUrl.js';
import {
  createGqaMultiProviderProfile,
  createGqaMultiProviderService,
  startGqaMultiProviderService,
} from '../src/gqaMultiProviderService.js';
import { createGqaWikipediaService } from '../src/gqaWikipediaService.js';

const FIXED_NOW = 1700000000000;
const SIGV4_DATE = new Date(FIXED_NOW);
function sigV4FixtureAccount(_id, isAdmin) {
  return Object.freeze({
    _id,
    accessKeyId: `fixture-access-${randomBytes(12).toString('hex')}`,
    secretAccessKey: randomBytes(32).toString('hex'),
    isActive: true,
    isAdmin,
  });
}

const SIGV4_ACCOUNTS = Object.freeze({
  owner: sigV4FixtureAccount('gqa-owner-account', false),
  other: sigV4FixtureAccount('gqa-other-account', false),
  admin: sigV4FixtureAccount('gqa-admin-account', true),
});
const TEST_ATTRIBUTION_AUTH = { verifyCaller: async () => ({ accountId: 'account-1' }) };

function answerRequest(text = 'what is a fixture fact') {
  return {
    type: 'LISTEN_LAUNCH',
    msgID: 'account-attribution-request',
    ts: 1700000000000,
    data: {
      general: {
        accountID: 'account-1',
        robotID: 'robot-1',
        remoteAddress: '127.0.0.1',
      },
      runtime: { location: { lat: 42.1, lng: -71.2, countryCode: 'US' } },
      skill: { id: 'answer', session: null },
      result: {
        nlu: { intent: 'generalWhatQuestions', entities: {} },
        asr: { text, confidence: 1 },
      },
    },
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function signedAttributionRequest(baseUrl, path, body, account, date = SIGV4_DATE) {
  const serialized = JSON.stringify(body);
  const signed = signSigV4({
    method: 'POST',
    path,
    body: serialized,
    headers: {
      Host: new URL(baseUrl).host,
      'Content-Type': 'application/json',
    },
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date,
  });
  return {
    body: serialized,
    headers: {
      ...signed.headers,
      // This metadata is deliberately added after signing. The verifier must
      // ignore it and derive identity from the signed access key only.
      'x-amz-credentials': JSON.stringify({ id: 'gqa-owner-account', isAdmin: true }),
      'x-forwarded-for': 'gqa-forged-forwarded-address',
    },
  };
}

async function postSignedAttribution(baseUrl, path, body, account, date = SIGV4_DATE) {
  const request = signedAttributionRequest(baseUrl, path, body, account, date);
  return fetch(`${baseUrl}${path}`, { method: 'POST', ...request });
}

test('account lookup preserves the source POST body, headers, and first loop ID', async () => {
  const requests = [];
  const peer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers['content-type'],
      body: Buffer.concat(chunks).toString('utf8'),
    });
    const body = JSON.stringify({ 'account-1': ['loop-1', 'loop-older'] });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
  try {
    const lookup = createGqaAccountLookup({
      endpoint: `http://127.0.0.1:${peer.address().port}/fakeAccount`,
    });
    assert.equal(await lookup('account-1'), 'loop-1');
    assert.deepEqual(requests, [{
      method: 'POST',
      path: '/fakeAccount',
      contentType: 'application/json',
      body: '{"accountsIds": ["account-1"]}',
    }]);
  } finally {
    await closeServer(peer);
  }
});

test('account lookup keeps source failure and post-HTTP shape boundaries visible', async () => {
  const unavailable = createGqaAccountLookup({
    endpoint: 'http://fixture.invalid/account',
    fetchImpl: async () => { throw new Error('fixture connection refused'); },
  });
  assert.deepEqual(await unavailable('account-1'), {});

  const malformed = createGqaAccountLookup({
    endpoint: 'http://fixture.invalid/account',
    fetchImpl: async () => ({ json: async () => { throw new SyntaxError('invalid JSON'); } }),
  });
  assert.deepEqual(await malformed('account-1'), {});

  const empty = createGqaAccountLookup({
    endpoint: 'http://fixture.invalid/account',
    fetchImpl: async () => ({ json: async () => ({ 'account-1': [] }) }),
  });
  assert.deepEqual(await empty('account-1'), {});

  const missing = createGqaAccountLookup({
    endpoint: 'http://fixture.invalid/account',
    fetchImpl: async () => ({ json: async () => ({ 'other-account': ['loop-2'] }) }),
  });
  await assert.rejects(missing('account-1'), /missing 'account-1'/);
});

test('source JSON dumping and attribution memory store preserve source fields and windows', async () => {
  assert.equal(sourceJsonDumps({ accountsIds: ['é😀'] }), '{"accountsIds": ["\\u00e9\\ud83d\\ude00"]}');
  const store = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await store.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/a', null, 'loop-1');
  await store.insert('Wolfram Alpha', 'Another answer.', 'https://fixture.invalid/b', 'https://fixture.invalid/b.jpg', 'loop-1');
  await store.insert('Bing', 'Other loop.', 'https://fixture.invalid/c', null, 'loop-2');

  assert.deepEqual(await store.search('loop-1', 'Bing', FIXED_NOW, FIXED_NOW - 1), []);
  assert.deepEqual(await store.search('loop-1', 'Bing', FIXED_NOW + 1, FIXED_NOW - 2), [
    {
      service: 'Bing',
      query: 'A fixture answer.',
      url: 'https://fixture.invalid/a',
      image_url: null,
      loop_id: 'loop-1',
      timestamp: FIXED_NOW,
    },
  ]);
  assert.equal(await store.wipe('loop-2'), 1);
  assert.equal(store.snapshot().length, 2);
});

test('attribution records redact API-key query parameters from provider URLs', async () => {
  const store = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await store.insert(
    'Bing',
    'A fixture answer.',
    'https://fixture.invalid/search?q=fixture&appid=bing-secret&api_key=another-secret',
    'https://fixture.invalid/image.jpg?subscription-key=image-secret',
    'loop-1',
  );
  const [record] = await store.search('loop-1', 'Bing', FIXED_NOW + 1, FIXED_NOW - 1);
  assert.equal(record.url, 'https://fixture.invalid/search?q=fixture');
  assert.equal(record.image_url, 'https://fixture.invalid/image.jpg');
  assert.equal(JSON.stringify(record).includes('secret'), false);
});

test('provider URL redaction removes semantic credential query names', () => {
  const redacted = redactProviderUrl(
    'https://fixture.invalid/search?q=fixture&x-api-key=api-secret&x-auth-token=auth-secret'
      + '&accessToken=access-secret&refresh_token=refresh-secret&clientSecret=client-secret'
      + '&private-key=private-secret&credential=credential-secret&safe=value',
  );
  assert.equal(redacted, 'https://fixture.invalid/search?q=fixture&safe=value');
  assert.doesNotMatch(redacted, /secret/);
});

test('Mongo attribution reads sanitize legacy provider URLs before returning records', async () => {
  const collection = {
    async insertOne() {},
    async createIndex() {},
    find() {
      return { limit: () => [{
        service: 'Bing',
        query: 'legacy',
        url: 'https://fixture.invalid/search?appid=legacy-secret',
        image_url: 'https://fixture.invalid/image?key=legacy-image-secret',
        loop_id: 'loop-legacy',
        timestamp: FIXED_NOW,
      }] };
    },
    async deleteMany() { return { deletedCount: 0 }; },
  };
  const store = createGqaAttributionStore({ collection, clock: () => FIXED_NOW });
  const [record] = await store.search('loop-legacy', 'Bing', FIXED_NOW + 1, FIXED_NOW - 1);
  assert.equal(record.url, 'https://fixture.invalid/search');
  assert.equal(record.image_url, 'https://fixture.invalid/image');
  assert.equal(JSON.stringify(record).includes('secret'), false);
});

test('Mongo attribution adapter uses source query projection, 90-day floor, limit, and index', async () => {
  const calls = [];
  const rows = [];
  const collection = {
    async insertOne(record) {
      const stored = { _id: `internal-${rows.length + 1}`, ...record };
      rows.push(stored);
      calls.push(['insertOne', record]);
    },
    async createIndex(index) { calls.push(['createIndex', index]); },
    find(query, options) {
      calls.push(['find', query, options]);
      assert.deepEqual(options, { projection: { _id: 0 } });
      const selected = rows.filter((row) => row.loop_id === query.loop_id
        && row.timestamp > query.timestamp.$gt
        && (query.timestamp.$lt === undefined || row.timestamp < query.timestamp.$lt)
        && (query.service === undefined || row.service === query.service));
      return {
        limit(value) {
          calls.push(['limit', value]);
          return selected.slice(0, value).map(({ _id, ...row }) => row);
        },
      };
    },
    async deleteMany(query) {
      calls.push(['deleteMany', query]);
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].loop_id === query.loop_id) rows.splice(index, 1);
      }
      return { deletedCount: before - rows.length };
    },
  };
  const store = createGqaAttributionStore({ collection, clock: () => FIXED_NOW });
  await store.insert('Bing', 'answer.', 'https://fixture.invalid/a', null, 'loop-1');
  assert.deepEqual(await store.search('loop-1', 'Bing', FIXED_NOW + 2, 0), [{
    service: 'Bing', query: 'answer.', url: 'https://fixture.invalid/a',
    image_url: null, loop_id: 'loop-1', timestamp: FIXED_NOW,
  }]);
  assert.equal(await store.wipe('loop-1'), 1);
  assert.deepEqual(calls, [
    ['insertOne', {
      service: 'Bing', query: 'answer.', url: 'https://fixture.invalid/a',
      image_url: null, loop_id: 'loop-1', timestamp: FIXED_NOW,
    }],
    ['createIndex', { loop_id: -1, timestamp: -1, service: -1 }],
    ['find', {
      loop_id: 'loop-1',
      timestamp: { $gt: FIXED_NOW - (90 * 24 * 60 * 60 * 1000), $lt: FIXED_NOW + 2 },
      service: 'Bing',
    }, { projection: { _id: 0 } }],
    ['limit', 50],
    ['deleteMany', { loop_id: 'loop-1' }],
  ]);
});

test('Mongo attribution storage returns complete inserted records through retrieveAtt and wipes them', async () => {
  const rows = [];
  const collection = {
    async insertOne(record) {
      rows.push({ _id: `mongo-id-${rows.length + 1}`, ...record });
    },
    async createIndex() {},
    find(query, options) {
      assert.deepEqual(options, { projection: { _id: 0 } });
      const selected = rows.filter((row) => row.loop_id === query.loop_id
        && row.timestamp > query.timestamp.$gt
        && (query.timestamp.$lt === undefined || row.timestamp < query.timestamp.$lt)
        && (query.service === undefined || row.service === query.service));
      return {
        limit(value) {
          return selected.slice(0, value).map(({ _id, ...record }) => record);
        },
      };
    },
    async deleteMany(query) {
      const matching = rows.filter((row) => row.loop_id === query.loop_id).length;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].loop_id === query.loop_id) rows.splice(index, 1);
      }
      return { deletedCount: matching };
    },
  };
  const attribution = createGqaAttributionStore({ collection, clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'A source answer.', 'https://fixture.invalid/a', null, 'loop-1');
  await attribution.insert('Wolfram Alpha', 'A calculation.', 'https://fixture.invalid/b', 'https://fixture.invalid/b.jpg', 'loop-1');
  await attribution.insert('Bing', 'Another loop.', 'https://fixture.invalid/c', null, 'loop-2');

  const service = createGqaMultiProviderService({
    profile: {
      skillId: 'answer',
      handler: createGqaAnswerSkill({ provider: async () => ({}) }),
      accountLookup: async (accountId) => (accountId === 'account-1' ? 'loop-1' : {}),
      attribution,
      attributionAuth: TEST_ATTRIBUTION_AUTH,
    },
  });
  const server = await service.listen(0);
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const retrieve = await fetch(`${baseUrl}/retrieveAtt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
      },
      body: JSON.stringify({ Service: 'Bing', after: FIXED_NOW - 1, before: FIXED_NOW + 1 }),
    });
    assert.equal(retrieve.status, 200);
    assert.equal(retrieve.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await retrieve.text()), {
      data: [{
        service: 'Bing',
        query: 'A source answer.',
        url: 'https://fixture.invalid/a',
        image_url: null,
        loop_id: 'loop-1',
        timestamp: FIXED_NOW,
      }],
    });

    const wipe = await fetch(`${baseUrl}/wipeID`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ID: 'loop-1' }),
    });
    assert.equal(wipe.status, 200);
    assert.deepEqual(JSON.parse(await wipe.text()), { deleted_row: 2 });

    const afterWipe = await fetch(`${baseUrl}/retrieveAtt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
      },
      body: JSON.stringify({ Service: 'Bing' }),
    });
    assert.equal(afterWipe.status, 200);
    assert.deepEqual(JSON.parse(await afterWipe.text()), { data: [] });
  } finally {
    await closeServer(server);
  }
});

test('Mongo attribution storage applies the source service/window filters before its 50-row limit', async () => {
  const rows = [];
  const collection = {
    async insertOne(record) { rows.push({ _id: rows.length + 1, ...record }); },
    async createIndex() {},
    find(query, options) {
      assert.deepEqual(options, { projection: { _id: 0 } });
      const selected = rows.filter((row) => row.loop_id === query.loop_id
        && row.service === query.service
        && row.timestamp > query.timestamp.$gt
        && row.timestamp < query.timestamp.$lt);
      return {
        limit(value) {
          return selected.slice(0, value).map(({ _id, ...record }) => record);
        },
      };
    },
    async deleteMany() { return { deletedCount: 0 }; },
  };
  const store = createGqaAttributionStore({ collection, clock: () => FIXED_NOW });
  for (let index = 0; index < 55; index += 1) {
    await store.insert('Bing', `answer-${index}`, `https://fixture.invalid/${index}`, null, 'loop-1');
  }
  await store.insert('Wolfram Alpha', 'wrong-service', 'https://fixture.invalid/wrong', null, 'loop-1');
  await store.insert('Bing', 'wrong-loop', 'https://fixture.invalid/other', null, 'loop-2');
  rows[0].timestamp = FIXED_NOW - 1;

  const result = await store.search('loop-1', 'Bing', FIXED_NOW + 1, FIXED_NOW - 1);
  assert.equal(result.length, 50);
  assert.equal(result[0].query, 'answer-1');
  assert.equal(result.at(-1).query, 'answer-50');
  assert.ok(result.every((record) => record.service === 'Bing' && record.loop_id === 'loop-1'));
});

test('answer profile resolves loop ID before providers and attributes Bing answers after punctuation', async () => {
  const order = [];
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  const handler = createGqaAnswerSkill({
    accountLookup: async (accountId) => {
      order.push(['account', accountId]);
      return 'loop-1';
    },
    attribution,
    provider: async (context) => {
      order.push(['provider', context.loopId]);
      return {
        source: 'Bing',
        type: 'entities',
        url: 'https://fixture.invalid/result',
        response: { type: 'string', payload: 'A fixture answer' },
      };
    },
    clock: () => FIXED_NOW,
    rng: () => 0,
  });
  const response = await handler(answerRequest());
  assert.equal(response.data.action.config.jcp.config.play.esml, 'A fixture answer.');
  assert.deepEqual(order, [['account', 'account-1'], ['provider', 'loop-1']]);
  assert.deepEqual(attribution.snapshot(), [{
    service: 'Bing',
    query: 'A fixture answer.',
    url: 'https://fixture.invalid/result',
    image_url: null,
    loop_id: 'loop-1',
    timestamp: FIXED_NOW,
  }]);
});

test('multi-provider profile accepts account endpoint and storage only as explicit options', () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  const profile = createGqaMultiProviderProfile({
    bing: { endpoint: 'http://fixture.invalid/bing', apiKey: 'fixture-key' },
    wikipedia: { endpoint: 'http://fixture.invalid/wiki' },
    wolfram: { endpoint: 'http://fixture.invalid/wolfram', apiKey: 'fixture-key' },
    account: { endpoint: 'http://fixture.invalid/account' },
    attribution,
  });
  assert.equal(typeof profile.accountLookup, 'function');
  assert.equal(profile.attribution, attribution);
});

test('explicit profile exposes source attribution routes without changing the default route envelope', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/result', null, 'loop-1');
  const accountLookup = async (accountId) => (accountId === 'account-1' ? 'loop-1' : {});
  const handler = createGqaAnswerSkill({ provider: async () => ({}) });
  const service = createGqaMultiProviderService({
    profile: {
      skillId: 'answer',
      handler,
      accountLookup,
      attribution,
      attributionAuth: TEST_ATTRIBUTION_AUTH,
    },
  });
  const server = await service.listen(0);
  try {
    const retrieve = await fetch(`http://127.0.0.1:${server.address().port}/retrieveAtt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
      },
      body: JSON.stringify({ Service: 'Bing' }),
    });
    assert.equal(retrieve.status, 200);
    assert.equal(retrieve.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(JSON.parse(await retrieve.text()), {
      data: [{
        service: 'Bing',
        query: 'A fixture answer.',
        url: 'https://fixture.invalid/result',
        image_url: null,
        loop_id: 'loop-1',
        timestamp: FIXED_NOW,
      }],
    });

    const wipe = await fetch(`http://127.0.0.1:${server.address().port}/wipeID`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ID: 'loop-1' }),
    });
    assert.equal(wipe.status, 200);
    assert.deepEqual(JSON.parse(await wipe.text()), { deleted_row: 1 });
  } finally {
    await closeServer(server);
  }
});

test('attribution route factories keep authenticated source status for missing IDs', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  const retrieve = createGqaRetrieveAttributionRoute({
    accountLookup: async () => 'loop-1',
    attribution,
    attributionAuth: TEST_ATTRIBUTION_AUTH,
  });
  const wipe = createGqaWipeAttributionRoute({
    accountLookup: async () => 'loop-1',
    attribution,
    attributionAuth: TEST_ATTRIBUTION_AUTH,
  });
  const sent = [];
  const response = {
    status(code) { sent.push(['status', code]); return this; },
    type(value) { sent.push(['type', value]); return this; },
    send(value) { sent.push(['send', value]); return this; },
  };
  await retrieve({ body: {}, req: { headers: { 'content-type': 'application/json', 'content-length': '2' } }, res: response });
  assert.equal(sent[0][0], 'status');
  assert.equal(sent[0][1], 200);
  sent.length = 0;
  await wipe({ body: {}, req: { headers: {} }, res: response });
  assert.equal(sent[0][0], 'status');
  assert.equal(sent[0][1], 500);
  assert.ok(createGqaHttpRoute({ handler: async () => ({}) }).jsonStrict === false);
});

test('attribution routes fail closed without a verified identity or trusted internal opt-in', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'private answer', 'https://fixture.invalid/private', null, 'loop-1');
  const routes = {
    'POST /retrieveAtt': createGqaRetrieveAttributionRoute({
      accountLookup: async () => 'loop-1',
      attribution,
    }),
    'POST /wipeID': createGqaWipeAttributionRoute({ attribution }),
  };
  const server = await createService({ name: 'q01-attribution-auth-required', routes }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = {
      'content-type': 'application/json',
      'x-amz-credentials': JSON.stringify({ id: 'account-1', isAdmin: true }),
    };
    const retrieve = await fetch(`${base}/retrieveAtt`, {
      method: 'POST', headers, body: JSON.stringify({ Service: 'Bing' }),
    });
    assert.equal(retrieve.status, 503);
    assert.deepEqual(await retrieve.json(), {
      version: '5.2.15',
      message: 'Attribution authorization is not configured',
    });

    const wipe = await fetch(`${base}/wipeID`, {
      method: 'POST', headers, body: JSON.stringify({ ID: 'loop-1' }),
    });
    assert.equal(wipe.status, 503);
    assert.deepEqual(await wipe.json(), {
      version: '5.2.15',
      message: 'Attribution authorization is not configured',
    });
    assert.equal((await attribution.search('loop-1', 'Bing', FIXED_NOW + 1, FIXED_NOW - 1)).length, 1);
  } finally {
    await closeServer(server);
  }
});

test('trusted internal attribution opt-in is address-bound and ignores forwarded client addresses', async () => {
  const configured = readGqaAttributionAuthConfig({
    [GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV]: 'true',
    [GQA_ATTRIBUTION_TRUSTED_INTERNAL_ADDRESSES_ENV]: '10.0.0.7, ::1',
  });
  assert.deepEqual(configured, {
    trustedInternal: {
      mode: 'trusted-internal',
      remoteAddresses: ['10.0.0.7', '::1'],
    },
  });

  const authorize = createGqaAttributionAuthorizer(configured);
  const headers = {
    'x-amz-credentials': JSON.stringify({ id: 'account-1', isAdmin: true }),
    'x-forwarded-for': '10.0.0.7',
  };
  assert.deepEqual(await authorize({ headers, socket: { remoteAddress: '10.0.0.7' } }), {
    accountId: 'account-1', isAdmin: true,
  });
  assert.equal(await authorize({ headers, socket: { remoteAddress: '203.0.113.10' } }), null);
  assert.equal(await authorize({ headers, socket: { remoteAddress: '::ffff:203.0.113.10' } }), null);
  assert.throws(
    () => readGqaAttributionAuthConfig({ [GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV]: 'maybe' }),
    /must be true or false/,
  );
});

test('attribution authorization uses the verified caller, not forged credentials headers, and enforces owner/admin access', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'account one', 'https://fixture.invalid/one', null, 'loop-1');
  await attribution.insert('Bing', 'account two', 'https://fixture.invalid/two', null, 'loop-2');
  const callers = {
    'Bearer account-one': { accountId: 'account-1', isAdmin: false },
    'Bearer account-two': { accountId: 'account-2', isAdmin: false },
    'Bearer administrator': { accountId: 'account-admin', isAdmin: true },
  };
  const attributionAuth = {
    verifyCaller: async (request) => callers[request.headers.authorization] || null,
  };
  const accountLookup = async (accountId) => ({
    'account-1': 'loop-1',
    'account-2': 'loop-2',
  }[accountId] || {});
  const routes = {
    'POST /retrieveAtt': createGqaRetrieveAttributionRoute({ accountLookup, attribution, attributionAuth }),
    'POST /wipeID': createGqaWipeAttributionRoute({ accountLookup, attribution, attributionAuth }),
  };
  const server = await createService({ name: 'q01-attribution-authz', routes }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, authorization, extraHeaders = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization,
      // This must never become the identity source once verifyCaller is configured.
      'x-amz-credentials': JSON.stringify({ id: 'account-1', isAdmin: true }),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  try {
    const forgedRead = await post(
      '/retrieveAtt',
      { Service: 'Bing', ID: 'loop-1', loop_id: 'loop-1', accountID: 'account-1' },
      'Bearer account-two',
    );
    assert.equal(forgedRead.status, 200);
    assert.deepEqual((await forgedRead.json()).data.map((row) => row.loop_id), ['loop-2']);

    const unauthenticated = await post('/retrieveAtt', { Service: 'Bing' }, undefined);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).message, 'Attribution authorization required');

    const crossAccountDelete = await post('/wipeID', { ID: 'loop-1' }, 'Bearer account-two');
    assert.equal(crossAccountDelete.status, 403);
    assert.equal((await crossAccountDelete.json()).message, 'Attribution access denied');
    assert.equal((await attribution.search('loop-1', 'Bing', FIXED_NOW + 1, FIXED_NOW - 1)).length, 1);

    const ownerDelete = await post('/wipeID', { ID: 'loop-1' }, 'Bearer account-one');
    assert.equal(ownerDelete.status, 200);
    assert.deepEqual(await ownerDelete.json(), { deleted_row: 1 });

    const adminDelete = await post('/wipeID', { ID: 'loop-2' }, 'Bearer administrator');
    assert.equal(adminDelete.status, 200);
    assert.deepEqual(await adminDelete.json(), { deleted_row: 1 });
  } finally {
    await closeServer(server);
  }
});

test('direct HTTP SigV4 attribution adapter verifies signed caller bytes and owner/admin boundaries', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'owner answer', 'https://fixture.invalid/owner', null, 'gqa-owner-loop');
  await attribution.insert('Bing', 'other answer', 'https://fixture.invalid/other', null, 'gqa-other-loop');

  const credentialByAccessKey = new Map(
    Object.values(SIGV4_ACCOUNTS).map((account) => [account.accessKeyId, account]),
  );
  const accountById = new Map(Object.values(SIGV4_ACCOUNTS).map((account) => [account._id, account]));
  const resolvedAccessKeys = [];
  const lookedUpAccountIds = [];
  const verifyCaller = createGqaSigV4CallerVerifier({
    resolveCredentials: (accessKeyId) => {
      resolvedAccessKeys.push(accessKeyId);
      return credentialByAccessKey.get(accessKeyId) || null;
    },
    accountLookup: (accountId, ...unexpectedArguments) => {
      assert.equal(unexpectedArguments.length, 0);
      lookedUpAccountIds.push(accountId);
      return accountById.get(accountId) || null;
    },
    clock: () => SIGV4_DATE,
  });
  const ownedLoops = {
    [SIGV4_ACCOUNTS.owner._id]: 'gqa-owner-loop',
    [SIGV4_ACCOUNTS.other._id]: 'gqa-other-loop',
  };
  const routes = {
    'POST /retrieveAtt': createGqaRetrieveAttributionRoute({
      accountLookup: async (accountId) => ownedLoops[accountId] || {},
      attribution,
      attributionAuth: { verifyCaller },
    }),
    'POST /wipeID': createGqaWipeAttributionRoute({
      accountLookup: async (accountId) => ownedLoops[accountId] || {},
      attribution,
      attributionAuth: { verifyCaller },
    }),
  };
  const server = await createService({ name: 'q01-attribution-sigv4-e2e', routes }).listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await postSignedAttribution(
      baseUrl,
      '/retrieveAtt',
      {
        Service: 'Bing',
        ID: 'gqa-other-loop',
        loop_id: 'gqa-other-loop',
        accountID: SIGV4_ACCOUNTS.other._id,
        after: FIXED_NOW - 1,
        before: FIXED_NOW + 1,
      },
      SIGV4_ACCOUNTS.owner,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((row) => row.loop_id), ['gqa-owner-loop']);
    assert.deepEqual(resolvedAccessKeys, [SIGV4_ACCOUNTS.owner.accessKeyId]);
    assert.deepEqual(lookedUpAccountIds, [SIGV4_ACCOUNTS.owner._id]);

    response = await postSignedAttribution(
      baseUrl,
      '/retrieveAtt',
      { Service: 'Bing', after: FIXED_NOW - 1, before: FIXED_NOW + 1 },
      SIGV4_ACCOUNTS.other,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map((row) => row.loop_id), ['gqa-other-loop']);
    assert.deepEqual(resolvedAccessKeys, [SIGV4_ACCOUNTS.owner.accessKeyId, SIGV4_ACCOUNTS.other.accessKeyId]);
    assert.deepEqual(lookedUpAccountIds, [SIGV4_ACCOUNTS.owner._id, SIGV4_ACCOUNTS.other._id]);

    const tampered = signedAttributionRequest(
      baseUrl,
      '/retrieveAtt',
      { Service: 'Bing', after: FIXED_NOW - 1, before: FIXED_NOW + 1 },
      SIGV4_ACCOUNTS.owner,
    );
    response = await fetch(`${baseUrl}/retrieveAtt`, {
      method: 'POST',
      headers: tampered.headers,
      body: JSON.stringify({ Service: 'Bing', ID: 'gqa-other-loop' }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, 'Attribution authorization required');

    response = await postSignedAttribution(
      baseUrl,
      '/retrieveAtt',
      { Service: 'Bing' },
      SIGV4_ACCOUNTS.owner,
      new Date(FIXED_NOW - (15 * 60 * 1000) - 1),
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, 'Attribution authorization required');

    response = await postSignedAttribution(
      baseUrl,
      '/wipeID',
      { ID: 'gqa-owner-loop' },
      SIGV4_ACCOUNTS.other,
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).message, 'Attribution access denied');
    assert.equal(attribution.snapshot().length, 2);

    response = await postSignedAttribution(
      baseUrl,
      '/wipeID',
      { ID: { $ne: 'gqa-owner-loop' } },
      SIGV4_ACCOUNTS.admin,
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).message, 'Attribution access denied');
    assert.equal(attribution.snapshot().length, 2);

    response = await postSignedAttribution(
      baseUrl,
      '/wipeID',
      { ID: 'gqa-owner-loop' },
      SIGV4_ACCOUNTS.owner,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted_row: 1 });

    response = await postSignedAttribution(
      baseUrl,
      '/wipeID',
      { ID: 'gqa-other-loop' },
      SIGV4_ACCOUNTS.admin,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted_row: 1 });
    assert.deepEqual(attribution.snapshot(), []);
  } finally {
    await closeServer(server);
  }
});

test('SigV4 attribution adapter refuses to verify a parsed body without raw bytes', async () => {
  const account = SIGV4_ACCOUNTS.owner;
  const signed = signSigV4({
    method: 'POST',
    path: '/retrieveAtt',
    body: '',
    headers: { Host: '127.0.0.1:0', 'Content-Type': 'application/json' },
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date: SIGV4_DATE,
  });
  const verifyCaller = createGqaSigV4CallerVerifier({
    resolveCredentials: () => account,
    accountLookup: () => account,
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => verifyCaller({
      method: 'POST',
      url: '/retrieveAtt',
      headers: signed.headers,
      body: { Service: 'Bing' },
    }),
    /raw request body is required/,
  );
  await assert.rejects(
    () => verifyCaller({
      url: '/retrieveAtt',
      headers: signed.headers,
      rawBody: Buffer.alloc(0),
    }),
    /HTTP method is required/,
  );
  assert.throws(
    () => createGqaSigV4CallerVerifier({
      resolveCredentials: () => account,
      accountLookup: () => account,
      allowNativeClientPayloadHash: true,
    }),
    /allowNativeClientPayloadHash must remain disabled/,
  );

  const compressedRequest = signedAttributionRequest(
    'http://127.0.0.1:0',
    '/retrieveAtt',
    { Service: 'Bing' },
    account,
  );
  await assert.rejects(
    () => verifyCaller({
      method: 'POST',
      url: '/retrieveAtt',
      headers: { ...compressedRequest.headers, 'content-encoding': 'gzip' },
      // createService exposes inflated bytes here; GQA must reject the
      // compressed transport rather than authenticate these reconstructed bytes.
      rawBody: Buffer.from(compressedRequest.body),
    }),
    /compressed content encoding/,
  );
  await assert.rejects(
    () => verifyCaller({
      method: 'POST',
      url: '/retrieveAtt?opaque=one?two',
      headers: signed.headers,
      rawBody: Buffer.alloc(0),
    }),
    /query parameters/,
  );
});

test('SigV4 adapter rejects unknown, inactive, mismatched, and tampered callers', async () => {
  const baseUrl = 'http://127.0.0.1:65535';
  const owner = SIGV4_ACCOUNTS.owner;
  const unknown = sigV4FixtureAccount('gqa-unknown-account', false);
  const inactive = Object.freeze({ ...sigV4FixtureAccount('gqa-inactive-account', false), isActive: false });
  const deleted = Object.freeze({ ...owner, isDeleted: true });
  const requestFrom = (signed, overrides = {}) => ({
    method: 'POST',
    originalUrl: '/retrieveAtt',
    headers: signed.headers,
    rawBody: Buffer.from(signed.body),
    ...overrides,
  });
  const signedOwner = signedAttributionRequest(baseUrl, '/retrieveAtt', { Service: 'Bing' }, owner);
  const signedUnknown = signedAttributionRequest(baseUrl, '/retrieveAtt', { Service: 'Bing' }, unknown);

  const unknownVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => null,
    accountLookup: () => owner,
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => unknownVerifier(requestFrom(signedUnknown)),
    (error) => error?.code === 'ACCESS_KEY_NOT_FOUND',
  );

  const inactiveVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => inactive,
    accountLookup: () => inactive,
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => inactiveVerifier(requestFrom(signedOwner)),
    (error) => error?.code === 'ACCOUNT_NOT_ACTIVE',
  );

  const deletedVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => deleted,
    accountLookup: () => owner,
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => deletedVerifier(requestFrom(signedOwner)),
    /GQA SigV4 credentials are not active/,
  );

  const mismatchVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => owner,
    accountLookup: () => sigV4FixtureAccount('gqa-mismatched-account', false),
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => mismatchVerifier(requestFrom(signedOwner)),
    /GQA SigV4 account identity is unavailable/,
  );

  const nonBooleanCredentialVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => ({ ...owner, isActive: 'yes' }),
    accountLookup: () => owner,
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => nonBooleanCredentialVerifier(requestFrom(signedOwner)),
    /GQA SigV4 credentials are not active/,
  );

  const missingAccountActiveVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => owner,
    accountLookup: () => ({ ...owner, isActive: undefined }),
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => missingAccountActiveVerifier(requestFrom(signedOwner)),
    /GQA SigV4 account is not active/,
  );

  const inactiveAccountVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => owner,
    accountLookup: () => ({ ...owner, isActive: false }),
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => inactiveAccountVerifier(requestFrom(signedOwner)),
    /GQA SigV4 account is not active/,
  );

  const deletedAccountVerifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => owner,
    accountLookup: () => ({ ...owner, isActive: true, isDeleted: true }),
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => deletedAccountVerifier(requestFrom(signedOwner)),
    /GQA SigV4 account is not active/,
  );

  const verifier = createGqaSigV4CallerVerifier({
    resolveCredentials: () => owner,
    accountLookup: () => owner,
    clock: () => SIGV4_DATE,
  });
  await assert.rejects(
    () => verifier(requestFrom(signedOwner, { method: 'GET' })),
    (error) => error?.code === 'SIGNATURE_MISMATCH',
  );
  await assert.rejects(
    () => verifier(requestFrom(signedOwner, { originalUrl: '/wipeID' })),
    (error) => error?.code === 'SIGNATURE_MISMATCH',
  );
  await assert.rejects(
    () => verifier(requestFrom({
      ...signedOwner,
      headers: { ...signedOwner.headers, 'x-amz-content-sha256': '0'.repeat(64) },
    })),
    (error) => error?.code === 'SIGNATURE_MISMATCH',
  );
});

test('direct HTTP SigV4 attribution errors keep a fixed response and sanitized bounded logs', async () => {
  const hostileError = new Error(
    `password=fixture-http-password\nBearer fixture-http-token\u0000${'p'.repeat(700)}`,
  );
  hostileError.name = `name\r\nsecret=fixture-http-name-secret\u001b[31m${'n'.repeat(300)}`;
  hostileError.code = `code\t x-amz-credentials=fixture-http-code-secret\u007f${'c'.repeat(300)}`;
  const hostileCause = new Error(
    `token=fixture-http-cause-token\n${'q'.repeat(700)}`,
  );
  hostileCause.name = `cause-name\r\npassword=fixture-http-cause-name\u001b${'r'.repeat(300)}`;
  hostileCause.code = `cause-code\tsecret=fixture-http-cause-code\u007f${'s'.repeat(300)}`;
  hostileError.cause = hostileCause;
  const attribution = {
    async search() { throw hostileError; },
    async wipe() { throw hostileError; },
  };
  const verifyCaller = createGqaSigV4CallerVerifier({
    resolveCredentials: () => SIGV4_ACCOUNTS.owner,
    accountLookup: (accountId) => accountId === SIGV4_ACCOUNTS.owner._id ? SIGV4_ACCOUNTS.owner : null,
    clock: () => SIGV4_DATE,
  });
  const routes = {
    'POST /retrieveAtt': createGqaRetrieveAttributionRoute({
      accountLookup: async () => 'gqa-owner-loop',
      attribution,
      attributionAuth: { verifyCaller },
    }),
  };
  const server = await createService({ name: 'q01-attribution-safe-http', routes }).listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    const response = await postSignedAttribution(
      baseUrl,
      '/retrieveAtt',
      { Service: 'Bing' },
      SIGV4_ACCOUNTS.owner,
    );
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(body), {
      version: '5.2.15',
      message: 'Internal server error',
    });
    const logText = writes.join('');
    assert.doesNotMatch(body, /fixture-http/);
    assert.doesNotMatch(logText, /fixture-http-password|fixture-http-token|fixture-http-name-secret|fixture-http-code-secret|fixture-http-cause-token|fixture-http-cause-name|fixture-http-cause-code/);
    assert.doesNotMatch(logText, /PRIVATE_STACK_SENTINEL/);
    let records = 0;
    let causes = 0;
    for (const line of writes) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (!parsed.error) continue;
      records += 1;
      if (parsed.cause) causes += 1;
      for (const details of [parsed.error, parsed.cause]) {
        if (!details) continue;
        for (const value of [details.name, details.code, details.message]) {
          if (value === undefined) continue;
          assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/);
          assert.ok(value.length <= 512);
        }
      }
    }
    assert.equal(records, 1);
    assert.equal(causes, 1);
  } finally {
    process.stderr.write = originalWrite;
    await closeServer(server);
  }
});

test('GQA attribution and source HTTP errors disclose no stack and log only sanitized detail', async () => {
  const sourceError = new Error('database password=fixture-secret');
  sourceError.stack = 'Error: database password=fixture-secret\n    at PRIVATE_STACK_SENTINEL';
  const logs = [];
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
  const attribution = {
    async search() { throw sourceError; },
    async wipe() { throw sourceError; },
  };
  const retrieve = createGqaRetrieveAttributionRoute({
    accountLookup: async () => 'loop-1',
    attribution,
    attributionAuth: { verifyCaller: async () => ({ accountId: 'account-1' }) },
  });
  await retrieve({
    req: { headers: { authorization: 'Bearer verified' } },
    body: { Service: 'Bing' },
    res: response,
    log: { error: (message, fields) => logs.push([message, fields]) },
  });
  const retrieveBody = JSON.parse(response.body);
  assert.equal(response.statusCode, 500);
  assert.equal(retrieveBody.message, 'Internal server error');
  assert.equal(Object.prototype.hasOwnProperty.call(retrieveBody, 'stacktrace'), false);
  assert.doesNotMatch(response.body, /PRIVATE_STACK_SENTINEL|fixture-secret/);
  assert.equal(logs[0][1].error.stack, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_STACK_SENTINEL/);

  const sourceResponse = { ...response, statusCode: null, body: null };
  const sourceLogs = [];
  const sourceRoute = createGqaHttpRoute({ handler: async () => { throw sourceError; } });
  await sourceRoute({
    req: { headers: { 'x-jibo-transid': 'gqa-stack-test' } },
    body: answerRequest(),
    res: sourceResponse,
    log: { error: (message, fields) => sourceLogs.push([message, fields]) },
  });
  const sourceBody = JSON.parse(sourceResponse.body);
  assert.equal(sourceResponse.statusCode, 500);
  assert.equal(sourceBody.message, 'Internal server error');
  assert.equal(Object.prototype.hasOwnProperty.call(sourceBody, 'stacktrace'), false);
  assert.doesNotMatch(sourceResponse.body, /PRIVATE_STACK_SENTINEL|fixture-secret/);
  assert.equal(sourceLogs[0][1].error.stack, undefined);
});

test('safe GQA error detail sanitizes and bounds every logged error field', () => {
  const error = new Error(
    `password=fixture-password\nBearer fixture-token\u0000${'m'.repeat(700)}`,
  );
  error.name = `name\r\nsecret=fixture-name-secret\u001b[31m${'n'.repeat(300)}`;
  error.code = `code\t x-amz-credentials=fixture-credential-secret\u007f${'c'.repeat(300)}`;

  const detail = safeGqaErrorDetail(error);
  assert.deepEqual(Object.keys(detail), ['name', 'code', 'message']);
  assert.ok(detail.name.length <= 128);
  assert.ok(detail.code.length <= 128);
  assert.ok(detail.message.length <= 512);
  for (const value of Object.values(detail)) {
    assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/);
  }
  assert.doesNotMatch(JSON.stringify(detail), /fixture-password|fixture-token|fixture-name-secret|fixture-credential-secret/);

  for (const [code, message] of [
    ['ACCESS_KEY_NOT_FOUND', 'Access key not found'],
    ['ACCOUNT_NOT_ACTIVE', 'Account not active'],
    ['MISSING_AUTH_HEADER', 'Request is not signed properly, missing authorization header'],
    ['MISSING_DATE_HEADER', 'Request must contain Date or X-Amz-Date header'],
    ['MISSING_ENCRYPTION_ALGORITHM', 'Request is not signed properly, encryption algorithm not specified'],
    ['SIGNATURE_MISMATCH', 'Signature does not match'],
    ['ACCOUNT_SERVICE_UNAVAILABLE', 'Account service not found'],
    ['CLOCK_SKEW_TOO_LONG', 'Clock skew is more than 15 minutes'],
  ]) {
    const stableError = new Error(message);
    stableError.name = code;
    stableError.code = code;
    assert.deepEqual(safeGqaErrorDetail(stableError), {
      name: code,
      code,
      message,
    });
  }
  for (const message of [
    'Attribution authorization required',
    'Attribution authorization is not configured',
    'Attribution access denied',
  ]) {
    assert.equal(safeGqaErrorDetail(new Error(message)).message, message);
  }
  assert.equal(
    safeGqaErrorDetail(new Error('Provider path /search?q=hello%20world')).message,
    'Provider path /search?q=hello%20world',
  );
  assert.equal(
    safeGqaErrorDetail(new Error('Provider path /search?q=caf%C3%A9')).message,
    'Provider path /search?q=caf%C3%A9',
  );
  for (const [message, value] of [
    ['password&equals;fixture-encoded-delimiter-secret', 'fixture-encoded-delimiter-secret'],
    ['Authorization&colon;Bearer fixture-encoded-auth-secret', 'fixture-encoded-auth-secret'],
  ]) {
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(new Error(message))), new RegExp(value));
  }
  const mixedEncodedMarker = new Error(
    'p assword=fixture-space-split-secret; token=fixture-mixed-token',
  );
  assert.doesNotMatch(
    JSON.stringify(safeGqaErrorDetail(mixedEncodedMarker)),
    /fixture-space-split-secret|fixture-mixed-token/,
  );
  assert.equal(
    safeGqaErrorDetail(new Error('tokens=100; latency=45ms')).message,
    'tokens=100; latency=45ms',
  );
  assert.equal(
    safeGqaErrorDetail(new Error('Basically unavailable\n')).message,
    String.raw`Basically unavailable\u000a`,
  );
  assert.equal(
    safeGqaErrorDetail(new Error('Basic operation failed\n')).message,
    String.raw`Basic operation failed\u000a`,
  );
  for (const marker of [
    String.raw`secre\u0074accesskey`,
    'secre%u0074accesskey',
  ]) {
    const adjacentEscape = new Error(`{\"${marker}\":\"fixture-adjacent-escape-secret\"}`);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(adjacentEscape)), /fixture-adjacent-escape-secret/);
  }

  const jsonCredentialError = new Error(
    '{"password":"fixture-json-password","secretAccessKey":"fixture-json-secret"}',
  );
  jsonCredentialError.name = '{"Authorization":"Bearer fixture-json-token","Cookie":"fixture-cookie=fixture-json-cookie-secret; second=fixture-json-cookie-secret-2"}';
  jsonCredentialError.code = '{"apiKey":"fixture-json-api-key"}';
  const jsonDetail = safeGqaErrorDetail(jsonCredentialError);
  assert.doesNotMatch(JSON.stringify(jsonDetail), /fixture-json-password|fixture-json-secret|fixture-json-token|fixture-json-cookie-secret|fixture-json-api-key/);

  const headerValueError = new Error('Authorization: Bearer fixture-header-token; trailing=fixture-header-secret');
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(headerValueError)), /fixture-header-token|fixture-header-secret/);

  const multilineCredentialError = new Error('password=fixture-multiline-first\nfixture-multiline-password');
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(multilineCredentialError)), /fixture-multiline-first|fixture-multiline-password/);

  const escapedCredentialError = new Error(String.raw`{\\"password\\":\\"fixture-escaped-password\\"}`);
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(escapedCredentialError)), /fixture-escaped-password/);

  const splitCredentialError = new Error('p\u0000assword=fixture-split-password');
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(splitCredentialError)), /fixture-split-password/);

  const serializedMarker = `p\u0000assword`;
  const serializedCredentialError = new Error(JSON.stringify({ [serializedMarker]: '731942' }));
  serializedCredentialError.cause = new Error(String.raw`{"p\u0061ssword":"842753"}`);
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(serializedCredentialError)), /731942/);
  assert.doesNotMatch(JSON.stringify(safeGqaErrorCause(serializedCredentialError)), /842753/);

  const serializedAccessKeyError = new Error(String.raw`{"access\u0000Key":"953164"}`);
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(serializedAccessKeyError)), /953164/);

  for (const [separator, value] of [['\\n', '164275'], ['\\t', '275386'], ['\\r', '386497'], ['\\b', '497518'], ['\\f', '518629']]) {
    const serializedShortEscape = new Error(`{"p${separator}assword":"${value}"}`);
    serializedShortEscape.cause = new Error(serializedShortEscape.message);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(serializedShortEscape)), new RegExp(value));
    assert.doesNotMatch(JSON.stringify(safeGqaErrorCause(serializedShortEscape)), new RegExp(value));
  }

  for (const [marker, value] of [[String.raw`p\\u0061ssword`, '629731'], [String.raw`cred\\u0065ntial`, '731842']]) {
    const nestedEscapedCredential = new Error(`{"${marker}":"${value}"}`);
    nestedEscapedCredential.cause = new Error(nestedEscapedCredential.message);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(nestedEscapedCredential)), new RegExp(value));
    assert.doesNotMatch(JSON.stringify(safeGqaErrorCause(nestedEscapedCredential)), new RegExp(value));
  }

  const deeplyEscapedMarker = `p${'\\'.repeat(12)}u0061ssword`;
  const deeplyEscapedCredential = new Error(`{"${deeplyEscapedMarker}":"417268"}`);
  assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(deeplyEscapedCredential)), /417268/);

  for (const [marker, value] of [
    [String.raw`p\qassword`, '268379'],
    [String.raw`p&UnknownEntity;assword`, '379481'],
  ]) {
    const unresolvedEncodedCredential = new Error(`{"${marker}":"${value}"}`);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(unresolvedEncodedCredential)), new RegExp(value));
  }

  for (const [marker, value] of [
    [String.raw`p\u{61}ssword`, '379481'],
    [String.raw`p\U00000061ssword`, '481592'],
    ['p&#97;ssword', '592613'],
    ['p&#x61;ssword', '613724'],
    ['ｐａｓｓｗｏｒｄ', '724835'],
    [String.raw`p\u{ff50}assword`, '835946'],
    ['%EF%BD%90assword', '946157'],
    ['p&Tab;assword', '157268'],
  ]) {
    const alternateEncodedCredential = new Error(`{"${marker}":"${value}"}`);
    alternateEncodedCredential.cause = new Error(alternateEncodedCredential.message);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(alternateEncodedCredential)), new RegExp(value));
    assert.doesNotMatch(JSON.stringify(safeGqaErrorCause(alternateEncodedCredential)), new RegExp(value));
  }

  for (const [marker, value] of [[String.raw`p\141ssword`, '842953'], [String.raw`p\\141ssword`, '953164']]) {
    const octalEscapedCredential = new Error(`{"${marker}":"${value}"}`);
    octalEscapedCredential.cause = new Error(octalEscapedCredential.message);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(octalEscapedCredential)), new RegExp(value));
    assert.doesNotMatch(JSON.stringify(safeGqaErrorCause(octalEscapedCredential)), new RegExp(value));
  }
});

test('safe GQA error detail fails closed for legacy escapes and invisible separators', () => {
  const cases = [
    ['legacy percent-unicode', 'p%u0061ssword', 'fixture-legacy-percent-secret'],
    ['legacy percent-uppercase-unicode', 'p%U00000061ssword', 'fixture-legacy-uppercase-percent-secret'],
    ['malformed percent escape', 'p%ZZassword', 'fixture-malformed-percent-secret'],
    ['invalid UTF-8 percent escape', 'p%E0%A4%Aassword', 'fixture-invalid-utf8-percent-secret'],
    ['zero-width separator', 'p\\u200Bassword', 'fixture-zero-width-secret'],
    ['soft-hyphen separator', 'p\\u00adassword', 'fixture-soft-hyphen-secret'],
    ['non-breaking-space separator', 'p\\u00a0assword', 'fixture-nbsp-secret'],
    ['formatted bearer scheme', 'Bearer\\u200Bfixture-bearer-secret', 'fixture-bearer-secret'],
    ['HTML backslash entity', 'p&bsol;u0061ssword', 'fixture-html-backslash-secret'],
    ['HTML percent entity', 'p&percnt;61ssword', 'fixture-html-percent-secret'],
  ];
  let deeplyEncodedMarker = '%70%61%73%73%77%6f%72%64';
  for (let pass = 0; pass < 40; pass += 1) {
    deeplyEncodedMarker = encodeURIComponent(deeplyEncodedMarker);
  }
  assert.notEqual(deeplyEncodedMarker, 'password');
  cases.push(['bounded nested percent-unicode', deeplyEncodedMarker, 'fixture-deeply-encoded-secret']);

  for (const [label, marker, value] of cases) {
    const error = new Error(`{\"${marker}\":\"${value}\"}`);
    error.cause = new Error(error.message);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorDetail(error)), new RegExp(value), label);
    assert.doesNotMatch(JSON.stringify(safeGqaErrorCause(error)), new RegExp(value), label);
  }
});

test('GQA handler error logging tolerates a throwing cause getter', async () => {
  const error = new Error('handler failure');
  Object.defineProperty(error, 'cause', {
    get() { throw new Error('PRIVATE_CAUSE_GETTER'); },
  });
  const route = createGqaHttpRoute({ handler: async () => { throw error; } });
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
  const logs = [];
  await assert.doesNotReject(() => route({
    req: { headers: { 'x-jibo-transid': 'gqa-cause-getter-test' } },
    body: answerRequest(),
    res: response,
    log: { error: (message, fields) => logs.push([message, fields]) },
  }));
  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    version: '5.2.15',
    message: 'Internal server error',
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].cause, undefined);
});

test('safe GQA error detail survives throwing getters and proxies', () => {
  const throwingGetters = {};
  for (const property of ['name', 'code', 'message', 'cause']) {
    Object.defineProperty(throwingGetters, property, {
      get() { throw new Error(`PRIVATE_${property.toUpperCase()}_GETTER`); },
    });
  }
  assert.deepEqual(safeGqaErrorDetail(throwingGetters), {
    name: 'Error',
    message: 'Unknown GQA attribution failure',
  });
  assert.equal(safeGqaErrorCause(throwingGetters), undefined);

  const hostileProxy = new Proxy({}, {
    get() { throw new Error('PRIVATE_PROXY_GETTER'); },
  });
  assert.doesNotThrow(() => safeGqaErrorDetail(hostileProxy));
  assert.deepEqual(safeGqaErrorDetail(hostileProxy), {
    name: 'Error',
    message: 'Unknown GQA attribution failure',
  });
});

test('safe GQA attribution routes survive a revoked error proxy', async () => {
  const revoked = Proxy.revocable({}, {});
  const error = revoked.proxy;
  revoked.revoke();
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(value) { this.body = value; return this; },
  };
  const route = createGqaRetrieveAttributionRoute({
    accountLookup: async () => ['revoked-loop'],
    attribution: { async search() { throw error; } },
    attributionAuth: { verifyCaller: async () => ({ accountId: 'revoked-account' }) },
  });
  const logs = [];
  await assert.doesNotReject(() => route({
    req: { headers: { 'content-type': 'application/json', 'content-length': '1' } },
    body: { Service: 'Bing' },
    res: response,
    log: { error: (message, fields) => logs.push([message, fields]) },
  }));
  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    version: '5.2.15',
    message: 'Internal server error',
  });
  assert.deepEqual(logs[0][1].error, {
    name: 'Error',
    message: 'Unknown GQA attribution failure',
  });
});

test('Wikipedia GQA profile applies the same attribution authorization boundary', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Wikipedia', 'profile answer', 'https://fixture.invalid/wiki', null, 'loop-1');
  const service = createGqaWikipediaService({
    endpoint: async () => ({ ok: true, async json() { return {}; } }),
    account: async () => 'loop-1',
    attribution,
    attributionAuth: TEST_ATTRIBUTION_AUTH,
  });
  const server = await service.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/retrieveAtt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Service: 'Wikipedia' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 1);
  } finally {
    await closeServer(server);
  }
});

test('multi-provider launcher reads the explicit trusted-internal opt-in', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'launcher answer', 'https://fixture.invalid/launcher', null, 'loop-1');
  const server = await startGqaMultiProviderService(0, {
    env: { [GQA_ATTRIBUTION_TRUSTED_INTERNAL_ENV]: 'true' },
    bing: { endpoint: 'https://fixture.invalid/bing' },
    wikipedia: { endpoint: 'https://fixture.invalid/wiki' },
    wolfram: { endpoint: 'https://fixture.invalid/wolfram' },
    account: async () => 'loop-1',
    attribution,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/retrieveAtt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
      },
      body: JSON.stringify({ Service: 'Bing' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 1);
  } finally {
    await closeServer(server);
  }
});

test('attribution HTTP routes preserve source parser boundaries and retrieve ordering', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/result', null, 'loop-1');
  const accountCalls = [];
  const storageCalls = [];
  const trackedAttribution = {
    async search(...args) {
      storageCalls.push('find');
      const result = await attribution.search(...args);
      storageCalls.push('limit');
      return result;
    },
    async wipe(...args) {
      storageCalls.push('delete_many');
      return attribution.wipe(...args);
    },
  };
  const routes = {
    'POST /retrieveAtt': createGqaRetrieveAttributionRoute({
      accountLookup: async (id) => {
        accountCalls.push(id);
        return 'loop-1';
      },
      attribution: trackedAttribution,
      attributionAuth: TEST_ATTRIBUTION_AUTH,
    }),
    'POST /wipeID': createGqaWipeAttributionRoute({
      accountLookup: async () => 'loop-1',
      attribution: trackedAttribution,
      attributionAuth: TEST_ATTRIBUTION_AUTH,
    }),
  };
  const server = await createService({ name: 'q01-attribution-boundary-test', routes }).listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body, headers = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }
  try {
    let response = await post('/retrieveAtt', 'null', {
      'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(accountCalls, ['account-1']);
    assert.deepEqual(storageCalls, []);

    accountCalls.length = 0;
    storageCalls.length = 0;
    response = await post('/retrieveAtt', JSON.stringify({ Service: 'Bing', after: '1700000000000' }), {
      'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(accountCalls, ['account-1']);
    assert.deepEqual(storageCalls, ['find']);

    accountCalls.length = 0;
    storageCalls.length = 0;
    response = await post('/retrieveAtt', '{}', {
      'x-amz-credentials': JSON.stringify({ id: 'account-1' }),
      'content-type': 'text/plain',
    });
    assert.equal(response.status, 500);
    assert.deepEqual(accountCalls, ['account-1']);
    assert.deepEqual(storageCalls, []);

    accountCalls.length = 0;
    storageCalls.length = 0;
    response = await post('/retrieveAtt', '');
    assert.equal(response.status, 400);
    assert.deepEqual(accountCalls, []);
    assert.deepEqual(storageCalls, []);

    response = await post('/wipeID', '');
    assert.equal(response.status, 400);
    response = await post('/wipeID', JSON.stringify({ ID: 'loop-1' }));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(await response.text()), { deleted_row: 1 });
  } finally {
    await closeServer(server);
  }
});


test('attribution media selection preserves accepted vendor JSON and ignored AWS JSON', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/result', null, 'loop-1');
  let calls = 0;
  const routes = {
    'POST /retrieveAtt': createGqaRetrieveAttributionRoute({
      accountLookup: async () => { calls += 1; return 'loop-1'; }, attribution,
      attributionAuth: TEST_ATTRIBUTION_AUTH,
    }),
    'POST /wipeID': createGqaWipeAttributionRoute({
      accountLookup: async () => 'loop-1',
      attribution,
      attributionAuth: TEST_ATTRIBUTION_AUTH,
    }),
  };
  const server = await createService({ name: 'q01-media', routes }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, type) => fetch(base + path, {
    method: 'POST', body,
    headers: { 'content-type': type, 'x-amz-credentials': JSON.stringify({ id: 'account-1' }) },
  });
  try {
    const retrieved = await post('/retrieveAtt', '{}', 'application/vnd.fixture+json');
    assert.equal(retrieved.status, 200);
    assert.equal((await retrieved.json()).data.length, 1);
    const beforeMalformed = calls;
    assert.equal((await post('/retrieveAtt', '{', 'application/vnd.fixture+json')).status, 400);
    assert.equal(calls, beforeMalformed);
    assert.equal((await post('/retrieveAtt', '{', 'application/x-amz-json-1.1')).status, 500);
    assert.equal(calls, beforeMalformed + 1, 'Flask ignores this media body before the account call');
    assert.equal((await post('/wipeID', '{', 'application/x-amz-json-1.1')).status, 500);
    assert.equal(attribution.snapshot().length, 1);
    const wiped = await post('/wipeID', JSON.stringify({ ID: 'loop-1' }), 'application/vnd.fixture+json');
    assert.equal(wiped.status, 200);
    assert.deepEqual(await wiped.json(), { deleted_row: 1 });
  } finally { await closeServer(server); }
});

test('memory attribution numeric timestamp windows match real Mongo type bracketing', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  await attribution.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/result', null, 'loop-1');
  for (const before of [String(FIXED_NOW + 1), [FIXED_NOW + 1], { value: FIXED_NOW + 1 }, true, FIXED_NOW]) {
    assert.deepEqual(await attribution.search('loop-1', 'Bing', before, FIXED_NOW - 1), []);
  }
  for (const before of [false, FIXED_NOW + 1, [], {}]) {
    assert.equal((await attribution.search('loop-1', 'Bing', before, FIXED_NOW - 1)).length, 1);
  }
});

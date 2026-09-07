import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  createGqaAccountLookup,
  createGqaAttributionStore,
  createGqaMemoryAttributionStore,
  createGqaRetrieveAttributionRoute,
  createGqaWipeAttributionRoute,
  sourceJsonDumps,
} from '../src/gqaAccountAttribution.js';
import { createGqaAnswerSkill, createGqaHttpRoute } from '../src/gqaAnswerSkill.js';
import {
  createGqaMultiProviderProfile,
  createGqaMultiProviderService,
} from '../src/gqaMultiProviderService.js';

const FIXED_NOW = 1700000000000;

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

test('attribution route factories retain source error status for missing credentials and IDs', async () => {
  const attribution = createGqaMemoryAttributionStore({ clock: () => FIXED_NOW });
  const retrieve = createGqaRetrieveAttributionRoute({
    accountLookup: async () => 'loop-1',
    attribution,
  });
  const wipe = createGqaWipeAttributionRoute({ attribution });
  const sent = [];
  const response = {
    status(code) { sent.push(['status', code]); return this; },
    type(value) { sent.push(['type', value]); return this; },
    send(value) { sent.push(['send', value]); return this; },
  };
  await retrieve({ body: {}, req: { headers: {} }, res: response });
  assert.equal(sent[0][0], 'status');
  assert.equal(sent[0][1], 500);
  sent.length = 0;
  await wipe({ body: {}, req: { headers: {} }, res: response });
  assert.equal(sent[0][0], 'status');
  assert.equal(sent[0][1], 500);
  assert.ok(createGqaHttpRoute({ handler: async () => ({}) }).jsonStrict === false);
});

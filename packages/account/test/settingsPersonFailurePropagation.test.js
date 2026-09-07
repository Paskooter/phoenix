import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSettingsInternalService } from '../src/index.js';
import { createSettingsProviders, isPersonRequestFatal } from '../src/settingsProviders.js';
import { Store } from '../src/store.js';

const reportView = {
  type: 'switch',
  valueDefinition: { target: 'person', key: 'x', default: false },
};

function jsonResponse(status, value) {
  const body = JSON.stringify(value);
  return { status, headers: { 'content-type': 'application/json' }, body };
}

function responseFor(kind) {
  switch (kind) {
    case 'partial-reset':
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"x":', truncate: true };
    case 'short-content-length':
      return {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '20' },
        body: '{"x":',
      };
    case 'missing-status-200':
      return jsonResponse(200, { error: 'ProviderError', message: 'status omitted' });
    case 'missing-status-400':
      return jsonResponse(400, { error: 'ProviderError', message: 'status omitted' });
    case 'invalid-status':
      return jsonResponse(200, { error: 'ProviderError', message: 'status invalid', statusCode: 399 });
    case 'valid-400':
      return jsonResponse(400, {
        error: 'ProviderError', message: 'http status', statusCode: 400, code: 'P400',
      });
    case 'malformed-json':
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{bad' };
    case 'stored':
      return jsonResponse(200, { stored: true });
    case 'valid':
      return jsonResponse(200, { x: { value: true } });
    default:
      throw new Error(`unknown Person control: ${kind}`);
  }
}

async function listenPersonPeer(kinds) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const index = requests.length;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const response = responseFor(kinds[index] || 'valid');
      const headers = { connection: 'close', ...(response.headers || {}) };
      res.writeHead(response.status, headers);
      if (response.truncate) {
        res.write(response.body);
        setTimeout(() => res.socket?.destroy(), 5);
        return;
      }
      res.end(response.body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    requests,
    address: `127.0.0.1:${server.address().port}`,
  };
}

async function close(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

function personProvider(address) {
  return createSettingsProviders({ store: {}, env: { NET_settings_person: address } }).person;
}

const context = { userId: 'person-failure-user', loopId: 'person-failure-loop', transactionId: 'tx-1' };

test('Person labels stream and provider-status assertion failures structurally', async () => {
  const peer = await listenPersonPeer([
    'partial-reset',
    'short-content-length',
    'missing-status-200',
    'missing-status-400',
    'invalid-status',
    'valid-400',
    'malformed-json',
  ]);
  try {
    const person = personProvider(peer.address);
    for (const kind of [
      'partial-reset', 'short-content-length', 'missing-status-200',
      'missing-status-400', 'invalid-status',
    ]) {
      await assert.rejects(
        () => person.getAccountProperties(context, ['x']),
        (error) => isPersonRequestFatal(error),
        kind,
      );
    }

    await assert.rejects(
      () => person.getAccountProperties(context, ['x']),
      (error) => {
        assert.equal(isPersonRequestFatal(error), false);
        assert.equal(error.output.statusCode, 400);
        assert.equal(error.output.payload.message, 'http status');
        return true;
      },
      'valid provider status remains an ordinary provider error',
    );
    await assert.rejects(
      () => person.getAccountProperties(context, ['x']),
      (error) => {
        assert.equal(isPersonRequestFatal(error), false);
        assert.equal(error.isDeveloperError, true);
        return true;
      },
      'malformed JSON remains an ordinary response parsing error',
    );
  } finally {
    await close(peer.server);
  }
});

function settingsProviders(person) {
  return {
    account: { checkUserBelongsToLoop: async () => {} },
    hub: {
      getSkillConfigs: async () => [{ id: 'source-control', settings: { view: structuredClone(reportView) } }],
    },
    person,
    lasso: { getCredential: async () => ({ credentialExists: false }) },
  };
}

async function startSettings(person) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-person-fatal-'));
  const store = new Store(join(dir, 'store.json'));
  const server = await createSettingsInternalService({
    store,
    settingsProviders: settingsProviders(person),
  }).listen(0);
  return { dir, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function settingsRequest(base, target, body) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amz-target': `Settings_20171219.${target}`,
      'x-amz-credentials': JSON.stringify({ id: context.userId }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

const generic500 = JSON.stringify({
  message: 'An internal server error occurred', statusCode: 500, error: 'Internal Server Error',
});

test('Settings projects fatal Person responses as HTTP 500 and valid errors per key', async () => {
  const peer = await listenPersonPeer([
    'partial-reset',
    'short-content-length',
    'missing-status-200',
    'missing-status-400',
    'invalid-status',
    'valid-400',
    'malformed-json',
    'stored',
    'partial-reset',
  ]);
  const running = await startSettings(personProvider(peer.address));
  try {
    for (const target of ['GetSettings', 'GetDataForSettings']) {
      const body = target === 'GetDataForSettings'
        ? { loopId: context.loopId, settings: [{ skillId: 'source-control', view: reportView }] }
        : { loopId: context.loopId };
      const result = await settingsRequest(running.base, target, body);
      assert.equal(result.status, 500, `${target} stream failure`);
      assert.equal(result.body, generic500, `${target} stream failure body`);
    }

    for (const label of ['missing-status-200', 'missing-status-400', 'invalid-status']) {
      const result = await settingsRequest(running.base, 'GetSettings', { loopId: context.loopId });
      assert.equal(result.status, 500, label);
      assert.equal(result.body, generic500, label);
    }

    const ordinary = await settingsRequest(running.base, 'GetSettings', { loopId: context.loopId });
    assert.equal(ordinary.status, 200);
    const ordinaryBody = JSON.parse(ordinary.body);
    assert.equal(ordinaryBody[0].errors.x.message, 'person request error: http status');

    const malformed = await settingsRequest(running.base, 'GetSettings', { loopId: context.loopId });
    assert.equal(malformed.status, 200);
    const malformedBody = JSON.parse(malformed.body);
    assert.match(malformedBody[0].errors.x.message, /^person request error: /);

    // UpdateController has no per-key catch for Person. A fatal response from
    // either the write or its readback therefore reaches the same request 500.
    const update = await settingsRequest(running.base, 'UpdateSettings', {
      loopId: context.loopId,
      data: { x: { skillId: 'source-control', dataService: 'person', value: { value: true } } },
    });
    assert.equal(update.status, 500, 'UpdateSettings Person failure');
    assert.equal(update.body, generic500, 'UpdateSettings Person failure body');
  } finally {
    await close(running.server);
    rmSync(running.dir, { recursive: true, force: true });
    await close(peer.server);
  }
});

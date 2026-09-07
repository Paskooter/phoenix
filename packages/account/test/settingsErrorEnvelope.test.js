import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSettingsInternalService } from '../src/index.js';
import { Store } from '../src/store.js';

const view = {
  type: 'switch',
  valueDefinition: { target: 'person', key: 'x', default: false },
};
const context = { userId: 'error-envelope-user', loopId: 'error-envelope-loop' };
const missing = Symbol('missing');

function providerError(statusCode, errorName, message, code = missing) {
  const error = new Error(message);
  error.isBoom = true;
  error.statusCode = statusCode;
  error.output = {
    statusCode,
    payload: { statusCode, error: errorName, message },
  };
  if (code !== missing) error.output.payload.code = code;
  return error;
}

function providersFor(activeError) {
  return {
    account: { checkUserBelongsToLoop: async () => {} },
    hub: { getSkillConfigs: async () => [{ id: 'source-control', settings: { view: structuredClone(view) } }] },
    person: {
      setAccountProperty: async () => { throw activeError.current; },
      getAccountProperties: async () => ({ x: { value: true } }),
    },
    lasso: { getCredential: async () => ({ credentialExists: false }) },
  };
}

async function request(base) {
  const response = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amz-target': 'Settings_20171219.UpdateSettings',
      'x-amz-credentials': JSON.stringify({ id: context.userId }),
    },
    body: JSON.stringify({
      loopId: context.loopId,
      data: { x: { skillId: 'source-control', dataService: 'person', value: { value: true } } },
    }),
  });
  return { status: response.status, body: await response.text() };
}

test('Settings preserves Boom error labels and empty code presence at the internal boundary', async () => {
  const activeError = { current: null };
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-error-envelope-'));
  const service = await createSettingsInternalService({
    store: new Store(join(dir, 'store.json')),
    settingsProviders: providersFor(activeError),
  }).listen(0);
  const base = `http://127.0.0.1:${service.address().port}`;
  const cases = [
    {
      id: '400-code-absent',
      error: providerError(400, 'Bad Request', 'http status'),
      expected: { status: 400, body: '{"statusCode":400,"error":"Bad Request","message":"http status"}' },
    },
    {
      id: '400-code-empty',
      error: providerError(400, 'Bad Request', 'http status', ''),
      expected: { status: 400, body: '{"statusCode":400,"error":"Bad Request","message":"http status","code":""}' },
    },
    {
      id: '401-code-absent',
      error: providerError(401, 'Unauthorized', 'unauthorized'),
      expected: { status: 401, body: '{"statusCode":401,"error":"Unauthorized","message":"unauthorized"}' },
    },
    {
      id: '503-code-empty',
      error: providerError(503, 'Service Unavailable', 'unavailable', ''),
      expected: { status: 503, body: '{"statusCode":503,"error":"Service Unavailable","message":"unavailable","code":""}' },
    },
    {
      id: '500-code-absent',
      error: providerError(500, 'Internal Server Error', 'provider down'),
      expected: { status: 500, body: '{"message":"An internal server error occurred","statusCode":500,"error":"Internal Server Error"}' },
    },
  ];
  try {
    for (const item of cases) {
      activeError.current = item.error;
      assert.deepEqual(await request(base), item.expected, item.id);
    }
  } finally {
    await new Promise((resolve) => service.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

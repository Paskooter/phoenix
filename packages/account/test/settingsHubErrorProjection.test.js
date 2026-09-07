import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSettingsInternalService } from '../src/index.js';
import { Store } from '../src/store.js';

const context = { userId: 'hub-projection-user', loopId: 'hub-projection-loop' };

function boom(statusCode, errorName, message, code) {
  const error = new Error(message);
  error.isBoom = true;
  error.statusCode = statusCode;
  error.output = {
    statusCode,
    payload: { statusCode, error: errorName, message },
    headers: {},
  };
  if (code !== undefined) error.output.payload.code = code;
  return error;
}

function providers(active) {
  return {
    account: { checkUserBelongsToLoop: async () => {} },
    hub: { getSkillConfigs: async () => { throw active.current; } },
    person: { getAccountProperties: async () => ({}) },
    lasso: { getCredential: async () => ({ credentialExists: false }) },
  };
}

async function request(port) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amz-target': 'Settings_20171219.GetSettings',
      'x-amz-credentials': JSON.stringify({ id: context.userId }),
    },
    body: JSON.stringify({ loopId: context.loopId }),
  });
  return { status: response.status, body: await response.json() };
}

test('Hub error code survives a 500 source envelope while transport codes stay private', async () => {
  const active = { current: null };
  const dir = mkdtempSync(join(tmpdir(), 'phx-settings-hub-error-projection-'));
  const service = await createSettingsInternalService({
    store: new Store(join(dir, 'store.json')),
    settingsProviders: providers(active),
  }).listen(0);
  try {
    active.current = boom(500, 'Internal Server Error', 'hub unavailable', 'HUB_DOWN');
    assert.deepEqual(await request(service.address().port), {
      status: 500,
      body: {
        message: 'An internal server error occurred',
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'HUB_DOWN',
      },
    });

    const transport = boom(502, 'Bad Gateway', 'Client request error: connect ECONNREFUSED', undefined);
    transport.code = 'ECONNREFUSED';
    active.current = transport;
    assert.deepEqual(await request(service.address().port), {
      status: 502,
      body: {
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'Client request error: connect ECONNREFUSED',
      },
    });
  } finally {
    await new Promise((resolve) => service.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSettingsInternalService } from '../src/index.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(join(tmpdir(), 'phx-settings-transport-'));
const store = new Store(join(dataDir, 'store.json'));
const calls = [];
const reportView = {
  type: 'group',
  childViews: [
    { type: 'switch', valueDefinition: { target: 'person', key: 'accountFlag', default: false } },
    { type: 'switch', valueDefinition: { target: 'loop', key: 'loopFlag', default: true } },
    {
      type: 'oauth',
      valueDefinition: { target: 'lasso', key: 'google:calendar:readonly' },
      oauthParams: { serviceName: 'google', serviceAccountName: 'calendar', scopes: ['read'] },
    },
  ],
};
const otherView = {
  type: 'group',
  childViews: [
    { type: 'switch', valueDefinition: { target: 'person', key: 'otherFlag', default: true } },
  ],
};
const sourceConfigs = [
  { id: 'report-skill', settings: { view: reportView } },
  { id: 'other-skill', settings: { view: otherView } },
];
const providers = {
  account: {
    checkUserBelongsToLoop: async (context) => { calls.push({ client: 'account', context }); },
  },
  hub: { getSkillConfigs: async () => sourceConfigs },
  person: { getAccountProperties: async () => ({}), getLoopProperties: async () => ({}) },
  lasso: { getCredential: async () => ({ credentialExists: false }) },
};

let server;
let base;

before(async () => {
  server = await createSettingsInternalService({ store, settingsProviders: providers }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

async function request({ target, contentType = 'application/json', body = '{"loopId":"loop-1"}', origin } = {}) {
  calls.length = 0;
  const headers = {
    'content-type': contentType,
    'x-amz-credentials': '{"id":"source-user"}',
  };
  if (target !== undefined) headers['x-amz-target'] = target;
  if (origin) headers.origin = origin;
  const response = await fetch(`${base}/`, {
    method: 'POST', headers, body,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
    calls: calls.slice(),
  };
}

function assertSourceSuccess(result) {
  assert.deepEqual(JSON.parse(result.body), [
    {
      skillId: 'report-skill',
      view: reportView,
      data: {
        accountFlag: { value: false },
        loopFlag: { value: true },
        'google:calendar:readonly': { credentialExists: false },
      },
    },
    {
      skillId: 'other-skill',
      view: otherView,
      data: { otherFlag: { value: true } },
    },
  ]);
}

test('internal target extraction follows the source second-segment and first-letter rule', async () => {
  const cases = [
    ['Settings_20171219.getsettings', 404, 'Method getsettings not found.'],
    ['Settings_20171219.GETSETTINGS', 404, 'Method gETSETTINGS not found.'],
    ['Settings_20171219.GetSettings.extra', 200, null],
    ['Settings_20171219.extra.GetSettings', 404, 'Method extra not found.'],
    ['Settings_20171219.Missing', 404, 'Method missing not found.'],
    ['Settings_20171219', 500, null],
    ['Settings_20171219.', 500, null],
    ['.GetSettings', 200, null],
    ['Other.GetSettings', 200, null],
    [undefined, 500, null],
  ];

  for (const [target, status, message] of cases) {
    const result = await request({ target });
    assert.equal(result.status, status, target || '(omitted)');
    assert.equal(result.headers.get('vary'), status === 200 ? 'origin,accept-encoding' : 'accept-encoding');
    if (message) {
      assert.deepEqual(JSON.parse(result.body), {
        statusCode: status === 404 ? 404 : 500,
        error: status === 404 ? 'Not Found' : 'Internal Server Error',
        ...(status === 404
          ? { message }
          : { message: 'An internal server error occurred' }),
      });
      assert.equal(result.calls.length, 0);
    } else if (status === 500) {
      assert.deepEqual(JSON.parse(result.body), {
        message: 'An internal server error occurred',
        statusCode: 500,
        error: 'Internal Server Error',
      });
      assert.equal(result.calls.length, 0);
    } else {
      assertSourceSuccess(result);
      assert.equal(result.calls.length, 1);
    }
  }
});

test('internal listener retains Hapi content parsing and CORS boundary', async () => {
  const malformed = await request({ target: 'Settings_20171219.GetSettings', body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.body), {
    statusCode: 400,
    error: 'Bad Request',
    message: 'Invalid request payload JSON format',
  });
  assert.equal(malformed.headers.get('vary'), 'origin,accept-encoding');
  assert.equal(malformed.calls.length, 0);

  const text = await request({
    target: 'Settings_20171219.GetSettings',
    contentType: 'text/plain',
  });
  assert.equal(text.status, 200);
  assertSourceSuccess(text);
  assert.equal(text.calls.length, 1);
  assert.equal(text.calls[0].client, 'account');
  assert.equal(text.calls[0].context.userId, 'source-user');
  assert.equal(text.calls[0].context.loopId, undefined);
  assert.equal(text.calls[0].context.transactionId, undefined);

  const awsJson = await request({
    target: 'Settings_20171219.GetSettings',
    contentType: 'application/x-amz-json-1.1',
  });
  assert.equal(awsJson.status, 415);
  assert.deepEqual(JSON.parse(awsJson.body), {
    statusCode: 415,
    error: 'Unsupported Media Type',
    message: 'Unsupported Media Type',
  });
  assert.equal(awsJson.headers.get('vary'), 'origin,accept-encoding');
  assert.equal(awsJson.calls.length, 0);

  const origin = await request({
    target: 'Settings_20171219.GetSettings',
    origin: 'https://example.test',
  });
  assert.equal(origin.status, 200);
  assertSourceSuccess(origin);
  assert.equal(origin.headers.get('access-control-allow-origin'), 'https://example.test');
  assert.equal(origin.headers.get('access-control-expose-headers'), 'WWW-Authenticate,Server-Authorization');
  assert.match(origin.headers.get('vary') || '', /^origin,accept-encoding$/);
});

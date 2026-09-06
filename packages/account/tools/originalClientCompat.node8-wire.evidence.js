// NEW corrected A-02 wire evidence: exercise the pinned original Jibo AWS
// client signer through both ephemeral Phoenix Account and Classic listeners.
// Run explicitly; this is intentionally outside ordinary unit-test discovery.
// Earlier corrected artifacts remain preserved, including their recorded wire
// mismatch; this file records only synthetic credentials and hashes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire, Module } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jwt } from '@phoenix/common';

const ORIGINAL_CLIENT_VERSION = '3.0.110';
const ORIGINAL_CLIENT_ROOT = findOriginalClientRoot();
const PREPARED_REFERENCE_NODE_MODULES = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c/node_modules';
const HERMES_NODE_MODULES = '/home/shell/work/hermes-be/node_modules';
process.env.NODE_PATH = [PREPARED_REFERENCE_NODE_MODULES, HERMES_NODE_MODULES, process.env.NODE_PATH]
  .filter(Boolean).join(':');
Module._initPaths();
const originalRequire = createRequire(join(ORIGINAL_CLIENT_ROOT, 'lib/aws.js'));
const AWS = originalRequire('./aws.js');
assert.equal(AWS.VERSION, ORIGINAL_CLIENT_VERSION);

const ACCESS_KEY = 'A02ORIGINALKEY00';
const SECRET = 'a02-original-synthetic-secret-only';
const REGION = 'global';
const SERVICE = 'jibo';
const TARGET = 'Account_20151111.CreateHubToken';
const HUB_SECRET = 'a02-original-local-hub-secret';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const SOURCE_HAPI_ERROR_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-cache',
  vary: 'accept-encoding',
  connection: 'keep-alive',
};
const SOURCE_ROOTS = {
  gateway: '/home/shell/work/phoenix/.parity/consumers/security-gw-43a692f',
  account: '/home/shell/work/phoenix/.parity/consumers/account-ws-b525601',
  native: '/home/shell/work/phoenix/.parity/consumers/git/jiboV2/jetstream/01ae81fc366ccd6e68ca66fa98f77f957dcdb1fb',
};
const HAPI_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/parity/reviews/a02-source-correction/hapi-validation.cjs');

const dir = mkdtempSync(join(tmpdir(), 'phx-a02-original-client-'));
const storeFile = join(dir, 'store.json');
process.env.ETCO_account_dataFile = storeFile;
process.env.HUB_TOKEN_SECRET = HUB_SECRET;

const { createAccountService, Store } = await import('../src/index.js');
const { createOwnerAccount } = await import('../src/model.js');
const { createClassicEntrypoint } = await import('../../classic/src/index.js');

let accountService;
let accountBase;
let classicService;
let classicBase;
let account;
const observations = {};

function findOriginalClientRoot() {
  const candidates = [
    process.env.PHX_A02_ORIGINAL_CLIENT_ROOT,
    '/home/shell/work/phoenix/.parity/yarn-cache/v1/npm-@jibo/jibo-server-client-3.0.110-dc0962bd91de9392ecf2ef6f96c6d9f7642d23e8',
    '/home/shell/work/hermes-be/node_modules/@jibo/jibo-server-client',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const packageInfo = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
      if (packageInfo.version === ORIGINAL_CLIENT_VERSION) return candidate;
    } catch {
      // Continue to the next prepared source location.
    }
  }
  throw new Error(`pinned @jibo/jibo-server-client@${ORIGINAL_CLIENT_VERSION} is unavailable`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sourceHashes() {
  const files = [
    ['original-client/package.json', join(ORIGINAL_CLIENT_ROOT, 'package.json')],
    ['original-client/lib/signers/v4.js', join(ORIGINAL_CLIENT_ROOT, 'lib/signers/v4.js')],
    ['original-client/lib/util.js', join(ORIGINAL_CLIENT_ROOT, 'lib/util.js')],
    ['security-gw/src/v4.js', join(SOURCE_ROOTS.gateway, 'src/v4.js')],
    ['security-gw/src/controllers/auth.ctrl.ts', join(SOURCE_ROOTS.gateway, 'src/controllers/auth.ctrl.ts')],
    ['security-gw/src/auth.scheme.ts', join(SOURCE_ROOTS.gateway, 'src/auth.scheme.ts')],
    ['account-ws/src/controllers/account.ctrl.ts', join(SOURCE_ROOTS.account, 'src/controllers/account.ctrl.ts')],
    ['account-ws/src/controllers/token.ctrl.ts', join(SOURCE_ROOTS.account, 'src/controllers/token.ctrl.ts')],
    ['review/hapi-validation.cjs', HAPI_FIXTURE],
    ['native/jibohub-client/src/Authentication.cpp', join(SOURCE_ROOTS.native, 'jibohub-client/src/Authentication.cpp')],
  ];
  return files.map(([path, file]) => ({ path, sha256: sha256(file) }));
}

function originalSdkRequest({ host, body, date, headers = {} }) {
  const request = new AWS.HttpRequest(`http://${host}/`, REGION);
  request.method = 'POST';
  request.path = '/';
  request.region = REGION;
  request.body = body;
  request.headers.host = host;
  request.headers['Content-Type'] = 'application/x-amz-json-1.1';
  request.headers['X-Amz-Target'] = TARGET;
  Object.assign(request.headers, headers);
  // This is the original @jibo/jibo-server-client V4 implementation, not
  // Phoenix's signer. The payload is already the JSON wire entity here.
  const signer = new AWS.Signers.V4(request, SERVICE, false);
  signer.addAuthorization({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET }, date);
  return {
    kind: 'original-sdk-body',
    method: request.method,
    path: request.path,
    headers: { ...request.headers },
    body: Buffer.from(body),
  };
}

function originalNativeRequest({ host, date, body = '{}', target = TARGET }) {
  // Authentication.cpp signs StandardHttpRequest(https://host, POST) before
  // get_token attaches the JSON body, target, content type, and content length.
  const request = new AWS.HttpRequest(`https://${host}/`, REGION);
  request.method = 'POST';
  request.path = '/';
  request.region = REGION;
  request.body = '';
  request.headers.host = host;
  request.headers['x-amz-content-sha256'] = EMPTY_SHA256;
  const signer = new AWS.Signers.V4(request, SERVICE, false);
  signer.addAuthorization({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET }, date);

  const headers = { ...request.headers };
  headers['Content-Type'] = 'application/json';
  headers['Content-Length'] = String(Buffer.byteLength(body));
  headers['X-Amz-Target'] = target;
  return {
    kind: 'native-sign-before-body',
    method: request.method,
    path: request.path,
    headers,
    body: Buffer.from(body),
  };
}

function rawRequest(request) {
  return {
    kind: request.kind,
    method: request.method,
    path: request.path,
    headers: request.headers,
    bodyUtf8: request.body.toString('utf8'),
    bodyHex: request.body.toString('hex'),
  };
}

async function send(request, overrides = {}) {
  const headers = { ...request.headers, ...(overrides.headers || {}) };
  const body = overrides.body === undefined ? request.body : overrides.body;
  if (overrides.body !== undefined) {
    const lengthHeader = Object.keys(headers).find((name) => name.toLowerCase() === 'content-length');
    if (lengthHeader) headers[lengthHeader] = Buffer.byteLength(body);
  }
  const endpoint = new URL(overrides.base || classicBase);
  const response = await new Promise((resolve, reject) => {
    const client = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname || '/'}${endpoint.search || ''}`,
      method: request.method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        errorType: res.headers['x-amzn-errortype'] || null,
        headers: Object.fromEntries(Object.entries(res.headers).sort(([a], [b]) => a.localeCompare(b))),
        rawBody: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    client.on('error', reject);
    client.end(body);
  });
  let parsed = null;
  try { parsed = JSON.parse(response.rawBody); } catch { /* retain raw response text */ }
  return { ...response, body: parsed };
}

function responseAssertion(response, claims = {}) {
  return {
    status: response.status,
    errorType: response.errorType,
    bodyKeys: response.body && typeof response.body === 'object' ? Object.keys(response.body).sort() : [],
    headers: response.headers,
    body: response.body,
    claims,
  };
}

function assertHapiError(response, message) {
  assert.equal(response.status, 422);
  assert.deepEqual(response.body, {
    statusCode: 422,
    error: 'Unprocessable Entity',
    message,
  });
  for (const [name, value] of Object.entries(SOURCE_HAPI_ERROR_HEADERS)) {
    assert.equal(response.headers[name], value, `${name} header`);
  }
  assert.equal(response.headers['x-powered-by'], undefined);
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers['keep-alive'], undefined);
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(response.rawBody)));
}

function sanitizeObservations(value) {
  if (Array.isArray(value)) return value.map(sanitizeObservations);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'body' && child && typeof child === 'object' && typeof child.token === 'string') {
      result.body = { tokenSha256: sha256Buffer(child.token), tokenLength: child.token.length };
    } else {
      result[key] = sanitizeObservations(child);
    }
  }
  return result;
}

before(async () => {
  const store = new Store(storeFile);
  account = createOwnerAccount(store, { email: 'a02-original@synthetic.invalid', password: 'A02-original-pass-4' });
  // Keep the original-client fixture deterministic while using only synthetic
  // credentials. The source signer below signs with this exact account pair.
  account.accessKeyId = ACCESS_KEY;
  account.secretAccessKey = SECRET;
  store.flush();
  accountService = await createAccountService({ store }).listen(0);
  accountBase = `http://localhost:${accountService.address().port}/`;
  process.env.NET_account = `localhost:${accountService.address().port}`;
  classicService = await createClassicEntrypoint().listen(0);
  classicBase = `http://localhost:${classicService.address().port}/`;
});

after(() => {
  if (process.env.PHX_A02_NODE8_WIRE_OUT) {
    writeFileSync(process.env.PHX_A02_NODE8_WIRE_OUT, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      runKind: 'wire-corrected-original-sdk-compatibility',
      supersedes: 'A-02-original-client-corrected-20260905.json',
      historicalArtifactsPreserved: [
        'A-02-original-client-compat-20260905.json',
        'A-02-original-client-corrected-20260905.json',
      ],
      syntheticOnly: true,
      sourcePins: {
        originalClient: `@jibo/jibo-server-client@${AWS.VERSION}`,
        securityGateway: 'jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c',
        account: 'jiborobot/srv-account-ws@b525601390108b8635a31794dfa5cc3fda8a37d0',
        native: 'jiboV2/jetstream@01ae81fc366ccd6e68ca66fa98f77f957dcdb1fb',
      },
      sourceHashes: sourceHashes(),
      syntheticCredential: {
        accessKeyId: ACCESS_KEY,
        secretSha256: sha256Buffer(SECRET),
      },
      sourceExpectation: {
        fixture: 'source-validatePayload-joi-boom-hapi',
        transport: 'Hapi network response (server.inject omits automatic keep-alive framing)',
        errorStatus: 422,
        errorHeaders: SOURCE_HAPI_ERROR_HEADERS,
        messages: {
          object: '"value" must be an object',
          string: 'child "payload" fails because ["payload" must be a string]',
          empty: 'child "payload" fails because ["payload" is not allowed to be empty]',
        },
      },
      observations: sanitizeObservations(observations),
    }, null, 2)}\n`);
  }
  accountService.close();
  classicService.close();
  delete process.env.NET_account;
  delete process.env.HUB_TOKEN_SECRET;
  delete process.env.ETCO_account_dataFile;
  rmSync(dir, { recursive: true, force: true });
});

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('original SDK JSON signer reaches CreateHubToken through Classic', async () => {
  const body = '{"payload":"original-sdk"}';
  const request = originalSdkRequest({
    host: `localhost:${classicService.address().port}`,
    body,
    date: new Date(),
  });
  observations.originalSdk = { request: rawRequest(request) };
  const response = await send(request, {
    headers: { 'X-Amz-Credentials': JSON.stringify({ id: 'forged', accessKeyId: 'forged' }) },
  });
  assert.equal(response.status, 200);
  assert.equal(response.errorType, null);
  const claims = jwt.verify(response.body.token, HUB_SECRET);
  assert.equal(claims.id, account._id);
  assert.equal(claims.accessKeyId, ACCESS_KEY);
  assert.equal(claims.payload, 'original-sdk');
  assert.equal(claims.secretAccessKey, SECRET);
  assert.deepEqual(Object.keys(claims), ['accessKeyId', 'email', 'friendlyId', 'id', 'payload', 'secretAccessKey', 'iat', 'exp']);
  observations.originalSdk.response = responseAssertion(response, {
    id: claims.id,
    accessKeyId: claims.accessKeyId,
    payload: claims.payload,
    secretAccessKeySha256: sha256Buffer(claims.secretAccessKey),
    claimKeys: Object.keys(claims),
    exp: claims.exp,
    iat: claims.iat,
    expMinusIat: claims.exp - claims.iat,
  });
});

test('native sign-before-body request accepts explicit empty hash only as source permits', async () => {
  const request = originalNativeRequest({
    host: `localhost:${classicService.address().port}`,
    date: new Date(),
  });
  observations.native = { request: rawRequest(request) };
  const response = await send(request, {
    headers: { 'X-Amz-Credentials': JSON.stringify({ id: 'forged-native' }) },
  });
  assert.equal(response.status, 200);
  const claims = jwt.verify(response.body.token, HUB_SECRET);
  assert.equal(claims.id, account._id);
  assert.equal(claims.secretAccessKey, SECRET);
  assert.deepEqual(Object.keys(claims), ['accessKeyId', 'email', 'friendlyId', 'id', 'payload', 'secretAccessKey', 'iat', 'exp']);
  observations.native.response = responseAssertion(response, {
    id: claims.id,
    accessKeyId: claims.accessKeyId,
    payload: claims.payload,
    secretAccessKeySha256: sha256Buffer(claims.secretAccessKey),
    claimKeys: Object.keys(claims),
    exp: claims.exp,
    iat: claims.iat,
    explicitHash: request.headers['x-amz-content-sha256'],
  });

  const bodyTamper = await send(request, { body: Buffer.from('{"payload":"changed-after-signing"}') });
  assert.equal(bodyTamper.status, 200, 'the pinned gateway trusts an explicit content hash');
  const targetTamper = await send(request, { headers: { 'X-Amz-Target': 'Account_20151111.createhubtoken' } });
  assert.equal(targetTamper.status, 200, 'native source attaches target after signing');
  const hostTamper = await send(request, { headers: { host: 'tampered.invalid' } });
  assert.equal(hostTamper.status, 401);
  assert.equal(hostTamper.errorType, 'SIGNATURE_MISMATCH');
  observations.native.tamper = {
    body: responseAssertion(bodyTamper),
    target: responseAssertion(targetTamper),
    host: responseAssertion(hostTamper),
  };
});

test('source validation cases match Hapi bodies and headers through Account and Classic', async () => {
  const cases = [
    ['top-null', 'null', '"value" must be an object'],
    ['top-array', '[]', '"value" must be an object'],
    ['top-number', '1', '"value" must be an object'],
    ['top-boolean', 'true', '"value" must be an object'],
    ['top-string', '"source-string"', '"value" must be an object'],
    ['missing-body', '', '"value" must be an object'],
    ['payload-null', '{"payload":null}', 'child "payload" fails because ["payload" must be a string]'],
    ['payload-empty', '{"payload":""}', 'child "payload" fails because ["payload" is not allowed to be empty]'],
    ['payload-number', '{"payload":4}', 'child "payload" fails because ["payload" must be a string]'],
    ['payload-object', '{"payload":{}}', 'child "payload" fails because ["payload" must be a string]'],
  ];
  observations.validation = [];
  for (const [endpoint, base, port] of [
    ['account', accountBase, accountService.address().port],
    ['classic', classicBase, classicService.address().port],
  ]) {
    for (const [name, body, message] of cases) {
      const request = originalSdkRequest({
        host: `localhost:${port}`,
        body,
        date: new Date(),
      });
      const response = await send(request, { base });
      assertHapiError(response, message);
      observations.validation.push({ endpoint, name, request: rawRequest(request), response: responseAssertion(response) });
    }
  }
});

test('valid original SDK bodies preserve source object semantics at both boundaries', async () => {
  observations.valid = [];
  for (const [endpoint, base, port] of [
    ['account', accountBase, accountService.address().port],
    ['classic', classicBase, classicService.address().port],
  ]) {
    for (const [name, body, payload] of [
      ['omitted-payload', '{}', null],
      ['unknown-key', '{"extra":true}', null],
      ['string-payload', '{"payload":"accepted"}', 'accepted'],
    ]) {
      const request = originalSdkRequest({ host: `localhost:${port}`, body, date: new Date() });
      const response = await send(request, { base });
      assert.equal(response.status, 200, `${endpoint}/${name}`);
      const claims = jwt.verify(response.body.token, HUB_SECRET);
      assert.equal(claims.payload, payload);
      assert.equal(claims.secretAccessKey, SECRET);
      observations.valid.push({
        endpoint,
        name,
        request: rawRequest(request),
        response: responseAssertion(response, {
          payload: claims.payload,
          claimKeys: Object.keys(claims),
          secretAccessKeySha256: sha256Buffer(claims.secretAccessKey),
          expMinusIat: claims.exp - claims.iat,
        }),
      });
    }
  }
});

test('original SDK body, target, and clock mutations retain gateway errors', async () => {
  const body = '{"payload":"mutation-control"}';
  const request = originalSdkRequest({
    host: `localhost:${classicService.address().port}`,
    body,
    date: new Date(),
  });
  const bodyTamper = await send(request, { body: Buffer.from('{"payload":"tampered"}') });
  const targetTamper = await send(request, { headers: { 'X-Amz-Target': 'Account_20151111.createhubtoken' } });
  const clockTamper = await send(originalSdkRequest({
    host: `localhost:${classicService.address().port}`,
    body,
    date: new Date(Date.now() - 16 * 60 * 1000),
  }));
  assert.equal(bodyTamper.status, 401);
  assert.equal(bodyTamper.errorType, 'SIGNATURE_MISMATCH');
  assert.equal(targetTamper.status, 401);
  assert.equal(targetTamper.errorType, 'SIGNATURE_MISMATCH');
  assert.equal(clockTamper.status, 401);
  assert.equal(clockTamper.errorType, 'CLOCK_SKEW_TOO_LONG');
  observations.mutations = {
    body: responseAssertion(bodyTamper),
    target: responseAssertion(targetTamper),
    clock: responseAssertion(clockTamper),
  };
});

// H-10 differential regression guard.
//
// Turns the one-time H-10 review differentials into a permanent test. Each fixture is
// replayed against the CURRENT gateway/jwt/preprocessor implementation and compared,
// case by case, to the committed pinned-source goldens that were captured by running
// the frozen reference under Node 8.9.4:
//
//   auth     docs/parity/reviews/h10-root/source.json.gz            (1965 cases)
//   identity docs/parity/reviews/h10-identity-root/source.json      (187 cases)
//
// Sources: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/utils/src/service/BaseService.ts:58-78,170-192
//   packages/hub/src/utils/MessagePreProcessor.ts:19-40
//   packages/hub/src/utils/MessageValidator.ts:10-36
//
// Both accept and reject paths are covered: valid tokens/contexts must succeed and every
// malformed/mismatched input must fail with the exact source error name and message.
//
// The replay logic mirrors the review probes (packages/gateway/tools/h10-*-probe.*) so the
// comparison stays apples-to-apples; it is re-implemented here rather than imported because
// the probes are top-level scripts, not modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { gunzipSync } from 'node:zlib';
import { createHmac } from 'node:crypto';
import { jwt } from '@phoenix/common';
import { preprocessContext } from '../src/preprocessor.js';

const { checkAuthentication, createGateway } = await import('@phoenix/gateway');

// packages/gateway/test -> ../../../ == repo root
const REVIEW = new URL('../../../docs/parity/reviews/', import.meta.url);
const readJson = (url) => JSON.parse(fs.readFileSync(url, 'utf8'));

const AUTH_FIXTURE = readJson(new URL('h10-root/generated-fixtures.json', REVIEW));
const AUTH_GOLDEN = JSON.parse(gunzipSync(fs.readFileSync(new URL('h10-root/source.json.gz', REVIEW))).toString('utf8'));
const IDENTITY_FIXTURE = readJson(new URL('h10-identity-root/fixtures.json', REVIEW));
const IDENTITY_GOLDEN = readJson(new URL('h10-identity-root/source.json', REVIEW));

// --- token construction (identical to the probes) ---------------------------

const b64url = (value) => Buffer.from(value).toString('base64url');
const digestFor = (alg) => (alg === 'HS256' ? 'sha256' : alg === 'HS384' ? 'sha384' : 'sha512');

function buildToken(cases, spec) {
  const header = spec.headerJson !== undefined ? spec.headerJson : JSON.stringify(spec.header);
  const input = `${b64url(header)}.${b64url(spec.payloadJson)}`;
  let signature;
  if (spec.signature === 'hmac' || spec.signature === 'hmac-alt') {
    signature = createHmac(digestFor(spec.header.alg), cases.secret).update(input).digest('base64url');
    if (spec.signature === 'hmac-alt') {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      signature = `${signature.slice(0, -1)}${alphabet[alphabet.indexOf(signature.at(-1)) + 1]}`;
    }
  } else if (spec.signature === 'empty') {
    signature = '';
  } else {
    signature = spec.signature;
  }
  return `${input}.${signature}`;
}

function tokenMap(cases) {
  const tokens = Object.fromEntries(cases.tokens.map((spec) => [spec.id, buildToken(cases, spec)]));
  tokens.malformed = 'not-a-jwt';
  return tokens;
}

function substitute(tokens, value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (match, id) => (tokens[id] === undefined ? match : tokens[id]));
}

const TOKENS = tokenMap(AUTH_FIXTURE);

// --- normalization + outcome capture (identical to the probes) ---------------

// The committed goldens are JSON files, so they lost `undefined`-valued properties and
// null prototypes. Normalize the in-memory result the same way before comparing.
const jsonNormalize = (value) => JSON.parse(JSON.stringify(value));

function normalized(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return null;
  if (value instanceof Date) return { type: 'Date', value: value.toISOString() };
  return value;
}

function outcome(fn) {
  try {
    return { ok: true, value: normalized(fn()) };
  } catch (error) {
    return { ok: false, error: { name: error?.name, message: error?.message, constructor: error?.constructor?.name } };
  }
}

// --- auth differential: direct verify + checkAuthentication + real upgrades --

function directResults() {
  const tokens = tokenMap(AUTH_FIXTURE);
  const output = {};
  for (const spec of AUTH_FIXTURE.tokens) {
    output[spec.id] = outcome(() => jwt.verify(tokens[spec.id], AUTH_FIXTURE.secret, { clockTimestamp: AUTH_FIXTURE.clockTimestamp }));
  }
  for (const spec of AUTH_FIXTURE.direct) {
    output[spec.id] = outcome(() => jwt.verify(spec.kind === 'missing' ? undefined : spec.value, AUTH_FIXTURE.secret, { clockTimestamp: AUTH_FIXTURE.clockTimestamp }));
  }
  return jsonNormalize(output);
}

function authResults() {
  const tokens = tokenMap(AUTH_FIXTURE);
  const output = {};
  for (const spec of AUTH_FIXTURE.auth) {
    const headers = {};
    if (spec.authorization !== null) headers.authorization = substitute(tokens, spec.authorization);
    output[spec.id] = outcome(() => checkAuthentication(headers, spec.secret === 'missing' ? '' : AUTH_FIXTURE.secret));
  }
  return jsonNormalize(output);
}

function rawUpgrade(port, path, authorization) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { socket.destroy(); if (!settled) { settled = true; reject(new Error(`upgrade timeout ${path}`)); } }, 2000);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      const separator = bytes.indexOf('\r\n\r\n');
      const head = bytes.subarray(0, separator).toString('latin1').split('\r\n');
      const status = head.shift().match(/^HTTP\/1\.1 (\d+) (.*)$/);
      const headers = {};
      for (const line of head) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: Number(status[1]), reason: status[2], headers, body: bytes.subarray(separator + 4).toString('utf8') });
    };
    socket.on('connect', () => {
      const lines = ['GET ' + path + ' HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13'];
      if (authorization !== null) lines.push('Authorization: ' + substitute(TOKENS, authorization));
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => { if (!settled && chunks.length === 0) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function upgradeResults() {
  const gateway = await createGateway({
    hubTokenSecret: AUTH_FIXTURE.secret,
    disableAuth: false,
    accountUrl: '',
    parserURL: 'http://127.0.0.1:9',
    historyURL: 'http://127.0.0.1:9',
    skills: [],
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  const output = {};
  try {
    for (const spec of AUTH_FIXTURE.upgrades) output[spec.id] = await rawUpgrade(port, spec.path, spec.authorization);
  } finally {
    await new Promise((resolve) => gateway.wss.close(() => resolve()));
    await new Promise((resolve, reject) => gateway.service.server.close((error) => (error ? reject(error) : resolve())));
  }
  return jsonNormalize(output);
}

// --- identity differential --------------------------------------------------

function identityResults() {
  const cases = {};
  for (const spec of IDENTITY_FIXTURE.cases) {
    const message = JSON.parse(JSON.stringify(spec.message));
    const auth = Object.hasOwn(spec, 'auth')
      ? (spec.auth === 'undefined' ? undefined : JSON.parse(JSON.stringify(spec.auth)))
      : JSON.parse(JSON.stringify(IDENTITY_FIXTURE.auth));
    try {
      if (message && message.type === 'CONTEXT') {
        preprocessContext(message, auth, IDENTITY_FIXTURE.remoteAddress);
      }
      cases[spec.id] = { ok: true, message };
    } catch (error) {
      cases[spec.id] = { ok: false, error: { name: error.name, message: error.message, constructor: error.constructor.name }, message };
    }
  }
  return jsonNormalize(cases);
}

// --- tests ------------------------------------------------------------------

test('auth differential: 1965 pinned-source outcomes replay exactly', async () => {
  const direct = directResults();
  const auth = authResults();
  const upgrades = await upgradeResults();

  // direct + auth are pure function comparisons
  for (const [section, actual] of [['direct', direct], ['auth', auth]]) {
    const expected = AUTH_GOLDEN[section];
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${section}: case id set`);
    for (const id of Object.keys(expected)) {
      assert.deepEqual(actual[id], expected[id], `${section}/${id}`);
    }
  }

  // upgrades are real WebSocket upgrade rejections/acceptances
  assert.deepEqual(Object.keys(upgrades).sort(), Object.keys(AUTH_GOLDEN.upgrades).sort(), 'upgrades: case id set');
  for (const id of Object.keys(AUTH_GOLDEN.upgrades)) {
    assert.deepEqual(upgrades[id], AUTH_GOLDEN.upgrades[id], `upgrades/${id}`);
  }

  assert.equal(Object.keys(direct).length + Object.keys(auth).length + Object.keys(upgrades).length, 1965, 'total auth cases');
});

test('identity differential: 187 pinned-source CONTEXT outcomes replay exactly', () => {
  const actual = identityResults();
  const expected = IDENTITY_GOLDEN.cases;
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'case id set');
  for (const id of Object.keys(expected)) {
    assert.deepEqual(actual[id], expected[id], `case/${id}`);
  }
  assert.equal(Object.keys(actual).length, 187, 'total identity cases');
});

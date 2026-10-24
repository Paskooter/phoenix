// Fixed-clock, loopback-only HTTP checks of the real bearer and logger paths.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { Catalog } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';

const NOW = 1_800_000_000_000;
const ID = 'os-13.0.7-fcs';
const HOST = 'ota.fixture.test';
const SECRET = 'synthetic-ota-diagnostic-test-key';
const PAYLOAD = Buffer.from('synthetic OTA package bytes');
let dir;
let server;
// Content-Length completion is earlier than the server's source EOF/pipeline
// cleanup. Keep successful clients connected instead of aborting that work.
const downloadAgent = new http.Agent({ keepAlive: true });

function signed(expires = NOW + 60_000, id = ID) {
  const signature = createHmac('sha256', SECRET)
    .update(['phoenix-ota-v1', 'GET', id, String(expires)].join('\n')).digest('hex');
  return new URL(`/ota/package?${new URLSearchParams({ id, expires: String(expires), signature })}`, `https://${HOST}`);
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ota-refusals-'));
  await writeFile(path.join(dir, 'package.tar'), PAYLOAD);
  const catalog = await Catalog.load({ dataDir: dir, log: {}, entries: [{
    id: ID, subsystem: 'os', fromVersion: '*', toVersion: '13.0.7', file: 'package.tar',
  }] });
  server = await createOtaService({
    catalog, requireAuth: true, publicBaseUrl: `https://${HOST}`,
    packageBearerSecret: SECRET, now: () => NOW,
  }).listen(0, '127.0.0.1');
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  downloadAgent.destroy();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function download(url, host = HOST, agent = downloadAgent) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1', port: server.address().port,
      path: url.pathname + url.search, headers: { host }, agent,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode, statusMessage: res.statusMessage,
        headers: res.headers, body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function refused(t, url, expected, host = HOST) {
  const output = [];
  t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
  // Refusals have no file stream; retain their exact Connection: close contract.
  const response = await download(url, host, false);
  assert.equal(response.status, 403);
  assert.equal(response.statusMessage, 'Forbidden');
  assert.deepEqual(response.body, Buffer.from('forbidden'));
  const { date, ...headers } = response.headers;
  assert.ok(Number.isFinite(Date.parse(date)));
  assert.deepEqual(headers, {
    'x-powered-by': 'Express', 'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store', connection: 'close', 'transfer-encoding': 'chunked',
  });
  const raw = output.join('');
  assert.ok(!raw.includes(url.search), 'the query string must not enter logs');
  assert.ok(!raw.includes(url.href), 'the full URL must not enter logs');
  for (const signature of url.searchParams.getAll('signature')) {
    if (signature) assert.ok(!raw.includes(signature), 'the signature must not enter logs');
  }
  assert.ok(!raw.includes(SECRET), 'the fixture signing key must not enter logs');
  const lines = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 1, 'one rejection log, no extra unredacted diagnostics');
  const { t: timestamp, level, ns, msg, ...fields } = lines[0];
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.equal(level, 'warn');
  assert.equal(ns, 'ota');
  assert.equal(msg, 'ota package URL rejected');
  assert.deepEqual(fields, expected);
  return fields;
}

test('authentic expired package logs its age in whole seconds without changing the refusal', async t => {
  await refused(t, signed(NOW - 20_999), { reason: 'expired', id: ID, expiredForSeconds: 20 });
});

for (const [name, expiry] of [['noncanonical', `0${NOW + 60_000}`], ['unsafe', '9007199254740992']]) {
  test(`${name} expiry logs invalid-expiry without echoing its text`, async t => {
    const url = signed();
    url.searchParams.set('expires', expiry);
    await refused(t, url, { reason: 'invalid-expiry', id: ID });
  });
}

for (const [name, signature, expires] of [
  ['short', 'a'.repeat(63), NOW + 60_000],
  ['nonhex', 'g'.repeat(64), NOW + 60_000],
  ['empty', '', NOW + 60_000],
  ['expired malformed', 'a'.repeat(65), NOW - 20_000],
]) {
  test(`${name} signature logs only its length and the safe id`, async t => {
    const url = signed(expires);
    url.searchParams.set('signature', signature);
    await refused(t, url, { reason: 'malformed-signature', id: ID, signatureLength: signature.length });
  });
}

for (const [name, expires] of [['unexpired', NOW + 60_000], ['expired', NOW - 20_000], ['at expiry', NOW]]) {
  test(`${name} forged package logs signature-mismatch and never an authenticated age`, async t => {
    const url = signed(expires);
    const original = url.searchParams.get('signature');
    url.searchParams.set('signature', `${original[0] === 'a' ? 'b' : 'a'}${original.slice(1)}`);
    await refused(t, url, {
      reason: 'signature-mismatch', id: ID, ...(expires <= NOW ? { expired: true } : {}),
    });
  });
}

for (const [name, expires, age] of [['at expiry', NOW, 0], ['a day old', NOW - 86_400_000, 86_400]]) {
  test(`authentic ${name} link remains forbidden and reports its age`, async t => {
    await refused(t, signed(expires), { reason: 'expired', id: ID, expiredForSeconds: age });
  });
}

for (const [name, mutate] of [
  ['missing expiry', url => url.searchParams.delete('expires')],
  ['missing signature', url => url.searchParams.delete('signature')],
  ['duplicate id', url => url.searchParams.append('id', ID)],
  ['duplicate expiry', url => url.searchParams.append('expires', String(NOW + 60_000))],
  ['duplicate signature', url => url.searchParams.append('signature', 'a'.repeat(64))],
]) {
  test(`${name} retains query-cardinality with no query values logged`, async t => {
    const url = signed();
    mutate(url);
    await refused(t, url, { reason: 'query-cardinality' });
  });
}

for (const [name, field, value] of [
  ['invalid id', 'id', 'unsafe/id'],
  ['oversized id', 'id', 'a'.repeat(257)],
  ['empty id', 'id', ''],
  ['nonnumeric expiry', 'expires', 'not-a-timestamp'],
  ['scientific expiry', 'expires', '1.8e12'],
]) {
  test(`${name} retains query-shape and never logs an invalid id`, async t => {
    const url = signed();
    url.searchParams.set(field, value);
    await refused(t, url, { reason: 'query-shape' });
  });
}

test('host mismatch retains its existing bounded host diagnostic', async t => {
  await refused(t, signed(), { reason: 'host-mismatch', host: 'wrong.fixture.test' }, 'wrong.fixture.test');
});

for (const variant of ['canonical', 'uppercase hex', 'equivalent percent encoding', 'one millisecond left']) {
  test(`${variant} authentic unexpired link still downloads exact package bytes`, async t => {
    const output = [];
    t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
    const url = signed(variant === 'one millisecond left' ? NOW + 1 : undefined);
    if (variant === 'uppercase hex') url.searchParams.set('signature', url.searchParams.get('signature').toUpperCase());
    if (variant === 'equivalent percent encoding') url.search = url.search.replace('id=os', 'id=%6Fs').replace('expires=1', 'expires=%31');
    const response = await download(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-length'], String(PAYLOAD.length));
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(response.body, PAYLOAD);
    assert.equal(output.length, 0, 'a valid download must not emit a rejection or bearer');
  });
}

test('successful download stays quiet through delayed source EOF and pipeline cleanup', async t => {
  const output = [];
  t.mock.method(process.stderr, 'write', chunk => { output.push(String(chunk)); return true; });
  const createReadStream = fs.createReadStream;
  let sourceClosed;
  const streamMock = t.mock.method(fs, 'createReadStream', (file, options) => {
    const source = createReadStream(file, { ...options, fs: {
      open: fs.open,
      close: fs.close,
      read(fd, ...args) {
        const callback = args.pop();
        return fs.read(fd, ...args, (...result) => {
          // Content-Length can be consumed before the source reaches EOF.
          // Delay only that real callback; do not synthesize bytes or logs.
          if (!result[0] && result[1] === 0) setTimeout(() => callback(...result), 30);
          else callback(...result);
        });
      },
    } });
    sourceClosed = new Promise(resolve => source.once('close', resolve));
    return source;
  });
  syncBuiltinESMExports();
  t.after(() => { streamMock.mock.restore(); syncBuiltinESMExports(); });
  const response = await download(signed());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, PAYLOAD);
  await sourceClosed;
  // pipeline's promise settles after the source close event.
  await setImmediate();
  assert.equal(output.length, 0, 'a completed download must remain quiet through server cleanup');
});

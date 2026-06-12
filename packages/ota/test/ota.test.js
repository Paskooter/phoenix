// Tests for the OTA update server: catalog matching + the AWS-JSON Update wire surface +
// package streaming. No network fixtures — temp package files are created and hashed here so
// the assertions pin the exact length/SHA-1 the robot's jibo-download-update would verify.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { Catalog, cmpVersion } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

// fake package payloads (content is irrelevant; only length+sha matter to the robot)
const FILES = {
  'os-12.10.0.tar': Buffer.from('OS-IMAGE-12.10.0-'.repeat(64)),
  'os-12.6.0.tar': Buffer.from('OS-IMAGE-12.6.0-'.repeat(40)),
  'services-12.10.0.tar': Buffer.from('SERVICES-12.10.0-'.repeat(50)),
  'be-10.0.16.tar': Buffer.from('BE-10.0.16-'.repeat(30)),
  'diag-6.0.16.tar': Buffer.from('DIAG-6.0.16-'.repeat(20)),
};

const ENTRIES = [
  { id: 'os-12.10.0', subsystem: 'os', fromVersion: '*', toVersion: '12.10.0', changes: 'os latest', filter: '', dependencies: {}, file: 'os-12.10.0.tar', created: 1534982400000 },
  { id: 'os-12.6.0', subsystem: 'os', fromVersion: '*', toVersion: '12.6.0', changes: 'os older', filter: '', dependencies: {}, file: 'os-12.6.0.tar' },
  { id: 'services-12.10.0', subsystem: 'services', fromVersion: '*', toVersion: '12.10.0', changes: 'svc', filter: '', dependencies: { os: '12.10.0' }, file: 'services-12.10.0.tar' },
  { id: 'be-10.0.16', subsystem: 'be', fromVersion: '*', toVersion: '10.0.16', changes: 'be', filter: 'green', dependencies: {}, file: 'be-10.0.16.tar' },
  { id: 'diag-6.0.16', subsystem: 'jibo-diagnostics', fromVersion: '3.1.2', toVersion: '6.0.16', changes: 'diag', filter: '', dependencies: {}, file: 'diag-6.0.16.tar' },
  { id: 'missing', subsystem: 'os', fromVersion: '*', toVersion: '9.9.9', file: 'does-not-exist.tar' }, // skipped at load
];

let dataDir;
let catalog;
let server;
let base;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ota-test-'));
  for (const [name, buf] of Object.entries(FILES)) await writeFile(path.join(dataDir, name), buf);
  catalog = await Catalog.load({ entries: ENTRIES, dataDir, log: {} });
  const svc = createOtaService({ catalog });
  server = await svc.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

const amz = (target, body) =>
  fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Update_20160301.${target}` },
    body: JSON.stringify(body),
  });

// --- version compare --------------------------------------------------------
test('cmpVersion orders dotted numeric versions', () => {
  assert.ok(cmpVersion('12.10.0', '3.3.4') > 0);
  assert.ok(cmpVersion('12.6.0', '12.10.0') < 0); // 6 < 10, not lexical
  assert.equal(cmpVersion('1.0.0', '1.0.0'), 0);
});

// --- catalog ----------------------------------------------------------------
test('load skips entries whose package file is missing', () => {
  assert.equal(catalog.entries.length, 5);
  assert.equal(catalog.findById('missing'), null);
});

test('load computes real length + sha1 from the file', () => {
  const e = catalog.findById('os-12.10.0');
  assert.equal(e.length, FILES['os-12.10.0.tar'].length);
  assert.equal(e.sha1, sha1(FILES['os-12.10.0.tar']));
});

test('listUpdatesFrom: wildcard applies to any lower version', () => {
  assert.equal(catalog.listUpdatesFrom({ fromVersion: '3.3.4', subsystem: 'os' }).length, 2);
});

test('listUpdatesFrom: loop-guard — nothing offered once already at/above target', () => {
  assert.equal(catalog.listUpdatesFrom({ fromVersion: '12.10.0', subsystem: 'os' }).length, 0);
});

test('getUpdateFrom picks the highest toVersion', () => {
  const best = catalog.getUpdateFrom({ fromVersion: '3.3.4', subsystem: 'os' });
  assert.equal(best.id, 'os-12.10.0');
});

test('exact fromVersion matches only that version', () => {
  assert.equal(catalog.listUpdatesFrom({ fromVersion: '3.1.2', subsystem: 'jibo-diagnostics' }).length, 1);
  assert.equal(catalog.listUpdatesFrom({ fromVersion: '9.9.9', subsystem: 'jibo-diagnostics' }).length, 0);
});

test('filter is a prefix of the entry filter; empty request matches all', () => {
  assert.equal(catalog.listUpdates({ subsystem: 'be', filter: 'bl' }).length, 0);
  assert.equal(catalog.listUpdates({ subsystem: 'be', filter: 'gr' }).length, 1);
  assert.equal(catalog.listUpdates({ subsystem: 'be', filter: '' }).length, 1);
});

test('toUpdate echoes the requested fromVersion for "*" entries and builds a download url', () => {
  const e = catalog.findById('os-12.10.0');
  const u = catalog.toUpdate(e, { baseUrl: 'http://x', fromVersion: '3.3.4' });
  assert.equal(u._id, 'os-12.10.0');
  assert.equal(u.fromVersion, '3.3.4');
  assert.equal(u.toVersion, '12.10.0');
  assert.equal(u.shaHash, e.sha1);
  assert.equal(u.length, e.length);
  assert.equal(u.url, 'http://x/ota/package?id=os-12.10.0');
});

// --- wire surface -----------------------------------------------------------
test('GET /healthcheck', async () => {
  const r = await fetch(`${base}/healthcheck`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('ListUpdatesFrom returns the wire array with self-pointing urls', async () => {
  const r = await amz('ListUpdatesFrom', { fromVersion: '3.3.4', subsystem: 'os' });
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.equal(list.length, 2);
  const latest = list.find((u) => u._id === 'os-12.10.0');
  assert.equal(latest.shaHash, sha1(FILES['os-12.10.0.tar']));
  assert.ok(latest.url.endsWith('/ota/package?id=os-12.10.0'));
});

test('GetUpdateFrom returns the optimal Update object', async () => {
  const r = await amz('GetUpdateFrom', { fromVersion: '3.3.4', subsystem: 'os' });
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.equal(u._id, 'os-12.10.0');
  assert.equal(u.subsystem, 'os');
});

test('GetUpdateFrom with no applicable update -> 404 UPDATE_NOT_FOUND', async () => {
  // The exact code matters: the robot's UpdateManager aborts the whole check on any error code
  // other than UPDATE_NOT_FOUND (so a not-stocked subsystem must not poison os/services).
  const r = await amz('GetUpdateFrom', { fromVersion: '12.10.0', subsystem: 'os' });
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('x-amzn-errortype'), 'UPDATE_NOT_FOUND');
  const e = await r.json();
  assert.equal(e.__type, 'UPDATE_NOT_FOUND');
});

test('unknown X-Amz-Target -> 400', async () => {
  const r = await amz('Frobnicate', {});
  assert.equal(r.status, 400);
  assert.equal((await r.json()).__type, 'UnknownOperationException');
});

test('GET /ota/package streams the exact bytes with Content-Length', async () => {
  const r = await fetch(`${base}/ota/package?id=services-12.10.0`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(Number(r.headers.get('content-length')), FILES['services-12.10.0.tar'].length);
  const body = Buffer.from(await r.arrayBuffer());
  assert.equal(sha1(body), sha1(FILES['services-12.10.0.tar']));
});

test('GET /ota/package for unknown id -> 404', async () => {
  const r = await fetch(`${base}/ota/package?id=nope`);
  assert.equal(r.status, 404);
});

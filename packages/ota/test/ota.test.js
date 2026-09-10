// Tests for the OTA update server: catalog matching + the AWS-JSON Update wire surface +
// package streaming. No network fixtures — temp package files are created and hashed here so
// the assertions pin the exact length/SHA-1 the robot's jibo-download-update would verify.
//
// Matching follows the pinned server jiborobot/srv-update-ws src/controllers/update.ctrl.ts:
// the query is always scoped to one subsystem (default "main"), the filter is a PREFIX of the
// entry's filter when one is asked for and EXACTLY "" when none is, and a robot's server-side
// target overrides the filter it asked with.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { Catalog, cmpVersion, filterMatches } from '../src/catalog.js';
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

const amz = (target, body, headers = {}) =>
  fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Update_20160301.${target}`, ...headers },
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

// Source update.ctrl.ts:30-41 — the subsystem always defaults to "main"; the filter is a
// prefix match when asked for and EXACTLY "" when not.
test('subsystem defaults to "main" and is never a match-all', () => {
  assert.equal(catalog.listUpdates().length, 0, 'no "main" entries -> nothing offered');
  assert.equal(catalog.listUpdates({ subsystem: 'os' }).length, 2);
});

test('filter: prefix when asked for, empty-string-exact when not', () => {
  assert.equal(catalog.listUpdates({ subsystem: 'be', filter: 'bl' }).length, 0);
  assert.equal(catalog.listUpdates({ subsystem: 'be', filter: 'gr' }).length, 1);
  assert.equal(catalog.listUpdates({ subsystem: 'be', filter: '' }).length, 0, 'a filterless request must not see the "green" entry');
  assert.equal(catalog.listUpdates({ subsystem: 'os', filter: '' }).length, 2, 'unfiltered entries are served to a filterless request');
  assert.equal(catalog.listUpdates({ subsystem: 'os', filter: 'gr' }).length, 0, 'an unfiltered entry must not be served to a filtered request');
});

test('filterMatches is the source rule in both directions', () => {
  assert.equal(filterMatches('green', 'gr'), true);
  assert.equal(filterMatches('green', 'blue'), false);
  assert.equal(filterMatches('green', ''), false);
  assert.equal(filterMatches('', ''), true);
  assert.equal(filterMatches('', 'gr'), false);
});

// Source targeted.ctrl.ts + update.ctrl.ts:29-36 — a server-side target overrides the filter.
test('a server-side target overrides the filter the robot asks with', async () => {
  const cat = await Catalog.load({ entries: ENTRIES, dataDir, log: {} });
  await cat.setTarget('BOJW-1000-5555', 'green'); // SetOTATarget
  assert.deepEqual(cat.listTargets(), [{ serial: 'BOJW-1000-5555', target: 'green' }]);
  assert.equal(await cat.effectiveFilter('', 'BOJW-1000-5555'), 'green');
  assert.equal(await cat.effectiveFilter('blue', 'BOJW-1000-5555'), 'green', 'target wins over the request filter');
  assert.equal(cat.listUpdates({ subsystem: 'be', filter: await cat.effectiveFilter('blue', 'BOJW-1000-5555') }).length, 1);
  assert.equal(await cat.effectiveFilter('blue', 'OTHER-ROBOT'), 'blue', 'no mapping -> the request filter stands');
  await cat.setTarget('BOJW-1000-5555', null); // ClearOTATarget
  assert.deepEqual(cat.listTargets(), []);
  assert.equal(await cat.effectiveFilter('blue', 'BOJW-1000-5555'), 'blue');
});

test('getFilter resolves friendlyId -> serial via the injected resolver when supplied', async () => {
  const cat = await Catalog.load({ entries: [], dataDir, log: {}, serialOf: async (fid) => (fid === 'Alex-Alex' ? 'BOJW-1' : undefined) });
  await cat.setTarget('BOJW-1', 'alex');
  assert.equal(await cat.getFilter('Alex-Alex'), 'alex');
  assert.equal(await cat.getFilter('Beta-Beta'), undefined, 'unresolvable friendlyId -> no filter (source returns undefined)');
});

// Source getUpdateFrom (update.ctrl.ts:110-111) picks at RANDOM among entries that share the
// highest toVersion.
test('getUpdateFrom breaks a tie on the top toVersion at random', async () => {
  const tied = await Catalog.load({
    entries: [
      { id: 'tie-a', subsystem: 'os', fromVersion: '1.0.0', toVersion: '5.0.0', filter: '', file: 'os-12.10.0.tar' },
      { id: 'tie-b', subsystem: 'os', fromVersion: '1.0.0', toVersion: '5.0.0', filter: '', file: 'os-12.6.0.tar' },
    ],
    dataDir,
    log: {},
  });
  const picks = new Set();
  for (let i = 0; i < 60; i++) {
    const best = tied.getUpdateFrom({ fromVersion: '1.0.0', subsystem: 'os' });
    assert.equal(best.toVersion, '5.0.0');
    picks.add(best.id);
  }
  assert.deepEqual([...picks].sort(), ['tie-a', 'tie-b'], 'both tied entries are reachable');
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

test('ListUpdates with no subsystem queries "main" (nothing stocked) -> 200 []', async () => {
  const r = await amz('ListUpdates', {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
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
  assert.equal(e.message, 'Update not found');
});

test('GetUpdateFrom / ListUpdatesFrom without fromVersion -> 422 Boom.badData (Joi required)', async () => {
  // Source @validatePayload({fromVersion: Joi.string().required()}) -> Boom.badData -> 422 with
  // NO error code (the client then reads body.error = the HTTP reason phrase).
  for (const op of ['GetUpdateFrom', 'ListUpdatesFrom']) {
    const r = await amz(op, { subsystem: 'os' });
    assert.equal(r.status, 422, `${op} must reject a missing fromVersion`);
    assert.equal(r.headers.get('x-amzn-errortype'), null, `${op} carries no x-amzn-errortype (Hapi/Boom shape)`);
    const e = await r.json();
    assert.equal(e.statusCode, 422);
    assert.equal(e.error, 'Unprocessable Entity');
    assert.match(e.message, /fromVersion/);
    assert.equal(e.__type, undefined);
  }
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

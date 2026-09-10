// The Update service's admin/publication surface, re-derived from the pinned server
// jiborobot/srv-update-ws:
//   src/handlers/update.handler.ts      CreateUpdate / RemoveUpdate / ListUniqueFilters
//   src/handlers/targeted.handler.ts    SetTarget / ListTargets  (apis/updateadmin-2016-03-01)
//   src/controllers/update.ctrl.ts      create/remove/listUniqueFilters + the wire record
//   src/controllers/targeted.ctrl.ts    the serial -> target map
//   src/errors/update.ts                the codified error envelopes
// plus jiborobot/srv-server src/errors.ts (AUTHORIZED_UNDER_ADMIN) and src/validate.ts
// (Joi -> Boom.badData -> 422).
//
// Every operation here is unreachable in the pinned gateway without a signed, active account
// (none of the eight Update targets appear in unauthorizedMethods, unsignedMethods is empty),
// so the tests drive the injected x-amz-credentials header the gateway populates.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { Catalog } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const ADMIN = { 'x-amz-credentials': JSON.stringify({ id: 'acct-admin', isAdmin: true }) };
const OTHER = { 'x-amz-credentials': JSON.stringify({ id: 'acct-other', isAdmin: true }) };
const PLAIN = { 'x-amz-credentials': JSON.stringify({ id: 'acct-plain' }) };

const PKG = Buffer.from('OS-IMAGE-13.0.0-'.repeat(40));
const ENTRIES = [
  { id: 'os-12.10.0', subsystem: 'os', fromVersion: '*', toVersion: '12.10.0', changes: 'os', filter: '', dependencies: {}, file: 'os-12.10.0.tar' },
  { id: 'be-green', subsystem: 'be', fromVersion: '*', toVersion: '10.0.16', changes: 'be', filter: 'green', dependencies: {}, file: 'be-green.tar' },
];

let dataDir;
let catalog;
let server;
let base;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ota-admin-'));
  await writeFile(path.join(dataDir, 'os-12.10.0.tar'), PKG);
  await writeFile(path.join(dataDir, 'be-green.tar'), PKG);
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

const create = (buf, headers = {}) =>
  fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Update_20160301.CreateUpdate',
      'x-update-from-version': '12.10.0',
      'x-update-to-version': '13.0.0',
      'x-update-changes': 'Last Dance',
      ...headers,
    },
    body: buf,
  });

// --- ListUniqueFilters ------------------------------------------------------
test('ListUniqueFilters is admin-only (401) and lists distinct filters', async () => {
  const anon = await amz('ListUniqueFilters', {});
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('x-amzn-errortype'), 'AUTHORIZED_UNDER_ADMIN');
  assert.equal((await anon.json()).__type, 'AUTHORIZED_UNDER_ADMIN');

  const r = await amz('ListUniqueFilters', {}, ADMIN);
  assert.equal(r.status, 200);
  const filters = await r.json();
  assert.deepEqual([...filters].sort(), ['', 'green']);
});

// --- SetTarget / ListTargets (updateadmin) ----------------------------------
test('SetTarget / ListTargets are admin-only and map serial -> target', async () => {
  for (const op of ['SetTarget', 'ListTargets']) {
    const anon = await amz(op, op === 'SetTarget' ? { serial: 'S1', target: 'green' } : {}, {});
    assert.equal(anon.status, 401, `${op} must require an admin`);
  }

  const list0 = await amz('ListTargets', {}, ADMIN);
  assert.deepEqual(await list0.json(), []);

  const set = await amz('SetTarget', { serial: 'BOJW-1000-5555', target: 'green' }, ADMIN);
  assert.equal(set.status, 200);

  const list1 = await amz('ListTargets', {}, ADMIN);
  assert.deepEqual(await list1.json(), [{ serial: 'BOJW-1000-5555', target: 'green' }]);

  // ClearOTATarget — an empty target removes the mapping
  const clear = await amz('SetTarget', { serial: 'BOJW-1000-5555', target: null }, ADMIN);
  assert.equal(clear.status, 200);
  assert.deepEqual(await (await amz('ListTargets', {}, ADMIN)).json(), []);
});

test('SetTarget validation: a missing or empty serial is a 422 with no error code', async () => {
  for (const body of [{ target: 'green' }, { serial: '', target: 'green' }]) {
    const r = await amz('SetTarget', body, ADMIN);
    assert.equal(r.status, 422);
    assert.equal(r.headers.get('x-amzn-errortype'), null);
    const e = await r.json();
    assert.equal(e.error, 'Unprocessable Entity');
    assert.match(e.message, /serial/);
  }
  // @parseCredentials({adminOnly:true}) runs before validatePayload: non-admin -> 401 even
  // with a bad payload.
  const anon = await amz('SetTarget', {}, {});
  assert.equal(anon.status, 401);
});

test('a robot presenting a targeted serial sees the target-filtered update', async () => {
  await amz('SetTarget', { serial: 'ROBOT-1', target: 'green' }, ADMIN);
  // The robot asks with no filter, but its server-side target is "green".
  const r = await amz('GetUpdateFrom', { fromVersion: '3.3.4', subsystem: 'be' }, { 'x-amz-credentials': JSON.stringify({ id: 'r1', friendlyId: 'ROBOT-1' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json())._id, 'be-green');
  // A robot without the mapping gets nothing for "be" (the filterless request cannot see "green").
  const none = await amz('GetUpdateFrom', { fromVersion: '3.3.4', subsystem: 'be' }, { 'x-amz-credentials': JSON.stringify({ id: 'r2', friendlyId: 'ROBOT-2' }) });
  assert.equal(none.status, 404);
  await amz('SetTarget', { serial: 'ROBOT-1', target: null }, ADMIN);
});

// --- CreateUpdate -----------------------------------------------------------
test('CreateUpdate is admin-gated: 403 UPDATE_ONLY_ADMIN_CAN_CREATE for a non-admin', async () => {
  const r = await create(PKG, PLAIN);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('x-amzn-errortype'), 'UPDATE_ONLY_ADMIN_CAN_CREATE');
  const e = await r.json();
  assert.equal(e.__type, 'UPDATE_ONLY_ADMIN_CAN_CREATE');
  assert.equal(e.message, 'Only admin account can create platform update');
});

test('CreateUpdate validates the required headers (422) before the admin gate', async () => {
  const headers = { ...ADMIN };
  delete headers['x-amz-credentials'];
  const r = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Update_20160301.CreateUpdate',
      'x-update-to-version': '13.0.0',
      // x-update-from-version and x-update-changes omitted
    },
    body: PKG,
  });
  assert.equal(r.status, 422);
  const e = await r.json();
  assert.equal(e.error, 'Unprocessable Entity');
  assert.match(e.message, /x-update-/);
});

test('CreateUpdate stores the package and returns the wire Update record', async () => {
  const r = await create(PKG, ADMIN);
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.match(u._id, /^[0-9a-f]{24}$/, 'ObjectId-shaped id');
  assert.equal(u.subsystem, 'main', 'subsystem defaults to "main"');
  assert.equal(u.fromVersion, '12.10.0');
  assert.equal(u.toVersion, '13.0.0');
  assert.equal(u.changes, 'Last Dance');
  assert.equal(u.accountId, 'acct-admin');
  assert.equal(u.length, PKG.length);
  assert.equal(u.shaHash, sha1(PKG));
  assert.ok(typeof u.created === 'number' && u.created > 0);
  assert.ok(u.url.endsWith(`/ota/package?id=${u._id}`));

  // the bytes the robot would download are exactly what was uploaded
  const dl = await fetch(u.url);
  assert.equal(dl.status, 200);
  assert.equal(Number(dl.headers.get('content-length')), PKG.length);
  assert.equal(sha1(Buffer.from(await dl.arrayBuffer())), sha1(PKG));

  // and it is immediately selectable
  const listed = await amz('ListUpdates', { subsystem: 'main' }, ADMIN);
  assert.equal((await listed.json()).length, 1);
});

test('CreateUpdate rejects a duplicate (same from/to/subsystem/filter) with 409 UPDATE_ALREADY_EXISTS', async () => {
  const r = await create(PKG, ADMIN);
  assert.equal(r.status, 409);
  assert.equal(r.headers.get('x-amzn-errortype'), 'UPDATE_ALREADY_EXISTS');
  assert.equal((await r.json()).message, 'Update with same version specifications already exists');
});

test('CreateUpdate reads x-update-dependencies* headers into the dependencies map', async () => {
  const r = await create(PKG, { ...ADMIN, 'x-update-from-version': '13.0.0', 'x-update-to-version': '14.0.0', 'x-update-dependenciesos': '13.0.0' });
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.deepEqual(u.dependencies, { os: '13.0.0' });
});

test('CreateUpdate honours an explicit subsystem and filter', async () => {
  const r = await create(PKG, { ...ADMIN, 'x-update-from-version': '20.0.0', 'x-update-to-version': '21.0.0', 'x-update-subsystem': 'services', 'x-update-filter': 'blue' });
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.equal(u.subsystem, 'services');
  assert.equal(u.filter, 'blue');
  const filters = await (await amz('ListUniqueFilters', {}, ADMIN)).json();
  assert.ok(filters.includes('blue'));
});

// --- RemoveUpdate -----------------------------------------------------------
test('RemoveUpdate validates id (422) and reports an unknown id as 404 UPDATE_NOT_FOUND', async () => {
  const missing = await amz('RemoveUpdate', {}, ADMIN);
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).error, 'Unprocessable Entity');

  const unknown = await amz('RemoveUpdate', { id: 'ffffffffffffffffffffffff' }, ADMIN);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).__type, 'UPDATE_NOT_FOUND');
});

test('RemoveUpdate refuses a different admin account with 403 UPDATE_BELONGS_OTHER_ACCOUNT', async () => {
  const created = await (await create(PKG, { ...ADMIN, 'x-update-from-version': '30.0.0', 'x-update-to-version': '31.0.0' })).json();
  const r = await amz('RemoveUpdate', { id: created._id }, OTHER);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('x-amzn-errortype'), 'UPDATE_BELONGS_OTHER_ACCOUNT');
  assert.equal((await r.json()).message, 'Update belongs to other account');

  // the creator can remove it; a second removal is then 404
  const ok = await amz('RemoveUpdate', { id: created._id }, ADMIN);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json())._id, created._id);
  const again = await amz('RemoveUpdate', { id: created._id }, ADMIN);
  assert.equal(again.status, 404);
});

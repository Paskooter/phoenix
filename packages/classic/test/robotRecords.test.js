// A-07 — Robot records, provisioning and calibration/history behaviour.
//
// Every expectation here is derived from the pinned source (see the header of
// packages/classic/src/robot.js for the exact file:line provenance):
//   jiborobot/srv-robots-ws@4c8b1b75f3e0ccb90fab160019637704ba62d36a  (command side)
//   jiborobot/srv-robots-read-ws@decbbf7e959af3dabe2384940cb316b0689a18b4 (read side)
//   jiborobot/srv-serial-names src/main.js (GetFriendlyIds vocabulary)
//   apis/robot-2016-02-25.normal.json + apis/robotadmin-2016-02-25.normal.json (wire model)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../src/index.js';
import {
  makeRobotHandler, RobotStore, convertRobotId, ROBOT_ERRORS,
  COMMAND_ACCEPTED_RESPONSE, MANUFACTURING_EMAIL,
} from '../src/robot.js';
import { generateFriendlyId, randomlyGenerateCombos, WORD_COUNTS } from '../src/serialNames.js';

// An unroutable account base so the default ownership resolver returns "unresolved" fast
// (connection refused, not a 2s timeout) — the LAN-trust path.
process.env.NET_account = '127.0.0.1:1';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'a07-robot-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const credsHeader = (o) => ({ headers: { 'x-amz-credentials': JSON.stringify(o) } });
const MFG = () => credsHeader({ id: 'mfg-account', email: MANUFACTURING_EMAIL });
const ADMIN = () => credsHeader({ id: 'admin-account', isAdmin: true });
const OWNER = () => credsHeader({ id: 'owner-account', email: 'owner@example.com' });
const OTHER = () => credsHeader({ id: 'other-account', email: 'other@example.com' });

/** Drive the handler directly; capture status/headers/body like sendAmz writes them. */
function call(handler, op, body, req = {}, log = undefined) {
  const out = { status: null, headers: null, body: null };
  const res = {
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(text) { out.body = text === undefined ? null : JSON.parse(text); },
  };
  return Promise.resolve(handler({ req, res, op, body, log })).then(() => out);
}

function storeFor(name) { return new RobotStore({ dir: join(dir, name) }); }

async function amz(port, target, body, headers = {}) {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

const ID = 'ab-cd-ef-gh';        // 4 hyphen parts -> converted to Ab-Cd-Ef-Gh
const CID = 'Ab-Cd-Ef-Gh';

// ---------------------------------------------------------------------------
// id conversion + event projection (source convertId / Robot.applyEvent)
// ---------------------------------------------------------------------------

test('convertRobotId Pascal-cases only 4-part ids, like the source convertId', () => {
  assert.equal(convertRobotId('ab-cd-ef-gh'), 'Ab-Cd-Ef-Gh');
  assert.equal(convertRobotId('AB-CD-EF-GH'), 'Ab-Cd-Ef-Gh');
  assert.equal(convertRobotId('robot-123'), 'robot-123');       // 2 parts untouched
  assert.equal(convertRobotId('a-b-c-d-e'), 'a-b-c-d-e');       // 5 parts untouched
  assert.equal(convertRobotId(''), '');
});

test('RobotStore aggregate applies RobotCreated/Updated/Calibrated/Deleted like the source', () => {
  const store = storeFor('aggregate');
  assert.deepEqual(store.eventsFor(ID), []);
  store.append({ name: 'RobotCreated', objectId: CID, created: 10, payload: { serialNumber: 'S1', nested: { a: 1 } } });
  store.append({ name: 'RobotUpdated', objectId: CID, created: 20, payload: { nested: { b: 2 }, suspended: false } });
  store.append({ name: 'RobotCalibrated', objectId: CID, created: 30, payload: { yaw: 1 } });
  const agg = store.aggregate(ID);
  assert.equal(agg.exists, true);
  assert.equal(agg.deleted, false);
  assert.equal(agg.created, 10);
  assert.equal(agg.updated, 30);                                 // calibrate restamps `updated`
  assert.deepEqual(agg.payload, { serialNumber: 'S1', nested: { a: 1, b: 2 }, suspended: false });
  assert.deepEqual(agg.calibrationPayload, { yaw: 1 });
  store.append({ name: 'RobotDeleted', objectId: CID, created: 40 });
  const deleted = store.aggregate(ID);
  assert.equal(deleted.exists, true);
  assert.equal(deleted.deleted, true);
});

// ---------------------------------------------------------------------------
// error envelopes + missing-record behaviour (exact status codes + __type)
// ---------------------------------------------------------------------------

test('command-side errors carry the source status and __type', async () => {
  const store = storeFor('errors');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: () => 5 });

  const created = await call(h, 'CreateRobot', { id: ID, payload: {} }, MFG());
  assert.equal(created.status, 200);
  assert.deepEqual(created.body, COMMAND_ACCEPTED_RESPONSE);

  const dup = await call(h, 'CreateRobot', { id: ID, payload: {} }, MFG());
  assert.equal(dup.status, 409);
  assert.equal(dup.body.__type, 'ENTITY_ALREADY_EXISTS');
  assert.equal(dup.headers['x-amzn-errortype'], 'ENTITY_ALREADY_EXISTS');
  assert.equal(dup.body.message, ROBOT_ERRORS.ENTITY_ALREADY_EXISTS.message);

  const notFound = await call(h, 'CalibrateRobot', { id: 'zz-zz-zz-zz', calibrationPayload: {} }, MFG());
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.__type, 'ENTITY_NOT_FOUND');

  await call(h, 'RemoveRobot', { id: ID }, MFG());
  const deleted = await call(h, 'RemoveRobot', { id: ID }, MFG());
  assert.equal(deleted.status, 410);
  assert.equal(deleted.body.__type, 'ENTITY_DELETED');

  const readDeleted = await call(h, 'GetRobot', { id: ID }, MFG());
  assert.equal(readDeleted.status, 404, 'a deleted robot is gone from the read projection');
  assert.equal(readDeleted.body.__type, 'ROBOT_NOT_FOUND');
});

test('validation failures use the 400 ValidationException envelope', async () => {
  const h = makeRobotHandler({ store: storeFor('validation'), ownedRobots: async () => null });
  for (const [op, body] of [
    ['CreateRobot', {}],                              // id + payload required
    ['CreateRobot', { id: ID }],                      // payload required
    ['UpdateRobot', { id: ID }],                      // payload required
    ['RemoveRobot', {}],                              // id required
    ['CalibrateRobot', { id: ID }],                   // calibrationPayload required
    ['GetFriendlyIds', {}],                           // count required
  ]) {
    const r = await call(h, op, body, MFG());
    assert.equal(r.status, 400, `${op} should be a 400`);
    assert.equal(r.body.__type, 'ValidationException');
  }
  const missingId = await call(h, 'UpdateRobot', { payload: {} }, OWNER());
  assert.equal(missingId.status, 400);
});

test('unknown Robot operations stay a bounded ValidationException', async () => {
  const h = makeRobotHandler({ store: storeFor('unknown'), ownedRobots: async () => null });
  const r = await call(h, 'FrobnicateRobot', { id: ID }, MFG());
  assert.equal(r.status, 400);
  assert.equal(r.body.__type, 'ValidationException');
  assert.match(r.body.message, /unknown Robot operation/);
});

// ---------------------------------------------------------------------------
// permission matrix (manufacturing / admin / owner / robot / anonymous)
// ---------------------------------------------------------------------------

test('manufacturing-only command ops reject non-manufacturing callers with MANUFACTURING_ONLY 403', async () => {
  const store = storeFor('perm-mfg');
  const h = makeRobotHandler({ store, ownedRobots: async () => ['any'], clock: () => 1 });
  for (const [op, body] of [
    ['CreateRobot', { id: ID, payload: {} }],
    ['CreateRobotBatch', [{ id: ID, payload: {} }]],
    ['CalibrateRobot', { id: ID, calibrationPayload: {} }],
    ['RemoveRobot', { id: ID }],
    ['GetFriendlyIds', { count: 1 }],
  ]) {
    const r = await call(h, op, body, OWNER());
    assert.equal(r.status, 403, `${op} must be manufacturing-only`);
    assert.equal(r.body.__type, 'MANUFACTURING_ONLY');
  }
  // The manufacturing admin email is the only accepted identity for the mfg gate.
  const adminPrefixed = await call(h, 'CreateRobot', { id: ID, payload: {} }, ADMIN());
  assert.equal(adminPrefixed.status, 403, 'isAdmin does NOT satisfy the manufacturing-only command gate');
});

test('GetFriendlyIds accepts manufacturing or isAdmin (source isManufacturingOrAdmin)', async () => {
  const h = makeRobotHandler({ store: storeFor('perm-friendly'), ownedRobots: async () => null, clock: () => 1 });
  assert.equal((await call(h, 'GetFriendlyIds', { count: 1 }, MFG())).status, 200);
  assert.equal((await call(h, 'GetFriendlyIds', { count: 1 }, ADMIN())).status, 200);
  assert.equal((await call(h, 'GetFriendlyIds', { count: 1 }, OWNER())).status, 403);
});

test('reads enforce manufacturing-or-owner when an identity is present', async () => {
  const store = storeFor('perm-read');
  const owned = async (ownerId) => (ownerId === 'owner-account' ? [ID] : []);
  const h = makeRobotHandler({ store, ownedRobots: owned, clock: () => 1 });
  await call(h, 'CreateRobot', { id: ID, payload: { serialNumber: 'S1' } }, MFG());

  for (const op of ['GetRobot', 'GetRobotHistory', 'GetCalibrationData']) {
    assert.equal((await call(h, op, { id: ID }, MFG())).status, 200, `${op} manufacturing`);
    assert.equal((await call(h, op, { id: ID }, ADMIN())).status, 200, `${op} admin`);
    assert.equal((await call(h, op, { id: ID }, OWNER())).status, 200, `${op} owner`);
    const denied = await call(h, op, { id: ID }, OTHER());
    assert.equal(denied.status, 403, `${op} non-owner`);
    assert.equal(denied.body.__type, 'MANUFACTURING_OR_OWNER_ONLY');
  }
});

test('UpdateRobot: owner may update, non-owner is refused, suspended is manufacturing-only', async () => {
  const store = storeFor('perm-update');
  const owned = async (ownerId) => (ownerId === 'owner-account' ? [ID] : []);
  const h = makeRobotHandler({ store, ownedRobots: owned, clock: () => 1 });
  await call(h, 'CreateRobot', { id: ID, payload: {} }, MFG());

  assert.equal((await call(h, 'UpdateRobot', { id: ID, payload: { timeZone: 'UTC' } }, OWNER())).status, 200);
  const nonOwner = await call(h, 'UpdateRobot', { id: ID, payload: { timeZone: 'UTC' } }, OTHER());
  assert.equal(nonOwner.status, 403);
  assert.equal(nonOwner.body.__type, 'ROBOT_OR_OWNER_ONLY');
  // payload.suspended is restrictedToManufacturing (config.json): refused before ownership.
  const suspended = await call(h, 'UpdateRobot', { id: ID, payload: { suspended: true } }, OWNER());
  assert.equal(suspended.status, 403);
  assert.equal(suspended.body.__type, 'MANUFACTURING_ONLY');
  // manufacturing may set suspended and may update any robot.
  assert.equal((await call(h, 'UpdateRobot', { id: ID, payload: { suspended: true } }, MFG())).status, 200);
});

test('an anonymous (no forwarded identity) read follows the LAN-trust path; writes stay gated', async () => {
  const h = makeRobotHandler({ store: storeFor('perm-anon'), ownedRobots: async () => null });
  // no x-amz-credentials at all (the robot's unverified SigV4 boot read)
  assert.equal((await call(h, 'GetRobot', { id: ID }, {})).status, 200);
  assert.equal((await call(h, 'GetCalibrationData', { id: ID }, {})).status, 200);
  // manufacturing-only writes are still refused without the manufacturing identity
  assert.equal((await call(h, 'CreateRobot', { id: ID, payload: {} }, {})).status, 403);
  assert.equal((await call(h, 'GetFriendlyIds', { count: 1 }, {})).status, 403);
});

// ---------------------------------------------------------------------------
// read response shapes (output-shape driven)
// ---------------------------------------------------------------------------

test('GetRobot returns the read-projection record (id/payload/created/updated; no calibration/events)', async () => {
  const store = storeFor('shape-robot');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: () => 1000 });
  await call(h, 'CreateRobot', { id: ID, payload: { serialNumber: 'S1' } }, MFG());
  const r = await call(h, 'GetRobot', { id: ID }, MFG());
  assert.deepEqual(r.body, { id: CID, payload: { serialNumber: 'S1' }, created: 1000 });
  const keys = Object.keys(r.body).sort();
  assert.deepEqual(keys, ['created', 'id', 'payload']);
  // source strips calibrationPayload and events from the GetRobot result
  assert.ok(!('calibrationPayload' in r.body));
  assert.ok(!('events' in r.body));
});

test('GetCalibrationData omits calibrationPayload until the robot is calibrated', async () => {
  const store = storeFor('shape-cal');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: () => 1000 });
  await call(h, 'CreateRobot', { id: ID, payload: {} }, MFG());
  const before = await call(h, 'GetCalibrationData', { id: ID }, MFG());
  assert.deepEqual(before.body, { id: CID });                                   // undefined dropped, source projection
  await call(h, 'CalibrateRobot', { id: ID, calibrationPayload: { yaw: 1 } }, MFG());
  const after = await call(h, 'GetCalibrationData', { id: ID }, MFG());
  assert.deepEqual(after.body, { id: CID, calibrationPayload: { yaw: 1 } });
});

test('GetRobotHistory returns the Events LIST (id/name/created/payload), not an {events} wrapper', async () => {
  const store = storeFor('shape-history');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: (() => { let t = 100; return () => (t += 10); })() });
  await call(h, 'CreateRobot', { id: ID, payload: { serialNumber: 'S1' } }, MFG());
  await call(h, 'UpdateRobot', { id: ID, payload: { timeZone: 'UTC' } }, MFG());
  await call(h, 'CalibrateRobot', { id: ID, calibrationPayload: { yaw: 2 } }, MFG());
  const r = await call(h, 'GetRobotHistory', { id: ID }, MFG());
  assert.ok(Array.isArray(r.body), 'output shape Events is a list');
  assert.deepEqual(r.body.map((e) => e.name), ['RobotCreated', 'RobotUpdated', 'RobotCalibrated']);
  assert.deepEqual(r.body[0].payload, { serialNumber: 'S1' });
  assert.equal(r.body[0].id, CID);
  assert.equal(typeof r.body[0].created, 'number');
});

test('serialNumber is validated (422) after record existence (404), matching source order', async () => {
  const store = storeFor('shape-serial');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: () => 1 });
  await call(h, 'CreateRobot', { id: ID, payload: { serialNumber: 'S1' } }, MFG());
  const mismatch = await call(h, 'GetRobot', { id: ID, serialNumber: 'NOPE' }, MFG());
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.__type, 'SERIAL_NUMBER_NOT_MATCH');
  assert.equal((await call(h, 'GetRobot', { id: ID, serialNumber: 'S1' }, MFG())).status, 200);

  // payload without a serial number -> SERIAL_NUMBER_NOT_SET
  await call(h, 'CreateRobot', { id: 'aa-bb-cc-dd', payload: {} }, MFG());
  const notSet = await call(h, 'GetRobot', { id: 'aa-bb-cc-dd', serialNumber: 'S1' }, MFG());
  assert.equal(notSet.status, 422);
  assert.equal(notSet.body.__type, 'SERIAL_NUMBER_NOT_SET');

  // missing record + a serial number still 404s before the serial check
  const missing = await call(h, 'GetRobot', { id: 'zz-zz-zz-zz', serialNumber: 'S1' }, MFG());
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// friendly ids (srv-serial-names vocabulary + IdPairs list shape)
// ---------------------------------------------------------------------------

test('GetFriendlyIds returns a LIST of IdPair{id} from the source vocabulary', async () => {
  const h = makeRobotHandler({ store: storeFor('friendly'), ownedRobots: async () => null, clock: () => 1 });
  const r = await call(h, 'GetFriendlyIds', { count: 3 }, MFG());
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body), 'IdPairs is a list');
  assert.equal(r.body.length, 3);
  for (const pair of r.body) {
    assert.deepEqual(Object.keys(pair), ['id'], 'IdPair declares only the id member');
    assert.match(pair.id, /^[A-Z][a-z]+(-[A-Z][a-z]+){3}$/, 'four PascalCase hyphen parts');
    assert.ok(pair.id.length <= 25, 'serial-names max_length=25');
  }
  assert.equal(new Set(r.body.map((p) => p.id)).size, 3, 'ids are unique');
});

test('the vendored serial-names pools are the pinned four data files', () => {
  assert.deepEqual(WORD_COUNTS, { colors: 218, tech: 238, food: 169, fabrics: 71 });
  const combo = randomlyGenerateCombos('bla bla', '-', 25, 1)[0];
  assert.match(combo, /^[A-Za-z]+-[A-Za-z]+-[A-Za-z]+-[A-Za-z]+$/);
  // four groups come from four distinct pools -> generated ids are 4 words
  assert.equal(combo.split('-').length, 4);
  assert.equal(generateFriendlyId().split('-').length, 4);
});

test('GetFriendlyIds skips ids already present in the durable record set', async () => {
  const store = storeFor('friendly-collide');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: () => 1 });
  const first = (await call(h, 'GetFriendlyIds', { count: 1 }, MFG())).body[0].id;
  await call(h, 'CreateRobot', { id: first, payload: {} }, MFG());
  const next = (await call(h, 'GetFriendlyIds', { count: 1 }, MFG())).body[0].id;
  assert.notEqual(next, first);
});

// ---------------------------------------------------------------------------
// CreateRobotBatch (Joi array body; per-item errors swallowed)
// ---------------------------------------------------------------------------

test('CreateRobotBatch requires an array, creates valid items and swallows per-item conflicts', async () => {
  const store = storeFor('batch');
  const h = makeRobotHandler({ store, ownedRobots: async () => null, clock: () => 7 });
  const notArray = await call(h, 'CreateRobotBatch', { id: ID, payload: {} }, MFG());
  assert.equal(notArray.status, 400);

  const r = await call(h, 'CreateRobotBatch', [
    { id: 'aa-aa-aa-aa', payload: { a: 1 } },
    { id: 'bb-bb-bb-bb', payload: { b: 2 } },
    { id: 'aa-aa-aa-aa', payload: { a: 1 } },   // duplicate inside the batch -> ignored
    { id: '', payload: {} },                    // invalid item -> ignored
  ], MFG());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, COMMAND_ACCEPTED_RESPONSE);
  assert.equal(store.eventsFor('aa-aa-aa-aa').length, 1);
  assert.equal(store.eventsFor('bb-bb-bb-bb').length, 1);
});

// ---------------------------------------------------------------------------
// runtime: every operation is SERVED, and state survives a real restart
// ---------------------------------------------------------------------------

test('every robot/robotadmin operation is served over HTTP and state survives a process restart', async () => {
  const rdir = join(dir, 'runtime');
  let serverA = await createClassicEntrypoint({ robotStore: new RobotStore({ dir: rdir }) }).listen(0);
  const portA = serverA.address().port;
  const mfg = MFG().headers;

  // robotadmin + robot command ops -> 200 Command accepted
  assert.equal((await amz(portA, 'Robot_20160225.CreateRobot', { id: ID, payload: { serialNumber: 'SN-1' } }, mfg)).status, 200);
  assert.equal((await amz(portA, 'Robot_20160225.CreateRobotBatch', [{ id: 'ab-ab-ab-ab', payload: {} }], mfg)).status, 200);
  assert.equal((await amz(portA, 'Robot_20160225.UpdateRobot', { id: ID, payload: { timeZone: 'UTC' } }, mfg)).status, 200);
  assert.equal((await amz(portA, 'Robot_20160225.CalibrateRobot', { id: ID, calibrationPayload: { yaw: 9 } }, mfg)).status, 200);

  // read ops
  const robot = await amz(portA, 'Robot_20160225.GetRobot', { id: ID }, mfg);
  assert.equal(robot.status, 200);
  assert.deepEqual(robot.body.payload, { serialNumber: 'SN-1', timeZone: 'UTC' });
  const friendly = await amz(portA, 'Robot_20160225.GetFriendlyIds', { count: 2 }, mfg);
  assert.equal(friendly.status, 200);
  assert.equal(friendly.body.length, 2);

  // stop the whole process face, keep only the on-disk log, start a fresh entrypoint
  await new Promise((resolve) => serverA.close(resolve));
  const persisted = JSON.parse(readFileSync(join(rdir, 'robots.json'), 'utf8'));
  assert.equal(persisted.events.filter((e) => e.objectId === CID).length, 3, 'created+updated+calibrated on disk');

  serverA = await createClassicEntrypoint({ robotStore: new RobotStore({ dir: rdir }) }).listen(0);
  const portB = serverA.address().port;

  const restored = await amz(portB, 'Robot_20160225.GetRobot', { id: ID }, mfg);
  assert.equal(restored.status, 200, 'the durable record is re-read after restart');
  assert.equal(restored.body.id, CID);
  assert.deepEqual(restored.body.payload, { serialNumber: 'SN-1', timeZone: 'UTC' });

  const restoredCal = await amz(portB, 'Robot_20160225.GetCalibrationData', { id: ID }, mfg);
  assert.deepEqual(restoredCal.body, { id: CID, calibrationPayload: { yaw: 9 } }, 'calibration survives restart');

  const restoredHistory = await amz(portB, 'Robot_20160225.GetRobotHistory', { id: ID }, mfg);
  assert.ok(Array.isArray(restoredHistory.body));
  assert.deepEqual(restoredHistory.body.map((e) => e.name), ['RobotCreated', 'RobotUpdated', 'RobotCalibrated']);

  const restoredBatch = await amz(portB, 'Robot_20160225.GetRobot', { id: 'ab-ab-ab-ab' }, mfg);
  assert.equal(restoredBatch.status, 200, 'batch-created robot also survives');

  // RemoveRobot is the ninth op and is served too
  assert.equal((await amz(portB, 'Robot_20160225.RemoveRobot', { id: ID }, mfg)).status, 200);
  assert.equal((await amz(portB, 'Robot_20160225.GetRobot', { id: ID }, mfg)).status, 404);

  await new Promise((resolve) => serverA.close(resolve));
});

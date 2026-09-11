// A-05 criterion 1+2 — the OOBE target surface and its AWS-JSON framing, pinned to the
// archived API models and the original handler decorators.
//
// Contract sources (Jibo archive MCP, https://pvindex.org/mcp):
//   gitea_read_file jiborobot/srv-jibo-server-client apis/oobe-2016-10-26.normal.json
//     metadata.targetPrefix = "OOBE_20161026", protocol "json", jsonVersion "1.1"
//     operations: PrepareRobot -> TokenContainer, GetStatus -> StatusContainer,
//                 SetupRobot -> RobotCredentials, ReconnectRobot -> CommandResponse
//   gitea_read_file jiborobot/srv-jibo-server-client apis/oobeadmin-2016-10-26.normal.json
//     metadata.targetPrefix = "OOBE_20161026" (same prefix), operations: GetServiceToken -> TokenContainer
//   gitea_read_file jiborobot/srv-account-ws src/handlers/oobe.handler.ts@master
//     mapping = { getServiceToken, getStatus, prepareRobot, reconnectRobot, setupRobot }
//     @parseCredentials({}) + @validatePayload on the four normal ops; GetServiceToken is
//     @parseCredentials({ adminOnly: true }) with NO @validatePayload.
//   docs/parity/evidence/2026-09-10/a02-auth-boundary/gateway-allow-lists.json
//     unauthorizedMethods = ["OOBE_20161026.GetStatus", "OOBE_20161026.SetupRobot"]
//
// The robot's @jibo/jibo-server-client serializes with X-Amz-Target: <targetPrefix>.<Operation>
// and Content-Type: application/x-amz-json-1.1; this face must answer in the same envelope.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-oobe-targets-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
delete process.env.NET_robotread;

// Relative imports only: node_modules/@phoenix/* symlinks to the MAIN checkout, so a
// package-name import would exercise the wrong tree.
const { createAccountService, getStore } = await import('../src/index.js');
const { createOwnerAccount, createLoop, mintSetupToken } = await import('../src/model.js');

let server; let base;

// The legacy OOBE face resolves the caller by the Authorization Credential accessKeyId
// (oobe.handler.ts @parseCredentials); the gateway, not this handler, owns SigV4.
const sig = (keyId) => `AWS4-HMAC-SHA256 Credential=${keyId}/20260612/us-east-1/account/aws4_request, SignedHeaders=host, Signature=feedface`;

async function amz(target, body, headers = {}) {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      ...headers,
      connection: 'close',
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    ct: res.headers.get('content-type'),
    errType: res.headers.get('x-amzn-errortype'),
    body: await res.json().catch(() => null),
  };
}

const AMZ = 'application/x-amz-json-1.1';

// The archived operation set, verbatim from the two API models. Both models share the
// single targetPrefix OOBE_20161026; the endpointPrefix (oobe vs oobeadmin) never
// reaches the wire target.
const NORMAL_OPS = ['PrepareRobot', 'GetStatus', 'SetupRobot', 'ReconnectRobot'];
const ADMIN_OPS = ['GetServiceToken'];

let seq = 0;
const nextId = (label) => `${label}-${seq += 1}`;

before(async () => {
  server = await createAccountService({ log: { info() {}, warn() {}, error() {} } }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('every archived OOBE operation reaches a real handler, never UnknownOperationException', async () => {
  // SetupRobot and GetStatus are in the gateway's unauthorizedMethods, so a bare request
  // reaches the handler and is refused by the handler's own boundary (Joi / credentials).
  const cases = [
    ['OOBE_20161026.PrepareRobot', {}, {}, 'CREDENTIALS_REQUIRED'],
    ['OOBE_20161026.GetStatus', {}, {}, 'ValidationException(422)'],
    ['OOBE_20161026.SetupRobot', {}, {}, 'ValidationException(422)'],
    ['OOBE_20161026.ReconnectRobot', {}, {}, 'CREDENTIALS_REQUIRED'],
    ['OOBE_20161026.GetServiceToken', {}, {}, 'AUTHORIZED_UNDER_ADMIN'],
  ];
  for (const [target, body, headers, expected] of cases) {
    const r = await amz(target, body, headers);
    assert.notEqual(r.errType, 'UnknownOperationException', `${target} must be a served operation`);
    assert.notEqual(r.status, 400, `${target} must not be an unknown target`);
    if (expected === 'ValidationException(422)') {
      assert.equal(r.status, 422, `${target} keeps Hapi's 422 @validatePayload envelope`);
    } else {
      assert.equal(r.body.__type, expected, `${target} reaches the named handler error`);
    }
  }
  assert.equal([...NORMAL_OPS, ...ADMIN_OPS].length, 5, 'the archived surface is five operations');
});

test('the admin operation shares the normal OOBE_20161026 target prefix', async () => {
  const store = getStore();
  const admin = createOwnerAccount(store, { email: 'admin-prefix@oobe.test', password: 'pw' });
  admin.isAdmin = true;
  store.flush();

  // oobeadmin-2016-10-26.normal.json declares targetPrefix OOBE_20161026 (not "OOBEAdmin..."),
  // so the generated client sends the admin call on the same prefix as the normal API.
  const r = await amz('OOBE_20161026.GetServiceToken', {}, { authorization: sig(admin.accessKeyId) });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.token, 'string');
});

test('both prefix spellings seen in the consumers resolve to the same handlers', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'prefix-owner@oobe.test', password: 'pw', firstName: 'Prefix' });
  store.flush();

  // OOBE_20161026 is the archived targetPrefix; scripts/portal-smoke.mjs and the older
  // local tests send the bare "OOBE." spelling. Dispatch is operation-keyed, so both work.
  const archived = await amz('OOBE_20161026.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
  const bare = await amz('OOBE.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
  assert.equal(archived.status, 200);
  assert.equal(bare.status, 200);
  assert.equal(typeof bare.body.token, 'string');
});

test('an unknown OOBE operation is a 400 UnknownOperationException in the AWS envelope', async () => {
  const r = await amz('OOBE_20161026.Frobnicate', {});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'UnknownOperationException');
  assert.equal(r.body.__type, 'UnknownOperationException');
  assert.equal(r.ct, AMZ);
});

test('PrepareRobot/GetStatus/SetupRobot/ReconnectRobot/GetServiceToken return the archived output shapes', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'shapes-owner@oobe.test', password: 'pw', firstName: 'Shapes' });
  store.flush();

  // TokenContainer { token (required), expires (long) } — PrepareRobot.
  const prepared = await amz('OOBE_20161026.PrepareRobot', {}, { authorization: sig(owner.accessKeyId) });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.ct, AMZ);
  assert.deepEqual(Object.keys(prepared.body).sort(), ['expires', 'token']);
  assert.equal(typeof prepared.body.token, 'string');
  assert.ok(prepared.body.token.length > 0);
  assert.equal(typeof prepared.body.expires, 'number');
  assert.ok(prepared.body.expires > Date.now(), 'expires is in the future');

  // StatusContainer { complete (required, boolean) } — GetStatus before and after redeem.
  const pending = await amz('OOBE_20161026.GetStatus', { token: prepared.body.token });
  assert.deepEqual(Object.keys(pending.body), ['complete']);
  assert.equal(pending.body.complete, false);

  // RobotCredentials { accessKeyId, secretAccessKey, serviceMode? } — SetupRobot.
  const setup = await amz('OOBE_20161026.SetupRobot', { token: prepared.body.token, id: 'shapes-robot-alpha' });
  assert.equal(setup.status, 200);
  assert.deepEqual(Object.keys(setup.body).sort(), ['accessKeyId', 'secretAccessKey']);
  assert.match(setup.body.accessKeyId, /^[A-Za-z0-9]{20}$/);
  assert.match(setup.body.secretAccessKey, /^[A-Za-z0-9]{40}$/);

  const done = await amz('OOBE_20161026.GetStatus', { token: prepared.body.token });
  assert.equal(done.body.complete, true);

  // CommandResponse { result (required, string) } — ReconnectRobot on the new robot's loop.
  const robot = store.accountByFriendlyId('shapes-robot-alpha');
  const loop = [...store.loops.values()].find((l) => l.robot === robot._id);
  const token = mintSetupToken(store, owner._id, loop._id);
  const reconnect = await amz('OOBE_20161026.ReconnectRobot', { token: token._id }, { authorization: sig(robot.accessKeyId) });
  assert.equal(reconnect.status, 200);
  assert.deepEqual(reconnect.body, { result: 'Command accepted' });

  // TokenContainer again — GetServiceToken (admin).
  const admin = createOwnerAccount(store, { email: 'shapes-admin@oobe.test', password: 'pw' });
  admin.isAdmin = true;
  store.flush();
  const service = await amz('OOBE_20161026.GetServiceToken', {}, { authorization: sig(admin.accessKeyId) });
  assert.equal(service.status, 200);
  assert.deepEqual(Object.keys(service.body).sort(), ['expires', 'token']);
  assert.equal(service.body._id, undefined, 'TokenContainer, not the raw token document');
});

test('controller failures keep the AWS-JSON envelope plus the x-amzn-errortype header', async () => {
  const store = getStore();
  const owner = createOwnerAccount(store, { email: 'err-owner@oobe.test', password: 'pw', firstName: 'Err' });
  store.flush();

  const missing = await amz('OOBE_20161026.SetupRobot', { token: 'NoSuchToken', id: 'err-robot' });
  assert.equal(missing.status, 404);
  assert.equal(missing.ct, AMZ);
  assert.equal(missing.errType, 'TOKEN_NOT_FOUND');
  assert.deepEqual(missing.body, { __type: 'TOKEN_NOT_FOUND', message: 'Token not found' });

  const nonAdmin = await amz('OOBE_20161026.GetServiceToken', {}, { authorization: sig(owner.accessKeyId) });
  assert.equal(nonAdmin.status, 401);
  assert.equal(nonAdmin.errType, 'AUTHORIZED_UNDER_ADMIN');
  assert.deepEqual(nonAdmin.body, { __type: 'AUTHORIZED_UNDER_ADMIN', message: 'Must be authorized under admin account' });
});

test('@validatePayload refusals keep Hapi 422 and carry no x-amzn-errortype', async () => {
  // oobe.handler.ts @validatePayload raises Boom.badData -> Hapi's 422 JSON envelope, which is
  // a different shape from the AWS 400 ValidationException used elsewhere on the robot face.
  for (const target of ['OOBE_20161026.SetupRobot', 'OOBE_20161026.GetStatus']) {
    const r = await amz(target, {});
    assert.equal(r.status, 422, target);
    assert.equal(r.ct, 'application/json; charset=utf-8', target);
    assert.equal(r.errType, null, `${target} is not an AWS error`);
    assert.equal(r.body.statusCode, 422);
    assert.equal(r.body.error, 'Unprocessable Entity');
    assert.match(r.body.message, /is required/, target);
  }
});

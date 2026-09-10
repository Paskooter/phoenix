// A-16 — ROM certificate exchange (ROM_20171011). Create / SetupServer / SetupClient.
//
// Contract source: jiborobot/srv-jibo-server-client@155d20a8.../apis/rom-2017-10-11.normal.json
// Behaviour source: jiborobot/srv-rom-ws (controllers/rom.ctrl.ts, handlers/rom.handler.ts,
//   schemes/certificate.ts, errors/rom.ts, clients/account.client.ts, clients/robot.client.ts).
//
// The controller-level cases mirror the archived original spec test
// (jiborobot/srv-rom-ws:test/rom.ctrl.spec.ts) one-for-one; the wire cases exercise the
// AWS-JSON envelope the robot/app actually sees.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { createClassicEntrypoint } from '../src/index.js';
import {
  RomController, RomError, CertificateStore, ROM_ERRORS,
  generateCertificatePair, CERTIFICATE_LIFETIME_DAYS,
} from '../src/rom.js';

const OWNER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const FRIENDLY_ID = 'Alex-Alex-Alex-Alex';
const IP = '192.168.1.100';
const NETMASK = '255.255.252.0';

/** Fake account/robot clients — the two dependencies rom.ctrl.ts injects. */
function fakes({ remoteEnabled = true, owned = true, robotPresent = true } = {}) {
  const loops = owned ? [{ owner: OWNER, robotFriendlyId: FRIENDLY_ID }] : [];
  return {
    accountClient: { async listLoops(ownerId) { return loops.filter((l) => l.owner === ownerId); } },
    robotClient: {
      async getById() {
        return robotPresent ? { id: FRIENDLY_ID, payload: { remoteEnabled } } : null;
      },
    },
  };
}

function controller(options = {}) {
  let tick = 1_700_000_000_000;
  const clock = () => (tick += 1000);
  const certificates = new CertificateStore(clock);
  return {
    certificates,
    controller: new RomController({ ...fakes(), certificates, ...options }),
  };
}

const pem = (label, value) => assert.match(value, new RegExp(`^-----BEGIN ${label}-----`), `${label} PEM`);

// ── controller: the original RomController cases ─────────────────────────────

test('rom: create returns { created } as a millisecond timestamp', async () => {
  const { controller: ctrl } = controller();
  const created = await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  assert.deepEqual(Object.keys(created), ['created']);
  assert.equal(typeof created.created, 'number');
  assert.ok(created.created > 1_600_000_000_000, 'epoch milliseconds, not seconds');
});

test('rom: create always mints a NEW certificate (findByIdAndRemove)', async () => {
  const { controller: ctrl, certificates } = controller();
  const first = await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  const firstFingerprint = certificates.findById(FRIENDLY_ID).client.fingerprint;
  const second = await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  assert.notEqual(second.created, first.created);
  assert.equal(certificates.certificates.size, 1, 'the previous pair is replaced, not accumulated');
  assert.notEqual(certificates.findById(FRIENDLY_ID).client.fingerprint, firstFingerprint);
});

test('rom: create reports the client fingerprint on connection-requested', async () => {
  const seen = [];
  const { controller: ctrl, certificates } = controller({ onConnectionRequested: (e) => seen.push(e) });
  await ctrl.create({ aco: { appId: 'ImmaLittleTeapot' }, friendlyId: FRIENDLY_ID, ownerId: OWNER });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].aco, { appId: 'ImmaLittleTeapot' });
  assert.equal(seen[0].friendlyId, FRIENDLY_ID);
  assert.equal(seen[0].certFingerprint, certificates.findById(FRIENDLY_ID).client.fingerprint);
});

test('rom: setupClient before the robot deploys -> CERTIFICATE_NOT_DEPLOYED 404', async () => {
  const { controller: ctrl } = controller();
  await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  await assert.rejects(
    () => ctrl.setupClient({ friendlyId: FRIENDLY_ID, ownerId: OWNER }),
    (err) => err instanceof RomError
      && err.romError.code === 'CERTIFICATE_NOT_DEPLOYED'
      && err.romError.statusCode === 404,
  );
});

test('rom: setupServer returns the server bundle (no p12) and records the payload', async () => {
  const { controller: ctrl, certificates } = controller();
  await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  const out = await ctrl.setupServer({
    friendlyId: FRIENDLY_ID, ipAddress: IP, ipAddresses: [{ address: IP, netmask: NETMASK }],
  });
  assert.deepEqual(Object.keys(out).sort(), ['cert', 'created', 'fingerprint', 'private', 'public']);
  assert.equal(Object.hasOwn(out, 'p12'), false, 'ServerResponse has no p12 member');
  pem('CERTIFICATE', out.cert);
  pem('RSA PRIVATE KEY', out.private);
  pem('PUBLIC KEY', out.public);
  assert.equal(out.fingerprint, certificates.findById(FRIENDLY_ID).client.fingerprint,
    'ServerResponse.fingerprint is the CLIENT certificate fingerprint (ClientFingerprint shape)');
  assert.equal(typeof out.created, 'number');
  assert.equal(certificates.findById(FRIENDLY_ID).complete, true);
});

test('rom: setupClient after deploy returns the client bundle + robot payload', async () => {
  const { controller: ctrl, certificates } = controller();
  await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  await ctrl.setupServer({ friendlyId: FRIENDLY_ID, ipAddress: IP, ipAddresses: [{ address: IP, netmask: NETMASK }] });
  const out = await ctrl.setupClient({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  assert.deepEqual(Object.keys(out).sort(), ['cert', 'created', 'fingerprint', 'p12', 'payload', 'private', 'public']);
  pem('CERTIFICATE', out.cert);
  pem('RSA PRIVATE KEY', out.private);
  pem('PUBLIC KEY', out.public);
  assert.ok(out.p12.length > 100, 'PKCS#12 blob is present');
  assert.equal(out.fingerprint, certificates.findById(FRIENDLY_ID).server.fingerprint,
    'ClientResponse.fingerprint is the SERVER fingerprint (ServerFingerprint shape)');
  assert.equal(out.payload.ipAddress, IP);
  assert.equal(out.payload.ipAddresses.length, 1);
  assert.equal(out.payload.ipAddresses[0].address, IP);
  assert.equal(out.payload.ipAddresses[0].netmask, NETMASK);
});

test('rom: a second create resets the deployed state', async () => {
  const { controller: ctrl } = controller();
  await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  await ctrl.setupServer({ friendlyId: FRIENDLY_ID, ipAddress: IP, ipAddresses: [] });
  await ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER });
  await assert.rejects(() => ctrl.setupClient({ friendlyId: FRIENDLY_ID, ownerId: OWNER }),
    (err) => err.romError.code === 'CERTIFICATE_NOT_DEPLOYED');
});

test('rom: create from a non-owner -> ROBOT_NOT_OWNED 403', async () => {
  const { controller: ctrl } = controller({ ...fakes({ owned: false }) });
  await assert.rejects(() => ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER }),
    (err) => err.romError.code === 'ROBOT_NOT_OWNED' && err.romError.statusCode === 403);
});

test('rom: create with the remote master switch off -> REMOTE_MODE_DISABLED 403', async () => {
  const { controller: ctrl } = controller({ ...fakes({ remoteEnabled: false }) });
  await assert.rejects(() => ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER }),
    (err) => err.romError.code === 'REMOTE_MODE_DISABLED' && err.romError.statusCode === 403);
});

test('rom: create when the robot record is missing -> ROBOT_NOT_FOUND 404', async () => {
  const { controller: ctrl } = controller({ ...fakes({ robotPresent: false }) });
  await assert.rejects(() => ctrl.create({ friendlyId: FRIENDLY_ID, ownerId: OWNER }),
    (err) => err.romError.code === 'ROBOT_NOT_FOUND' && err.romError.statusCode === 404);
});

test('rom: setupServer without a robot identity -> ROBOT_MUST_CALL 403', async () => {
  const { controller: ctrl } = controller();
  await assert.rejects(() => ctrl.setupServer({ ipAddress: IP }),
    (err) => err.romError.code === 'ROBOT_MUST_CALL' && err.romError.statusCode === 403);
});

test('rom: setupServer / setupClient for an uncreated robot -> CERTIFICATE_NOT_FOUND 404', async () => {
  const { controller: ctrl } = controller();
  await assert.rejects(() => ctrl.setupServer({ friendlyId: FRIENDLY_ID, ipAddress: IP }),
    (err) => err.romError.code === 'CERTIFICATE_NOT_FOUND' && err.romError.statusCode === 404);
  await assert.rejects(() => ctrl.setupClient({ friendlyId: FRIENDLY_ID, ownerId: OWNER }),
    (err) => err.romError.code === 'CERTIFICATE_NOT_FOUND' && err.romError.statusCode === 404);
});

test('rom: the error catalog matches the archived errors/rom.ts', () => {
  assert.deepEqual(ROM_ERRORS.ROBOT_NOT_OWNED, { code: 'ROBOT_NOT_OWNED', message: 'You must own specified robot to create certificate', statusCode: 403 });
  assert.deepEqual(ROM_ERRORS.ROBOT_NOT_FOUND, { code: 'ROBOT_NOT_FOUND', message: 'Specified robot is not found', statusCode: 404 });
  assert.deepEqual(ROM_ERRORS.REMOTE_MODE_DISABLED, { code: 'REMOTE_MODE_DISABLED', message: 'Remote mode is disabled for specified robot', statusCode: 403 });
  assert.deepEqual(ROM_ERRORS.ROBOT_MUST_CALL, { code: 'ROBOT_MUST_CALL', message: 'Only robot is allowed to call this method', statusCode: 403 });
  assert.deepEqual(ROM_ERRORS.CERTIFICATE_NOT_FOUND, { code: 'CERTIFICATE_NOT_FOUND', message: 'Certificate not found', statusCode: 404 });
  assert.deepEqual(ROM_ERRORS.CERTIFICATE_NOT_DEPLOYED, { code: 'CERTIFICATE_NOT_DEPLOYED', message: 'Certificate not deployed', statusCode: 404 });
});

// ── real certificate material (not faked) ────────────────────────────────────

test('rom: generated material is a genuine matched self-signed pair', async () => {
  const { client, server } = await generateCertificatePair();

  const serverCert = forge.pki.certificateFromPem(server.cert);
  assert.equal(serverCert.subject.getField('CN').value, 'jibo.com');
  assert.equal(serverCert.issuer.getField('CN').value, 'jibo.com');
  const lifetime = (serverCert.validity.notAfter - serverCert.validity.notBefore) / 86_400_000;
  assert.ok(Math.abs(lifetime - CERTIFICATE_LIFETIME_DAYS) < 0.01, `server lifetime ~= 1 day, got ${lifetime}`);

  // The returned fingerprint is the SHA-1 of the server certificate DER.
  const serverFp = forge.md.sha1.create()
    .update(forge.asn1.toDer(forge.pki.certificateToAsn1(serverCert)).getBytes())
    .digest().toHex().match(/.{2}/g).join(':');
  assert.equal(server.fingerprint, serverFp);
  assert.match(server.fingerprint, /^([0-9a-f]{2}:){19}[0-9a-f]{2}$/, 'SHA-1 colon-hex (20 bytes)');

  const clientCert = forge.pki.certificateFromPem(client.cert);
  assert.equal(clientCert.issuer.getField('CN').value, 'jibo.com', 'client is issued by the server pair');
  const clientFp = forge.md.sha1.create()
    .update(forge.asn1.toDer(forge.pki.certificateToAsn1(clientCert)).getBytes())
    .digest().toHex().match(/.{2}/g).join(':');
  assert.equal(client.fingerprint, clientFp);
  assert.notEqual(client.fingerprint, server.fingerprint);

  // The client certificate really is signed by the server key.
  assert.doesNotThrow(() => serverCert.verify(clientCert), 'server key validates the client certificate');

  // The PKCS#12 blob decodes with the empty passphrase the controller used.
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(client.p12)), '');
  assert.ok(p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag].length >= 1);
});

// ── AWS-JSON serving over the real entrypoint ────────────────────────────────

let server; let port; let defaultServer; let defaultPort;
async function amz(target, body, credentials, atPort = port) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  if (credentials) headers['x-amz-credentials'] = JSON.stringify(credentials);
  const res = await fetch(`http://localhost:${atPort}/`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => {
  server = await createClassicEntrypoint({ rom: fakes() }).listen(0);
  port = server.address().port;
  // A second entrypoint with NO rom overrides: proves the wired default handler is served.
  defaultServer = await createClassicEntrypoint().listen(0);
  defaultPort = defaultServer.address().port;
});
after(() => { server.close(); defaultServer.close(); });

test('rom wire: create -> setupServer -> setupClient round trip serves the source shapes', async () => {
  const create = await amz('ROM_20171011.Create', { friendlyId: FRIENDLY_ID, aco: {} }, { id: OWNER });
  assert.equal(create.status, 200);
  assert.deepEqual(Object.keys(create.body), ['created'], 'CreateResponse requires only created');

  const setupServer = await amz('ROM_20171011.SetupServer',
    { ipAddress: IP, ipAddresses: [{ address: IP, netmask: NETMASK }] }, { friendlyId: FRIENDLY_ID });
  assert.equal(setupServer.status, 200);
  assert.deepEqual(Object.keys(setupServer.body).sort(), ['cert', 'created', 'fingerprint', 'private', 'public']);

  const setupClient = await amz('ROM_20171011.SetupClient', { friendlyId: FRIENDLY_ID }, { id: OWNER });
  assert.equal(setupClient.status, 200);
  assert.deepEqual(Object.keys(setupClient.body).sort(), ['cert', 'created', 'fingerprint', 'p12', 'payload', 'private', 'public']);
  assert.equal(setupClient.body.payload.ipAddress, IP);
  assert.equal(setupClient.body.payload.ipAddresses[0].netmask, NETMASK);
});

test('rom wire: error envelope carries __type + x-amzn-errortype and the source status', async () => {
  const r = await amz('ROM_20171011.SetupServer', { ipAddress: IP }); // no robot credentials
  assert.equal(r.status, 403);
  assert.equal(r.errType, 'ROBOT_MUST_CALL');
  assert.equal(r.body.__type, 'ROBOT_MUST_CALL');
  assert.equal(r.body.message, 'Only robot is allowed to call this method');
});

test('rom wire: missing required payload field -> ValidationException 400', async () => {
  const r = await amz('ROM_20171011.Create', {}, { id: OWNER });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('rom wire: unknown ROM operation -> ValidationException 400', async () => {
  const r = await amz('ROM_20171011.Frobnicate', {}, { id: OWNER });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('rom wire: the wired DEFAULT entrypoint serves ROM without injected clients', async () => {
  // ROBOT_MUST_CALL is decided from credentials alone, so this exercises the default
  // (no-override) handler rather than the test doubles above.
  const r = await amz('ROM_20171011.SetupServer', { ipAddress: IP }, undefined, defaultPort);
  assert.equal(r.status, 403);
  assert.equal(r.body.__type, 'ROBOT_MUST_CALL');
  const unknown = await amz('ROM_20171011.Nope', {}, undefined, defaultPort);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.errType, 'ValidationException');
});

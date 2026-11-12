// The catalog passes an official release signature through to robots unchanged, next to the
// version fields it signs, and refuses to serve a signature that cannot match the package.
// Keys are generated here and never written outside memory.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Catalog } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';
import { signRow, verifyRow } from '../src/releaseSignature.js';

const KEY_ID = 'phoenix-ota-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const digests = (buf) => ({
  length: buf.length,
  sha1: createHash('sha1').update(buf).digest('hex'),
  sha256: createHash('sha256').update(buf).digest('hex'),
});

const FILES = {
  'os-13.0.9.tar': Buffer.from('OS-13.0.9-'.repeat(400)),
  'be-13.9.1.tar': Buffer.from('BE-13.9.1-'.repeat(300)),
  'services-13.0.9.tar': Buffer.from('SERVICES-13.0.9-'.repeat(200)),
};
const OS_ROW = { id: 'os-13.0.9', subsystem: 'os', fromVersion: '*', toVersion: '13.0.9', filter: 'fcs', dependencies: {}, file: 'os-13.0.9.tar' };
const BE_ROW = { id: 'be-13.9.1', subsystem: 'be', fromVersion: '*', toVersion: '13.9.1', filter: 'fcs', dependencies: { os: '13.0.9' }, file: 'be-13.9.1.tar' };
const SVC_ROW = { id: 'services-13.0.9', subsystem: 'services', fromVersion: '*', toVersion: '13.0.9', filter: 'fcs', dependencies: { os: '13.0.9' }, file: 'services-13.0.9.tar' };

let dataDir;
let catalog;
let server;
let base;
const warnings = [];

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ota-sig-catalog-'));
  for (const [name, buf] of Object.entries(FILES)) await writeFile(path.join(dataDir, name), buf);
  const signedOs = { ...OS_ROW, phoenixSignature: signRow(OS_ROW, digests(FILES['os-13.0.9.tar']), { privateKey, keyId: KEY_ID }) };
  // Signed for different bytes: the package was rebuilt after signing.
  const staleBe = { ...BE_ROW, phoenixSignature: signRow(BE_ROW, digests(Buffer.from('older build')), { privateKey, keyId: KEY_ID }) };
  catalog = await Catalog.load({
    entries: [signedOs, staleBe, SVC_ROW],
    dataDir,
    log: { warn: (msg, meta) => warnings.push({ msg, meta }) },
  });
  server = await createOtaService({ catalog }).listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

const getUpdateFrom = (body) => fetch(`${base}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Update_20160301.GetUpdateFrom' },
  body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, body: await res.json() }));

test('(c) GetUpdateFrom serves the release signature with the version fields it signs', async () => {
  const { status, body } = await getUpdateFrom({ subsystem: 'os', fromVersion: '13.0.7', filter: 'fcs' });
  assert.equal(status, 200);
  assert.equal(body.toVersion, '13.0.9');
  assert.equal(body.fromVersion, '13.0.7'); // wire echo of the robot's version for a "*" row
  const sig = body.phoenixSignature;
  assert.ok(sig, 'signed row must carry phoenixSignature');
  assert.equal(sig.format, 'phoenix-ota-release/1');
  assert.equal(sig.alg, 'RSA-SHA256');
  assert.equal(sig.keyId, KEY_ID);
  const statement = JSON.parse(sig.payload);
  assert.equal(statement.toVersion, body.toVersion);
  assert.equal(statement.fromVersion, '*'); // the signed manifest value, not the wire echo
  assert.equal(statement.id, body._id);
  assert.equal(statement.sha1, body.shaHash);
  assert.equal(statement.length, body.length);

  // What a robot does: verify against its pinned key and the bytes it downloaded.
  const row = { id: body._id, subsystem: body.subsystem, fromVersion: statement.fromVersion, toVersion: body.toVersion,
    filter: body.filter, dependencies: body.dependencies };
  const ok = verifyRow(sig, row, digests(FILES['os-13.0.9.tar']), { [KEY_ID]: publicKey });
  assert.equal(ok.ok, true, ok.reason);
  const tampered = Buffer.from(FILES['os-13.0.9.tar']);
  tampered[0] ^= 1;
  assert.equal(verifyRow(sig, row, digests(tampered), { [KEY_ID]: publicKey }).reason, 'mismatch:sha256');
});

test('(c) the package download carries the same signature in x-phoenix-ota-signature', async () => {
  const { body } = await getUpdateFrom({ subsystem: 'os', fromVersion: '13.0.7', filter: 'fcs' });
  const res = await fetch(body.url);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  const header = JSON.parse(Buffer.from(res.headers.get('x-phoenix-ota-signature'), 'base64').toString('utf8'));
  assert.deepEqual(header, body.phoenixSignature);
  const statement = JSON.parse(header.payload);
  const row = { id: statement.id, subsystem: statement.subsystem, fromVersion: statement.fromVersion,
    toVersion: statement.toVersion, filter: statement.filter, dependencies: statement.dependencies };
  assert.equal(verifyRow(header, row, digests(bytes), { [KEY_ID]: publicKey }).ok, true);
});

test('(c) unsigned rows are served exactly as before, without the member or header', async () => {
  const { status, body } = await getUpdateFrom({ subsystem: 'services', fromVersion: '13.0.7', filter: 'fcs' });
  assert.equal(status, 200);
  assert.equal('phoenixSignature' in body, false);
  const res = await fetch(body.url);
  await res.arrayBuffer();
  assert.equal(res.headers.get('x-phoenix-ota-signature'), null);
});

test('a signature made for other bytes is not served, and the catalog says why', async () => {
  const { status, body } = await getUpdateFrom({ subsystem: 'be', fromVersion: '13.9.0', filter: 'fcs' });
  assert.equal(status, 200);
  assert.equal(body.toVersion, '13.9.1');
  assert.equal('phoenixSignature' in body, false);
  const w = warnings.find((x) => x.meta?.id === 'be-13.9.1');
  assert.ok(w, 'expected a warning for the stale signature');
  assert.match(w.msg, /release signature does not match/);
  assert.equal(w.meta.reason, 'mismatch:length');
});

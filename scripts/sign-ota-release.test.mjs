// Release signing, end to end through the publish-kit step: a throwaway key generated here
// signs official rows, the public half verifies them, and every way a server could change a
// release (other bytes, edited record, other key, no signature) fails verification. The be
// integrity gate cannot be skipped by the kit. No key ever leaves the temp directory.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGN = path.join(ROOT, 'scripts/sign-ota-release.mjs');
const KIT = path.join(ROOT, 'scripts/ota-release-kit.sh');
const KEY_ID = 'phoenix-ota-test';

let dir;
let dataDir;
let manifestFile;
let privFile;
let pubFile;
let otherPrivFile;
let smallPrivFile;
let signedFile;

const ROWS = [
  { id: 'os-13.0.9', subsystem: 'os', fromVersion: '*', toVersion: '13.0.9', filter: 'fcs', dependencies: {}, file: 'os-13.0.9.tar' },
  { id: 'services-13.0.9', subsystem: 'services', fromVersion: '*', toVersion: '13.0.9', filter: 'fcs', dependencies: { os: '13.0.9' }, file: 'services-13.0.9.tar' },
  { id: 'be-13.9.1', subsystem: 'be', fromVersion: '*', toVersion: '13.9.1', filter: 'fcs', dependencies: { services: '13.0.9', os: '13.0.9' }, file: 'be-13.9.1.tar' },
];

async function writeKey(name, bits) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const priv = path.join(dir, `${name}.pem`);
  const pub = path.join(dir, `${name}.pub.pem`);
  await writeFile(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv, pub };
}

async function node(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SIGN, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function kit(args) {
  try {
    const { stdout, stderr } = await run('bash', [KIT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const verifyArgs = (manifest, extra = []) => ['verify', '--manifest', manifest, '--data-dir', dataDir, '--pubkey', `${KEY_ID}=${pubFile}`, ...extra];

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ota-sign-test-'));
  dataDir = path.join(dir, 'data');
  await run('mkdir', ['-p', dataDir]);
  await writeFile(path.join(dataDir, 'os-13.0.9.tar'), Buffer.from('OS-13.0.9-'.repeat(500)));
  await writeFile(path.join(dataDir, 'services-13.0.9.tar'), Buffer.from('SERVICES-13.0.9-'.repeat(300)));
  await writeFile(path.join(dataDir, 'be-13.9.1.tar'), Buffer.from('BE-13.9.1-'.repeat(200)));
  manifestFile = path.join(dir, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify({ version: 1, updates: ROWS }, null, 2));
  ({ priv: privFile, pub: pubFile } = await writeKey('release', 3072));
  ({ priv: otherPrivFile } = await writeKey('attacker', 3072));
  ({ priv: smallPrivFile } = await writeKey('small', 2048));
  signedFile = path.join(dir, 'signed.json');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('(a) the kit signs official rows with the release key and they verify with the public key', async () => {
  const res = await kit(['--manifest', manifestFile, '--data-dir', dataDir, '--out', signedFile,
    '--key', privFile, '--key-id', KEY_ID, '--pubkey', pubFile, '--ids', 'os-13.0.9,services-13.0.9']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /signed and verified/);

  const signed = JSON.parse(await readFile(signedFile, 'utf8'));
  const sig = signed.updates.find((r) => r.id === 'services-13.0.9').phoenixSignature;
  assert.equal(sig.format, 'phoenix-ota-release/1');
  assert.equal(sig.alg, 'RSA-SHA256');
  assert.equal(sig.keyId, KEY_ID);
  const statement = JSON.parse(sig.payload);
  assert.deepEqual(Object.keys(statement), ['format', 'keyId', 'id', 'subsystem', 'fromVersion', 'toVersion',
    'filter', 'dependencies', 'length', 'sha256', 'sha1']);
  assert.equal(statement.toVersion, '13.0.9');
  assert.equal(statement.fromVersion, '*');
  assert.deepEqual(statement.dependencies, { os: '13.0.9' });
  assert.equal(statement.length, 'SERVICES-13.0.9-'.length * 300);
  // the unselected be row stays unsigned
  assert.equal(signed.updates.find((r) => r.id === 'be-13.9.1').phoenixSignature, undefined);

  const v = await node(verifyArgs(signedFile, ['--ids', 'os-13.0.9,services-13.0.9']));
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.equal(JSON.parse(v.stdout).verified, 2);
});

test('(b) an unsigned row fails verification', async () => {
  const v = await node(verifyArgs(signedFile, ['--ids', 'be-13.9.1']));
  assert.equal(v.code, 1);
  assert.equal(JSON.parse(v.stdout).results[0].reason, 'unsigned');
});

test('(b) a tampered package fails verification', async () => {
  const tamperedDir = path.join(dir, 'tampered');
  await run('cp', ['-r', dataDir, tamperedDir]);
  const pkg = path.join(tamperedDir, 'os-13.0.9.tar');
  const bytes = await readFile(pkg);
  bytes[17] ^= 0x01; // same length, one bit different
  await writeFile(pkg, bytes);
  const v = await node(['verify', '--manifest', signedFile, '--data-dir', tamperedDir, '--pubkey', `${KEY_ID}=${pubFile}`, '--ids', 'os-13.0.9']);
  assert.equal(v.code, 1);
  assert.equal(JSON.parse(v.stdout).results[0].reason, 'mismatch:sha256');
});

test('(b) a server cannot edit the record, re-sign with its own key, or swap in an older version', async () => {
  const signed = JSON.parse(await readFile(signedFile, 'utf8'));
  const cases = [];

  // Edited record (dependencies dropped) with the original signature.
  const edited = structuredClone(signed);
  edited.updates[1].dependencies = {};
  cases.push(['edited-deps', edited, 'services-13.0.9', 'mismatch:dependencies']);

  // Downgrade: the record and statement claim an older version; the signature no longer covers it.
  const downgraded = structuredClone(signed);
  const row = downgraded.updates[0];
  row.toVersion = '13.0.5';
  row.phoenixSignature.payload = row.phoenixSignature.payload.replace('"toVersion":"13.0.9"', '"toVersion":"13.0.5"');
  cases.push(['downgrade', downgraded, 'os-13.0.9', 'bad-signature']);

  // Same keyId, attacker key.
  const forged = path.join(dir, 'forged.json');
  const r = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', forged,
    '--key', otherPrivFile, '--key-id', KEY_ID, '--ids', 'os-13.0.9']);
  assert.equal(r.code, 0, r.stderr);
  cases.push(['attacker-key', JSON.parse(await readFile(forged, 'utf8')), 'os-13.0.9', 'bad-signature']);

  // A key id the robot does not pin, and a relabelled key id on an official signature.
  const other = path.join(dir, 'other-key.json');
  const o = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', other,
    '--key', otherPrivFile, '--key-id', 'someone-else', '--ids', 'os-13.0.9']);
  assert.equal(o.code, 0, o.stderr);
  cases.push(['untrusted-key', JSON.parse(await readFile(other, 'utf8')), 'os-13.0.9', 'untrusted-key:someone-else']);
  const relabelled = structuredClone(signed);
  relabelled.updates[0].phoenixSignature.keyId = 'someone-else';
  cases.push(['relabelled-key', relabelled, 'os-13.0.9', 'mismatch:keyId']);

  for (const [name, manifest, id, reason] of cases) {
    const file = path.join(dir, `case-${name}.json`);
    await writeFile(file, JSON.stringify(manifest));
    const v = await node(verifyArgs(file, ['--ids', id]));
    assert.equal(v.code, 1, `${name} must fail`);
    assert.equal(JSON.parse(v.stdout).results[0].reason, reason, name);
  }
});

test('the kit never signs a be package without a passing be_ota_integrity.py gate', async () => {
  const out = path.join(dir, 'be-signed.json');
  const noBase = await kit(['--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', privFile, '--key-id', KEY_ID, '--pubkey', pubFile, '--ids', 'be-13.9.1']);
  assert.notEqual(noBase.code, 0);
  assert.match(noBase.stderr, /--official-base .* is required/);

  const bogusBase = path.join(dir, 'not-official.tar.gz');
  await run('tar', ['-czf', bogusBase, '-C', dataDir, 'os-13.0.9.tar']);
  const gateFails = await kit(['--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', privFile, '--key-id', KEY_ID, '--pubkey', pubFile, '--ids', 'be-13.9.1', '--official-base', bogusBase]);
  assert.notEqual(gateFails.code, 0);
  assert.match(gateFails.stderr, /integrity gate failed for be-13.9.1; nothing was signed/);
  assert.equal(existsSync(out), false);

  // The sign script alone refuses too, and accepts only a passing receipt for these exact bytes.
  const direct = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', privFile, '--key-id', KEY_ID, '--ids', 'be-13.9.1']);
  assert.equal(direct.code, 1);
  assert.match(direct.stderr, /without a passing scripts\/be_ota_integrity.py receipt/);
  assert.equal(existsSync(out), false);

  const sha256 = (await run('sha256sum', [path.join(dataDir, 'be-13.9.1.tar')])).stdout.split(' ')[0];
  const failing = path.join(dir, 'gate-fail.json');
  await writeFile(failing, JSON.stringify({ officialFiles: 21590, candidateFiles: 21600, addedFiles: 10, unresolvedMains: 2, sha256 }));
  const bad = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', privFile, '--key-id', KEY_ID, '--ids', 'be-13.9.1', '--gate-receipt', failing]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /is not a pass/);

  const passing = path.join(dir, 'gate-pass.json');
  await writeFile(passing, JSON.stringify({ officialFiles: 21590, candidateFiles: 21604, addedFiles: 14, unresolvedMains: 0, sha256 }));
  const good = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', privFile, '--key-id', KEY_ID, '--ids', 'be-13.9.1', '--gate-receipt', passing]);
  assert.equal(good.code, 0, good.stderr);
  const v = await node(verifyArgs(out, ['--ids', 'be-13.9.1']));
  assert.equal(v.code, 0, v.stdout);
});

test('signing refuses weak keys, overwriting, and rows whose recorded digest is stale', async () => {
  const small = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', path.join(dir, 'x.json'),
    '--key', smallPrivFile, '--key-id', KEY_ID, '--ids', 'os-13.0.9']);
  assert.equal(small.code, 1);
  assert.match(small.stderr, /at least 3072 bits/);

  const overwrite = await node(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', signedFile,
    '--key', privFile, '--key-id', KEY_ID, '--ids', 'os-13.0.9']);
  assert.equal(overwrite.code, 1);
  assert.match(overwrite.stderr, /never overwrites/);

  const stale = path.join(dir, 'stale.json');
  await writeFile(stale, JSON.stringify({ updates: [{ ...ROWS[0], sha256: '0'.repeat(64) }] }));
  const r = await node(['sign', '--manifest', stale, '--data-dir', dataDir, '--out', path.join(dir, 'y.json'),
    '--key', privFile, '--key-id', KEY_ID]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /manifest sha256 .* differs from the package/);
});

// The robot verifies on Node 6.9.2. With PHOENIX_TEST_NODE6 pointing at that binary, prove its
// crypto accepts the served payload/signature and the SPKI public key as-is.
test('Node 6.9.2 verifies a release signature with createVerify (PHOENIX_TEST_NODE6)', { skip: !process.env.PHOENIX_TEST_NODE6 }, async () => {
  const signed = JSON.parse(await readFile(signedFile, 'utf8'));
  const sig = signed.updates[0].phoenixSignature;
  const script = path.join(dir, 'node6-verify.js');
  await writeFile(script, `
    var crypto = require('crypto'); var fs = require('fs');
    var sig = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    var pem = fs.readFileSync(process.argv[3], 'utf8');
    function check(payload) { return crypto.createVerify('RSA-SHA256').update(new Buffer(payload, 'utf8')).verify(pem, sig.signature, 'base64'); }
    var st = JSON.parse(sig.payload);
    console.log(JSON.stringify({ node: process.version, ok: check(sig.payload), tampered: check(sig.payload.replace('13.0.9', '13.0.8')), toVersion: st.toVersion }));
  `);
  const sigFile = path.join(dir, 'sig.json');
  await writeFile(sigFile, JSON.stringify(sig));
  await chmod(script, 0o644);
  const { stdout } = await run(process.env.PHOENIX_TEST_NODE6, [script, sigFile, pubFile]);
  const out = JSON.parse(stdout);
  assert.equal(out.node, 'v6.9.2');
  assert.equal(out.ok, true);
  assert.equal(out.tampered, false);
  assert.equal(out.toVersion, '13.0.9');
});

// The real Phoenix OTA release keys pinned in deploy/ota-release-keys: the public halves of the
// current and next release keys. The release tools default to them and refuse to sign under a
// pinned key id with any other private key; the image builder (deploy/robot-patches) pins the same
// pair. Only throwaway keys generated here are ever used to sign; no private key is read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIGN = path.join(ROOT, 'scripts/sign-ota-release.mjs');
const KIT = path.join(ROOT, 'scripts/ota-release-kit.sh');
const BAKER = path.join(ROOT, 'deploy/robot-patches/bake_jibo_io_native_image.py');
const PINNED_DIR = path.join(ROOT, 'deploy/ota-release-keys');
const CURRENT = 'phoenix-ota-20261112';
const NEXT = 'phoenix-ota-20261112b';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let dir;
let dataDir;
let manifestFile;
let throwaway;

async function exec(cmd, args, env = {}) {
  try {
    const { stdout, stderr } = await run(cmd, args, { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}
const sign = (args, env) => exec(process.execPath, [SIGN, ...args], env);

async function writeKey(name, bits = 3072) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const priv = path.join(dir, `${name}.pem`);
  const pub = path.join(dir, `${name}.pub.pem`);
  await writeFile(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  return { priv, pub };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ota-release-keys-test-'));
  dataDir = path.join(dir, 'data');
  await run('mkdir', ['-p', dataDir]);
  await writeFile(path.join(dataDir, 'os-13.0.9.tar'), Buffer.from('OS-13.0.9-'.repeat(500)));
  manifestFile = path.join(dir, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify({ version: 1, updates: [
    { id: 'os-13.0.9', subsystem: 'os', fromVersion: '*', toVersion: '13.0.9', filter: 'fcs', dependencies: {}, file: 'os-13.0.9.tar' },
  ] }, null, 2));
  throwaway = await writeKey('throwaway');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('the pinned set is the current and next release keys: RSA >= 3072 public halves, hash-pinned', () => {
  const doc = JSON.parse(readFileSync(path.join(PINNED_DIR, 'release-keys.json'), 'utf8'));
  assert.equal(doc.format, 'phoenix-ota-release/1');
  assert.deepEqual(doc.keys.map((k) => [k.keyId, k.role]), [[CURRENT, 'current'], [NEXT, 'next']]);
  for (const k of doc.keys) {
    const pem = readFileSync(path.join(PINNED_DIR, k.file));
    assert.equal(k.file, `${k.keyId}.pub.pem`);
    assert.equal(sha256(pem), k.pemSha256, `${k.file} matches its pinned hash`);
    assert.match(pem.toString('ascii'), /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
    const key = createPublicKey(pem);
    assert.equal(key.asymmetricKeyType, 'rsa');
    assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072);
    assert.equal(k.bits, key.asymmetricKeyDetails.modulusLength);
    assert.equal(sha256(key.export({ type: 'spki', format: 'der' })), k.spkiDerSha256);
  }
  assert.notEqual(doc.keys[0].spkiDerSha256, doc.keys[1].spkiDerSha256, 'current and next are different keys');
  assert.deepEqual(readdirSync(PINNED_DIR).sort(),
    ['README.md', `${CURRENT}.pub.pem`, `${NEXT}.pub.pem`, 'release-keys.json'].sort());
  for (const name of readdirSync(PINNED_DIR)) {
    assert.doesNotMatch(readFileSync(path.join(PINNED_DIR, name), 'utf8'), /PRIVATE KEY/, `${name} holds no private key`);
  }
});

test('sign-ota-release.mjs pinned lists the pinned keys, and the image builder pins the same pair', async () => {
  const r = await sign(['pinned']);
  assert.equal(r.code, 0, r.stderr);
  const listed = JSON.parse(r.stdout);
  assert.equal(listed.current, CURRENT);
  assert.equal(listed.next, NEXT);
  assert.deepEqual(listed.keys.map((k) => [k.keyId, k.role, k.path]),
    [[CURRENT, 'current', path.join(PINNED_DIR, `${CURRENT}.pub.pem`)], [NEXT, 'next', path.join(PINNED_DIR, `${NEXT}.pub.pem`)]]);

  const py = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("baker", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
keys = b.load_pinned_ota_release_keys()
print(json.dumps({"keys": keys, "config": b.ota_gate_config(keys)["keys"]}))
`, BAKER], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const baked = JSON.parse(py.stdout);
  assert.deepEqual(Object.keys(baked.keys).sort(), [CURRENT, NEXT]);
  for (const id of [CURRENT, NEXT]) {
    assert.equal(baked.keys[id], readFileSync(path.join(PINNED_DIR, `${id}.pub.pem`), 'utf8'), `builder pins ${id} verbatim`);
    assert.equal(baked.config[id], baked.keys[id]);
  }
});

test('sign refuses a pinned key id with any other private key, and writes nothing', async () => {
  const out = path.join(dir, 'forged.json');
  const r = await sign(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', throwaway.priv, '--key-id', CURRENT]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /does not match the pinned public key for phoenix-ota-20261112/);
  assert.equal(existsSync(out), false);
});

test('verify without --pubkey checks rows against the pinned keys', async () => {
  const out = path.join(dir, 'test-signed.json');
  const s = await sign(['sign', '--manifest', manifestFile, '--data-dir', dataDir, '--out', out,
    '--key', throwaway.priv, '--key-id', 'phoenix-ota-test']);
  assert.equal(s.code, 0, s.stderr);
  const v = await sign(['verify', '--manifest', out, '--data-dir', dataDir]);
  assert.equal(v.code, 1, v.stdout + v.stderr);
  assert.deepEqual(JSON.parse(v.stdout).results.map((x) => x.reason), ['untrusted-key:phoenix-ota-test']);

  // A signature by another key relabelled as the pinned current key fails the real public key.
  const forged = JSON.parse(await readFile(out, 'utf8'));
  const sig = forged.updates[0].phoenixSignature;
  sig.keyId = CURRENT;
  sig.payload = sig.payload.replace('"keyId":"phoenix-ota-test"', `"keyId":"${CURRENT}"`);
  const forgedFile = path.join(dir, 'relabelled.json');
  await writeFile(forgedFile, JSON.stringify(forged));
  const f = await sign(['verify', '--manifest', forgedFile, '--data-dir', dataDir]);
  assert.equal(f.code, 1);
  assert.deepEqual(JSON.parse(f.stdout).results.map((x) => x.reason), ['bad-signature']);
});

test('the kit defaults to the pinned current key and refuses a different private key', async () => {
  const out = path.join(dir, 'kit-out.json');
  const r = await exec('bash', [KIT, '--manifest', manifestFile, '--data-dir', dataDir, '--out', out, '--key', throwaway.priv]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /pinned current key phoenix-ota-20261112/);
  assert.match(r.stderr, /does not match the pinned public key for phoenix-ota-20261112/);
  assert.equal(existsSync(out), false);
});

test('the kit and default verifier accept both pinned fixture slots without the real private keys', async () => {
  const pinnedDir = await mkdtemp(path.join(dir, 'fixture-keys-'));
  const next = await writeKey('fixture-next');
  const fixtureKeys = [['fixture-current', 'current', throwaway], ['fixture-next', 'next', next]];
  const entries = [];
  for (const [keyId, role, key] of fixtureKeys) {
    const pem = await readFile(key.pub);
    const publicKey = createPublicKey(pem);
    const file = `${keyId}.pub.pem`;
    await writeFile(path.join(pinnedDir, file), pem);
    entries.push({ keyId, role, file, alg: 'RSA-SHA256', bits: 3072,
      pemSha256: sha256(pem), spkiDerSha256: sha256(publicKey.export({ type: 'spki', format: 'der' })) });
  }
  await writeFile(path.join(pinnedDir, 'release-keys.json'), JSON.stringify({ format: 'phoenix-ota-release/1', keys: entries }));
  const env = { PHOENIX_OTA_RELEASE_KEYS_DIR: pinnedDir };
  for (const [keyId, role, key] of fixtureKeys) {
    const out = path.join(dir, `${keyId}.signed.json`);
    const args = [KIT, '--manifest', manifestFile, '--data-dir', dataDir, '--out', out, '--key', key.priv];
    if (role === 'next') args.push('--key-id', keyId);
    const signed = await exec('bash', args, env);
    assert.equal(signed.code, 0, signed.stderr);
    const verified = await sign(['verify', '--manifest', out, '--data-dir', dataDir], env);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    const result = JSON.parse(verified.stdout);
    assert.equal(result.verified, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.results[0].keyId, keyId);
  }
});

test('a pinned set that is altered, too large or holds a private key is refused by both loaders', async () => {
  const variants = {
    'swapped key file': async (d) => { await cp(throwaway.pub, path.join(d, `${CURRENT}.pub.pem`)); },
    'three keys': async (d) => {
      const doc = JSON.parse(await readFile(path.join(d, 'release-keys.json'), 'utf8'));
      doc.keys.push({ ...doc.keys[1], keyId: 'phoenix-ota-20261112c', file: `${NEXT}.pub.pem` });
      await writeFile(path.join(d, 'release-keys.json'), JSON.stringify(doc));
    },
    'two current keys': async (d) => {
      const doc = JSON.parse(await readFile(path.join(d, 'release-keys.json'), 'utf8'));
      doc.keys[1].role = 'current';
      await writeFile(path.join(d, 'release-keys.json'), JSON.stringify(doc));
    },
    'a private key in place of a public one': async (d) => {
      const priv = await readFile(throwaway.priv);
      await writeFile(path.join(d, `${CURRENT}.pub.pem`), priv);
      const doc = JSON.parse(await readFile(path.join(d, 'release-keys.json'), 'utf8'));
      doc.keys[0].pemSha256 = sha256(priv);
      await writeFile(path.join(d, 'release-keys.json'), JSON.stringify(doc));
    },
    'a 2048-bit key': async (d) => {
      const small = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
      const pem = small.export({ type: 'spki', format: 'pem' });
      await writeFile(path.join(d, `${CURRENT}.pub.pem`), pem);
      const doc = JSON.parse(await readFile(path.join(d, 'release-keys.json'), 'utf8'));
      doc.keys[0].pemSha256 = sha256(Buffer.from(pem));
      doc.keys[0].spkiDerSha256 = sha256(small.export({ type: 'spki', format: 'der' }));
      await writeFile(path.join(d, 'release-keys.json'), JSON.stringify(doc));
    },
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const d = await mkdtemp(path.join(dir, 'pinned-'));
    await cp(PINNED_DIR, d, { recursive: true });
    const env = { PHOENIX_OTA_RELEASE_KEYS_DIR: d };
    const control = await sign(['pinned'], env);
    assert.equal(control.code, 0, `${label}: an unaltered copy loads (${control.stderr})`);
    await mutate(d);
    const node = await sign(['pinned'], env);
    assert.notEqual(node.code, 0, `${label}: sign-ota-release.mjs refuses`);
    assert.match(node.stderr, /pinned OTA release keys/, label);
    const py = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("baker", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
try:
    b.load_pinned_ota_release_keys()
except RuntimeError as exc:
    sys.stderr.write(str(exc) + "\\n"); sys.exit(2)
`, BAKER], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(py.status, 2, `${label}: the image builder refuses (${py.stderr})`);
    assert.match(py.stderr, /pinned OTA release keys/, label);
  }
});

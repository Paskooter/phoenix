import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('./robot-ota-repoint.sh', import.meta.url), 'utf8');
const step = source.split('# 7c. Trust root.')[1].split('# 7c-bis.')[0];
const publicRoot = new URL('./robot-client/isrg-root-x1.pem', import.meta.url).pathname;
const openssl = (...args) => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(run, root = publicRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-capath-'));
  const trust = join(dir, 'certs');
  mkdirSync(trust);
  const bundle = join(trust, 'ca-certificates.crt');
  writeFileSync(bundle, readFileSync(root));
  const hash = openssl('x509', '-in', root, '-noout', '-subject_hash');
  const oldHash = openssl('x509', '-in', root, '-noout', '-subject_hash_old');
  const apply = (haveRoot = 1) => spawnSync('bash', ['-c', `set -uo pipefail
TRUST_DIR=${quote(trust)}; TRUST_BUNDLE=${quote(bundle)}; ROOT_PEM_SRC=${quote(root)}
HAVE_ROOT=${haveRoot}; STAMP=test; APPLIED=()
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
rsh() { sh -c "$1"; }
rput() { cp "$1" "$2"; }
${step.replaceAll('/tmp/.phoenix-isrg-root-', dir + '/.phoenix-isrg-root-')}
printf 'RECEIPT=%s\\n' "\${APPLIED[@]}"
`], { encoding: 'utf8', timeout: 10000 });
  try { run({ dir, trust, bundle, hash, oldHash, apply }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('trust repair adds the OpenSSL 1.0.2 ISRG hash even when the bundle already has the root', () => fixture(f => {
  assert.equal(f.hash, '4042bcee');
  assert.equal(f.oldHash, '6187b673');
  writeFileSync(join(f.trust, 'isrg-root-x1.pem'), readFileSync(publicRoot));
  symlinkSync('isrg-root-x1.pem', join(f.trust, f.oldHash + '.0'));
  const before = readFileSync(f.bundle);
  const first = f.apply();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readlinkSync(join(f.trust, f.hash + '.0')), 'isrg-root-x1.pem');
  assert.equal(readlinkSync(join(f.trust, f.oldHash + '.0')), 'isrg-root-x1.pem');
  assert.deepEqual(readFileSync(f.bundle), before, 'bundle is not duplicated');
  assert.match(first.stdout, /RECEIPT=.*4042bcee/);
  const files = readdirSync(f.trust);
  assert.equal(f.apply().status, 0);
  assert.deepEqual(readdirSync(f.trust), files);
}));

test('trust repair appends a missing root once and preserves the prior bundle for rollback', () => fixture(f => {
  writeFileSync(f.bundle, 'existing bundle\n');
  const result = f.apply(0);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.bundle + '.prerepoint-test.bak', 'utf8'), 'existing bundle\n');
  assert.equal(readFileSync(f.bundle, 'utf8'), 'existing bundle\n' + readFileSync(publicRoot, 'utf8'));
  assert.equal(statSync(join(f.trust, 'isrg-root-x1.pem')).mode & 0o777, 0o644);
  assert.equal(f.apply(1).status, 0);
  assert.equal(readFileSync(f.bundle + '.prerepoint-test.bak', 'utf8'), 'existing bundle\n');
}));

for (const collision of ['file', 'dangling symlink', 'directory']) {
  test(`trust repair preserves a different hash.0 ${collision} and uses the next free suffix`, () => fixture(f => {
    const occupied = join(f.trust, f.hash + '.0');
    if (collision === 'file') writeFileSync(occupied, 'another certificate');
    else if (collision === 'directory') mkdirSync(occupied);
    else symlinkSync('missing.pem', occupied);
    const result = f.apply();
    assert.equal(result.status, 0, result.stderr);
    if (collision === 'file') assert.equal(readFileSync(occupied, 'utf8'), 'another certificate');
    else if (collision === 'directory') assert.ok(statSync(occupied).isDirectory());
    else assert.equal(readlinkSync(occupied), 'missing.pem');
    assert.equal(readlinkSync(join(f.trust, f.hash + '.1')), 'isrg-root-x1.pem');
    assert.equal(f.apply().status, 0);
    assert.equal(readdirSync(f.trust).filter(name => name.startsWith(f.hash)).length, 2);
  }));
}

test('trust repair refuses a different named PEM instead of replacing its bytes', () => fixture(f => {
  writeFileSync(join(f.trust, 'isrg-root-x1.pem'), 'different root');
  const result = f.apply();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(f.trust, 'isrg-root-x1.pem'), 'utf8'), 'different root');
}));

test('CApath-only verification fails with the old hash and succeeds after the actual trust step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-chain-'));
  try {
    const root = join(dir, 'root.pem');
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'root.key'), '-out', root,
      '-days', '2', '-subj', '/CN=Phoenix synthetic CApath root', '-addext', 'basicConstraints=critical,CA:TRUE');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'leaf.key'), '-out', join(dir, 'leaf.csr'),
      '-subj', '/CN=synthetic.jibo.invalid');
    openssl('x509', '-req', '-in', join(dir, 'leaf.csr'), '-CA', root, '-CAkey', join(dir, 'root.key'),
      '-set_serial', '2', '-days', '2', '-out', join(dir, 'leaf.pem'));
    fixture(f => {
      assert.notEqual(f.hash, f.oldHash);
      writeFileSync(join(f.trust, 'isrg-root-x1.pem'), readFileSync(root));
      symlinkSync('isrg-root-x1.pem', join(f.trust, f.oldHash + '.0'));
      const verify = () => spawnSync('openssl', ['verify', '-no-CAfile', '-no-CAstore', '-CApath', f.trust, join(dir, 'leaf.pem')],
        { encoding: 'utf8' });
      const before = verify();
      assert.notEqual(before.status, 0, 'old hash alone must fail');
      assert.match(before.stderr, /unable to get local issuer certificate/);
      const applied = f.apply();
      assert.equal(applied.status, 0, applied.stderr);
      const after = verify();
      assert.equal(after.status, 0, after.stderr);
      assert.match(after.stdout, /: OK/);
    }, root);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

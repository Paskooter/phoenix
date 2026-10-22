import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, symlinkSync, rmSync, statSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(new URL('./robot-ota-repoint.sh', import.meta.url), 'utf8');
const step = source.split('# 7c. Trust root.')[1].split('# 7c-bis.')[0];
const preflight = source.split('# Trust preflight.')[1]?.split('# End trust preflight.')[0] || '';
const snapshot = dir => readdirSync(dir).sort().map(name => {
  const path = join(dir, name);
  const stat = lstatSync(path);
  return [name, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) :
    stat.isDirectory() ? snapshot(path) : readFileSync(path, 'hex')];
});
const publicRoot = new URL('./robot-client/isrg-root-x1.pem', import.meta.url).pathname;
const openssl = (...args) => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(run, root = publicRoot) {
  const originalRoot = readFileSync(root);
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-capath-'));
  const trust = join(dir, 'certs');
  mkdirSync(trust);
  const bundle = join(trust, 'ca-certificates.crt');
  writeFileSync(bundle, readFileSync(root));
  const hash = openssl('x509', '-in', root, '-noout', '-subject_hash');
  const oldHash = openssl('x509', '-in', root, '-noout', '-subject_hash_old');
  const apply = (haveRoot = 1, dry = false, { remotePath = process.env.PATH, between = '', rootSource = root } = {}) => spawnSync('bash', ['-c', `set -uo pipefail
TRUST_DIR=${quote(trust)}; TRUST_BUNDLE=${quote(bundle)}; ROOT_PEM_SRC=${quote(rootSource)}
HAVE_ROOT=${haveRoot}; STAMP=test; APPLIED=()
say() { printf '%s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
rsh() { PATH=${quote(remotePath)} /bin/sh -c "$1"; }
rput() { cp "$1" "$2"; }
${preflight}
${between}
${dry ? '' : `printf started > ${quote(join(dir, 'apply-started'))}\n${step.replaceAll('/tmp/.phoenix-isrg-root-', dir + '/.phoenix-isrg-root-')}`}
printf 'RECEIPT=%s\\n' "\${APPLIED[@]}"
`], { encoding: 'utf8', timeout: 10000 });
  try { run({ dir, trust, bundle, hash, oldHash, apply, preview: (haveRoot = 1) => apply(haveRoot, true) }); }
  finally {
    const after = readFileSync(root);
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(after, originalRoot, 'the trust fixture must never modify source PEM bytes');
  }
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

test('trust repair preserves a foreign PEM and installs a Phoenix-named root and modern hash link', () => fixture(f => {
  writeFileSync(join(f.trust, 'isrg-root-x1.pem'), 'different root');
  const result = f.apply();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.trust, 'isrg-root-x1.pem'), 'utf8'), 'different root');
  assert.deepEqual(readFileSync(join(f.trust, 'phoenix-isrg-root-x1.pem')), readFileSync(publicRoot));
  assert.equal(readlinkSync(join(f.trust, f.hash + '.0')), 'phoenix-isrg-root-x1.pem');
}));

test('unsafe Phoenix-named PEM refuses in read-only preflight before any apply writes', () => fixture(f => {
  writeFileSync(join(f.trust, 'isrg-root-x1.pem'), 'foreign root');
  writeFileSync(join(f.trust, 'phoenix-isrg-root-x1.pem'), 'different Phoenix root');
  const before = snapshot(f.dir);
  const result = f.apply();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing was changed.*unsafe Phoenix root PEM/);
  assert.deepEqual(snapshot(f.dir), before);
}));

for (const foreign of ['symlink', 'dangling symlink', 'directory']) {
  test(`trust repair leaves a foreign ${foreign} untouched and uses its Phoenix-named root`, () => fixture(f => {
    const path = join(f.trust, 'isrg-root-x1.pem');
    if (foreign === 'directory') mkdirSync(path);
    else {
      if (foreign === 'symlink') writeFileSync(join(f.trust, 'foreign.pem'), readFileSync(publicRoot), { mode: 0o600 });
      symlinkSync('foreign.pem', path);
    }
    const before = snapshot(f.trust).filter(([name]) => ['isrg-root-x1.pem', 'foreign.pem'].includes(name));
    const result = f.apply();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(f.trust).filter(([name]) => ['isrg-root-x1.pem', 'foreign.pem'].includes(name)), before);
    assert.deepEqual(readFileSync(join(f.trust, 'phoenix-isrg-root-x1.pem')), readFileSync(publicRoot));
    assert.equal(readlinkSync(join(f.trust, f.hash + '.0')), 'phoenix-isrg-root-x1.pem');
    assert.match(result.stdout, /RECEIPT=.*phoenix-isrg-root-x1.pem/);
    const applied = snapshot(f.trust);
    assert.equal(f.apply().status, 0);
    assert.deepEqual(snapshot(f.trust), applied);
  }));
}

for (const unsafe of ['symlink', 'dangling symlink', 'directory']) {
  test(`Phoenix-named ${unsafe} refuses before apply even if its target is the pinned root`, () => fixture(f => {
    writeFileSync(join(f.trust, 'isrg-root-x1.pem'), 'foreign root');
    const path = join(f.trust, 'phoenix-isrg-root-x1.pem');
    if (unsafe === 'directory') mkdirSync(path);
    else {
      const target = join(f.dir, 'root-target.pem');
      if (unsafe === 'symlink') writeFileSync(target, readFileSync(publicRoot));
      symlinkSync(unsafe === 'symlink' ? target : 'missing.pem', path);
    }
    const before = snapshot(f.dir);
    const result = f.apply();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nothing was changed.*unsafe Phoenix root PEM/);
    assert.deepEqual(snapshot(f.dir), before);
  }));
}

test('exhausted hash slots refuse in preflight without installing any PEM', () => fixture(f => {
  for (let n = 0; n < 100; n++) symlinkSync('missing.pem', join(f.trust, f.hash + '.' + n));
  const before = snapshot(f.dir);
  const result = f.apply();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing was changed.*too many occupied public root hash entries/);
  assert.deepEqual(snapshot(f.dir), before);
}));

for (const occupied of ['file', 'dangling symlink', 'directory']) {
  test(`existing bundle backup ${occupied} refuses before any apply writes`, () => fixture(f => {
    const path = f.bundle + '.prerepoint-test.bak';
    if (occupied === 'file') writeFileSync(path, 'prior backup');
    else if (occupied === 'directory') mkdirSync(path);
    else symlinkSync('missing.pem', path);
    const before = snapshot(f.dir);
    const result = f.apply(0);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nothing was changed.*existing trust bundle backup/);
    assert.deepEqual(snapshot(f.dir), before);
  }));
}

test('missing remote cmp refuses in preflight without writes', () => fixture(f => {
  const bin = join(f.dir, 'empty-bin');
  mkdirSync(bin);
  const before = snapshot(f.dir);
  const result = f.apply(1, false, { remotePath: bin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nothing was changed.*cmp is required/);
  assert.deepEqual(snapshot(f.dir), before);
}));

for (const local of ['missing', 'invalid']) {
  test(`${local} local public root refuses before apply`, () => fixture(f => {
    const path = join(f.dir, 'local-root.pem');
    if (local === 'invalid') writeFileSync(path, 'not a certificate');
    const before = snapshot(f.dir);
    const result = f.apply(1, false, { rootSource: path });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nothing was changed:.*(?:no public root|could not compute)/);
    assert.deepEqual(snapshot(f.dir), before);
  }));
}

for (const unsafe of ['directory', 'symlink']) {
  test(`unsafe trust bundle ${unsafe} refuses in read-only preflight`, () => fixture(f => {
    rmSync(f.bundle);
    if (unsafe === 'directory') mkdirSync(f.bundle);
    else {
      const target = join(f.dir, 'bundle-target.pem');
      writeFileSync(target, readFileSync(publicRoot));
      symlinkSync(target, f.bundle);
    }
    const before = snapshot(f.dir);
    const result = f.apply(0);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nothing was changed.*unsafe trust bundle/);
    assert.deepEqual(snapshot(f.dir), before);
  }));
}

test('quoted custom PEM bytes and trailing newlines survive the read-only comparison and install', () => fixture(f => {
  const path = join(f.dir, 'custom.pem');
  const pem = readFileSync(publicRoot, 'utf8') + "# user's public root\n\n";
  writeFileSync(path, pem);
  const result = f.apply(1, false, { rootSource: path });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.trust, 'isrg-root-x1.pem'), 'utf8'), pem);
  assert.equal(f.apply(1, false, { rootSource: path }).status, 0);
}));

test('trust preflight supports the BusyBox cmp applet when standalone cmp is absent from PATH', () => fixture(f => {
  const bin = join(f.dir, 'busybox-bin');
  mkdirSync(bin);
  const cmp = execFileSync('sh', ['-c', 'command -v cmp'], { encoding: 'utf8' }).trim();
  // Model BusyBox's applet dispatch while still comparing bytes with real cmp.
  writeFileSync(join(bin, 'busybox'), `#!/bin/sh
if [ "$1" = --list ]; then printf 'cmp\\n'; else shift; exec ${quote(cmp)} "$@"; fi
`, { mode: 0o755 });
  for (const tool of ['grep', 'chmod', 'ln']) {
    const path = execFileSync('sh', ['-c', 'command -v ' + tool], { encoding: 'utf8' }).trim();
    symlinkSync(path, join(bin, tool));
  }
  const result = f.apply(1, false, { remotePath: bin });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(f.trust, 'isrg-root-x1.pem')), readFileSync(publicRoot));
}));

for (const state of ['absent', 'identical', 'foreign', 'Phoenix identical', 'collision', 'hash identical']) {
  test(`dry-run trust plan for ${state} is read-only`, () => fixture(f => {
    if (state === 'identical') writeFileSync(join(f.trust, 'isrg-root-x1.pem'), readFileSync(publicRoot));
    if (state === 'foreign' || state === 'Phoenix identical') writeFileSync(join(f.trust, 'isrg-root-x1.pem'), 'foreign root');
    if (state === 'Phoenix identical') writeFileSync(join(f.trust, 'phoenix-isrg-root-x1.pem'), readFileSync(publicRoot));
    if (state === 'collision') symlinkSync('missing.pem', join(f.trust, f.hash + '.0'));
    if (state === 'hash identical') symlinkSync('ca-certificates.crt', join(f.trust, f.hash + '.0'));
    const before = snapshot(f.dir);
    const result = f.preview();
    assert.equal(result.status, 0, result.stderr);
    const name = ['foreign', 'Phoenix identical'].includes(state) ? 'phoenix-isrg-root-x1.pem' : 'isrg-root-x1.pem';
    const rootAction = ['identical', 'Phoenix identical'].includes(state) ? 'reuse' : 'install';
    const linkAction = state === 'hash identical' ? 'reuse' : 'add';
    const suffix = state === 'collision' ? 1 : 0;
    const foreign = ['foreign', 'Phoenix identical'].includes(state) ? '; leave foreign isrg-root-x1.pem untouched' : '';
    assert.ok(result.stdout.includes(`  public root trust: ${rootAction} ${name}; ${linkAction} 4042bcee.${suffix}; preserve existing hash entries${foreign}\n`), result.stdout);
    assert.deepEqual(snapshot(f.dir), before);
  }));
}

test('apply rechecks unsafe Phoenix roots before its own first write', () => fixture(f => {
  writeFileSync(join(f.trust, 'isrg-root-x1.pem'), 'foreign root');
  const result = f.apply(1, false, { between: `printf changed > ${quote(join(f.trust, 'phoenix-isrg-root-x1.pem'))}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to install the public root:.*unsafe Phoenix root PEM/);
  assert.equal(readFileSync(join(f.trust, 'phoenix-isrg-root-x1.pem'), 'utf8'), 'changed');
  assert.deepEqual(readdirSync(f.trust).sort(), ['ca-certificates.crt', 'isrg-root-x1.pem', 'phoenix-isrg-root-x1.pem']);
}));

for (const foreign of [false, true]) {
  test(`CApath-only verification fails with the old hash and succeeds after the actual trust step${foreign ? ' with a foreign PEM' : ''}`, () => {
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
        writeFileSync(join(f.trust, 'isrg-root-x1.pem'), foreign ? 'foreign root' : readFileSync(root));
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
        if (foreign) {
          assert.equal(readFileSync(join(f.trust, 'isrg-root-x1.pem'), 'utf8'), 'foreign root');
          assert.equal(readlinkSync(join(f.trust, f.hash + '.0')), 'phoenix-isrg-root-x1.pem');
        }
      }, root);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const configHelper = join(here, 'repoint-cloud-config.cjs');

test('Node 4 API emulation applies all JSON kinds with short descriptor writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-config-node4-api-'));
  const module = { exports: {} };
  // In Node 4 Buffer.from is inherited TypedArray.from, not the modern API.
  function OldBuffer(value, encoding) { return Buffer.from(value, encoding); }
  OldBuffer.from = () => { throw new TypeError('utf8 is not a function'); };
  const oldFs = { ...fs,
    writeFileSync(file, ...args) {
      assert.equal(typeof file, 'string', 'Node 4 writeFileSync requires a path');
      return fs.writeFileSync(file, ...args);
    },
    writeSync(fd, bytes, offset, length, position) {
      return fs.writeSync(fd, bytes, offset, Math.min(length, 7), position);
    },
  };
  vm.runInNewContext(readFileSync(configHelper, 'utf8'), {
    require: (name) => name === 'fs' ? oldFs : require(name), module, Buffer: OldBuffer,
    process: { pid: process.pid },
  });
  try {
    const kinds = {
      'region-config': { rules: { '*/*': 'globalSSL' }, patterns: { globalSSL: { endpoint: 'http://old.example' } } },
      credentials: { accessKeyId: 'local-test-only', secretAccessKey: 'local-test-only', region: 'open-jibo', endpoint: 'http://old.example' },
      notification: { NotificationSubsystem: { serverURLSuffix: '-socket.jibo.com' } },
      setup: { serverRegion: 'dev1-entrypoint' },
    };
    for (const [kind, value] of Object.entries(kinds)) {
      const file = join(dir, kind + '.json');
      writeFileSync(file, JSON.stringify(value), { mode: 0o644 });
      const options = { kind, file, region: 'api', suffix: 'jibo.io', stamp: '20261002-120000' };
      assert.equal(module.exports.apply({ ...options, dryRun: true }), 'patched');
      assert.deepEqual(JSON.parse(readFileSync(file)), value);
      assert.equal(module.exports.apply(options), 'patched');
      assert.equal(module.exports.apply(options), 'already-patched');
      assert.deepEqual(JSON.parse(readFileSync(file + '.prerepoint-20261002-120000.bak')), value);
      const output = JSON.parse(readFileSync(file));
      if (kind === 'credentials') {
        assert.equal(output.secretAccessKey, value.secretAccessKey);
        assert.equal(fs.statSync(file + '.prerepoint-20261002-120000.bak').mode & 0o777, 0o600);
      }
    }
    assert.equal(readdirSync(dir).length, 8, 'no staged files are left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zero-byte writes fail without replacing the original config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-config-zero-write-'));
  const file = join(dir, 'setup.json');
  const original = '{"serverRegion":"open-jibo"}';
  writeFileSync(file, original);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(configHelper, 'utf8'), {
    require: (name) => name === 'fs' ? { ...fs, writeSync: () => 0 } : require(name),
    module, Buffer, process: { pid: process.pid },
  });
  try {
    assert.throws(() => module.exports.apply({ kind: 'setup', file, region: 'api', suffix: 'jibo.io', stamp: '20261002-120000' }), /complete file write/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// CI can supply pinned x64 runtimes; ARM hardware is not needed to test Node's
// filesystem/Buffer APIs. These checks never contact or modify a real robot.
for (const [version, variable] of [['v4.1.2', 'PHOENIX_TEST_NODE4'], ['v6.9.2', 'PHOENIX_TEST_NODE6']]) {
  const binary = process.env[variable];
  test(`real ${version}: all robot helpers load and config apply writes successfully`, { skip: binary ? false : `set ${variable} to the archived runtime` }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'phx-real-legacy-node-'));
    try {
      assert.equal(spawnSync(binary, ['-v'], { encoding: 'utf8' }).stdout.trim(), version);
      const file = join(dir, 'credentials.json');
      const identity = { accessKeyId: 'local-test-only', secretAccessKey: 'local-test-only', region: 'open-jibo', endpoint: 'http://old.example' };
      writeFileSync(file, JSON.stringify(identity));
      const code = `var h=require(${JSON.stringify(configHelper)}); var o={kind:'credentials',file:process.argv[1],region:'api',suffix:'jibo.io',stamp:'20261002-120000'};
        console.log(h.apply(o)); console.log(h.apply(o));`;
      const result = spawnSync(binary, ['-e', code, file], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'patched\nalready-patched\n');
      const updated = JSON.parse(readFileSync(file));
      assert.equal(updated.endpoint, 'https://api.jibo.io');
      assert.equal(updated.secretAccessKey, identity.secretAccessKey);
      for (const helper of ['patch-ssm-wifi-check', 'patch-ota-downloader-tls', 'patch-system-backup-tls', 'patch-oobe-setup-text', 'trigger-ota']) {
        const loaded = spawnSync(binary, ['-e', `require(${JSON.stringify(join(here, helper + '.cjs'))});`], { encoding: 'utf8' });
        assert.equal(loaded.status, 0, helper + ': ' + loaded.stderr);
      }
      for (const check of ['test-patch-ssm-wifi-check', 'test-patch-ota-downloader-tls', 'test-patch-system-backup-tls', 'test-patch-oobe-setup-text']) {
        const oobeRoot = join(dir, 'oobe-test');
        if (!fs.existsSync(oobeRoot)) fs.mkdirSync(oobeRoot);
        const checked = spawnSync(binary, [join(here, check + '.cjs')], { encoding: 'utf8',
          env: { ...process.env, PHOENIX_TEST_OOBE_ROOT: oobeRoot } });
        assert.equal(checked.status, 0, check + ': ' + checked.stderr);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

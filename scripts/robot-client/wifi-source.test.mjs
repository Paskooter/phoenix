import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const patcher = require('./patch-ssm-wifi-check.cjs');
const stock = `class Wifi {
  constructor() { this._jiboServerUrl = null; }
  init(data) {
    this._jiboServerUrl = data.region + '.jibo.com';
    this._jiboServerUrl = this._wifiService.options.region + '.openjibo.com';
  }
  _checkJiboServers() {
    var options = { host: this._jiboServerUrl, path: '/' };
    https.get(options, function(res) {});
  }
}`;
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-wifi-structural-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const options = (target, dryRun = false) => ({ target, dryRun, suffix: 'jibo.io', region: 'api' });

test('Wi-Fi preflight is read-only; apply preserves mode, ownership, backup and repeatability', () => {
  fixture((dir) => {
    const target = join(dir, 'ssm.js');
    writeFileSync(target, stock, { mode: 0o755 });
    const stat = statSync(target);
    assert.equal(patcher.apply(options(target, true)), 'patched');
    assert.equal(readFileSync(target, 'utf8'), stock);
    assert.equal(existsSync(target + '.phoenix-ssm.bak'), false);
    assert.equal(patcher.apply(options(target)), 'patched');
    assert.equal(statSync(target).mode & 0o777, 0o755);
    assert.equal(statSync(target).uid, stat.uid);
    assert.equal(statSync(target).gid, stat.gid);
    assert.equal(readFileSync(target + '.phoenix-ssm.bak', 'utf8'), stock);
    const patched = readFileSync(target, 'utf8');
    assert.equal(patcher.apply(options(target)), 'already-patched');
    assert.equal(readFileSync(target, 'utf8'), patched);
    assert.equal(patcher.apply({ ...options(target), suffix: 'example.net', region: 'stg-entrypoint' }), 'patched');
    assert.match(readFileSync(target, 'utf8'), /stg-entrypoint\.example\.net/);
    assert.equal(readFileSync(target + '.phoenix-ssm.bak', 'utf8'), stock);
  });
});

test('an unsupported Wi-Fi request changes nothing and includes a diagnostic source hash', () => {
  fixture((dir) => {
    const target = join(dir, 'ssm.js');
    const unsupported = stock.replace("path: '/'", "path: '/', rejectUnauthorized: false");
    writeFileSync(target, unsupported);
    assert.throws(() => patcher.apply(options(target)), /disabled TLS verification; source SHA-256=[a-f0-9]{64}/);
    assert.equal(readFileSync(target, 'utf8'), unsupported);
    assert.equal(existsSync(target + '.phoenix-ssm.bak'), false);
    assert.throws(() => patcher.patchSource(stock.replace('https.get(options,', "options.ca = 'fake'; https.get(options,"), 'jibo.io', '/etc/x'), /used or modified/);
  });
});

test('a Wi-Fi source or backup symlink is refused', () => {
  fixture((dir) => {
    const target = join(dir, 'ssm.js');
    const link = join(dir, 'link.js');
    writeFileSync(target, stock);
    symlinkSync(target, link);
    assert.throws(() => patcher.apply(options(link)), /symlinked/);
    symlinkSync(target, target + '.phoenix-ssm.bak');
    assert.throws(() => patcher.apply(options(target)), /symlinked/);
    assert.equal(readFileSync(target, 'utf8'), stock);
  });
});

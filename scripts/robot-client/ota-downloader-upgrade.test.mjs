import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const patcher = require('./patch-ota-downloader-tls.cjs');
const code = fs.readFileSync(new URL('./patch-ota-downloader-tls.cjs', import.meta.url), 'utf8');
const ca = '/etc/ssl/certs/ca-certificates.crt';
const anchor = 'let req = http.get(argv.url, function(res) {';
// Phoenix-authored insertion from d1731dc, not a copy of the Jibo downloader.
const earlier = [
  '// This runs on Node 6.9.2, which predates NODE_EXTRA_CA_CERTS (added in 7.3) and',
  '// ignores the system trust store entirely -- /etc/ssl/cert.pem does not help it.',
  '// Against a publicly-trusted server certificate a bare https.get therefore fails',
  '// with UNABLE_TO_GET_ISSUER_CERT_LOCALLY and the update download dies at 0 bytes,',
  '// which the system manager reports only as "Failed to download update". Hand https',
  '// an explicit CA, the same way the patched jibo-server-client does.',
  'let _getOpts = argv.url;',
  'if (argv.url.startsWith("https:")) {',
  '    let _caPath = process.env.JIBO_EXTRA_CA_CERTS || "' + ca + '";',
  '    try {',
  '        let _url = require("url").parse(argv.url);',
  '        _getOpts = { protocol: _url.protocol, hostname: _url.hostname, port: _url.port,',
  '                     path: _url.path, ca: fs.readFileSync(_caPath) };',
  '    } catch (e) { /* no CA available: fall back to the default roots */ }',
  '}', '', 'let req = http.get(_getOpts, function(res) {'
].join('\n');

function fixture(run, { variant = '', input, originalPin, outputPin, injectedFs = fs } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'phoenix-downloader-upgrade-'));
  const target = join(dir, 'download.js');
  const receipt = join(dir, 'receipt.json');
  // Same small synthetic anchor fixture as test-patch-ota-downloader-tls.cjs.
  const stock = `const fs = require('fs');\n${variant}${anchor}\n  return res;\n});`;
  const previous = input ?? stock.replace(anchor, earlier);
  const output = patcher.patchSource(stock, ca);
  const original = patcher.sha256(stock);
  const reviewed = { [originalPin ?? original]: outputPin ?? patcher.sha256(output) };
  const prior = { [patcher.sha256(previous)]: originalPin ?? original };
  const module = { exports: {} };
  let source = code.replace(/^var TARGET = .*;$/m, 'var TARGET = ' + JSON.stringify(target) + ';')
    .replace(/^var RECEIPT = .*;$/m, 'var RECEIPT = ' + JSON.stringify(receipt) + ';')
    .replace(/var REVIEWED = \{[\s\S]*?\n\};/, 'var REVIEWED = ' + JSON.stringify(reviewed) + ';')
    .replace(/var PREVIOUS = \{[\s\S]*?\n\};/, 'var PREVIOUS = ' + JSON.stringify(prior) + ';');
  source += '\nmodule.exports.apply = apply;';
  vm.runInNewContext(source, { require: name => name === 'fs' ? injectedFs : require(name), module, Buffer, process });
  fs.writeFileSync(target, previous, { mode: 0o640 });
  try { run({ dir, target, receipt, backup: target + '.phoenix-ota-tls.bak', stock, previous, output, apply: module.exports.apply }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const variant of ['', '// synthetic progress-reporting variant\n']) {
  test(`earlier downloader without backup reconstructs pinned original${variant ? ' (second variant)' : ''}`, () => fixture(f => {
    assert.equal(f.apply({ dryRun: true }).state, 'upgraded');
    assert.deepEqual(fs.readdirSync(f.dir), ['download.js'], 'dry run writes nothing');
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.previous);
    assert.equal(f.apply({ dryRun: false }).state, 'upgraded');
    assert.equal(fs.readFileSync(f.backup, 'utf8'), f.stock);
    assert.equal(fs.statSync(f.backup).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.output);
    assert.equal(fs.statSync(f.target).mode & 0o777, 0o755);
    assert.equal(fs.statSync(f.receipt).mode & 0o777, 0o600);
    const receipt = JSON.parse(fs.readFileSync(f.receipt));
    assert.equal(receipt.originalSha256, patcher.sha256(f.stock));
    assert.equal(receipt.patchedSha256, patcher.sha256(f.output));
    assert.equal(f.apply({ dryRun: false }).state, 'already-patched');
    assert.equal(fs.readFileSync(f.backup, 'utf8'), f.stock);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['download.js', 'download.js.phoenix-ota-tls.bak', 'receipt.json']);
  }, { variant }));
}

test('earlier downloader still upgrades from a valid existing original backup', () => fixture(f => {
  fs.writeFileSync(f.backup, f.stock);
  assert.equal(f.apply({ dryRun: false }).state, 'upgraded');
  assert.equal(fs.readFileSync(f.backup, 'utf8'), f.stock);
}));

for (const kind of ['corrupt', 'symlink', 'dangling-symlink', 'directory']) {
  test(`earlier downloader refuses ${kind} backup without replacing anything`, () => fixture(f => {
    if (kind === 'corrupt') fs.writeFileSync(f.backup, 'not original');
    else if (kind === 'directory') fs.mkdirSync(f.backup);
    else fs.symlinkSync(kind === 'symlink' ? f.target : join(f.dir, 'absent'), f.backup);
    assert.throws(() => f.apply({ dryRun: false }), /backup.*(reviewed original|regular non-symlink)/);
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.previous);
    assert.equal(fs.existsSync(f.receipt), false);
  }));
}

for (const input of ['no earlier insertion', earlier + '\n' + earlier]) {
  test(`earlier downloader requires exactly one inverse anchor (${input.startsWith('no') ? 'missing' : 'duplicate'})`, () => fixture(f => {
    assert.throws(() => f.apply({ dryRun: false }), /exactly once/);
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.previous);
    assert.deepEqual(fs.readdirSync(f.dir), ['download.js']);
  }, { input }));
}

for (const pin of ['originalPin', 'outputPin']) {
  test(`earlier downloader refuses wrong ${pin} before writing a reconstructed backup`, () => fixture(f => {
    assert.throws(() => f.apply({ dryRun: false }), /reviewed (original|pin)/);
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.previous);
    assert.deepEqual(fs.readdirSync(f.dir), ['download.js']);
  }, { [pin]: '0'.repeat(64) }));
}

test('unknown earlier-looking downloader is refused before any write', () => fixture(f => {
  fs.appendFileSync(f.target, '\n// unreviewed change');
  assert.throws(() => f.apply({ dryRun: false }), /unsupported source hash/);
  assert.deepEqual(fs.readdirSync(f.dir), ['download.js']);
}));

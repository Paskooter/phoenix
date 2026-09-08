#!/usr/bin/env node
/*
 * Offline round-trip checks for patch-server-client-ca.cjs.
 *
 * The fixture is the exact upstream lib/http/node.js source hash pinned by
 * the installer. The test uses temporary package trees and a real generated
 * certificate so no robot, package registry, or network service is involved.
 */
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var UTILITY = path.resolve(__dirname, 'patch-server-client-ca.cjs');
var CANONICAL = path.resolve(__dirname, 'test-fixtures/canonical-jibo-server-client/lib/http/node.js');
var ORIGINAL_SHA256 = 'c3511dbc55c8a9ec3ac74a675a1245306b55c67fab65a3ecfe896ed01689997a';
var PATCHED_SHA256 = '29686ca0aec6b93b8b716b94fca443ce25e6e7e55e01e798be56bce920c66bac';

function hashFile(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function mkdirp(directory) {
  if (fs.existsSync(directory)) return;
  mkdirp(path.dirname(directory));
  fs.mkdirSync(directory);
}

function removeTree(filename) {
  var stat;
  try { stat = fs.lstatSync(filename); } catch (error) { return; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.readdirSync(filename).forEach(function(entry) { removeTree(path.join(filename, entry)); });
    fs.rmdirSync(filename);
  } else {
    fs.unlinkSync(filename);
  }
}

function writePackage(directory, packageName, mode) {
  mkdirp(path.join(directory, 'lib', 'http'));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({name: packageName, version: 'fixture'}));
  fs.writeFileSync(path.join(directory, 'lib', 'http', 'node.js'), fs.readFileSync(CANONICAL));
  fs.chmodSync(path.join(directory, 'lib', 'http', 'node.js'), mode || 0o644);
}

function run(args) {
  return childProcess.spawnSync(process.execPath, [UTILITY].concat(args), {
    encoding: 'utf8'
  });
}

function runJson(args) {
  var result = run(args.concat(['--json']));
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return {result: result, value: JSON.parse(result.stdout)};
}

function makeCertificate(directory) {
  var key = path.join(directory, 'test.key');
  var cert = path.join(directory, 'test.crt');
  if (process.env.PHOENIX_CA_TEST_CERTIFICATE) {
    fs.writeFileSync(cert, fs.readFileSync(process.env.PHOENIX_CA_TEST_CERTIFICATE));
  } else {
  var openssl = childProcess.spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=phoenix-installer-test', '-keyout', key, '-out', cert
  ], {encoding: 'utf8', stdio: 'ignore'});
  assert.strictEqual(openssl.status, 0, 'openssl or PHOENIX_CA_TEST_CERTIFICATE is required');
  }
  var bytes = fs.readFileSync(cert);
  var bundle = path.join(directory, 'system-ca-bundle.pem');
  // A bundle with two valid PEM blocks exercises the same parser used for a
  // system bundle while remaining private to this temporary test directory.
  fs.writeFileSync(bundle, Buffer.concat([bytes, bytes]));
  return bundle;
}

function packageNode(root, relativeDirectory) {
  return path.join(root, relativeDirectory, 'lib', 'http', 'node.js');
}

function assertSourceState(root, relativeDirectory, expectedHash) {
  assert.strictEqual(hashFile(packageNode(root, relativeDirectory)), expectedHash);
}

function main() {
  assert.strictEqual(hashFile(CANONICAL), ORIGINAL_SHA256, 'fixture source hash drifted');
  var temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-node-ca-test-'));
  try {
    var root = path.join(temporary, 'scan-root');
    var first = path.join(root, 'one', 'node_modules', '@jibo', 'jibo-server-client');
    var second = path.join(root, 'two', 'node_modules', 'jibo-server-client');
    writePackage(first, '@jibo/jibo-server-client', 0o640);
    writePackage(second, 'jibo-server-client', 0o600);
    fs.symlinkSync(first, path.join(root, 'alias-to-first'));
    mkdirp(path.join(root, 'ordinary-bin'));
    fs.symlinkSync('/bin/sh', path.join(root, 'ordinary-bin', 'sh-link'));
    fs.symlinkSync('/proc', path.join(root, 'proc-link'));
    var bundle = makeCertificate(temporary);
    var receipt = path.join(temporary, 'state', 'client-ca.json');

    var applied = runJson([
      '--root', root, '--ca-bundle', bundle, '--receipt', receipt
    ]);
    assert.strictEqual(applied.value.ok, true);
    assert.strictEqual(applied.value.receipt.targets.length, 2);
    assert.strictEqual(applied.value.receipt.caBundle.callerProvidedBundle, true);
    assert.strictEqual(applied.value.receipt.caBundle.validation.indexOf('tls.createSecureContext') >= 0, true);
    assertSourceState(root, 'one/node_modules/@jibo/jibo-server-client', PATCHED_SHA256);
    assertSourceState(root, 'two/node_modules/jibo-server-client', PATCHED_SHA256);
    assert.strictEqual(fs.statSync(packageNode(root, 'one/node_modules/@jibo/jibo-server-client')).mode & 0o777, 0o640);
    assert.strictEqual(fs.statSync(packageNode(root, 'two/node_modules/jibo-server-client')).mode & 0o777, 0o600);
    assert.strictEqual(applied.value.receipt.targets[0].aliases.length >= 1, true);
    applied.value.receipt.targets.forEach(function(target) {
      assert.strictEqual(hashFile(target.backupPath), ORIGINAL_SHA256);
      assert.strictEqual(hashFile(target.caPath), applied.value.receipt.caBundle.sha256);
    });

    // A second apply is an idempotent validation, not a second source edit.
    var secondApply = runJson([
      '--root', root, '--ca-bundle', bundle, '--receipt', receipt
    ]);
    assert.strictEqual(secondApply.value.receipt.targets.length, 2);
    assertSourceState(root, 'one/node_modules/@jibo/jibo-server-client', PATCHED_SHA256);

    // A source-only reapply must retain ownership of a previously installed
    // CA so a later revert still knows it may remove that file.
    var sourceOnly = runJson(['--root', root, '--receipt', receipt]);
    assert.strictEqual(sourceOnly.value.receipt.caBundle.sha256, secondApply.value.receipt.caBundle.sha256);
    sourceOnly.value.receipt.targets.forEach(function(target) {
      assert.strictEqual(target.caCreated, true);
      assert.strictEqual(target.caSha256, secondApply.value.receipt.caBundle.sha256);
    });

    // Dry-run must work with no writable receipt parent requirement and must
    // leave every byte unchanged.
    var beforeDrySource = hashFile(packageNode(root, 'one/node_modules/@jibo/jibo-server-client'));
    var beforeDryReceipt = hashFile(receipt);
    var dry = runJson([
      '--root', root, '--ca-bundle', bundle, '--receipt', receipt, '--dry-run'
    ]);
    assert.strictEqual(dry.value.dryRun, true);
    assert.strictEqual(hashFile(packageNode(root, 'one/node_modules/@jibo/jibo-server-client')), beforeDrySource);
    assert.strictEqual(hashFile(receipt), beforeDryReceipt);

    var dryRevert = runJson(['--root', root, '--receipt', receipt, '--revert', '--dry-run']);
    assert.strictEqual(dryRevert.value.dryRun, true);
    assertSourceState(root, 'one/node_modules/@jibo/jibo-server-client', PATCHED_SHA256);

    var reverted = runJson(['--root', root, '--receipt', receipt, '--revert']);
    assert.strictEqual(reverted.value.receipt.lastOperation, 'revert');
    assertSourceState(root, 'one/node_modules/@jibo/jibo-server-client', ORIGINAL_SHA256);
    assertSourceState(root, 'two/node_modules/jibo-server-client', ORIGINAL_SHA256);
    reverted.value.receipt.targets.forEach(function(target) {
      assert.strictEqual(fs.existsSync(target.caPath), false);
    });
    assert.strictEqual(fs.statSync(packageNode(root, 'one/node_modules/@jibo/jibo-server-client')).mode & 0o777, 0o640);
    assert.strictEqual(fs.statSync(packageNode(root, 'two/node_modules/jibo-server-client')).mode & 0o777, 0o600);

    // Revert remains safe after the package source is already restored. This
    // covers the state where a CA-only mutation had preceded an interruption.
    var secondRevert = run(['--root', root, '--receipt', receipt, '--revert']);
    assert.strictEqual(secondRevert.status, 0, secondRevert.stderr);

    // An unknown source must fail before either target, backup, CA, or receipt
    // is changed. This is the important guard against patching stale copies.
    var badRoot = path.join(temporary, 'bad-root');
    var bad = path.join(badRoot, 'node_modules', 'jibo-server-client');
    writePackage(bad, 'jibo-server-client');
    fs.appendFileSync(path.join(bad, 'lib', 'http', 'node.js'), '\nchanged outside reviewed patch\n');
    var badReceipt = path.join(temporary, 'bad-state', 'receipt.json');
    var badRun = run(['--root', badRoot, '--ca-bundle', bundle, '--receipt', badReceipt, '--json']);
    assert.notStrictEqual(badRun.status, 0);
    assert.strictEqual(hashFile(path.join(bad, 'lib', 'http', 'node.js')) !== PATCHED_SHA256, true);
    assert.strictEqual(fs.existsSync(path.join(bad, 'lib', 'http', 'node.js.phoenix-ca.bak')), false);
    assert.strictEqual(fs.existsSync(path.join(bad, 'lib', 'http', 'phoenix-ca.pem')), false);
    assert.strictEqual(fs.existsSync(badReceipt), false);

    // A malformed or missing bundle is rejected before package inspection can
    // mutate anything. The TLS context check catches marker-only PEM files.
    var invalidRoot = path.join(temporary, 'invalid-root');
    var invalid = path.join(invalidRoot, 'node_modules', 'jibo-server-client');
    writePackage(invalid, 'jibo-server-client');
    var invalidBundle = path.join(temporary, 'invalid.pem');
    fs.writeFileSync(invalidBundle, 'this is not a certificate bundle\n');
    var invalidRun = run(['--root', invalidRoot, '--ca-bundle', invalidBundle, '--receipt', path.join(temporary, 'invalid-state.json')]);
    assert.notStrictEqual(invalidRun.status, 0);
    assertSourceState(invalidRoot, 'node_modules/jibo-server-client', ORIGINAL_SHA256);
    assert.strictEqual(fs.existsSync(path.join(invalid, 'lib', 'http', 'node.js.phoenix-ca.bak')), false);

    var missingArgumentRun = run(['--root', invalidRoot, '--ca-bundle']);
    assert.notStrictEqual(missingArgumentRun.status, 0);
    assertSourceState(invalidRoot, 'node_modules/jibo-server-client', ORIGINAL_SHA256);

    process.stdout.write(JSON.stringify({
      ok: true,
      fixtureSourceSha256: ORIGINAL_SHA256,
      patchedSourceSha256: PATCHED_SHA256,
      targetCount: 2,
      checks: [
        'duplicate directory symlink deduplication',
        'file and virtual-tree symlink pruning',
        'valid PEM/TLS context validation',
        'apply and idempotent apply',
        'dry-run leaves bytes unchanged',
        'mode-preserving revert and repeat revert',
        'bundle-less reapply retains CA ownership',
        'unknown source fails before mutation',
        'invalid bundle and missing argument fail before mutation'
      ]
    }) + '\n');
  } finally {
    removeTree(temporary);
  }
}

main();

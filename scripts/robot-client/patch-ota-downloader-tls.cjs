#!/usr/bin/env node
/*
 * Give the legacy Node 6 OTA downloader an explicit public CA bundle, while
 * preserving the executable mode required by SystemManager. Node 6 does not
 * use the system trust store by default; changing only the client used for
 * update discovery is therefore insufficient for the package download.
 *
 * This is deliberately hash-guarded. It only accepts a reviewed stock downloader
 * or the exact output this patch generates from it, never an arbitrary lookalike.
 * Stock downloaders differ between factory images only in progress reporting;
 * the patched request is identical in each.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var TARGET = '/usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js';
var RECEIPT = '/var/lib/phoenix/jibo-ota-downloader-tls.json';
var CA_PATH = '/etc/ssl/certs/ca-certificates.crt';
// Reviewed stock downloader -> the exact patched output this file produces from it.
var REVIEWED = {
  // jibo-ota-updater 1.3.0 in the RTM3 (3.3.x) factory image through 1.4.1 in 13.0.x
  '33f6db1496baa3abd506a2ba9dad9b5cdf7567341e3e292e42cb3ed6f016003c':
    '1a01b446575bc5da145a41e969ea110af62f144d5651ed5b7ca5aee8bfef826a',
  // jibo-ota-updater 1.3.0 in the RTM2 (3.0.x) factory image
  '447a2a5598ec13ea46367207ea594efd6774d785c97d5322200e5809d6d9acb2':
    '6b9399b4d85213ba15c68224f0fae2c69ba787c207351184a65b6873452562b7'
};
var PATCHED = Object.keys(REVIEWED).map(function(original) { return REVIEWED[original]; });
var EXECUTABLE_MODE = 0o755;
var MARKER = 'JIBO_EXTRA_CA_CERTS';
var ANCHOR = 'let req = http.get(argv.url, function(res) {';

// Node 4.1 (factory RTM2/RTM3 images) predates Buffer.from(string): the name
// resolves to TypedArray.from, which treats the encoding as a map function.
function utf8Buffer(text) {
  return typeof Buffer.alloc === 'function' ? Buffer.from(text, 'utf8') : new Buffer(text, 'utf8');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function modeOf(filename) {
  return fs.statSync(filename).mode & 0o777;
}

function regularFile(filename, label) {
  var stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(label + ' must be a regular non-symlink file: ' + filename);
  }
}

function ensureSafeParent(filename) {
  var directory = path.dirname(filename);
  if (fs.existsSync(directory)) {
    var stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('receipt parent must be a real directory: ' + directory);
    }
    return;
  }
  var parent = path.dirname(directory);
  if (parent !== directory) ensureSafeParent(path.join(parent, '.phoenix-parent-check'));
  fs.mkdirSync(directory, 0o700);
}

function writeAtomic(filename, bytes, mode) {
  var temporary = filename + '.phoenix-ota-tls-' + process.pid + '-' + Math.random().toString(16).slice(2);
  try {
    fs.writeFileSync(temporary, bytes, { mode: mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
}

function exactlyOnce(source, needle, label) {
  var first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(label + ' anchor was not found exactly once');
  }
}

function patchSource(source, caPath) {
  exactlyOnce(source, ANCHOR, 'OTA downloader');
  var prelude = [
    '// This runs on Node 6.9.2, which predates NODE_EXTRA_CA_CERTS (added in 7.3) and',
    '// ignores the system trust store entirely -- /etc/ssl/cert.pem does not help it.',
    '// Against a publicly-trusted server certificate a bare https.get therefore fails',
    '// with UNABLE_TO_GET_ISSUER_CERT_LOCALLY and the update download dies at 0 bytes,',
    '// which the system manager reports only as "Failed to download update". Hand https',
    '// an explicit CA, the same way the patched jibo-server-client does.',
    'let _getOpts = argv.url;',
    'if (argv.url.startsWith("https:")) {',
    '    let _caPath = process.env.JIBO_EXTRA_CA_CERTS || "' + caPath + '";',
    '    try {',
    '        let _url = require("url").parse(argv.url);',
    '        _getOpts = { protocol: _url.protocol, hostname: _url.hostname, port: _url.port,',
    '                     path: _url.path, ca: fs.readFileSync(_caPath) };',
    '    } catch (e) { /* no CA available: fall back to the default roots */ }',
    '}',
    '',
    'let req = http.get(_getOpts, function(res) {'
  ].join('\n');
  return source.replace(ANCHOR, prelude);
}

function parseArgs(argv) {
  var result = { dryRun: false, json: false };
  argv.forEach(function(arg) {
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: patch-ota-downloader-tls.cjs [--dry-run] [--json]\n');
      process.exit(0);
    } else throw new Error('unknown argument: ' + arg);
  });
  return result;
}

function apply(options) {
  regularFile(TARGET, 'OTA downloader');
  var source = fs.readFileSync(TARGET);
  var sourceHash = sha256(source);
  var priorMode = modeOf(TARGET);
  var state;
  var output = null;

  var patchedSha256 = sourceHash;
  if (REVIEWED[sourceHash]) {
    output = utf8Buffer(patchSource(source.toString('utf8'), CA_PATH));
    patchedSha256 = REVIEWED[sourceHash];
    if (sha256(output) !== patchedSha256) {
      throw new Error('generated OTA downloader patch does not match the reviewed pin');
    }
    state = 'patched';
  } else if (PATCHED.indexOf(sourceHash) >= 0 && source.toString('utf8').indexOf(MARKER) >= 0) {
    state = priorMode === EXECUTABLE_MODE ? 'already-patched' : 'mode-repaired';
  } else {
    throw new Error('OTA downloader has an unsupported source hash: ' + sourceHash);
  }

  var result = {
    ok: true,
    path: TARGET,
    state: state,
    dryRun: options.dryRun,
    sourceHash: sourceHash,
    patchedSha256: patchedSha256,
    modeBefore: priorMode.toString(8),
    modeAfter: EXECUTABLE_MODE.toString(8)
  };
  if (options.dryRun) return result;

  if (output) {
    var backup = TARGET + '.phoenix-ota-tls.bak';
    if (fs.existsSync(backup)) {
      regularFile(backup, 'OTA downloader backup');
      if (sha256(fs.readFileSync(backup)) !== sourceHash) {
        throw new Error('OTA downloader backup is not the reviewed original source');
      }
    } else {
      writeAtomic(backup, source, priorMode);
    }
    writeAtomic(TARGET, output, EXECUTABLE_MODE);
    ensureSafeParent(RECEIPT);
    writeAtomic(RECEIPT, utf8Buffer(JSON.stringify({
      kind: 'phoenix-ota-downloader-tls', target: TARGET, backup: backup,
      originalSha256: sourceHash, patchedSha256: patchedSha256,
      originalMode: priorMode.toString(8), patchedMode: EXECUTABLE_MODE.toString(8)
    }, null, 2) + '\n'), 0o600);
  } else if (priorMode !== EXECUTABLE_MODE) {
    fs.chmodSync(TARGET, EXECUTABLE_MODE);
  }
  return result;
}

function main() {
  var options = parseArgs(process.argv.slice(2));
  var result = apply(options);
  process.stdout.write(options.json ? JSON.stringify(result) + '\n' : result.state + '\n');
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write('patch-ota-downloader-tls: ' + error.message + '\n'); process.exit(2); }
}

module.exports = { patchSource: patchSource, sha256: sha256 };

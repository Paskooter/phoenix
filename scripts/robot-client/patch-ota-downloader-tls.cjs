#!/usr/bin/env node
/*
 * Give the legacy Node 6 OTA downloader an explicit public CA bundle, while
 * preserving the executable mode required by SystemManager. Node 6 does not
 * use the system trust store by default; changing only the client used for
 * update discovery is therefore insufficient for the package download.
 *
 * This is deliberately hash-guarded. It only accepts the stock Release-13
 * downloader or this exact generated patch, never an arbitrary lookalike.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var TARGET = '/usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js';
var RECEIPT = '/var/lib/phoenix/jibo-ota-downloader-tls.json';
var CA_PATH = '/etc/ssl/certs/ca-certificates.crt';
var ORIGINAL_SHA256 = '33f6db1496baa3abd506a2ba9dad9b5cdf7567341e3e292e42cb3ed6f016003c';
var PATCHED_SHA256 = '1a01b446575bc5da145a41e969ea110af62f144d5651ed5b7ca5aee8bfef826a';
var EXECUTABLE_MODE = 0o755;
var MARKER = 'JIBO_EXTRA_CA_CERTS';
var ANCHOR = 'let req = http.get(argv.url, function(res) {';

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

  if (sourceHash === ORIGINAL_SHA256) {
    output = Buffer.from(patchSource(source.toString('utf8'), CA_PATH), 'utf8');
    if (sha256(output) !== PATCHED_SHA256) {
      throw new Error('generated OTA downloader patch does not match the reviewed pin');
    }
    state = 'patched';
  } else if (sourceHash === PATCHED_SHA256 && source.toString('utf8').indexOf(MARKER) >= 0) {
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
    patchedSha256: PATCHED_SHA256,
    modeBefore: priorMode.toString(8),
    modeAfter: EXECUTABLE_MODE.toString(8)
  };
  if (options.dryRun) return result;

  if (output) {
    var backup = TARGET + '.phoenix-ota-tls.bak';
    if (fs.existsSync(backup)) {
      regularFile(backup, 'OTA downloader backup');
      if (sha256(fs.readFileSync(backup)) !== ORIGINAL_SHA256) {
        throw new Error('OTA downloader backup is not the reviewed original source');
      }
    } else {
      writeAtomic(backup, source, priorMode);
    }
    writeAtomic(TARGET, output, EXECUTABLE_MODE);
    ensureSafeParent(RECEIPT);
    writeAtomic(RECEIPT, Buffer.from(JSON.stringify({
      kind: 'phoenix-ota-downloader-tls', target: TARGET, backup: backup,
      originalSha256: ORIGINAL_SHA256, patchedSha256: PATCHED_SHA256,
      originalMode: priorMode.toString(8), patchedMode: EXECUTABLE_MODE.toString(8)
    }, null, 2) + '\n', 'utf8'), 0o600);
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

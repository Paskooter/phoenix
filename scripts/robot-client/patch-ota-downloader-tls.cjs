#!/usr/bin/env node
/*
 * Give the legacy Node 6 OTA downloader an explicit public CA bundle, while
 * preserving the executable mode required by SystemManager. Node 6 does not
 * use the system trust store by default; changing only the client used for
 * update discovery is therefore insufficient for the package download.
 *
 * This is deliberately hash-guarded. It only accepts a reviewed stock downloader
 * or the exact output this patch generates from it, never an arbitrary lookalike.
 * The official Phoenix image's downloader, which also checks update signatures,
 * already has the CA and is recognised and left unchanged (see GATE_* below).
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
    '74b75fc45c8561ee9f1cae63bd0718316c00c62d77103f6492bfc5c58a0accbd',
  // jibo-ota-updater 1.3.0 in the RTM2 (3.0.x) factory image
  '447a2a5598ec13ea46367207ea594efd6774d785c97d5322200e5809d6d9acb2':
    'ce4253aabe016cc322401db15e5220bb89592ee18a04acc047e5cf1734ea6b14'
};
// Outputs of the previous version of this patch, which passed the CA bundle whole:
// Node 4 reads only its first certificate. The hosted image has these outputs
// without backups, so invert only this exact earlier Phoenix-authored insertion.
var PREVIOUS = {
  '1a01b446575bc5da145a41e969ea110af62f144d5651ed5b7ca5aee8bfef826a':
    '33f6db1496baa3abd506a2ba9dad9b5cdf7567341e3e292e42cb3ed6f016003c',
  '6b9399b4d85213ba15c68224f0fae2c69ba787c207351184a65b6873452562b7':
    '447a2a5598ec13ea46367207ea594efd6774d785c97d5322200e5809d6d9acb2'
};
var PATCHED = Object.keys(REVIEWED).map(function(original) { return REVIEWED[original]; });
var EXECUTABLE_MODE = 0o755;
var MARKER = 'JIBO_EXTRA_CA_CERTS';
var ANCHOR = 'let req = http.get(argv.url, function(res) {';
// The CA insertion from d1731dc. The official Phoenix image still bakes exactly this one.
var EARLIER_INSERTION = [
  '// This runs on Node 6.9.2, which predates NODE_EXTRA_CA_CERTS (added in 7.3) and',
  '// ignores the system trust store entirely -- /etc/ssl/cert.pem does not help it.',
  '// Against a publicly-trusted server certificate a bare https.get therefore fails',
  '// with UNABLE_TO_GET_ISSUER_CERT_LOCALLY and the update download dies at 0 bytes,',
  '// which the system manager reports only as "Failed to download update". Hand https',
  '// an explicit CA, the same way the patched jibo-server-client does.',
  'let _getOpts = argv.url;',
  'if (argv.url.startsWith("https:")) {',
  '    let _caPath = process.env.JIBO_EXTRA_CA_CERTS || "' + CA_PATH + '";',
  '    try {',
  '        let _url = require("url").parse(argv.url);',
  '        _getOpts = { protocol: _url.protocol, hostname: _url.hostname, port: _url.port,',
  '                     path: _url.path, ca: fs.readFileSync(_caPath) };',
  '    } catch (e) { /* no CA available: fall back to the default roots */ }',
  '}',
  '',
  'let req = http.get(_getOpts, function(res) {'
].join('\n');

// The official Phoenix image (deploy/robot-patches/bake_jibo_io_native_image.py) bakes a
// downloader that installs only updates signed by a pinned Phoenix key and newer than what the
// robot runs (docs/OTA-RELEASE-SIGNING.md). It already has the explicit CA, and swapping it for
// the CA-only patch would remove that check, so it is recognised and never rewritten:
//   * one check block (the builder's OTA_GATE_DEFINITIONS, pinned by hash with its one
//     configuration line set aside) directly before the CA insertion above;
//   * its three hook lines, each directly before the stock line it guards;
//   * without the block and hooks, the file is exactly the builder's CA-only output (GATED_BASE).
// Only the configuration line (pinned public keys, version sources) differs between builds.
var GATE_BEGIN = '// >>> phoenix-ota-signature-gate >>>';
var GATE_END = '// <<< phoenix-ota-signature-gate <<<\n\n';
var GATE_CONFIG_PREFIX = '\nconst _PHOENIX_OTA_GATE = ';
var GATE_CONFIG_PLACEHOLDER = '__PHOENIX_OTA_GATE_CONFIG__';
var GATE_TEMPLATE_SHA256 = '25445fdb460c929aa9600378d81413f3259da175fb87a6c7db97dbf7f68fedab';
var GATE_FORMAT = 'phoenix-ota-release/1';
var GATE_HEADER = 'x-phoenix-ota-signature';
var GATE_MAX_KEYS = 2;
var GATE_HOOKS = [
  ['    _phoenixOtaAdmit(res);  // phoenix-ota-signature-gate\n',
    '    progress.length = parseInt(res.headers["content-length"]);\n'],
  ['        _phoenixOtaChunk(chunk);  // phoenix-ota-signature-gate\n',
    '        hash.update(chunk, "binary");\n'],
  ['        _phoenixOtaFinish();  // phoenix-ota-signature-gate\n',
    '        let csum = hash.digest("hex");\n']
];
// The builder's CA-only output for the reviewed 1.4.1 stock downloader (also a PREVIOUS key).
var GATED_BASE = ['1a01b446575bc5da145a41e969ea110af62f144d5651ed5b7ca5aee8bfef826a'];

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
    '// This runs on Node 6.9.2 (Node 4.1.2 on factory images), which predates NODE_EXTRA_CA_CERTS and',
    '// ignores the system trust store entirely -- /etc/ssl/cert.pem does not help it.',
    '// Against a publicly-trusted server certificate a bare https.get therefore fails',
    '// with UNABLE_TO_GET_ISSUER_CERT_LOCALLY and the update download dies at 0 bytes,',
    '// which the system manager reports only as "Failed to download update". Hand https',
    '// an explicit CA, the same way the patched jibo-server-client does. The bundle is split',
    '// into certificates: Node 4 reads only the first certificate of a PEM bundle.',
    'let _getOpts = argv.url;',
    'if (argv.url.startsWith("https:")) {',
    '    let _caPath = process.env.JIBO_EXTRA_CA_CERTS || "' + caPath + '";',
    '    try {',
    '        let _url = require("url").parse(argv.url);',
    '        _getOpts = { protocol: _url.protocol, hostname: _url.hostname, port: _url.port,',
    '                     path: _url.path, ca: fs.readFileSync(_caPath, "utf8")',
    '                         .match(/-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----/g) };',
    '    } catch (e) { /* no CA available: fall back to the default roots */ }',
    '}',
    '',
    'let req = http.get(_getOpts, function(res) {'
  ].join('\n');
  return source.replace(ANCHOR, prelude);
}

// Exact insertion from d1731dc. Keep this separate from the current patch:
// reconstruction must recover the byte-pinned original, not a similar program.
function reconstructOriginal(source, originalHash) {
  var text = source.toString('utf8');
  exactlyOnce(text, EARLIER_INSERTION, 'earlier OTA downloader patch');
  var original = utf8Buffer(text.replace(EARLIER_INSERTION, ANCHOR));
  if (sha256(original) !== originalHash) throw new Error('reconstructed OTA downloader is not the reviewed original source');
  return original;
}

function countOf(text, needle) {
  var count = 0;
  for (var at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

function hasGateMarker(text) {
  return text.indexOf('phoenix-ota-signature-gate') >= 0 || text.indexOf('_phoenixOta') >= 0;
}

// Pinned public keys in the right format; anything else is not an official-image check.
function validGateConfig(json) {
  var config;
  try { config = JSON.parse(json); } catch (e) { return false; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (config.format !== GATE_FORMAT || config.header !== GATE_HEADER) return false;
  var keys = config.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
  var ids = Object.keys(keys);
  if (ids.length < 1 || ids.length > GATE_MAX_KEYS) return false;
  return ids.every(function(id) {
    var pem = keys[id];
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && typeof pem === 'string'
      && pem.indexOf('-----BEGIN PUBLIC KEY-----') === 0 && pem.indexOf('PRIVATE') < 0;
  });
}

// True for the official image's signature-checking downloader (see GATE_* above); throws for
// anything else that carries the check's marker, so it can never fall through to a rewrite.
function isSignatureGated(text) {
  if (!hasGateMarker(text)) return false;
  var refuse = function() {
    throw new Error('OTA downloader carries a Phoenix update signature check this helper does not recognise; it was left unchanged');
  };
  if (countOf(text, GATE_BEGIN) !== 1 || countOf(text, GATE_END) !== 1) refuse();
  var begin = text.indexOf(GATE_BEGIN);
  var end = text.indexOf(GATE_END) + GATE_END.length;
  if (end <= begin) refuse();
  var block = text.slice(begin, end);
  if (text.slice(end, end + EARLIER_INSERTION.length) !== EARLIER_INSERTION) refuse();
  if (countOf(block, GATE_CONFIG_PREFIX) !== 1) refuse();
  var configStart = block.indexOf(GATE_CONFIG_PREFIX) + GATE_CONFIG_PREFIX.length;
  var configEnd = block.indexOf(';\n', configStart);
  if (configEnd < 0) refuse();
  var configText = block.slice(configStart, configEnd);
  if (configText.indexOf('\n') >= 0 || !validGateConfig(configText)) refuse();
  var template = block.slice(0, configStart) + GATE_CONFIG_PLACEHOLDER + block.slice(configEnd);
  if (sha256(utf8Buffer(template)) !== GATE_TEMPLATE_SHA256) refuse();
  var rest = text.slice(0, begin) + text.slice(end);
  GATE_HOOKS.forEach(function(hook) {
    if (countOf(rest, hook[0]) !== 1 || countOf(rest, hook[0] + hook[1]) !== 1) refuse();
    rest = rest.replace(hook[0] + hook[1], hook[1]);
  });
  if (hasGateMarker(rest) || GATED_BASE.indexOf(sha256(utf8Buffer(rest))) < 0) refuse();
  return true;
}

// Unlike existsSync, lstat sees dangling symlinks, which must not be replaced.
function backupExists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
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
  var originalHash = sourceHash;
  var backup = TARGET + '.phoenix-ota-tls.bak';
  if (isSignatureGated(source.toString('utf8'))) {
    // The official image's downloader: it has the CA already and keeps its signature check.
    // Nothing is written; only a lost executable mode is restored below.
    state = 'signature-gated';
  } else if (PREVIOUS[sourceHash]) {
    // Prefer the saved original. Only known earlier output hashes may be
    // reconstructed, and both the recovered original and new output are pinned.
    originalHash = PREVIOUS[sourceHash];
    if (backupExists(backup)) {
      regularFile(backup, 'OTA downloader backup');
      source = fs.readFileSync(backup);
      if (sha256(source) !== originalHash) throw new Error('OTA downloader backup is not the reviewed original source');
    } else {
      source = reconstructOriginal(source, originalHash);
    }
    output = utf8Buffer(patchSource(source.toString('utf8'), CA_PATH));
    patchedSha256 = REVIEWED[originalHash];
    if (sha256(output) !== patchedSha256) throw new Error('generated OTA downloader patch does not match the reviewed pin');
    state = 'upgraded';
  } else if (REVIEWED[sourceHash]) {
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
    if (backupExists(backup)) {
      regularFile(backup, 'OTA downloader backup');
      if (sha256(fs.readFileSync(backup)) !== originalHash) {
        throw new Error('OTA downloader backup is not the reviewed original source');
      }
    } else {
      writeAtomic(backup, source, priorMode);
    }
    writeAtomic(TARGET, output, EXECUTABLE_MODE);
    ensureSafeParent(RECEIPT);
    writeAtomic(RECEIPT, utf8Buffer(JSON.stringify({
      kind: 'phoenix-ota-downloader-tls', target: TARGET, backup: backup,
      originalSha256: originalHash, patchedSha256: patchedSha256,
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

module.exports = {
  patchSource: patchSource, sha256: sha256,
  GATE_TEMPLATE_SHA256: GATE_TEMPLATE_SHA256, GATED_BASE: GATED_BASE.slice()
};

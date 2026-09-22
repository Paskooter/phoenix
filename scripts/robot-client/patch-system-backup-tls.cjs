#!/usr/bin/env node
/*
 * Make the stock system-manager backup and restore helpers use the robot's
 * maintained public CA bundle. These helpers are independent Node 6 programs:
 * patching @jibo/jibo-server-client does not affect their raw request/https
 * transfers. Never weaken TLS verification or install a server-specific trust
 * anchor here.
 *
 * The two stock source hashes are pinned from PlatformTeam/system-manager and
 * verified on a physical Release 13 robot. A changed helper is refused rather
 * than edited by a broad text substitution. This utility is Node 6-compatible.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var VERSION = 1;
var DEFAULT_ROOT = '/usr/local/bin';
var DEFAULT_RECEIPT = '/var/lib/phoenix/jibo-system-backup-tls.json';
var DEFAULT_CA_PATH = '/etc/ssl/certs/ca-certificates.crt';
var BACKUP_NAME = 'jibo-system-backup';
var RESTORE_NAME = 'jibo-system-restore';
var BACKUP_ORIGINAL_SHA256 = 'd17fbf4150dee58a988fe5ee72071d4515ef74f29876215bf66de2601e33e522';
var RESTORE_ORIGINAL_SHA256 = 'b5e7ec06c4ea72b641b8738b789a389575e250b152b3b6ecddd952d593e05ee6';
// Filled by the release test below. Keep the post-patch hashes pinned too: a
// second run accepts only our exact generated source, never a lookalike marker.
var BACKUP_PATCHED_SHA256 = 'fa438f59b09dcdc863526aaa574f9e8939670c465b40ed83236dd5646ab881d5';
var RESTORE_PATCHED_SHA256 = '7c48b4a15bc30405fc30570251071b6f0efaf7f3057546a2fc403a20b64beb03';

var MARK_BEGIN = '// >>> phoenix-system-backup-tls >>>';
var MARK_END = '// <<< phoenix-system-backup-tls <<<';

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
  var temporary = filename + '.phoenix-tls-' + process.pid + '-' + Math.random().toString(16).slice(2);
  try {
    fs.writeFileSync(temporary, bytes, { mode: mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
}

function sourceCaPrelude(caPath) {
  return [
    MARK_BEGIN,
    '// Node 6 does not load the system CA bundle for request/https automatically.',
    '// Read the maintained public bundle explicitly; a missing configured path is',
    '// fatal rather than silently disabling or bypassing certificate verification.',
    "var phoenixTlsCA = fs.readFileSync(process.env.JIBO_EXTRA_CA_CERTS || '" + caPath + "');",
    MARK_END,
    ''
  ].join('\n');
}

function exactlyOnce(source, needle, label) {
  var first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(label + ' anchor was not found exactly once');
  }
}

function patchBackup(source, caPath) {
  var requireLine = "var request = require('request');\n";
  var optionsAnchor = "            method: 'PUT',\n            headers: {";
  exactlyOnce(source, requireLine, BACKUP_NAME);
  exactlyOnce(source, optionsAnchor, BACKUP_NAME);
  return source
    .replace(requireLine, requireLine + sourceCaPrelude(caPath))
    .replace(optionsAnchor, "            method: 'PUT',\n            ca: phoenixTlsCA,\n            headers: {");
}

function patchRestore(source, caPath) {
  var httpsLine = "var https = require('https');\n";
  var downloadLine = '        https.get(downloadUrl, callbackDownload)';
  exactlyOnce(source, httpsLine, RESTORE_NAME);
  exactlyOnce(source, downloadLine, RESTORE_NAME);
  return source
    .replace(httpsLine, httpsLine + "var url = require('url');\n" + sourceCaPrelude(caPath))
    .replace(downloadLine, [
      '        var phoenixDownloadOptions = url.parse(downloadUrl);',
      '        phoenixDownloadOptions.ca = phoenixTlsCA;',
      '        https.get(phoenixDownloadOptions, callbackDownload)'
    ].join('\n'));
}

function patchedHashFor(name) {
  return name === BACKUP_NAME ? BACKUP_PATCHED_SHA256 : RESTORE_PATCHED_SHA256;
}

function originalHashFor(name) {
  return name === BACKUP_NAME ? BACKUP_ORIGINAL_SHA256 : RESTORE_ORIGINAL_SHA256;
}

function buildPatched(name, source, caPath) {
  return name === BACKUP_NAME ? patchBackup(source, caPath) : patchRestore(source, caPath);
}

function readTarget(name, root, caPath) {
  var filename = path.join(root, name);
  regularFile(filename, name);
  var source = fs.readFileSync(filename);
  var hash = sha256(source);
  var originalHash = originalHashFor(name);
  var patchedHash = patchedHashFor(name);
  var state;
  var output = null;
  if (hash === originalHash) {
    output = Buffer.from(buildPatched(name, source.toString('utf8'), caPath), 'utf8');
    if (sha256(output) !== patchedHash) {
      throw new Error(name + ' generated patch hash does not match the reviewed pin');
    }
    state = 'original';
  } else if (hash === patchedHash) {
    state = 'patched';
  } else {
    throw new Error(name + ' has an unsupported source hash: ' + hash);
  }
  return {
    name: name,
    path: filename,
    source: source,
    sourceHash: hash,
    originalHash: originalHash,
    patchedHash: patchedHash,
    output: output,
    mode: modeOf(filename),
    backupPath: filename + '.phoenix-tls.bak',
    state: state
  };
}

function parseArgs(argv) {
  var result = { root: DEFAULT_ROOT, receipt: DEFAULT_RECEIPT, caPath: DEFAULT_CA_PATH, dryRun: false, revert: false, json: false };
  for (var index = 0; index < argv.length; index += 1) {
    var arg = argv[index];
    if (arg === '--root' || arg === '--receipt' || arg === '--ca-path') {
      if (index + 1 >= argv.length) throw new Error(arg + ' requires a value');
      var value = argv[index + 1];
      index += 1;
      if (arg === '--root') result.root = value;
      if (arg === '--receipt') result.receipt = value;
      if (arg === '--ca-path') result.caPath = value;
    } else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--revert') result.revert = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: patch-system-backup-tls.cjs [--root DIR] [--receipt FILE] [--ca-path FILE] [--dry-run] [--revert] [--json]\n');
      process.exit(0);
    } else throw new Error('unknown argument: ' + arg);
  }
  if (!/^\/[A-Za-z0-9_./-]+$/.test(result.caPath)) throw new Error('--ca-path must be an absolute safe path');
  return result;
}

function readReceipt(filename) {
  if (!fs.existsSync(filename)) return null;
  regularFile(filename, 'receipt');
  var receipt = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!receipt || receipt.kind !== 'phoenix-system-backup-tls' || receipt.version !== VERSION || !Array.isArray(receipt.targets)) {
    throw new Error('receipt is not a recognized system backup TLS receipt');
  }
  return receipt;
}

function render(result, options) {
  if (options.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    result.targets.forEach(function(target) { process.stdout.write(target.name + ': ' + target.state + '\n'); });
  }
}

function apply(options) {
  var targets = [BACKUP_NAME, RESTORE_NAME].map(function(name) { return readTarget(name, options.root, options.caPath); });
  targets.forEach(function(target) {
    if (target.state !== 'original') return;
    if (!fs.existsSync(target.backupPath)) return;
    regularFile(target.backupPath, target.name + ' backup');
    if (sha256(fs.readFileSync(target.backupPath)) !== target.originalHash) {
      throw new Error(target.name + ' backup is not the reviewed original source');
    }
  });
  var result = { ok: true, operation: 'apply', dryRun: options.dryRun, targets: targets.map(function(target) {
    return { name: target.name, path: target.path, state: target.state, sourceHash: target.sourceHash, patchedHash: target.patchedHash };
  }) };
  if (options.dryRun) return result;
  var written = [];
  try {
    targets.forEach(function(target) {
      if (target.state !== 'original') return;
      if (!fs.existsSync(target.backupPath)) writeAtomic(target.backupPath, target.source, target.mode);
    });
    targets.forEach(function(target) {
      if (target.state !== 'original') return;
      writeAtomic(target.path, target.output, target.mode);
      written.push(target);
    });
    ensureSafeParent(options.receipt);
    var receipt = {
      kind: 'phoenix-system-backup-tls', version: VERSION, caPath: options.caPath,
      targets: targets.map(function(target) { return { name: target.name, path: target.path, backupPath: target.backupPath, originalSha256: target.originalHash, patchedSha256: target.patchedHash }; })
    };
    writeAtomic(options.receipt, Buffer.from(JSON.stringify(receipt, null, 2) + '\n', 'utf8'), 0o600);
    result.receipt = options.receipt;
    return result;
  } catch (error) {
    written.reverse().forEach(function(target) {
      try { writeAtomic(target.path, target.source, target.mode); } catch (ignored) {}
    });
    throw error;
  }
}

function revert(options) {
  var receipt = readReceipt(options.receipt);
  if (!receipt) throw new Error('no system backup TLS receipt to revert: ' + options.receipt);
  var targets = receipt.targets.map(function(entry) {
    if (entry.path !== path.join(options.root, entry.name)) throw new Error('receipt path is outside the requested root');
    regularFile(entry.path, entry.name);
    regularFile(entry.backupPath, entry.name + ' backup');
    var current = sha256(fs.readFileSync(entry.path));
    if (current !== entry.patchedSha256) throw new Error(entry.name + ' no longer matches the reviewed patched source');
    var original = fs.readFileSync(entry.backupPath);
    if (sha256(original) !== entry.originalSha256) throw new Error(entry.name + ' backup no longer matches the reviewed original source');
    return { name: entry.name, path: entry.path, source: original, mode: modeOf(entry.path), state: 'will-revert' };
  });
  var result = { ok: true, operation: 'revert', dryRun: options.dryRun, targets: targets.map(function(target) { return { name: target.name, path: target.path, state: target.state }; }) };
  if (!options.dryRun) {
    targets.forEach(function(target) { writeAtomic(target.path, target.source, target.mode); });
    fs.unlinkSync(options.receipt);
  }
  return result;
}

function main() {
  var options = parseArgs(process.argv.slice(2));
  var result = options.revert ? revert(options) : apply(options);
  render(result, options);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write('patch-system-backup-tls: ' + error.message + '\n'); process.exit(2); }
}

module.exports = { patchBackup: patchBackup, patchRestore: patchRestore, sha256: sha256 };

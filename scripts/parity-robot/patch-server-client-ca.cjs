#!/usr/bin/env node
/*
 * Patch the installed Node jibo-server-client copies with an opt-in Phoenix
 * CA source.  This file is intentionally CommonJS/ES5-compatible: the target
 * robot runs Node 6.9 and cannot consume the repository's module syntax.
 *
 * The utility is transactional at the package-file boundary.  It validates
 * every discovered supported package and its source hash before writing any
 * package file.  It never disables TLS verification.  Without a bundled CA
 * and without JIBO_EXTRA_CA_CERTS, the generated Agent receives exactly the
 * upstream {rejectUnauthorized: true} options.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var tls = require('tls');

var UTILITY_VERSION = 1;
var DEFAULT_RECEIPT = '/var/lib/phoenix/jibo-server-client-ca.json';
var DEFAULT_ROOTS = ['/usr', '/opt', '/var', '/home', '/root'];
var PACKAGE_NAMES = {
  '@jibo/jibo-server-client': true,
  'jibo-server-client': true
};

// This is the exact canonical source pin supplied by the frozen Moth survey:
// jiborobot/srv-jibo-server-client@dd4594bfb8554034075632a9bcc3499732a1d599.
var ORIGINAL_SOURCE_SHA256 = 'c3511dbc55c8a9ec3ac74a675a1245306b55c67fab65a3ecfe896ed01689997a';
// Hash of ORIGINAL_SOURCE_SHA256 after applyPatch(). Keep this guard in the
// utility so a manually altered/partially patched file is never accepted as a
// supported installed copy.
var PATCHED_SOURCE_SHA256 = '29686ca0aec6b93b8b716b94fca443ce25e6e7e55e01e798be56bce920c66bac';
var PATCHED_CA_BASENAME = 'phoenix-ca.pem';
var NODE_BACKUP_SUFFIX = '.phoenix-ca.bak';

var ORIGINAL_REQUIRE_LINE = "var AWS = require('../core');\n";
var ORIGINAL_AGENT_LINE = '      AWS.NodeHttpClient.sslAgent = new https.Agent({rejectUnauthorized: true});';
var PATCH_AGENT_BLOCK = [
  '      var agentOptions = {rejectUnauthorized: true};',
  "      var caPath = process.env.JIBO_EXTRA_CA_CERTS || __dirname + '/phoenix-ca.pem';",
  '',
  '      // An explicit path is authoritative: let readFileSync surface a',
  '      // missing or unreadable deployment certificate instead of silently',
  "      // falling back to Node's built-in roots.  The bundled path is",
  '      // optional so installations without the Phoenix CA retain the',
  '      // upstream agent behavior.',
  '      if (process.env.JIBO_EXTRA_CA_CERTS || fs.existsSync(caPath)) {',
  '        agentOptions.ca = fs.readFileSync(caPath);',
  '      }',
  '',
  '      AWS.NodeHttpClient.sslAgent = new https.Agent(agentOptions);'
].join('\n');

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filename) {
  return sha256Bytes(fs.readFileSync(filename));
}

function isRegular(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch (error) {
    return false;
  }
}

function isDirectory(filename) {
  try {
    return fs.statSync(filename).isDirectory();
  } catch (error) {
    return false;
  }
}

function fileMode(filename) {
  try {
    return fs.statSync(filename).mode & 0o777;
  } catch (error) {
    return 0o644;
  }
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fail(message) {
  throw new Error(message);
}

function displayPath(filename) {
  return path.resolve(filename);
}

function shouldPruneAbsolute(absolute) {
  var normalized = path.resolve(absolute);
  if (normalized === '/proc' || normalized.indexOf('/proc/') === 0) return true;
  if (normalized === '/sys' || normalized.indexOf('/sys/') === 0) return true;
  if (normalized === '/dev' || normalized.indexOf('/dev/') === 0) return true;
  if (normalized === '/run' || normalized.indexOf('/run/') === 0) return true;
  if (normalized === '/var/lib/docker' || normalized.indexOf('/var/lib/docker/') === 0) return true;
  if (normalized === '/var/cache' || normalized.indexOf('/var/cache/') === 0) return true;
  return false;
}

function shouldPrune(parent, name) {
  var absolute = path.join(parent, name);
  if (name === '.' || name === '..') return true;
  if (name === 'proc' || name === 'sys' || name === 'dev' || name === 'run') return true;
  if (name === '.git' || name === '__pycache__') return true;
  if (name === 'backup' || name === 'backups' || name === 'lost+found') return true;
  if (/\.phx-bak(?:-|$)/.test(name)) return true;
  // These are virtual/cache trees rather than installed application trees. In
  // particular, Docker layers can contain arbitrary duplicate package names;
  // scanning them would not patch a package loaded by the robot host.
  return shouldPruneAbsolute(absolute);
}

function scanPackages(roots, requiredRoots) {
  var packages = {};
  var visitedDirectories = {};
  var errors = [];

  function addPackage(packageName, packageDirectory, aliasDirectory) {
    var realDirectory;
    try {
      realDirectory = fs.realpathSync(packageDirectory);
    } catch (error) {
      errors.push('cannot resolve package directory ' + packageDirectory + ': ' + error.message);
      return;
    }
    var nodeCandidate = path.join(realDirectory, 'lib', 'http', 'node.js');
    if (!isRegular(nodeCandidate)) {
      errors.push('supported package has no regular lib/http/node.js: ' + packageDirectory);
      return;
    }
    var nodePath;
    try {
      nodePath = fs.realpathSync(nodeCandidate);
    } catch (error2) {
      errors.push('cannot resolve package HTTP client ' + nodeCandidate + ': ' + error2.message);
      return;
    }
    if (!hasOwn(packages, nodePath)) {
      packages[nodePath] = {
        packageName: packageName,
        packageDirectory: realDirectory,
        aliases: [],
        nodePath: nodePath,
        caPath: path.join(realDirectory, 'lib', 'http', PATCHED_CA_BASENAME),
        backupPath: nodePath + NODE_BACKUP_SUFFIX
      };
    }
    if (packages[nodePath].aliases.indexOf(aliasDirectory) < 0) {
      packages[nodePath].aliases.push(aliasDirectory);
    }
  }

  function inspectDirectory(directory, realDirectory) {
    var manifestPath = path.join(directory, 'package.json');
    if (!isRegular(manifestPath)) return;
    var manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      // A malformed manifest is irrelevant unless the directory itself is
      // visibly a target package. In that case, refusing to continue avoids
      // silently missing an installed copy.
      if (path.basename(directory) === 'jibo-server-client') {
        errors.push('cannot parse target package manifest ' + manifestPath + ': ' + error.message);
      }
      return;
    }
    if (manifest && PACKAGE_NAMES[manifest.name]) addPackage(manifest.name, realDirectory, directory);
  }

  function walk(directory) {
    var realDirectory;
    try {
      realDirectory = fs.realpathSync(directory);
    } catch (error) {
      // Broken optional symlinks are not installed package copies. A regular
      // root failure, however, must be visible to the caller.
      if (isDirectory(directory)) errors.push('cannot resolve directory ' + directory + ': ' + error.message);
      return;
    }
    // lstat reports executable and other file symlinks as links. Resolve first,
    // then recurse only into a real directory; otherwise readdirSync would
    // turn every /usr/bin symlink into a survey error. This also prevents a
    // symlink placed under an application tree from exposing /proc or /sys.
    if (!isDirectory(realDirectory) || shouldPruneAbsolute(realDirectory)) return;
    inspectDirectory(directory, realDirectory);
    if (visitedDirectories[realDirectory]) return;
    visitedDirectories[realDirectory] = true;

    var entries;
    try {
      entries = fs.readdirSync(directory);
    } catch (error2) {
      errors.push('cannot scan directory ' + directory + ': ' + error2.message);
      return;
    }
    entries.forEach(function(entry) {
      if (shouldPrune(directory, entry)) return;
      var child = path.join(directory, entry);
      var stats;
      try {
        stats = fs.lstatSync(child);
      } catch (error3) {
        errors.push('cannot inspect ' + child + ': ' + error3.message);
        return;
      }
      if (stats.isDirectory() || stats.isSymbolicLink()) walk(child);
    });
  }

  roots.forEach(function(root) {
    if (!isDirectory(root)) {
      if (requiredRoots && requiredRoots[root]) errors.push('scan root is not a directory: ' + root);
      return;
    }
    walk(root);
  });

  if (errors.length) fail('package survey failed:\n- ' + errors.join('\n- '));
  var result = Object.keys(packages).map(function(key) { return packages[key]; });
  result.sort(function(left, right) { return left.nodePath < right.nodePath ? -1 : left.nodePath > right.nodePath ? 1 : 0; });
  if (result.length === 0) fail('no supported jibo-server-client package copies were found');
  return result;
}

function applyPatch(source) {
  var patched = source;
  if (patched.indexOf(ORIGINAL_REQUIRE_LINE) !== 0) {
    fail('unsupported source: expected the canonical AWS require header');
  }
  patched = patched.replace(ORIGINAL_REQUIRE_LINE, ORIGINAL_REQUIRE_LINE + "var fs = require('fs');\n");
  if (patched.indexOf(ORIGINAL_AGENT_LINE) < 0) {
    fail('unsupported source: expected the canonical sslAgent constructor');
  }
  patched = patched.replace(ORIGINAL_AGENT_LINE, PATCH_AGENT_BLOCK);
  if (sha256Bytes(Buffer.from(patched)) !== PATCHED_SOURCE_SHA256) {
    fail('internal patch output hash does not match the reviewed patch pin');
  }
  return patched;
}

function inspectTargets(targets, previousReceipt, desiredCaHash) {
  var sourceStates = [];
  var previousByNode = {};
  if (previousReceipt && Array.isArray(previousReceipt.targets)) {
    previousReceipt.targets.forEach(function(entry) {
      previousByNode[entry.nodePath] = entry;
    });
  }

  targets.forEach(function(target) {
    var source = fs.readFileSync(target.nodePath);
    var sourceHash = sha256Bytes(source);
    var state;
    if (sourceHash === ORIGINAL_SOURCE_SHA256) state = 'original';
    else if (sourceHash === PATCHED_SOURCE_SHA256) state = 'patched';
    else fail('unsupported jibo-server-client source hash at ' + target.nodePath + ': ' + sourceHash);

    if (state === 'original') {
      // Validate the replacement now, before any backup or CA write occurs.
      applyPatch(source.toString('utf8'));
    } else {
      if (!isRegular(target.backupPath) || sha256File(target.backupPath) !== ORIGINAL_SOURCE_SHA256) {
        fail('patched source has no hash-verified rollback backup: ' + target.nodePath);
      }
    }

    if (fs.existsSync(target.caPath) && !isRegular(target.caPath)) {
      fail('package CA path exists but is not a regular file: ' + target.caPath);
    }
    if (fs.existsSync(target.backupPath) && !isRegular(target.backupPath)) {
      fail('rollback backup path exists but is not a regular file: ' + target.backupPath);
    }
    var caExists = isRegular(target.caPath);
    var caHash = caExists ? sha256File(target.caPath) : null;
    if (desiredCaHash && caExists && caHash !== desiredCaHash) {
      fail('existing package CA differs from requested bundle at ' + target.caPath
        + ': ' + caHash + ' (requested ' + desiredCaHash + ')');
    }
    if (desiredCaHash && caExists && previousByNode[target.nodePath]
      && previousByNode[target.nodePath].caCreated === true
      && previousByNode[target.nodePath].caSha256 !== desiredCaHash) {
      fail('existing receipt disagrees with package CA at ' + target.caPath);
    }
    if (caExists && previousByNode[target.nodePath]
      && previousByNode[target.nodePath].caCreated === true
      && previousByNode[target.nodePath].caSha256
      && previousByNode[target.nodePath].caSha256 !== caHash) {
      fail('owned package CA changed outside this utility: ' + target.caPath);
    }

    sourceStates.push({
      target: target,
      source: source,
      sourceHash: sourceHash,
      sourceMode: previousByNode[target.nodePath] && previousByNode[target.nodePath].sourceMode
        || fileMode(target.nodePath),
      state: state,
      caExists: caExists,
      caHash: caHash,
      previous: previousByNode[target.nodePath] || null,
      caCreated: Boolean(desiredCaHash && !caExists)
    });
  });
  return sourceStates;
}

function validateReceiptPath(receiptPath, targets) {
  var requested = path.resolve(receiptPath);
  targets.forEach(function(target) {
    [target.nodePath, target.backupPath, target.caPath].forEach(function(ownedPath) {
      if (requested === path.resolve(ownedPath)) {
        fail('receipt path overlaps an owned package file: ' + requested);
      }
    });
  });
}

function ensureReadableBundle(caPath) {
  if (!caPath) return null;
  if (!isRegular(caPath)) fail('--ca-bundle must name a regular readable file: ' + caPath);
  var bytes;
  try {
    bytes = fs.readFileSync(caPath);
  } catch (error) {
    fail('cannot read --ca-bundle ' + caPath + ': ' + error.message);
  }
  if (!bytes.length || bytes.toString('ascii').indexOf('-----BEGIN CERTIFICATE-----') < 0) {
    fail('--ca-bundle is not a PEM certificate bundle: ' + caPath);
  }
  // A marker-only file can pass a textual check while failing when Node builds
  // the actual TLS context. Validate before touching any discovered package.
  try {
    tls.createSecureContext({ca: bytes});
  } catch (contextError) {
    fail('--ca-bundle is not parseable by the target TLS runtime: ' + contextError.message);
  }
  return { bytes: bytes, sha256: sha256Bytes(bytes) };
}

function checkWritable(state, receiptPath, caBundle, dryRun) {
  if (dryRun) return;
  var directories = {};
  state.forEach(function(entry) {
    var nodeDirectory = path.dirname(entry.target.nodePath);
    directories[nodeDirectory] = true;
    if (caBundle && !entry.caExists) directories[path.dirname(entry.target.caPath)] = true;
    if (entry.state === 'patched') directories[nodeDirectory] = true;
    if (entry.state === 'original' && isRegular(entry.target.backupPath)) directories[path.dirname(entry.target.backupPath)] = true;
  });
  directories[path.dirname(receiptPath)] = true;
  Object.keys(directories).forEach(function(directory) {
    try {
      fs.accessSync(directory, fs.W_OK);
    } catch (error) {
      fail('package/receipt directory is not writable: ' + directory + ': ' + error.message);
    }
  });
}

function ensureDirectory(directory) {
  if (isDirectory(directory)) return;
  var parent = path.dirname(directory);
  if (parent !== directory) ensureDirectory(parent);
  try {
    fs.mkdirSync(directory, 0o700);
  } catch (error) {
    if (!isDirectory(directory)) fail('cannot create receipt directory ' + directory + ': ' + error.message);
  }
}

function atomicWrite(filename, bytes, mode) {
  var temporary = filename + '.phoenix-ca.tmp-' + process.pid;
  try {
    fs.writeFileSync(temporary, bytes, { mode: mode || 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { /* already renamed */ }
  }
}

function createBackup(target, source) {
  if (isRegular(target.backupPath)) {
    if (sha256File(target.backupPath) !== ORIGINAL_SOURCE_SHA256) {
      fail('rollback backup hash mismatch: ' + target.backupPath);
    }
    return false;
  }
  atomicWrite(target.backupPath, source, 0o600);
  if (sha256File(target.backupPath) !== ORIGINAL_SOURCE_SHA256) {
    fail('rollback backup verification failed: ' + target.backupPath);
  }
  return true;
}

function previousCaCreated(entry) {
  return Boolean(entry.previous && entry.previous.caCreated === true);
}

function makeReceipt(receiptPath, state, bundle, roots, operation, previousReceipt) {
  var previousBundle = previousReceipt && previousReceipt.caBundle || null;
  return {
    schema: 1,
    utility: 'patch-server-client-ca.cjs',
    utilityVersion: UTILITY_VERSION,
    operation: operation,
    generatedAt: new Date().toISOString(),
    source: {
      canonicalSha256: ORIGINAL_SOURCE_SHA256,
      patchedSha256: PATCHED_SOURCE_SHA256,
      packageNames: Object.keys(PACKAGE_NAMES),
      patchBehavior: 'strict TLS verification; package-local CA with optional JIBO_EXTRA_CA_CERTS override'
    },
    scanRoots: roots,
    caBundle: bundle ? {
      sha256: bundle.sha256,
      bytes: bundle.bytes.length,
      installedAs: PATCHED_CA_BASENAME,
      callerProvidedBundle: true,
      validation: 'PEM parsed by tls.createSecureContext; caller supplies the full system bundle'
    } : previousBundle,
    targets: state.map(function(entry) {
      return {
        packageName: entry.target.packageName,
        packageDirectory: entry.target.packageDirectory,
        aliases: entry.target.aliases,
        nodePath: entry.target.nodePath,
        sourceMode: entry.sourceMode,
        originalSha256: ORIGINAL_SOURCE_SHA256,
        patchedSha256: PATCHED_SOURCE_SHA256,
        backupPath: entry.target.backupPath,
        backupSha256: ORIGINAL_SOURCE_SHA256,
        caPath: entry.target.caPath,
        caSha256: entry.caHash || (bundle && bundle.sha256)
          || (entry.previous && entry.previous.caSha256) || null,
        caCreated: bundle ? Boolean(!entry.caExists || previousCaCreated(entry)) : previousCaCreated(entry)
      };
    })
  };
}

function writeReceipt(receiptPath, receipt) {
  ensureDirectory(path.dirname(receiptPath));
  var bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  atomicWrite(receiptPath, bytes, 0o600);
}

function readReceipt(receiptPath) {
  if (!isRegular(receiptPath)) fail('receipt not found: ' + receiptPath);
  var receipt;
  try {
    receipt = readJson(receiptPath);
  } catch (error) {
    fail('cannot parse receipt ' + receiptPath + ': ' + error.message);
  }
  if (!receipt || receipt.schema !== 1 || !receipt.source
    || receipt.source.canonicalSha256 !== ORIGINAL_SOURCE_SHA256
    || receipt.source.patchedSha256 !== PATCHED_SOURCE_SHA256
    || !Array.isArray(receipt.targets) || receipt.targets.length === 0) {
    fail('receipt is not for this reviewed patch: ' + receiptPath);
  }
  return receipt;
}

function runApply(options) {
  var previous = isRegular(options.receipt) ? readReceipt(options.receipt) : null;
  var bundle = ensureReadableBundle(options.caBundle);
  var targets = scanPackages(options.roots, options.explicitRoots);
  validateReceiptPath(options.receipt, targets);
  var state = inspectTargets(targets, previous, bundle && bundle.sha256);

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      operation: 'apply',
      sourceSha256: ORIGINAL_SOURCE_SHA256,
      patchedSha256: PATCHED_SOURCE_SHA256,
      caBundleSha256: bundle && bundle.sha256 || null,
      caBundleBytes: bundle && bundle.bytes.length || 0,
      targets: state.map(function(entry) {
        return {
          packageName: entry.target.packageName,
          nodePath: entry.target.nodePath,
          aliases: entry.target.aliases,
          sourceState: entry.state,
          caPath: entry.target.caPath,
          caState: entry.caExists ? 'present' : bundle ? 'would-install' : 'absent'
        };
      })
    };
  }

  // Receipt paths are normally under /var/lib/phoenix, which may not exist on
  // a fresh robot. Creating that directory is the first deliberate mutation,
  // after every package source and CA input has passed validation.
  ensureDirectory(path.dirname(options.receipt));
  checkWritable(state, options.receipt, bundle, false);

  var mutated = [];
  try {
    state.forEach(function(entry) {
      var target = entry.target;
      var currentSourceHash = sha256File(target.nodePath);
      if (currentSourceHash !== entry.sourceHash) {
        fail('package source changed after survey: ' + target.nodePath);
      }
      var mutation = {
        entry: entry,
        nodeBefore: entry.source,
        nodeMode: entry.sourceMode,
        nodeWriteAttempted: false,
        nodeChanged: false,
        caWriteAttempted: false,
        caCreated: false
      };
      mutated.push(mutation);
      if (entry.state === 'original') {
        var backupCreated = createBackup(target, entry.source);
        var patched = Buffer.from(applyPatch(entry.source.toString('utf8')));
        mutation.nodeWriteAttempted = true;
        atomicWrite(target.nodePath, patched, entry.sourceMode);
        if (sha256File(target.nodePath) !== PATCHED_SOURCE_SHA256) fail('patched source verification failed: ' + target.nodePath);
        mutation.nodeChanged = true;
        mutation.backupCreated = backupCreated;
      }
      if (bundle && !entry.caExists) {
        if (fs.existsSync(target.caPath)) {
          fail('package CA appeared after survey: ' + target.caPath);
        }
        mutation.caWriteAttempted = true;
        atomicWrite(target.caPath, bundle.bytes, 0o644);
        if (sha256File(target.caPath) !== bundle.sha256) fail('package CA verification failed: ' + target.caPath);
        mutation.caCreated = true;
      }
    });
    var receipt = makeReceipt(options.receipt, state, bundle, options.roots, 'apply', previous);
    writeReceipt(options.receipt, receipt);
    return { ok: true, dryRun: false, receipt: receipt };
  } catch (error) {
    // Restore only files whose current bytes still carry the hashes this run
    // wrote. A concurrent third-party edit is never overwritten on rollback.
    mutated.slice().reverse().forEach(function(item) {
      var target = item.entry.target;
      if ((item.nodeChanged || item.nodeWriteAttempted) && isRegular(target.nodePath)
        && sha256File(target.nodePath) === PATCHED_SOURCE_SHA256) {
        atomicWrite(target.nodePath, item.nodeBefore, item.nodeMode);
      }
      if ((item.caCreated || item.caWriteAttempted) && isRegular(target.caPath)
        && bundle && sha256File(target.caPath) === bundle.sha256) {
        fs.unlinkSync(target.caPath);
      }
      // Keep a verified backup as an audit aid; removing it would make an
      // interrupted run harder to inspect and is not needed for idempotence.
    });
    throw error;
  }
}

function runRevert(options) {
  var receipt = readReceipt(options.receipt);
  var scanned = scanPackages(options.roots, options.explicitRoots);
  var state = receipt.targets.map(function(record) {
    var target = scanned.filter(function(candidate) { return candidate.nodePath === record.nodePath; })[0];
    if (!target || record.backupPath !== target.backupPath || record.caPath !== target.caPath
      || record.packageDirectory !== target.packageDirectory || record.packageName !== target.packageName) {
      fail('receipt target does not match an installed package: ' + record.nodePath);
    }
    if (!isRegular(record.nodePath)) fail('owned package source is missing: ' + record.nodePath);
    if (!isRegular(record.backupPath) || sha256File(record.backupPath) !== ORIGINAL_SOURCE_SHA256) {
      fail('owned rollback backup is missing or changed: ' + record.backupPath);
    }
    var currentSourceHash = sha256File(record.nodePath);
    if (currentSourceHash !== PATCHED_SOURCE_SHA256 && currentSourceHash !== ORIGINAL_SOURCE_SHA256) {
      fail('owned package source changed outside this utility: ' + record.nodePath + ' (' + currentSourceHash + ')');
    }
    if (fs.existsSync(record.caPath) && !isRegular(record.caPath)) {
      fail('owned package CA path exists but is not a regular file: ' + record.caPath);
    }
    var caExists = isRegular(record.caPath);
    var caHash = caExists ? sha256File(record.caPath) : null;
    if (record.caCreated && caExists && caHash !== record.caSha256) {
      fail('owned package CA changed outside this utility: ' + record.caPath);
    }
    return {
      record: record,
      currentSource: fs.readFileSync(record.nodePath),
      currentSourceHash: currentSourceHash,
      caExists: caExists,
      caBytes: caExists ? fs.readFileSync(record.caPath) : null,
      caHash: caHash
    };
  });

  // Discover any additional patched copy not covered by this receipt. This
  // protects a partial historical run from being mistaken for a full revert.
  scanned.forEach(function(target) {
    if (sha256File(target.nodePath) === PATCHED_SOURCE_SHA256
      && !state.some(function(entry) { return entry.record.nodePath === target.nodePath; })) {
      fail('patched package is not owned by receipt: ' + target.nodePath);
    }
  });
  var directories = {};
  state.forEach(function(entry) { directories[path.dirname(entry.record.nodePath)] = true; });
  directories[path.dirname(options.receipt)] = true;
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      operation: 'revert',
      targets: state.map(function(entry) {
        return { nodePath: entry.record.nodePath, sourceState: entry.currentSourceHash === PATCHED_SOURCE_SHA256 ? 'would-restore' : 'original', caState: entry.record.caCreated ? (entry.caExists ? 'would-remove' : 'removed') : 'preserve' };
      })
    };
  }

  Object.keys(directories).forEach(function(directory) {
    try { fs.accessSync(directory, fs.W_OK); } catch (error) { fail('revert directory is not writable: ' + directory); }
  });

  var mutated = [];
  try {
    state.forEach(function(entry) {
      if (sha256File(entry.record.nodePath) !== entry.currentSourceHash
        || isRegular(entry.record.caPath) !== entry.caExists
        || (entry.caExists && sha256File(entry.record.caPath) !== entry.caHash)) {
        fail('owned package changed after revert survey: ' + entry.record.nodePath);
      }
      var mutation = {
        entry: entry,
        sourceWriteAttempted: false,
        sourceChanged: false,
        caRemoveAttempted: false,
        caRemoved: false
      };
      mutated.push(mutation);
      if (entry.currentSourceHash === PATCHED_SOURCE_SHA256) {
        mutation.sourceWriteAttempted = true;
        atomicWrite(entry.record.nodePath, fs.readFileSync(entry.record.backupPath), entry.record.sourceMode || 0o644);
        mutation.sourceChanged = true;
      }
      if (entry.record.caCreated && entry.caExists) {
        mutation.caRemoveAttempted = true;
        fs.unlinkSync(entry.record.caPath);
        mutation.caRemoved = true;
      }
    });
    receipt.lastOperation = 'revert';
    receipt.revertedAt = new Date().toISOString();
    writeReceipt(options.receipt, receipt);
    return { ok: true, dryRun: false, receipt: receipt };
  } catch (error) {
    mutated.slice().reverse().forEach(function(item) {
      if ((item.sourceChanged || item.sourceWriteAttempted) && isRegular(item.entry.record.nodePath)
        && sha256File(item.entry.record.nodePath) === ORIGINAL_SOURCE_SHA256) {
        atomicWrite(item.entry.record.nodePath, item.entry.currentSource, item.entry.record.sourceMode || 0o644);
      }
      if ((item.caRemoved || item.caRemoveAttempted) && !isRegular(item.entry.record.caPath) && item.entry.caBytes) {
        atomicWrite(item.entry.record.caPath, item.entry.caBytes, 0o644);
      }
    });
    throw error;
  }
}

function parseOptions(argv) {
  var options = {
    dryRun: false,
    revert: false,
    json: false,
    roots: [],
    explicitRoots: {},
    caBundle: null,
    receipt: DEFAULT_RECEIPT
  };
  for (var index = 0; index < argv.length; index += 1) {
    var arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--revert') options.revert = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--ca-bundle' || arg === '--ca') {
      if (index + 1 >= argv.length || !argv[index + 1]) fail(arg + ' requires a file path');
      options.caBundle = displayPath(argv[++index]);
    }
    else if (arg === '--receipt') {
      if (index + 1 >= argv.length || !argv[index + 1]) fail('--receipt requires a file path');
      options.receipt = displayPath(argv[++index]);
    }
    else if (arg === '--root') {
      if (index + 1 >= argv.length || !argv[index + 1]) fail('--root requires a directory path');
      var requestedRoot = displayPath(argv[++index]);
      options.roots.push(requestedRoot);
      options.explicitRoots[requestedRoot] = true;
    }
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail('unknown argument: ' + arg);
  }
  if (!options.roots.length) options.roots = DEFAULT_ROOTS.slice();
  if (options.revert && options.caBundle) fail('--ca-bundle cannot be combined with --revert');
  return options;
}

function help() {
  return [
    'Usage: patch-server-client-ca.cjs [--dry-run] [--json] [--ca-bundle FILE]',
    '       patch-server-client-ca.cjs --revert [--dry-run] [--json]',
    '',
    'Surveys /usr /opt /var /home /root for supported jibo-server-client copies.',
    '--ca-bundle FILE  install this full PEM system bundle as lib/http/phoenix-ca.pem',
    '--ca FILE         alias for --ca-bundle',
    '--receipt FILE     persistent hash-guarded rollback receipt',
    '--root DIR        additional survey root (repeatable; test/diagnostic use)',
    '--dry-run         validate and print the plan without changing files',
    '--revert          restore only files owned by the receipt',
    '--json            emit machine-readable result on stdout'
  ].join('\n');
}

function main() {
  var options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help() + '\n');
    return;
  }
  var result = options.revert ? runRevert(options) : runApply(options);
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    var resultTargets = result.targets || result.receipt && result.receipt.targets || [];
    process.stdout.write((result.dryRun ? 'dry-run' : result.operation || 'apply') + ': '
      + resultTargets.length + ' package target(s)\n');
  }
}

try {
  main();
} catch (error) {
  process.stderr.write('patch-server-client-ca: ' + error.message + '\n');
  process.exitCode = 1;
}

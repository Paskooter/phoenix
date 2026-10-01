#!/usr/bin/env node
/*
 * Normalize the robot's cloud configuration, including third-party repoints.
 * The 5x1/OpenJibo-style credential endpoint override wins over every
 * region_config.json rule, so replacing only jibo.com strings is insufficient.
 * This helper never reads a key aloud, never mints credentials, and refuses
 * malformed or symlinked input. It runs on factory Node 4 as well as Node 6.
 */
'use strict';

var fs = require('fs');
var path = require('path');

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(argv) {
  var out = { dryRun: false };
  for (var i = 0; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--kind' || arg === '--file' || arg === '--region' || arg === '--suffix' || arg === '--stamp') {
      if (!argv[i + 1]) throw new Error(arg + ' requires a value');
      out[arg.slice(2)] = argv[++i];
    } else throw new Error('unknown argument: ' + arg);
  }
  if (['region-config', 'credentials', 'notification', 'setup'].indexOf(out.kind) < 0) throw new Error('invalid --kind');
  if (!out.file || !path.isAbsolute(out.file)) throw new Error('--file must be absolute');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(out.region || '')) throw new Error('invalid --region');
  if (!/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z0-9][a-z0-9-]*$/.test(out.suffix || '')) throw new Error('invalid --suffix');
  if (!out.dryRun && !/^[0-9]{8}-[0-9]{6}$/.test(out.stamp || '')) throw new Error('invalid --stamp');
  return out;
}

function normalizeRegionConfig(data, region, suffix) {
  if (!object(data) || !object(data.rules) || !object(data.patterns) || !object(data.patterns.globalSSL)) {
    throw new Error('region config does not have the reviewed rules/patterns shape');
  }
  var endpoint = 'https://{region}.' + suffix;
  var socket = 'wss://{region}-socket.' + suffix;
  // Keep local/internal development routes. Everything a robot could select
  // for an external region must use the verified Phoenix HTTPS pattern, even
  // if another mod installed a service-specific rule or a new pattern name.
  Object.keys(data.patterns).forEach(function(name) {
    if (name === 'local' || name === 'internal') return;
    var pattern = data.patterns[name];
    if (!object(pattern)) throw new Error('invalid region pattern ' + name);
    pattern.endpoint = endpoint;
    pattern.wsendpoint = socket;
    pattern.globalEndpoint = true;
  });
  data.patterns.globalSSL.endpoint = endpoint;
  data.patterns.globalSSL.wsendpoint = socket;
  data.patterns.globalSSL.globalEndpoint = true;
  Object.keys(data.rules).forEach(function(name) {
    if (name.indexOf('local/') === 0 || name.indexOf('internal/') === 0) return;
    var rule = data.rules[name];
    if (typeof rule !== 'string' && !object(rule)) throw new Error('invalid region rule ' + name);
    if (object(rule)) {
      // Keep unrelated per-service options, such as signatureVersion.
      rule.endpoint = endpoint;
      rule.wsendpoint = socket;
      rule.globalEndpoint = true;
    } else data.rules[name] = 'globalSSL';
  });
  if (data.rules['*/*'] === undefined) data.rules['*/*'] = 'globalSSL';
  return data;
}

function normalizeCredentials(data, region, suffix) {
  if (!object(data) || typeof data.accessKeyId !== 'string' || typeof data.secretAccessKey !== 'string') {
    throw new Error('credentials do not contain a robot identity');
  }
  if (data.endpoint !== undefined && typeof data.endpoint !== 'string') throw new Error('invalid credential endpoint');
  if (data.wsendpoint !== undefined && typeof data.wsendpoint !== 'string') throw new Error('invalid credential socket endpoint');
  if (data.region !== undefined && typeof data.region !== 'string') throw new Error('invalid credential region');
  // Explicit endpoints take precedence over region_config.json in JSC. Keep
  // stock credentials stock-shaped, but replace any pre-existing override.
  if (data.endpoint !== undefined) data.endpoint = 'https://' + region + '.' + suffix;
  if (data.wsendpoint !== undefined) data.wsendpoint = 'wss://' + region + '-socket.' + suffix;
  data.region = region;
  if (data.sslEnabled === false) data.sslEnabled = true;
  return data;
}

function normalizeNotification(data, region, suffix) {
  if (!object(data)) throw new Error('invalid notification config');
  if (!object(data.NotificationSubsystem) || data.NotificationSubsystem.serverURLSuffix === undefined) return data;
  if (typeof data.NotificationSubsystem.serverURLSuffix !== 'string') throw new Error('invalid notification socket suffix');
  data.NotificationSubsystem.serverURLSuffix = '-socket.' + suffix;
  return data;
}

function normalizeSetup(data, region) {
  if (!object(data)) throw new Error('invalid setup config');
  // Older setup skills omit serverRegion and use the client's api default.
  // When present, it must agree with the selected destination; otherwise a
  // prior OpenJibo region survives until QR setup issues new credentials.
  if (data.serverRegion !== undefined) {
    if (typeof data.serverRegion !== 'string') throw new Error('invalid setup region');
    data.serverRegion = region;
  }
  return data;
}

function regularFile(filename) {
  var stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('refusing non-regular or symlinked file');
  return stat;
}

function writePrivateBackup(filename, bytes, mode) {
  var fd = fs.openSync(filename, 'wx', mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.chmodSync(filename, mode);
}

function writeAtomic(filename, bytes, stat, mode) {
  var temporary = filename + '.phoenix-repoint-' + process.pid;
  var fd = fs.openSync(temporary, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chownSync(temporary, stat.uid, stat.gid);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
}

function apply(options) {
  if ((options.kind === 'notification' || options.kind === 'setup') && !fs.existsSync(options.file)) return 'not-needed';
  var stat = regularFile(options.file);
  var original = fs.readFileSync(options.file);
  var data = JSON.parse(original.toString('utf8'));
  var before = JSON.stringify(data);
  var normalizer = options.kind === 'region-config' ? normalizeRegionConfig
    : options.kind === 'credentials' ? normalizeCredentials
    : options.kind === 'setup' ? normalizeSetup : normalizeNotification;
  normalizer(data, options.region, options.suffix);
  // A skill-local client config must be readable by the unprivileged BE user;
  // some prior mods leave it root-only. Preserve the credential file's mode:
  // its service reader may run under a different UID on older firmware.
  var mode = options.kind === 'region-config' || options.kind === 'setup' ? 0o644 : (stat.mode & 0o777);
  if (before === JSON.stringify(data)) {
    if ((stat.mode & 0o777) === mode) return 'already-patched';
    if (!options.dryRun) fs.chmodSync(options.file, mode);
    return 'mode-repaired';
  }
  if (options.dryRun) return 'patched';
  var backup = options.file + '.prerepoint-' + options.stamp + '.bak';
  writePrivateBackup(backup, original, options.kind === 'credentials' ? 0o600 : mode);
  // Factory Node 4 does not provide Buffer.from(string).
  var serialized = JSON.stringify(data, null, 2) + '\n';
  var encoded = typeof Buffer.from === 'function' ? Buffer.from(serialized, 'utf8') : new Buffer(serialized, 'utf8');
  writeAtomic(options.file, encoded, stat, mode);
  return 'patched';
}

if (require.main === module) {
  try { process.stdout.write(apply(parseArgs(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write('repoint-cloud-config: ' + error.message + '\n'); process.exit(2); }
}

module.exports = { parseArgs: parseArgs, normalizeRegionConfig: normalizeRegionConfig,
  normalizeCredentials: normalizeCredentials, normalizeNotification: normalizeNotification,
  normalizeSetup: normalizeSetup, apply: apply };

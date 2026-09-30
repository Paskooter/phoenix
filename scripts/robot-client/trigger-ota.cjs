#!/usr/bin/env node
'use strict';

// The stock system-manager owns OTA discovery, downloads, dependency ordering,
// and the rebooting installer. Its loopback /update API works without BE. Keep
// this helper compatible with the robot's Node 6 runtime and never fetch OTA
// packages on the operator's computer or bypass the updater's SHA-1 check.
var crypto = require('crypto');
var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');

var ORDER = ['os', 'services', 'oobe-config', '@be/be'];
// PHOENIX_OTA_QUERY_WRAPPER_V1: the same file briefly replaces the stock
// jibo-get-update entrypoint during a full migration. The stock system-manager
// still sees the real installed versions for dependency checks; only the
// GetUpdateFrom query receives this low fromVersion. Never alter the installed
// OS/services reporters or a skill's package.json to force an offer.
var QUERY_VERSION = '0.0.1';
var queryPath = process.env.PHOENIX_ROBOT_OTA_QUERY_PATH || '/usr/bin/jibo-get-update';
var queryOriginalPath = queryPath + '.phoenix-ota-original';
var queryStatePath = process.env.PHOENIX_ROBOT_OTA_QUERY_STATE_PATH || '/var/lib/phoenix/ota-query-override.json';
var queryAuditPath = queryStatePath + '.audit';
var QUERY_LEASE_MS = 5 * 60 * 1000;
var port = Number(process.env.PHOENIX_ROBOT_OTA_PORT || 8585);
var credentialsPath = process.env.PHOENIX_ROBOT_OTA_CREDENTIALS_PATH || '/var/jibo/credentials.json';
var workStatePath = process.env.PHOENIX_ROBOT_OTA_STATE_PATH || '/var/jibo/ota.json';
var modePath = process.env.PHOENIX_ROBOT_OTA_MODE_PATH || '/var/jibo/mode.json';
var setModeBin = process.env.PHOENIX_ROBOT_OTA_SETMODE_BIN || '/usr/bin/jibo-setmode';
var queryOverrideOwned = false;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('invalid system-manager port');
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}

function unlinkIfPresent(file) {
  if (lstatOrNull(file)) fs.unlinkSync(file);
}

function isQueryWrapper(file) {
  try { return fs.readFileSync(file, 'utf8').indexOf('PHOENIX_OTA_QUERY_WRAPPER_V1') !== -1; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

function rootMountIsReadOnly(mountInfo) {
  // /proc/mounts on Jibo starts with the synthetic, writable "rootfs /"
  // entry even when the real ext4 /dev/root mount is read-only. mountinfo
  // identifies the actual mounted filesystem and its per-mount options.
  var options = null;
  mountInfo.split('\n').forEach(function(line) {
    var fields = line.split(' - ')[0].split(' ');
    if (fields[4] === '/') options = fields[5];
  });
  if (!options) throw new Error('could not determine root mount mode');
  return options.split(',').indexOf('ro') !== -1;
}

function rootIsReadOnly() {
  return rootMountIsReadOnly(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
}

function withWritableQueryPath(fn) {
  // The test override lives in a temporary directory; only the actual robot
  // executable requires a rootfs remount. Always restore the original mode.
  var remount = queryPath === '/usr/bin/jibo-get-update' && rootIsReadOnly();
  if (remount) childProcess.execFileSync('mount', ['-o', 'remount,rw', '/']);
  try { return fn(); }
  finally { if (remount) childProcess.execFileSync('mount', ['-o', 'remount,ro', '/']); }
}

function originalIsStillInstalled() {
  var original = lstatOrNull(queryOriginalPath);
  var current = lstatOrNull(queryPath);
  if (!original || !current) return false;
  if (original.isSymbolicLink() && current.isSymbolicLink()) {
    return fs.readlinkSync(queryOriginalPath) === fs.readlinkSync(queryPath);
  }
  return original.isFile() && current.isFile()
    && original.dev === current.dev && original.ino === current.ino;
}

function restoreQueryOverride() {
  // Fail closed on an interrupted run: remove the lease first, so even if the
  // read-only remount fails, the installed wrapper forwards the true version.
  unlinkIfPresent(queryStatePath);
  if (lstatOrNull(queryOriginalPath)) {
    withWritableQueryPath(function() {
      if (isQueryWrapper(queryPath) || !lstatOrNull(queryPath)) {
        fs.renameSync(queryOriginalPath, queryPath);
      } else if (originalIsStillInstalled()) {
        // Interrupted after making the backup but before swapping in the wrapper.
        fs.unlinkSync(queryOriginalPath);
      } else {
        throw new Error('jibo-get-update changed while the OTA query override was active; original backup preserved');
      }
    });
  } else if (isQueryWrapper(queryPath)) {
    throw new Error('jibo-get-update override has no original backup; inspect the robot before another OTA');
  }
  unlinkIfPresent(queryAuditPath);
  queryOverrideOwned = false;
}

function installQueryOverride() {
  var existingState = lstatOrNull(queryStatePath);
  if (existingState) {
    if (!existingState.isFile() || existingState.isSymbolicLink()) throw new Error('unsafe OTA query lease');
    var active = null;
    try { active = JSON.parse(fs.readFileSync(queryStatePath, 'utf8')); } catch (e) { /* recover stale state */ }
    if (active && Number.isSafeInteger(active.expiresAt) && active.expiresAt > Date.now()
      && processIsAlive(active.pid)) {
      throw new Error('another full-refresh OTA query is active; wait for it to finish');
    }
  }
  restoreQueryOverride(); // recover an interrupted prior attempt first
  var stateDir = path.dirname(queryStatePath);
  var dirStat = lstatOrNull(stateDir);
  if (!dirStat) fs.mkdirSync(stateDir, 0o700);
  else if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('unsafe OTA query state directory');
  var targetStat = lstatOrNull(queryPath);
  if (!targetStat || !(targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new Error('stock jibo-get-update executable is missing or unsafe');
  }
  if (isQueryWrapper(queryPath)) throw new Error('jibo-get-update is already an OTA query wrapper');
  var state = { pid: process.pid, expiresAt: Date.now() + QUERY_LEASE_MS,
    version: QUERY_VERSION, subsystems: ORDER };
  fs.writeFileSync(queryStatePath, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  try {
    fs.writeFileSync(queryAuditPath, '', { mode: 0o600, flag: 'w' });
    withWritableQueryPath(function() {
      var staged = queryPath + '.phoenix-ota-new-' + crypto.randomBytes(6).toString('hex');
      if (targetStat.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(queryPath), queryOriginalPath);
      } else {
        fs.linkSync(queryPath, queryOriginalPath);
      }
      try {
        fs.writeFileSync(staged, fs.readFileSync(__filename), { mode: 0o755, flag: 'wx' });
        fs.chmodSync(staged, 0o755);
        fs.renameSync(staged, queryPath); // atomic switch; original stays intact
      } finally {
        unlinkIfPresent(staged);
      }
    });
    queryOverrideOwned = true;
  } catch (error) {
    try { restoreQueryOverride(); }
    catch (restoreError) { error.message += '; cleanup failed: ' + restoreError.message; }
    throw error;
  }
}

function runQueryWrapper() {
  var args = process.argv.slice(2);
  var subsystemAt = args.indexOf('--subsystem');
  var versionAt = args.indexOf('--version');
  var credentialsAt = args.indexOf('--credentials');
  var state = null;
  try { state = JSON.parse(fs.readFileSync(queryStatePath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') state = null; }
  if (state && state.version === QUERY_VERSION && processIsAlive(state.pid)
    && Number.isSafeInteger(state.expiresAt)
    && Date.now() < state.expiresAt && Array.isArray(state.subsystems)
    && credentialsAt >= 0 && args[credentialsAt + 1] === credentialsPath
    && subsystemAt >= 0 && state.subsystems.indexOf(args[subsystemAt + 1]) !== -1
    && versionAt >= 0 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(args[versionAt + 1] || '')) {
    args[versionAt + 1] = QUERY_VERSION;
    try { fs.appendFileSync(queryAuditPath, args[subsystemAt + 1] + '\n'); }
    catch (e) {
      process.stdout.write(JSON.stringify({ error: { code: 'OTA_OVERRIDE_AUDIT_FAILED', message: 'Could not record OTA query' } }) + '\n');
      process.exit(1);
    }
  }
  var result = childProcess.spawnSync(queryOriginalPath, args, { stdio: 'inherit' });
  if (result.error) {
    process.stdout.write(JSON.stringify({ error: { code: 'OTA_QUERY_FAILED', message: 'Could not execute original OTA query' } }) + '\n');
    process.exit(1);
  }
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

if (path.resolve(__filename) === path.resolve(queryPath)) runQueryWrapper();

function request(method, path, body, onLine, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var data = body === null ? null : JSON.stringify(body);
    var headers = data === null ? {} : {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(data)
    };
    var req = http.request({ hostname: '127.0.0.1', port: port, path: path,
      method: method, headers: headers }, function(res) {
      var text = '';
      var lineBuffer = '';
      var failed = null;
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        if (onLine) {
          lineBuffer += chunk;
          var newline;
          while (!failed && (newline = lineBuffer.indexOf('\n')) >= 0) {
            var line = lineBuffer.slice(0, newline).trim();
            lineBuffer = lineBuffer.slice(newline + 1);
            if (line) {
              try { onLine(line); } catch (e) { failed = e; }
            }
          }
          if (lineBuffer.length > 65536) failed = new Error('OTA progress line is too large');
        } else {
          text += chunk;
          if (text.length > 1048576) failed = new Error('system-manager response is too large');
        }
      });
      res.on('end', function() {
        if (failed) return reject(failed);
        if (onLine && lineBuffer.trim()) {
          try { onLine(lineBuffer.trim()); } catch (e) { return reject(e); }
        }
        if (res.statusCode !== 200) return reject(new Error('system-manager HTTP ' + res.statusCode + ': ' + text.slice(0, 200)));
        if (onLine) return resolve(null);
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error('system-manager returned invalid JSON')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs || 30000, function() { req.abort(); reject(new Error('system-manager request timed out')); });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function ensureIdle() {
  if (!fs.existsSync(credentialsPath)) throw new Error('robot has no credentials; use OOBE instead');
  if (fs.existsSync(workStatePath)) throw new Error('an OTA work state already exists; do not start another update');
}

function requestDiscovery(filter, busyRetries) {
  return request('GET', '/update/' + filter, null, null, 60000).then(function(data) {
    // UpdateManager's timed mutex can briefly reject a concurrent check before
    // it calls jibo-get-update at all. Retry only this explicit transient result,
    // while the query override is still active; all other errors remain fatal.
    if (data && data.error === 'Service temporarily unavailable' && busyRetries < 2) {
      return new Promise(function(resolve) { setTimeout(resolve, 500 * (busyRetries + 1)); })
        .then(function() { return requestDiscovery(filter, busyRetries + 1); });
    }
    return data;
  });
}

function discoverFullRefresh(filter) {
  // UpdateManager.getUpdates() checks the cloud in-line on every GET. Keep the
  // replacement executable installed ONLY for that GET; its cached offers are
  // enough for the subsequent native download and install calls.
  installQueryOverride();
  return requestDiscovery(filter, 0).then(function(data) {
    var seen;
    try {
      var audit = fs.readFileSync(queryAuditPath, 'utf8').trim();
      seen = audit ? audit.split('\n') : [];
    }
    finally { restoreQueryOverride(); }
    // Stock UpdateHandler returns HTTP 200 even for a manager error. It can
    // return before querying *any* subsystem (no credentials, busy manager) or
    // after an earlier query fails. Report that cause, not a misleading "os
    // was not queried" error. Never proceed without the full audited query set.
    if (data && data.error) {
      throw new Error('update discovery failed: ' +
        (typeof data.error === 'string' ? data.error.slice(0, 200) : 'unspecified system-manager error'));
    }
    if (!data || !Array.isArray(data.updates)) {
      throw new Error('system-manager did not return an update list (queries observed: ' +
        (seen.length ? seen.join(', ') : 'none') + ')');
    }
    ORDER.forEach(function(name) {
      if (seen.indexOf(name) === -1) {
        throw new Error('system-manager did not query ' + name +
          ' through the full-refresh override (queries observed: ' +
          (seen.length ? seen.join(', ') : 'none') + '; updates offered: ' + data.updates.length +
          '). Check the robot system-manager log; use --ota-only --dry-run for a read-only catalog preview.');
      }
    });
    return data;
  }, function(error) {
    try { restoreQueryOverride(); }
    catch (cleanup) { error.message += '; OTA query cleanup failed: ' + cleanup.message; }
    throw error;
  });
}

['SIGHUP', 'SIGINT', 'SIGTERM'].forEach(function(signal) {
  process.on(signal, function() {
    if (queryOverrideOwned) {
      try { restoreQueryOverride(); }
      catch (e) { process.stderr.write('OTA query cleanup failed: ' + e.message + '\n'); }
    }
    process.exit(signal === 'SIGINT' ? 130 : 1);
  });
});

function plan(filter) {
  ensureIdle();
  if (!/^[a-z0-9-]{1,30}$/.test(filter)) return Promise.reject(new Error('invalid OTA filter'));
  return discoverFullRefresh(filter).then(function(data) {
    var bySubsystem = {};
    data.updates.forEach(function(update) {
      if (!update || ORDER.indexOf(update.subsystem) === -1) {
        throw new Error('unexpected OTA subsystem; review the catalog before installing');
      }
      if (bySubsystem[update.subsystem]) throw new Error('multiple updates offered for ' + update.subsystem);
      // The server's OTA catalog selects the latest applicable release. Keep
      // the accepted subsystem set and metadata checks, but do not make a new
      // published release require a new copy of this robot-side helper.
      if (typeof update.toVersion !== 'string'
        || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(update.toVersion)
        || !/^[A-Za-z0-9._@-]{1,100}$/.test(update.id)
        || !Number.isSafeInteger(update.length) || update.length < 1) {
        throw new Error('invalid OTA version, ID, or length for ' + update.subsystem);
      }
      if (update.dependencies !== undefined && (update.dependencies === null
        || typeof update.dependencies !== 'object' || Array.isArray(update.dependencies))) {
        throw new Error('invalid OTA dependencies for ' + update.subsystem);
      }
      bySubsystem[update.subsystem] = update;
    });
    ORDER.forEach(function(name) {
      if (!bySubsystem[name]) {
        throw new Error('full refresh requires a published ' + name + ' OTA; no install was started');
      }
    });
    Object.keys(bySubsystem).forEach(function(name) {
      var dependencies = bySubsystem[name].dependencies || {};
      Object.keys(dependencies).forEach(function(requiredName) {
        if (ORDER.indexOf(requiredName) === -1
          || typeof dependencies[requiredName] !== 'string'
          || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(dependencies[requiredName])) {
          throw new Error('invalid OTA dependency for ' + name + ': ' + requiredName);
        }
        if (bySubsystem[requiredName]
          && bySubsystem[requiredName].toVersion !== dependencies[requiredName]) {
          throw new Error('OTA catalog dependency mismatch: ' + name + ' requires '
            + requiredName + ' ' + dependencies[requiredName] + ' but the catalog offers '
            + bySubsystem[requiredName].toVersion);
        }
      });
    });
    var updates = ORDER.filter(function(name) { return bySubsystem[name]; }).map(function(name) {
      var u = bySubsystem[name];
      return { id: u.id, subsystem: u.subsystem, toVersion: u.toVersion,
        length: u.length, dependencies: u.dependencies || {} };
    });
    var hash = crypto.createHash('sha256').update(JSON.stringify(updates)).digest('hex');
    return { updates: updates, hash: hash };
  });
}

function printPlan(result) {
  console.log('Full refresh: replace all four published subsystems with this server\'s current packages.');
  result.updates.forEach(function(u) {
    console.log('  ' + u.subsystem + ' -> ' + u.toVersion + ' (' + Math.ceil(u.length / 1048576) + ' MiB)');
  });
  console.log('PHOENIX_OTA_UPDATE_COUNT=' + result.updates.length);
  console.log('PHOENIX_OTA_PLAN_HASH=' + result.hash);
}

function preview(filter) {
  ensureIdle();
  if (!/^[a-z0-9-]{1,30}$/.test(filter)) throw new Error('invalid OTA filter');
  console.log('Read-only full-refresh preview (no installed robot files changed):');
  ORDER.forEach(function(subsystem) {
    var output = childProcess.execFileSync(queryPath, ['--credentials', credentialsPath,
      '--subsystem', subsystem, '--version', QUERY_VERSION, '--filter', filter],
    { encoding: 'utf8', timeout: 60000 });
    var update = JSON.parse(output);
    if (!update || update.subsystem !== subsystem
      || typeof update.toVersion !== 'string'
      || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(update.toVersion)
      || !Number.isSafeInteger(update.length) || update.length < 1) {
      throw new Error('no valid published ' + subsystem + ' OTA for full refresh');
    }
    console.log('  ' + subsystem + ' -> ' + update.toVersion
      + ' (' + Math.ceil(update.length / 1048576) + ' MiB)');
  });
}

function savedMode() {
  var value = JSON.parse(fs.readFileSync(modePath, 'utf8')).mode;
  if (!/^(identified|oobe|int-developer|developer|certification|normal|service)$/.test(value)) {
    throw new Error('unrecognized saved robot mode');
  }
  return value;
}

function setMode(mode) {
  childProcess.execFileSync(setModeBin, [mode], { timeout: 10000, stdio: 'pipe' });
  if (savedMode() !== mode) throw new Error('could not verify next-boot mode ' + mode);
}

function download(updates) {
  var finished = {};
  var lastBucket = {};
  return request('PUT', '/update/', { ids: updates.map(function(u) { return u.id; }) }, function(line) {
    var progress;
    try { progress = JSON.parse(line); }
    catch (e) { throw new Error('invalid OTA downloader progress'); }
    if (progress.error) throw new Error('OTA download failed: ' + progress.error);
    if (progress.status === 'failed') throw new Error('OTA download failed: ' + (progress.reason || 'unknown error'));
    if (!updates.some(function(u) { return u.id === progress.id; })) {
      throw new Error('progress for an unexpected OTA package');
    }
    if (progress.status === 'finished') {
      finished[progress.id] = true;
      console.log('  downloaded ' + progress.id + ' (checksum verified by robot)');
    } else if (progress.status === 'downloading' && progress.length > 0) {
      var bucket = Math.floor(10 * progress.received / progress.length);
      if (bucket > (lastBucket[progress.id] || 0)) {
        lastBucket[progress.id] = bucket;
        console.log('  ' + progress.id + ': ' + Math.min(100, bucket * 10) + '%');
      }
    }
  }, 1800000).then(function() {
    updates.forEach(function(u) {
      if (!finished[u.id]) throw new Error('download did not finish for ' + u.id);
    });
  });
}

function main() {
  var mode = process.argv[2];
  var expectedHash = process.argv[3];
  var filter = (mode === '--plan' || mode === '--preview' ? process.argv[3] : process.argv[4]) || 'fcs';
  if (mode !== '--plan' && mode !== '--apply' && mode !== '--preview') {
    throw new Error('use --preview, --plan, or --apply <plan-hash> [filter]');
  }
  if (mode === '--apply' && !/^[a-f0-9]{64}$/.test(expectedHash || '')) throw new Error('a plan hash is required to apply');
  if (mode === '--preview') { preview(filter); return Promise.resolve(); }
  return plan(filter).then(function(result) {
    printPlan(result);
    if (mode === '--plan' || !result.updates.length) return;
    if (result.hash !== expectedHash) throw new Error('OTA catalog changed since the plan; run the plan again');
    console.log('Downloading through the robot system-manager...');
    return download(result.updates).then(function() {
      // jibo-setmode only writes /var/jibo/mode.json; the running services keep
      // their current mode. Do this AFTER every package checksum succeeds and
      // immediately BEFORE the native installer queues its reboot. A paired
      // USB-flashed robot without BE must never boot normal before its BE OTA.
      var previousMode = savedMode();
      if (previousMode !== 'normal') {
        setMode('normal');
        console.log('Next-boot mode set to normal (was ' + previousMode + ').');
      }
      console.log('Downloads verified. Starting the native OTA installer; the robot will reboot.');
      return request('POST', '/update/', { ids: result.updates.map(function(u) { return u.id; }) }, null, 60000)
        .then(function(response) {
          if (response.error) {
            if (previousMode !== 'normal') setMode(previousMode);
            throw new Error('native OTA installer rejected the request: ' + response.error);
          }
          console.log('Native OTA accepted. Wait for the robot to finish installing and reconnect.');
        }, function(error) {
          // A disconnected POST is ambiguous: it may mean the installer already
          // rebooted. Restore only when no OTA work state was created.
          if (previousMode !== 'normal' && !fs.existsSync(workStatePath)) setMode(previousMode);
          throw error;
        });
    });
  });
}

if (require.main === module) {
  main().catch(function(error) {
    console.error('OTA not confirmed: ' + error.message);
    process.exitCode = 1;
  });
} else {
  module.exports = { rootMountIsReadOnly: rootMountIsReadOnly };
}

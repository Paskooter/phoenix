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

var ORDER = ['os', 'services', 'oobe-config', '@be/be'];
var port = Number(process.env.PHOENIX_ROBOT_OTA_PORT || 8585);
var credentialsPath = process.env.PHOENIX_ROBOT_OTA_CREDENTIALS_PATH || '/var/jibo/credentials.json';
var workStatePath = process.env.PHOENIX_ROBOT_OTA_STATE_PATH || '/var/jibo/ota.json';
var bePath = process.env.PHOENIX_ROBOT_OTA_BE_PATH || '/opt/jibo/Jibo/Skills/@be/be';
var modePath = process.env.PHOENIX_ROBOT_OTA_MODE_PATH || '/var/jibo/mode.json';
var setModeBin = process.env.PHOENIX_ROBOT_OTA_SETMODE_BIN || '/usr/bin/jibo-setmode';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('invalid system-manager port');
}

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

function plan(filter) {
  ensureIdle();
  if (!/^[a-z0-9-]{1,30}$/.test(filter)) return Promise.reject(new Error('invalid OTA filter'));
  return request('GET', '/update/' + filter, null, null, 60000).then(function(data) {
    if (!data || !Array.isArray(data.updates)) throw new Error('system-manager did not return an update list');
    if (data.error) throw new Error('update discovery failed: ' + data.error);
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
    if (!fs.existsSync(bePath) && !bySubsystem['@be/be']) {
      throw new Error('BE is absent but the server offered no BE update');
    }
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
  if (!result.updates.length) console.log('No updates offered; this robot is already current.');
  result.updates.forEach(function(u) {
    console.log('  ' + u.subsystem + ' -> ' + u.toVersion + ' (' + Math.ceil(u.length / 1048576) + ' MiB)');
  });
  console.log('PHOENIX_OTA_UPDATE_COUNT=' + result.updates.length);
  console.log('PHOENIX_OTA_PLAN_HASH=' + result.hash);
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
  var filter = (mode === '--plan' ? process.argv[3] : process.argv[4]) || 'fcs';
  if (mode !== '--plan' && mode !== '--apply') throw new Error('use --plan or --apply <plan-hash> [filter]');
  if (mode === '--apply' && !/^[a-f0-9]{64}$/.test(expectedHash || '')) throw new Error('a plan hash is required to apply');
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

main().catch(function(error) {
  console.error('OTA not confirmed: ' + error.message);
  process.exitCode = 1;
});

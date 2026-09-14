#!/usr/bin/env node

/**
 * Collect the provenance needed by the S-13 physical capture review.
 *
 * The remote side is one root SSH session running a read-only Node program.
 * It emits hashes and carefully selected metadata, never file contents.  The
 * local side hashes the complete SSH stdout/stderr byte streams, validates the
 * bounded result, and publishes one private receipt atomically.
 *
 * Usage:
 *   node scripts/parity-s13-provenance/collect.mjs \
 *     --host 192.0.2.10 --slot phoenix-be-11-0-1-parity --out /private/before.json
 *
 * An existing receipt can be compared without SSH:
 *   node .../collect.mjs --before before.json --after after.json --out comparison.json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'phoenix-s13-provenance-v1';
const REMOTE_PROTOCOL = 'phoenix-s13-provenance-remote-v1';
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_FILES = 8192;
const MAX_SOURCE_MANIFEST_FILES = 4096;
const MAX_REMOTE_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(`S-13 provenance: ${message}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return JSON.stringify(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing`);
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail(`${label} is not a SHA-256 digest`);
  return value;
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} is missing`);
  return value;
}

function safeSlot(value) {
  const raw = requireString(value, 'slot');
  // A slot is a directory name.  Keeping it to this grammar also makes the
  // remote shell program independent of shell quoting and path traversal.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw)) {
    fail('slot must be a single safe directory name');
  }
  return raw;
}

function safeHost(value) {
  const raw = requireString(value, 'host');
  if (raw.startsWith('-') || /[\0\r\n\t ]/.test(raw)) fail('host contains whitespace or an option prefix');
  // The target is passed as one argv item.  Accept DNS names, IPv4/IPv6
  // literals, and an already-qualified root@host target without accepting
  // arbitrary ssh options.
  if (!/^(?:root@)?[A-Za-z0-9_.:%[\]-]+$/.test(raw)) fail('host contains unsupported characters');
  return raw.startsWith('root@') ? raw.slice(5) : raw;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function outputPath(value) {
  const raw = requireString(value, 'output');
  if (raw === '-' || raw.endsWith(path.sep)) fail('output must be a JSON file path');
  return path.resolve(raw);
}

function lstatIfPresent(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function regularLocalFile(file, label) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) fail(`${label} is a symlink`);
  if (!stat.isFile()) fail(`${label} is not a regular file`);
  if (fs.realpathSync(absolute) !== absolute) fail(`${label} has a symlinked ancestor`);
  return absolute;
}

function readJsonFile(file, label) {
  const absolute = regularLocalFile(file, label);
  let value;
  const bytes = fs.readFileSync(absolute);
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  return { value, bytes, sha256: sha256(bytes) };
}

function hashPair(stdout, stderr) {
  const combined = Buffer.concat([stdout, Buffer.from([0]), stderr]);
  return {
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    combinedSha256: sha256(combined),
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length
  };
}

function validateRawCommand(command, index) {
  requireObject(command, `remote.commands[${index}]`);
  requireString(command.id || command.label, `remote.commands[${index}].id`);
  requireHash(command.stdoutSha256 || command.rawOutputSha256, `remote.commands[${index}].stdoutSha256`);
  if (command.stderrSha256 !== undefined) requireHash(command.stderrSha256, `remote.commands[${index}].stderrSha256`);
  if (command.combinedSha256 !== undefined) requireHash(command.combinedSha256, `remote.commands[${index}].combinedSha256`);
  if (command.stdoutBytes !== undefined && (!Number.isSafeInteger(command.stdoutBytes) || command.stdoutBytes < 0)) {
    fail(`remote.commands[${index}].stdoutBytes is invalid`);
  }
  if (command.stderrBytes !== undefined && (!Number.isSafeInteger(command.stderrBytes) || command.stderrBytes < 0)) {
    fail(`remote.commands[${index}].stderrBytes is invalid`);
  }
}

function validateManifest(manifest, label, maxFiles) {
  requireObject(manifest, label);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail(`${label}.files is missing`);
  if (manifest.files.length > maxFiles) fail(`${label}.files exceeds the bounded limit`);
  const seen = new Set();
  let previous = null;
  for (const [index, row] of manifest.files.entries()) {
    requireObject(row, `${label}.files[${index}]`);
    const relative = requireString(row.path, `${label}.files[${index}].path`);
    if (relative.startsWith('/') || relative.includes('\\') || relative === '..' || relative.startsWith('../')) {
      fail(`${label} contains an unsafe relative path`);
    }
    if (seen.has(relative)) fail(`${label} contains a duplicate path: ${relative}`);
    if (previous !== null && Buffer.from(previous).compare(Buffer.from(relative)) >= 0) {
      fail(`${label} is not sorted by relative path`);
    }
    previous = relative;
    seen.add(relative);
    requireHash(row.sha256, `${label}.files[${index}].sha256`);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_FILE_BYTES) {
      fail(`${label}.files[${index}].bytes is invalid`);
    }
  }
  requireHash(manifest.sha256 || manifest.manifestSha256, `${label}.sha256`);
  const digest = sha256(canonical(manifest.files));
  if ((manifest.sha256 || manifest.manifestSha256) !== digest) fail(`${label}.sha256 does not bind its rows`);
  return manifest;
}

function validatePackageInfo(packageInfo, label, expectedName, expectedVersion) {
  requireObject(packageInfo, label);
  if (expectedName && packageInfo.name !== expectedName) fail(`${label}.name is ${JSON.stringify(packageInfo.name)}, expected ${expectedName}`);
  requireString(packageInfo.name, `${label}.name`);
  if (expectedVersion && packageInfo.version !== expectedVersion) fail(`${label}.version is ${JSON.stringify(packageInfo.version)}, expected ${expectedVersion}`);
  requireString(packageInfo.version, `${label}.version`);
  requireHash(packageInfo.sha256 || packageInfo.packageSha256, `${label}.sha256`);
  requireString(packageInfo.path, `${label}.path`);
  if (packageInfo.bytes !== undefined && (!Number.isSafeInteger(packageInfo.bytes) || packageInfo.bytes <= 0)) fail(`${label}.bytes is invalid`);
  return packageInfo;
}

function validateArtifact(artifact, label) {
  requireObject(artifact, label);
  requireString(artifact.path, `${label}.path`);
  requireHash(artifact.sha256, `${label}.sha256`);
  if (artifact.bytes !== undefined && (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0)) fail(`${label}.bytes is invalid`);
  return artifact;
}

function validateTimestamp(value, label) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/.test(value)) fail(`${label} has an invalid timestamp`);
}

function validateRemotePayload(remote, slot) {
  requireObject(remote, 'remote response');
  if (remote.protocol !== REMOTE_PROTOCOL) fail(`unsupported remote protocol ${JSON.stringify(remote.protocol)}`);
  if (remote.ok !== true) fail('remote collector did not report success');
  const payload = requireObject(remote.payload, 'remote.payload');

  const root = requireObject(payload.root, 'remote.payload.root');
  requireString(root.slot, 'remote.payload.root.slot');
  if (root.slot !== slot) fail(`remote slot ${root.slot} does not match requested slot ${slot}`);
  requireString(root.path, 'remote.payload.root.path');

  requireObject(payload.timestamps, 'remote.payload.timestamps');
  validateTimestamp(payload.timestamps.utcStarted, 'remote.payload.timestamps.utcStarted');
  validateTimestamp(payload.timestamps.utcEnded, 'remote.payload.timestamps.utcEnded');
  validateTimestamp(payload.timestamps.localStarted, 'remote.payload.timestamps.localStarted');
  validateTimestamp(payload.timestamps.localEnded, 'remote.payload.timestamps.localEnded');
  const timezone = requireObject(payload.timestamps.timezone, 'remote.payload.timestamps.timezone');
  requireString(timezone.name, 'remote.payload.timestamps.timezone.name');
  requireString(timezone.source, 'remote.payload.timestamps.timezone.source');
  if (timezone.sourceSha256) requireHash(timezone.sourceSha256, 'remote.payload.timestamps.timezone.sourceSha256');

  const electron = requireObject(payload.electron, 'remote.payload.electron');
  const processInfo = requireObject(electron.process, 'remote.payload.electron.process');
  if (!Number.isInteger(processInfo.pid) || processInfo.pid <= 0) fail('active Electron PID is invalid');
  if (!Array.isArray(processInfo.argv) || processInfo.argv.length === 0) fail('active Electron argv is missing');
  processInfo.argv.forEach((arg, index) => requireString(arg, `active Electron argv[${index}]`));
  const argvSha256 = requireHash(processInfo.argvSha256, 'active Electron argvSha256');
  if (argvSha256 !== sha256(Buffer.from(canonical(processInfo.argv)))) {
    fail('active Electron argvSha256 does not bind the recorded argv');
  }
  requireString(processInfo.cwd, 'active Electron cwd');
  if (processInfo.candidateCount !== 1) fail('active Electron process is missing or ambiguous');
  if (processInfo.associatedProcessCount !== undefined
    && (!Number.isInteger(processInfo.associatedProcessCount) || processInfo.associatedProcessCount < processInfo.candidateCount)) {
    fail('associated Electron process count is invalid');
  }
  const page = requireObject(electron.page, 'remote.payload.electron.page');
  requireString(page.url, 'loaded Electron page URL');
  if (page.slot !== slot) fail(`loaded Electron page slot does not match ${slot}`);
  if (!page.url.endsWith(`/${slot}/index.html`)) fail('loaded Electron page URL does not bind the requested slot');
  requireString(page.type, 'loaded Electron page type');
  requireHash(page.jsonSha256 || page.pageJsonSha256, 'loaded Electron page JSON hash');

  const be = requireObject(payload.be, 'remote.payload.be');
  validatePackageInfo(be.package, 'remote.payload.be.package');
  if (!be.package.name.startsWith('@be/')) fail('remote.payload.be.package.name must use the @be namespace');
  validateArtifact(be.index, 'remote.payload.be.index');
  validateManifest(be.manifest, 'remote.payload.be.manifest', MAX_SOURCE_MANIFEST_FILES);

  const client = payload.jetstreamClient || payload.client;
  validatePackageInfo(client?.package, 'remote.payload.jetstreamClient.package', '@jibo/jetstream-client');
  validateArtifact(client.main, 'remote.payload.jetstreamClient.main');

  const nimbus = requireObject(payload.nimbus, 'remote.payload.nimbus');
  validatePackageInfo(nimbus.package, 'remote.payload.nimbus.package', '@be/nimbus');
  validateArtifact(nimbus.index, 'remote.payload.nimbus.index');
  validateManifest(nimbus.assets, 'remote.payload.nimbus.assets', MAX_MANIFEST_FILES);

  const ssm = requireObject(payload.ssm, 'remote.payload.ssm');
  validatePackageInfo(ssm.package, 'remote.payload.ssm.package', undefined, '16.0.0');
  validateArtifact(ssm.main, 'remote.payload.ssm.main');
  validateArtifact(ssm.skillMain, 'remote.payload.ssm.skillMain');

  const firmware = requireObject(payload.firmware, 'remote.payload.firmware');
  requireString(firmware.release, 'remote.payload.firmware.release');
  if (!/^\d+\.\d+\.\d+(?:\s+[A-Za-z0-9._-]+)*$/.test(firmware.release)) fail('firmware release has an invalid shape');
  requireString(firmware.source, 'remote.payload.firmware.source');
  if (firmware.rawOutputSha256) requireHash(firmware.rawOutputSha256, 'firmware.rawOutputSha256');

  const identity = requireObject(payload.identity, 'remote.payload.identity');
  requireString(identity.hostnameSha256, 'remote.payload.identity.hostnameSha256');
  requireHash(identity.hostnameSha256, 'remote.payload.identity.hostnameSha256');
  if (identity.credentialsSha256) requireHash(identity.credentialsSha256, 'remote.payload.identity.credentialsSha256');
  if (identity.robotIdSha256) requireHash(identity.robotIdSha256, 'remote.payload.identity.robotIdSha256');
  if (identity.robotIdSource) requireString(identity.robotIdSource, 'remote.payload.identity.robotIdSource');

  const raw = requireObject(payload.raw, 'remote.payload.raw');
  const ssh = requireObject(raw.ssh || {}, 'remote.payload.raw.ssh');
  if (ssh.stdoutSha256) requireHash(ssh.stdoutSha256, 'remote.payload.raw.ssh.stdoutSha256');
  if (ssh.stderrSha256) requireHash(ssh.stderrSha256, 'remote.payload.raw.ssh.stderrSha256');
  if (ssh.combinedSha256) requireHash(ssh.combinedSha256, 'remote.payload.raw.ssh.combinedSha256');
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) fail('remote command records are missing');
  raw.commands.forEach(validateRawCommand);

  return payload;
}

function parseRemoteFrame(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.length === 0) fail('SSH returned no stdout');
  if (stdout.length > MAX_REMOTE_FRAME_BYTES) fail('SSH stdout exceeds the bounded frame size');
  const text = stdout.toString('utf8');
  if (!text.endsWith('\n')) fail('remote protocol frame is missing its final newline');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 1 || !lines[0].startsWith('S13P1\t')) fail('SSH stdout contains an unexpected or ambiguous frame');
  let remote;
  try { remote = JSON.parse(lines[0].slice('S13P1\t'.length)); } catch (error) {
    fail(`remote protocol JSON is invalid: ${error.message}`);
  }
  return remote;
}

function buildRemoteScript(slot) {
  const script = String.raw`#!/bin/sh
set -eu
SLOT=__S13_SLOT__
export S13_SLOT="$SLOT"
# Node 6 on Moth does not recognize the modern node-dash stdin marker. With
# no script argument Node reads the here-document from stdin on both Node 6
# and current supported runtimes.
exec node <<'__S13_NODE__'
/* This program intentionally uses Node 6-compatible syntax: the stock robot
 * runtime is old, while the collector itself runs on the review host. */
var fs = require('fs');
var path = require('path');
var nodeCrypto = require('crypto');
var child = require('child_process');

var PROTOCOL = 'phoenix-s13-provenance-remote-v1';
var SLOT = process.env.S13_SLOT;
var SLOT_ROOT = '/opt/jibo/Jibo/Skills/' + SLOT;
var SSM_ROOT = '/usr/local/bin/jibo-ssm';
var MAX_FILE_BYTES = 64 * 1024 * 1024;
var MAX_MANIFEST_FILES = 8192;
var MAX_SOURCE_FILES = 4096;
var commands = [];
var files = [];
var fileByPath = {};

function die(message) {
  process.stderr.write('S13 provenance remote failure: ' + message + '\n');
  process.exit(1);
}
function digest(bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}
function json(value) { return JSON.stringify(value); }
function text(bytes) { return Buffer.from(bytes).toString('utf8'); }
function trim(value) { return String(value).replace(/^\s+|\s+$/g, ''); }
function isMissing(error) { return error && error.code === 'ENOENT'; }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }

function commandRecord(id, argv, stdout, stderr, status) {
  var joined = Buffer.concat([stdout, Buffer.from([0]), stderr]);
  var row = {
    id: id,
    argv: argv,
    stdoutSha256: digest(stdout),
    stderrSha256: digest(stderr),
    combinedSha256: digest(joined),
    rawOutputSha256: digest(stdout),
    stdoutBytes: stdout.length,
    stderrBytes: stderr.length,
    exitCode: status === null || status === undefined ? -1 : status,
  };
  commands.push(row);
  return row;
}

function run(id, executable, argv) {
  var result = child.spawnSync(executable, argv, { encoding: null });
  var stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
  var stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || '');
  var status = result.status;
  var record = commandRecord(id, [executable].concat(argv), stdout, stderr, status);
  if (result.error) die(id + ': ' + result.error.message);
  if (status !== 0) die(id + ' exited ' + status);
  return { bytes: stdout, text: text(stdout), record: record };
}

function regular(file, label, allowSymlink) {
  var stat;
  try { stat = fs.lstatSync(file); } catch (error) { die(label + ': ' + error.message); }
  if (stat.isSymbolicLink()) {
    if (!allowSymlink) die(label + ' is a symlink');
    try { stat = fs.statSync(file); } catch (error) { die(label + ': cannot resolve symlink: ' + error.message); }
  }
  if (!stat.isFile()) die(label + ' is not a regular file');
  if (stat.size > MAX_FILE_BYTES) die(label + ' exceeds the bounded file size');
  if (!allowSymlink && fs.realpathSync(file) !== file) die(label + ' has a symlinked ancestor');
  return stat;
}

function fileBytes(file, label, options) {
  options = options || {};
  regular(file, label, Boolean(options.allowSymlink));
  var bytes = fs.readFileSync(file);
  var row = {
    path: file,
    bytes: bytes.length,
    sha256: digest(bytes),
  };
  if (options.record !== false) {
    commandRecord(options.id || 'file:' + label, ['read', file], bytes, Buffer.alloc(0), 0);
  }
  return { bytes: bytes, row: row };
}

function addFile(file, label, options) {
  options = options || {};
  if (fileByPath[file]) return fileByPath[file];
  var value = fileBytes(file, label, options);
  var row = { path: file, bytes: value.bytes.length, sha256: value.row.sha256, component: options.component || label };
  fileByPath[file] = row;
  files.push(row);
  return row;
}

function safeChild(root, childPath, label) {
  var absolute = path.resolve(root, childPath);
  if (absolute !== root && absolute.indexOf(root + path.sep) !== 0) die(label + ' escapes package root');
  return absolute;
}

function packageInfo(root, expectedName, label) {
  if (!exists(root)) die(label + ' root is missing: ' + root);
  regular(root + '/package.json', label + ' package.json', false);
  var packageFile = addFile(root + '/package.json', label + '.package.json', { component: label + '.package' });
  var parsed;
  try { parsed = JSON.parse(text(fs.readFileSync(root + '/package.json'))); } catch (error) { die(label + ' package.json is invalid: ' + error.message); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) die(label + ' package.json is not an object');
  if (typeof parsed.name !== 'string' || !parsed.name) die(label + ' package name is missing');
  if (expectedName && parsed.name !== expectedName) die(label + ' package name is ' + parsed.name + ', expected ' + expectedName);
  if (typeof parsed.version !== 'string' || !parsed.version) die(label + ' package version is missing');
  if (typeof parsed.main !== 'string' || !parsed.main) die(label + ' package main is missing');
  var mainPath = safeChild(root, parsed.main, label + ' main');
  regular(mainPath, label + ' main', false);
  var mainFile = addFile(mainPath, label + '.main', { component: label + '.main' });
  return {
    root: root,
    path: root + '/package.json',
    name: parsed.name,
    version: parsed.version,
    sha256: packageFile.sha256,
    bytes: packageFile.bytes,
    main: parsed.main,
    mainArtifact: { path: mainPath, sha256: mainFile.sha256, bytes: mainFile.bytes },
    parsed: parsed,
  };
}

function rootIndex(root, label) {
  var indexPath = root + '/index.js';
  regular(indexPath, label + ' index.js', false);
  var row = addFile(indexPath, label + '.index', { component: label + '.index' });
  return { path: indexPath, sha256: row.sha256, bytes: row.bytes };
}

function walk(root, relative, rows, maxFiles, total) {
  var directory = relative ? path.join(root, relative) : root;
  var names;
  try { names = fs.readdirSync(directory).sort(); } catch (error) { die('cannot read ' + directory + ': ' + error.message); }
  names.forEach(function (name) {
    if (rows.length >= maxFiles) die('manifest exceeds its bounded file count');
    var rel = relative ? path.join(relative, name) : name;
    var file = path.join(root, rel);
    var stat;
    try { stat = fs.lstatSync(file); } catch (error) { die('cannot stat ' + file + ': ' + error.message); }
    if (stat.isSymbolicLink()) die('manifest path is a symlink: ' + rel);
    if (stat.isDirectory()) {
      walk(root, rel, rows, maxFiles, total);
    } else if (stat.isFile()) {
      if (stat.size > MAX_FILE_BYTES) die('manifest file exceeds bound: ' + rel);
      var row = addFile(file, 'manifest:' + rel, { component: 'manifest' });
      rows.push({ path: rel.split(path.sep).join('/'), bytes: row.bytes, sha256: row.sha256 });
      total.bytes += row.bytes;
      if (total.bytes > 128 * 1024 * 1024) die('manifest exceeds its bounded byte count');
    } else {
      die('manifest contains a non-file entry: ' + rel);
    }
  });
}

function manifest(root, directories, explicit, maxFiles, label) {
  var rows = [];
  var total = { bytes: 0 };
  explicit.forEach(function (name) {
    var file = safeChild(root, name, label);
    if (!exists(file)) die(label + ' missing required file: ' + name);
    var row = addFile(file, 'manifest:' + name, { component: label });
    rows.push({ path: name, bytes: row.bytes, sha256: row.sha256 });
    total.bytes += row.bytes;
  });
  directories.forEach(function (name) {
    var directory = safeChild(root, name, label);
    if (!exists(directory)) die(label + ' missing required directory: ' + name);
    walk(root, name, rows, maxFiles, total);
  });
  rows.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
  var unique = {};
  rows.forEach(function (row) { if (unique[row.path]) die(label + ' duplicate path: ' + row.path); unique[row.path] = true; });
  return {
    files: rows,
    sha256: digest(Buffer.from(json(rows))),
    count: rows.length,
    bytes: total.bytes,
    ordering: 'relative UTF-8 path ascending; byte count and SHA-256 per file',
  };
}

function presentDirectories(root, names, label) {
  return names.filter(function (name) {
    return exists(safeChild(root, name, label));
  });
}

function parseJson(bytes, label) {
  try { return JSON.parse(text(bytes)); } catch (error) { die(label + ' is not JSON: ' + error.message); }
}

function pageForSlot(raw, slot) {
  var pages = parseJson(raw.bytes, 'CDP page list');
  if (!Array.isArray(pages)) die('CDP page list is not an array');
  var suffix = '/' + slot + '/index.html';
  var matches = pages.filter(function (page) {
    return page && page.type === 'page' && typeof page.url === 'string' && page.url.slice(-suffix.length) === suffix;
  });
  if (matches.length !== 1) die('expected exactly one loaded Electron page for ' + slot + ', found ' + matches.length);
  return {
    url: matches[0].url,
    slot: slot,
    type: matches[0].type,
    jsonSha256: digest(raw.bytes),
    pageCount: pages.length,
  };
}

function processInfo(slot) {
  var entries;
  try { entries = fs.readdirSync('/proc').filter(function (name) { return /^[0-9]+$/.test(name); }); } catch (error) { die('cannot enumerate /proc: ' + error.message); }
  var slotElectron = [];
  entries.forEach(function (pid) {
    var cmdFile = '/proc/' + pid + '/cmdline';
    var bytes;
    try { bytes = fs.readFileSync(cmdFile); } catch (error) { return; }
    var argv = text(bytes).split('\0').filter(function (arg) { return arg.length > 0; });
    if (!argv.length) return;
    var joined = argv.join(' ');
    var electron = argv.some(function (arg) { return /(?:^|\/)electron(?:$|\s)/i.test(arg); }) || /(^|[\s/])electron(?:\s|$)/i.test(joined) || argv.some(function (arg) { return arg === '--type=renderer'; });
    if (!electron) return;
    var cwd = null;
    try { cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (error) { /* process can exit during the read */ }
    var row = { pid: Number(pid), argv: argv, cwd: cwd };
    if ((cwd && cwd === SLOT_ROOT) || joined.indexOf(SLOT_ROOT) !== -1 || joined.indexOf('/' + slot + '/index.html') !== -1) slotElectron.push(row);
  });
  // One Electron application normally has renderer, GPU, and zygote children
  // with the same cwd. The loaded page is the unambiguous browser/main process:
  // it names this slot's index.html and has no Chromium --type role.
  var pageSuffix = '/' + slot + '/index.html';
  var primary = slotElectron.filter(function (row) {
    var joined = row.argv.join(' ');
    return joined.indexOf(pageSuffix) !== -1 && !/(^|\s)--type=/.test(joined);
  });
  if (primary.length !== 1) die('expected exactly one active Electron main process for ' + slot + ', found ' + primary.length);
  var selected = primary[0];
  return {
    pid: selected.pid,
    argv: selected.argv,
    argvSha256: digest(Buffer.from(json(selected.argv))),
    cwd: selected.cwd || '',
    candidateCount: primary.length,
    associatedProcessCount: slotElectron.length,
  };
}

function timezoneInfo(local) {
  var source = null;
  var sourceSha256 = null;
  var sourceBytes = null;
  if (exists('/etc/timezone')) {
    // Embedded Linux images commonly expose this conventional text file as a
    // symlink. Its resolved bytes are still recorded and hashed as the
    // timezone source, just as for /etc/localtime below.
    var timezoneFile = fileBytes('/etc/timezone', 'timezone', { allowSymlink: true });
    source = trim(text(timezoneFile.bytes));
    sourceSha256 = timezoneFile.row.sha256;
    sourceBytes = timezoneFile.bytes.length;
  }
  if (!source && exists('/etc/localtime')) {
    var target = null;
    try { target = fs.readlinkSync('/etc/localtime'); } catch (error) { target = null; }
    var real = null;
    try { real = fs.realpathSync('/etc/localtime'); } catch (error) { die('cannot resolve /etc/localtime: ' + error.message); }
    source = target || real;
    var localtime = fileBytes('/etc/localtime', 'localtime', { allowSymlink: true });
    sourceSha256 = localtime.row.sha256;
    sourceBytes = localtime.bytes.length;
    commandRecord('timezone-localtime-target', ['readlink', '/etc/localtime'], Buffer.from(target || real), Buffer.alloc(0), 0);
  }
  if (!source) die('no timezone source (/etc/timezone or /etc/localtime)');
  return { name: trim(local), source: source, sourceSha256: sourceSha256, sourceBytes: sourceBytes };
}

function canonicalRegularFile(file) {
  try {
    var stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file;
  } catch (error) {
    return false;
  }
}

function firmwareInfo() {
  var candidates = [
    '/var/jibo/context.json', '/var/jibo/general.json', '/var/jibo/firmware.json',
    '/var/jibo/version.json', '/etc/jibo-release', '/etc/firmware-release',
    '/var/jibo/runtime/context.json', '/var/jibo/runtime/general.json',
    '/var/jibo/state/context.json', '/var/jibo/state/general.json',
    '/run/jibo/context.json', '/tmp/context.json',
    '/usr/share/jibo/release', '/usr/share/jibo/version', '/tmp/messages',
    '/var/log/messages', '/var/log/syslog', '/var/log/jibo/messages'
  ];
  var found = [];
  var releasePattern = /^\d+\.\d+\.\d+(?:\s+[A-Za-z0-9._-]+)*$/;
  function add(release, source, rawOutputSha256) {
    var normalized = trim(release);
    if (releasePattern.test(normalized)) found.push({ release: normalized, source: source, rawOutputSha256: rawOutputSha256 });
  }
  function visit(value, source, rawOutputSha256, depth) {
    if (depth > 16 || value === null || value === undefined) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      value.forEach(function (entry) { visit(entry, source, rawOutputSha256, depth + 1); });
      return;
    }
    if (typeof value !== 'object') return;
    Object.keys(value).forEach(function (key) {
      var child = value[key];
      var normalizedKey = String(key).toLowerCase();
      if (typeof child === 'string' && (normalizedKey === 'release' || normalizedKey === 'firmwarerelease' || normalizedKey === 'firmwareversion')) {
        add(child, source + '#' + key, rawOutputSha256);
      }
      visit(child, source, rawOutputSha256, depth + 1);
    });
  }
  candidates.forEach(function (file) {
    // Candidate logs can live under a redirected /var/log on appliance
    // images. Do not follow that topology while collecting a trusted release;
    // skip it and fail closed below if no canonical release source remains.
    if (!canonicalRegularFile(file)) return;
    var value = fileBytes(file, 'firmware:' + file, { record: true });
    var raw = text(value.bytes);
    var match;
    var re = /release[\s:=]+["']?([0-9]+\.[0-9]+\.[0-9]+(?:\s+[A-Za-z0-9._-]+)*)["']?/gi;
    while ((match = re.exec(raw))) add(match[1], file, value.row.sha256);
    if (/\.json$/.test(file)) {
      var parsed;
      try { parsed = JSON.parse(raw); } catch (error) { parsed = null; }
      visit(parsed, file, value.row.sha256, 0);
    }
    if (/\/(?:jibo-release|firmware-release|release|version)$/.test(file)) {
      add(raw, file, value.row.sha256);
    }
  });
  var distinct = {};
  found.forEach(function (row) { distinct[row.release] = true; });
  var releases = Object.keys(distinct);
  if (releases.length !== 1) die('firmware release is missing or ambiguous (' + releases.length + ' candidates)');
  var chosen = found.filter(function (row) { return row.release === releases[0]; })[0];
  return chosen;
}

function identityInfo() {
  var host = run('robot-hostname', 'hostname', []);
  var hostname = trim(host.text);
  if (!hostname) die('robot hostname is empty');
  var result = { hostnameSha256: digest(Buffer.from(hostname)) };
  var credential = '/var/jibo/credentials.json';
  if (exists(credential)) {
    var value = fileBytes(credential, 'robot-credentials', { record: true });
    result.credentialsSha256 = value.row.sha256;
    var parsed = null;
    try { parsed = JSON.parse(text(value.bytes)); } catch (error) { parsed = null; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      var keys = ['robotID', 'robotId', 'robot_id', 'deviceID', 'deviceId', 'uuid'];
      for (var i = 0; i < keys.length; i += 1) {
        if (parsed[keys[i]] !== undefined && parsed[keys[i]] !== null) {
          result.robotIdSha256 = digest(Buffer.from(String(parsed[keys[i]])));
          result.robotIdSource = credential + '#' + keys[i];
          break;
        }
      }
    }
  }
  return result;
}

function ssmSkillMain(pkg) {
  var candidates = [];
  function add(candidate) {
    if (!candidate || !exists(candidate)) return;
    try { regular(candidate, 'SSM skill-main', false); } catch (error) { return; }
    if (candidates.indexOf(candidate) === -1) candidates.push(candidate);
  }
  var bin = pkg.bin;
  if (typeof bin === 'string') add(safeChild(SSM_ROOT, bin, 'SSM bin'));
  else if (bin && typeof bin === 'object') Object.keys(bin).forEach(function (key) {
    if (/skill[-_]?main/i.test(key) || /skill[-_]?main/i.test(String(bin[key]))) add(safeChild(SSM_ROOT, String(bin[key]), 'SSM bin'));
  });
  function scan(directory, depth) {
    if (depth > 5 || !exists(directory)) return;
    var names;
    try { names = fs.readdirSync(directory).sort(); } catch (error) { die('cannot scan SSM: ' + error.message); }
    names.forEach(function (name) {
      if (name === 'node_modules') return;
      var candidate = path.join(directory, name);
      var stat;
      try { stat = fs.lstatSync(candidate); } catch (error) { die('cannot stat SSM path: ' + candidate); }
      if (stat.isSymbolicLink()) die('SSM path is a symlink: ' + candidate);
      if (stat.isDirectory()) scan(candidate, depth + 1);
      else if (stat.isFile() && /^skill[-_]?main(?:\.js)?$/i.test(name)) add(candidate);
    });
  }
  scan(SSM_ROOT, 0);
  if (candidates.length !== 1) die('expected exactly one SSM skill-main file, found ' + candidates.length);
  return candidates[0];
}

function main() {
  if (trim(run('effective-uid', 'id', ['-u']).text) !== '0') die('remote session is not root');
  var utcStarted = trim(run('timestamp-utc-start', 'date', ['-u', '+%Y-%m-%dT%H:%M:%S%z']).text);
  var localStartedRaw = trim(run('timestamp-local-start', 'date', ['+%Y-%m-%dT%H:%M:%S%z %Z']).text);
  var localStartedParts = localStartedRaw.split(/\s+/);
  var timezone = timezoneInfo(localStartedParts[localStartedParts.length - 1]);
  var processList = run('process-list', 'ps', []);
  if (!trim(processList.text)) die('process list is empty');
  var pageRaw = run('electron-cdp-pages', 'curl', ['-fsS', '--max-time', '5', 'http://127.0.0.1:9222/json']);
  var page = pageForSlot(pageRaw, SLOT);
  var activeProcess = processInfo(SLOT);
  var bePackage = packageInfo(SLOT_ROOT, null, 'be');
  var beIndex = rootIndex(SLOT_ROOT, 'be');
  // The deployed package is often a production layout with no source-only
  // src directory. Hash its invariant entrypoints and each conventional
  // runtime directory that is actually present instead of weakening the
  // collection with a missing-development-directory assumption.
  var beManifest = manifest(SLOT_ROOT, presentDirectories(SLOT_ROOT, ['src', 'lib', 'resources'], 'be.runtimePackageManifest'), ['package.json', 'index.js'], MAX_SOURCE_FILES, 'be.runtimePackageManifest');
  var clientRoot = SLOT_ROOT + '/node_modules/@jibo/jetstream-client';
  var jetstreamPackage = packageInfo(clientRoot, '@jibo/jetstream-client', 'jetstreamClient');
  var nimbusRoot = SLOT_ROOT + '/node_modules/@be/nimbus';
  var nimbusPackage = packageInfo(nimbusRoot, '@be/nimbus', 'nimbus');
  var nimbusIndex = rootIndex(nimbusRoot, 'nimbus');
  var nimbusAssets = manifest(nimbusRoot, ['assets'], [], MAX_MANIFEST_FILES, 'nimbus.runtimeAssetManifest');
  var ssmPackage = packageInfo(SSM_ROOT, null, 'ssm');
  if (ssmPackage.version !== '16.0.0') die('SSM version is ' + ssmPackage.version + ', expected 16.0.0');
  var ssmSkillPath = ssmSkillMain(ssmPackage.parsed);
  var ssmSkillRow = addFile(ssmSkillPath, 'ssm.skill-main', { component: 'ssm.skill-main' });
  var identity = identityInfo();
  var firmware = firmwareInfo();
  var utcEnded = trim(run('timestamp-utc-end', 'date', ['-u', '+%Y-%m-%dT%H:%M:%S%z']).text);
  var localEndedRaw = trim(run('timestamp-local-end', 'date', ['+%Y-%m-%dT%H:%M:%S%z %Z']).text);
  var localEndedParts = localEndedRaw.split(/\s+/);
  var immutableFiles = files.filter(function (row) {
    return row.component !== 'timezone' && row.component !== 'localtime' && row.component.indexOf('firmware:') !== 0 && row.component !== 'robot-credentials';
  }).map(function (row) { return { component: row.component, path: row.path, bytes: row.bytes, sha256: row.sha256 }; });
  immutableFiles.sort(function (a, b) { var ak = a.component + '\0' + a.path; var bk = b.component + '\0' + b.path; return ak < bk ? -1 : ak > bk ? 1 : 0; });
  var immutable = { files: immutableFiles, sha256: digest(Buffer.from(json(immutableFiles))) };
  var payload = {
    root: { slot: SLOT, path: SLOT_ROOT },
    timestamps: {
      utcStarted: utcStarted,
      utcEnded: utcEnded,
      localStarted: localStartedParts.slice(0, -1).join(' '),
      localEnded: localEndedParts.slice(0, -1).join(' '),
      timezone: timezone,
    },
    electron: { process: activeProcess, page: page },
    be: {
      package: { path: bePackage.path, name: bePackage.name, version: bePackage.version, sha256: bePackage.sha256, bytes: bePackage.bytes },
      index: beIndex,
      manifest: beManifest,
    },
    jetstreamClient: {
      package: { path: jetstreamPackage.path, name: jetstreamPackage.name, version: jetstreamPackage.version, sha256: jetstreamPackage.sha256, bytes: jetstreamPackage.bytes },
      main: jetstreamPackage.mainArtifact,
    },
    nimbus: {
      package: { path: nimbusPackage.path, name: nimbusPackage.name, version: nimbusPackage.version, sha256: nimbusPackage.sha256, bytes: nimbusPackage.bytes },
      index: nimbusIndex,
      assets: nimbusAssets,
    },
    ssm: {
      package: { path: ssmPackage.path, name: ssmPackage.name, version: ssmPackage.version, sha256: ssmPackage.sha256, bytes: ssmPackage.bytes },
      main: ssmPackage.mainArtifact,
      skillMain: { path: ssmSkillPath, sha256: ssmSkillRow.sha256, bytes: ssmSkillRow.bytes },
    },
    firmware: firmware,
    identity: identity,
    immutable: immutable,
    raw: { commands: commands, files: files, ssh: { remoteSession: true } },
  };
  payload.raw.commands.forEach(function (row) {
    if (row.exitCode !== 0) die('raw command did not succeed: ' + row.id);
  });
  process.stdout.write('S13P1\t' + JSON.stringify({ protocol: PROTOCOL, ok: true, payload: payload }) + '\n');
}

try { main(); } catch (error) { die(error && error.message ? error.message : String(error)); }
__S13_NODE__
`;
  return script.replace('__S13_SLOT__', shellQuote(slot));
}

function runSsh({ host, slot, sshBin = process.env.S13_SSH_BIN || 'ssh' }) {
  const target = `root@${host}`;
  const args = [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR',
    '--', target, 'sh', '-s'
  ];
  return new Promise((resolve, reject) => {
    let childProcess;
    try { childProcess = spawn(sshBin, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      childProcess.kill('SIGKILL');
      reject(new Error('SSH collection timed out'));
    }, 60_000);
    childProcess.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    childProcess.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    childProcess.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.stdin.on('error', (error) => {
      // A fixture or a remote wrapper may finish after emitting the complete
      // frame, which closes stdin while the local write is still draining.
      // EPIPE in that case does not invalidate the already collected stdout.
      if (error.code === 'EPIPE' || settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      const raw = hashPair(out, err);
      if (code !== 0) reject(new Error(`SSH exited ${code === null ? `by ${signal}` : code}; stderr sha256 ${raw.stderrSha256}`));
      else if (err.length !== 0) reject(new Error(`SSH produced stderr (sha256 ${raw.stderrSha256}); refusing an unclean receipt`));
      else resolve({ stdout: out, stderr: err, raw, args });
    });
    childProcess.stdin.end(buildRemoteScript(slot));
  });
}

function artifactRows(snapshot) {
  const rows = [];
  function add(component, value) {
    if (value && typeof value.path === 'string' && typeof value.sha256 === 'string') rows.push({ component, path: value.path, bytes: value.bytes, sha256: value.sha256 });
  }
  add('be.package', snapshot.be?.package);
  add('be.index', snapshot.be?.index);
  add('jetstreamClient.package', snapshot.jetstreamClient?.package || snapshot.client?.package);
  add('jetstreamClient.main', snapshot.jetstreamClient?.main || snapshot.client?.main);
  add('nimbus.package', snapshot.nimbus?.package);
  add('nimbus.index', snapshot.nimbus?.index);
  add('ssm.package', snapshot.ssm?.package);
  add('ssm.main', snapshot.ssm?.main);
  add('ssm.skillMain', snapshot.ssm?.skillMain);
  for (const row of snapshot.be?.manifest?.files || []) add('be.manifest', row);
  for (const row of snapshot.nimbus?.assets?.files || []) add('nimbus.assets', row);
  const derived = rows.sort((a, b) => {
    const ak = `${a.component}\0${a.path}`;
    const bk = `${b.component}\0${b.path}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  // Always derive the comparison set from the structured package/manifest
  // fields.  A caller cannot make a changed package appear unchanged merely by
  // editing the cached `immutable` block.  The declaration is checked by
  // compareSnapshots so a tampered cached block is still reported as invalid.
  return derived;
}

function validateSnapshotImmutableFields(snapshot, label) {
  if (!isObject(snapshot) || snapshot.schema !== SCHEMA) fail(`${label} has an unsupported snapshot schema`);
  const be = requireObject(snapshot.be, `${label}.be`);
  validatePackageInfo(be.package, `${label}.be.package`);
  if (!be.package.name.startsWith('@be/')) fail(`${label}.be.package.name must use the @be namespace`);
  validateArtifact(be.index, `${label}.be.index`);
  validateManifest(be.manifest, `${label}.be.manifest`, MAX_SOURCE_MANIFEST_FILES);
  const client = snapshot.jetstreamClient || snapshot.client;
  validatePackageInfo(client?.package, `${label}.jetstreamClient.package`, '@jibo/jetstream-client');
  validateArtifact(client?.main, `${label}.jetstreamClient.main`);
  const nimbus = requireObject(snapshot.nimbus, `${label}.nimbus`);
  validatePackageInfo(nimbus.package, `${label}.nimbus.package`, '@be/nimbus');
  validateArtifact(nimbus.index, `${label}.nimbus.index`);
  validateManifest(nimbus.assets, `${label}.nimbus.assets`, MAX_MANIFEST_FILES);
  const ssm = requireObject(snapshot.ssm, `${label}.ssm`);
  validatePackageInfo(ssm.package, `${label}.ssm.package`, undefined, '16.0.0');
  validateArtifact(ssm.main, `${label}.ssm.main`);
  validateArtifact(ssm.skillMain, `${label}.ssm.skillMain`);
}

function immutableDeclarationValid(snapshot, rows) {
  if (!isObject(snapshot.immutable) || !Array.isArray(snapshot.immutable.files)) return false;
  try {
    const declared = snapshot.immutable.files.map((row, index) => {
      requireObject(row, `immutable.files[${index}]`);
      requireString(row.component, `immutable.files[${index}].component`);
      requireString(row.path, `immutable.files[${index}].path`);
      requireHash(row.sha256, `immutable.files[${index}].sha256`);
      return { component: row.component, path: row.path, bytes: row.bytes, sha256: row.sha256 };
    }).sort((a, b) => {
      const ak = `${a.component}\0${a.path}`;
      const bk = `${b.component}\0${b.path}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
    const digest = requireHash(snapshot.immutable.sha256, 'immutable.sha256');
    return digest === sha256(Buffer.from(canonical(declared))) && canonical(declared) === canonical(rows);
  } catch {
    return false;
  }
}

export function immutableFileHashes(snapshot) {
  const rows = artifactRows(snapshot);
  return { files: rows, sha256: sha256(Buffer.from(canonical(rows))) };
}

export function compareSnapshots(before, after) {
  validateSnapshotImmutableFields(before, 'before snapshot');
  validateSnapshotImmutableFields(after, 'after snapshot');
  const beforeRows = immutableFileHashes(before);
  const afterRows = immutableFileHashes(after);
  const beforeCanonical = canonical(beforeRows.files);
  const afterCanonical = canonical(afterRows.files);
  const declarationsMatch = immutableDeclarationValid(before, beforeRows.files) && immutableDeclarationValid(after, afterRows.files);
  return {
    schema: 'phoenix-s13-provenance-comparison-v1',
    matched: declarationsMatch && beforeCanonical === afterCanonical,
    before: {
      schema: before.schema,
      immutableFileHashesSha256: beforeRows.sha256,
      fileCount: beforeRows.files.length,
    },
    after: {
      schema: after.schema,
      immutableFileHashesSha256: afterRows.sha256,
      fileCount: afterRows.files.length,
    },
    differences: declarationsMatch && beforeCanonical === afterCanonical
      ? []
      : (beforeCanonical === afterCanonical ? [{ key: 'immutable.declaration', before: before.immutable || null, after: after.immutable || null }] : diffRows(beforeRows.files, afterRows.files)),
  };
}

function diffRows(before, after) {
  const left = new Map(before.map((row) => [`${row.component}\0${row.path}`, row]));
  const right = new Map(after.map((row) => [`${row.component}\0${row.path}`, row]));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  return keys.filter((key) => canonical(left.get(key)) !== canonical(right.get(key))).map((key) => ({ key, before: left.get(key) || null, after: right.get(key) || null }));
}

function minimizedIdentity(identity) {
  const result = { hostnameSha256: identity.hostnameSha256 };
  for (const key of ['credentialsSha256', 'robotIdSha256', 'robotIdSource']) {
    if (identity[key] !== undefined) result[key] = identity[key];
  }
  return result;
}

function ensureOutputParent(file) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory()) fail('output parent is not a directory');
  if (fs.realpathSync(parent) !== parent) fail('output parent has a symlinked ancestor');
}

export function writeAtomicJson(file, value) {
  const target = outputPath(file);
  ensureOutputParent(target);
  const existing = lstatIfPresent(target);
  if (existing && existing.isSymbolicLink()) fail('refusing to replace a symlink output');
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    try {
      const directoryFd = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch { /* directory fsync is unavailable on some filesystems */ }
    fs.chmodSync(target, 0o600);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore cleanup failure */ } }
    try { fs.unlinkSync(temporary); } catch { /* ignore cleanup failure */ }
    throw error;
  }
  return target;
}

function makeSnapshot(remote, sshResult, host, slot) {
  const payload = validateRemotePayload(remote, slot);
  const snapshot = {
    schema: SCHEMA,
    collector: {
      version: 1,
      mode: 'root-ssh-read-only-single-session',
      remoteUser: 'root',
      sshArgvSha256: sha256(Buffer.from(canonical(sshResult.args))),
    },
    target: { host, slot, remoteRoot: payload.root.path },
    capturedAt: {
      utcStarted: payload.timestamps.utcStarted,
      utcEnded: payload.timestamps.utcEnded,
      localStarted: payload.timestamps.localStarted,
      localEnded: payload.timestamps.localEnded,
      timezone: payload.timestamps.timezone,
    },
    electron: payload.electron,
    be: payload.be,
    jetstreamClient: payload.jetstreamClient || payload.client,
    nimbus: payload.nimbus,
    ssm: payload.ssm,
    firmware: payload.firmware,
    identity: minimizedIdentity(payload.identity),
    raw: {
      ssh: {
        argvSha256: sha256(Buffer.from(canonical(sshResult.args))),
        stdoutSha256: sshResult.raw.stdoutSha256,
        stderrSha256: sshResult.raw.stderrSha256,
        combinedSha256: sshResult.raw.combinedSha256,
        stdoutBytes: sshResult.raw.stdoutBytes,
        stderrBytes: sshResult.raw.stderrBytes,
      },
      commands: payload.raw.commands,
      files: payload.raw.files || [],
    },
  };
  snapshot.immutable = immutableFileHashes(snapshot);
  return snapshot;
}

function readSnapshot(file, label) {
  const parsed = readJsonFile(file, label).value;
  if (!isObject(parsed) || parsed.schema !== SCHEMA) fail(`${label} has an unsupported schema`);
  return parsed;
}

function parseArgs(argv) {
  const args = { sshBin: process.env.S13_SSH_BIN || 'ssh' };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const key = token.slice(2);
    if (!['host', 'slot', 'out', 'before', 'after', 'ssh-bin'].includes(key)) fail(`unknown option ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) fail(`${token} requires a value`);
    args[key === 'ssh-bin' ? 'sshBin' : key] = value;
  }
  if (positional.length) {
    if (!args.host) args.host = positional.shift();
    if (!args.slot) args.slot = positional.shift();
    if (!args.out) args.out = positional.shift();
  }
  if (positional.length) fail('unexpected positional arguments');
  return args;
}

function usage() {
  return [
    'Usage:',
    '  collect.mjs --host HOST --slot SLOT --out RECEIPT.json [--before BASELINE.json]',
    '  collect.mjs --before BEFORE.json --after AFTER.json --out COMPARISON.json',
    '',
    'The remote collection always uses one root SSH session and read-only commands.',
  ].join('\n');
}

export async function collect(options) {
  const host = safeHost(options.host);
  const slot = safeSlot(options.slot);
  const out = outputPath(options.out);
  const sshResult = await runSsh({ host, slot, sshBin: options.sshBin });
  const remote = parseRemoteFrame(sshResult.stdout);
  const snapshot = makeSnapshot(remote, sshResult, host, slot);
  if (options.before) {
    const baseline = readSnapshot(options.before, 'before snapshot');
    const comparison = compareSnapshots(baseline, snapshot);
    if (!comparison.matched) fail(`before/after immutable file hashes differ (${comparison.differences.length} rows)`);
    snapshot.comparison = { mode: 'before-baseline', matched: true, before: path.resolve(options.before), immutableFileHashesSha256: comparison.after.immutableFileHashesSha256 };
  }
  writeAtomicJson(out, snapshot);
  return snapshot;
}

export function compareSnapshotFiles(beforeFile, afterFile, outFile) {
  const before = readSnapshot(beforeFile, 'before snapshot');
  const after = readSnapshot(afterFile, 'after snapshot');
  const result = compareSnapshots(before, after);
  result.before.path = path.resolve(beforeFile);
  result.after.path = path.resolve(afterFile);
  if (outFile) writeAtomicJson(outFile, result);
  return result;
}

async function mainCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  if (args.before && args.after) {
    if (!args.out) fail('comparison requires --out');
    const result = compareSnapshotFiles(args.before, args.after, args.out);
    if (!result.matched) {
      process.stderr.write(`S-13 provenance: immutable file hashes differ (${result.differences.length} rows)\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (!args.host || !args.slot || !args.out) fail(usage());
  await collect(args);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  mainCli().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}

export { SCHEMA, REMOTE_PROTOCOL, buildRemoteScript, parseRemoteFrame, validateRemotePayload };

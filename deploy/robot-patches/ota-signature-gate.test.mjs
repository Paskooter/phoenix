// The official image's OTA signature gate, end to end on the robot's runtime.
//
// The image builder (bake_jibo_io_native_image.py) renders the robot's OTA downloader with a
// throwaway release key generated here pinned in it. That downloader then fetches packages from
// a local server exactly as the system manager runs it (--id --url --destination --shasum) and
// must accept a signed, newer release and refuse unsigned, altered, re-labelled and older ones,
// each with a "Phoenix OTA gate refused update <id>: <reason>" log line and nothing left on disk.
// Signatures come from the real signer (packages/ota/src/releaseSignature.js).
//
// Runtime: PHOENIX_TEST_NODE6=<node v6.9.2 binary> runs the downloader on the robot's Node;
// otherwise the host Node runs it. PHOENIX_TEST_STOCK_OTA_DOWNLOADER=<path> also runs every case
// against the real stock downloader (sha256-pinned by the builder; it is Jibo code and is never
// committed) and the builder's ext4 image path. Without it a Phoenix-authored synthetic
// downloader with the same command line and anchor lines stands in. No key leaves the temp dir.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRow } from '../../packages/ota/src/releaseSignature.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAKER = path.join(HERE, 'bake_jibo_io_native_image.py');
const NODE = process.env.PHOENIX_TEST_NODE6 || process.execPath;
const STOCK = process.env.PHOENIX_TEST_STOCK_OTA_DOWNLOADER || '';
const KEY_ID = 'phoenix-ota-test';
const HEADER = 'x-phoenix-ota-signature';
const INSTALLED = { os: '13.0.8', services: '13.0.8', '@be/be': '13.9.0-dev.3', 'oobe-config': '9.0.2' };

// Phoenix-authored stand-in for the robot downloader: the same command line, globals and the
// four lines the builder anchors on. Not a copy of Jibo's file.
const SYNTHETIC_DOWNLOADER = `#!/usr/bin/env node
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const parseArgs = require("minimist");
const syslog = require("modern-syslog");
let argv = parseArgs(process.argv.slice(2));
syslog.init("jibo-download-update", 0, 0);
let fstream = fs.createWriteStream(argv.destination, {defaultEncoding: "binary"});
let hash = crypto.createHash("sha1");
let progress = { id: argv.id, length: null, received: 0, status: "uninitialized" };
function writeProgress(skipSyslog) { console.log(JSON.stringify(progress)); }
let http = require(argv.url.startsWith("https:") ? "https" : "http");
let req = http.get(argv.url, function(res) {
    if (res.statusCode != 200) { progress.status = "failed"; writeProgress(); process.exit(1); }
    progress.length = parseInt(res.headers["content-length"]);
    progress.status = "initialized";
    writeProgress();
    res.on("data", function(chunk) {
        hash.update(chunk, "binary");
        fstream.write(chunk);
        progress.received += chunk.length;
        progress.status = "downloading";
    });
    res.on("end", function() {
        fstream.end();
        let csum = hash.digest("hex");
        if (csum != argv.shasum) {
            progress.status = "failed";
            progress.reason = "checksum does not match";
            writeProgress();
            fs.unlinkSync(argv.destination);
            syslog.error("Download failed; checksum %s != %s", csum, argv.shasum);
            process.exit(1);
        }
        progress.status = "finished";
        writeProgress();
        syslog.info("Download completed successfully (%d bytes)", progress.length);
    });
});
req.on("error", function(e) { progress.status = "failed"; progress.reason = e.code; writeProgress(); process.exit(1); });
`;

// node_modules stubs: only what the downloader requires besides Node built-ins.
const MINIMIST = `module.exports = function(args) {
  var o = { _: [] };
  for (var i = 0; i < args.length; i++) {
    if (args[i].indexOf("--") === 0) {
      var next = args[i + 1];
      if (next === undefined || next.indexOf("--") === 0) o[args[i].slice(2)] = true;
      else { o[args[i].slice(2)] = next; i++; }
    } else o._.push(args[i]);
  }
  return o;
};`;
const SYSLOG = `var fs = require("fs"), util = require("util");
function line(level, args) {
  fs.appendFileSync(process.env.PHOENIX_TEST_SYSLOG, level + " " + util.format.apply(null, args) + "\\n");
}
module.exports = { LOG_PID: 1, LOG_ODELAY: 2, LOG_LOCAL0: 3, init: function() {},
  info: function() { line("info", arguments); }, error: function() { line("error", arguments); },
  debug: function() { line("debug", arguments); } };`;

let dir;
let server;
let base;
let trustedPriv;
let untrustedPriv;
const routes = new Map();
const variants = [];

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
}

function python(code, input) {
  const r = spawnSync('python3', ['-c', code, BAKER], { input: JSON.stringify(input), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`baker failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

// Render through the builder itself: pinned keys from --ota-release-pubkey parsing, the stock pin
// (real downloader only) and the anchored rendering. Version sources point at fixtures.
const RENDER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("baker", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
req = json.load(sys.stdin)
source = open(req["source"], encoding="utf-8").read()
if req["pinned"]:
    source = b.stock_ota_downloader(source)
keys = b.load_ota_release_pubkeys(req["keys"])
sys.stdout.write(b.render_ota_downloader(source, b.ota_gate_config(keys, req["sources"])))
`;

function installDownloader(name, sourceFile, pinned) {
  const root = path.join(dir, name);
  const versionScript = (label, v) => `#!/bin/sh\necho "Jibo ${label} Version: Release-${v}-20190225"\n`;
  write(path.join(root, 'bin/jibo-version'), versionScript('Release', INSTALLED.os), 0o755);
  write(path.join(root, 'bin/jibo-service-version'), versionScript('Service', INSTALLED.services), 0o755);
  for (const skill of ['@be/be', 'oobe-config']) {
    write(path.join(root, 'skills', skill, 'package.json'), JSON.stringify({ name: skill, version: INSTALLED[skill] }));
  }
  const sources = {
    versionCommands: {
      os: { command: path.join(root, 'bin/jibo-version'), pattern: '^Jibo Release Version: Release-(\\d+\\.\\d+\\.\\d+)' },
      services: { command: path.join(root, 'bin/jibo-service-version'), pattern: '^Jibo Service Version: Release-(\\d+\\.\\d+\\.\\d+)' },
    },
    skillsRoot: path.join(root, 'skills'),
  };
  const rendered = python(RENDER, { source: sourceFile, pinned, keys: [`${KEY_ID}=${path.join(dir, 'trusted.pub.pem')}`], sources });
  const downloader = path.join(root, 'src/download-update.js');
  write(downloader, rendered, 0o755);
  write(path.join(root, 'src/node_modules/minimist/index.js'), MINIMIST);
  write(path.join(root, 'src/node_modules/modern-syslog/index.js'), SYSLOG);
  return { name, root, downloader, rendered };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-ota-gate-'));
  for (const [name, bits] of [['trusted', 3072], ['untrusted', 3072]]) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
    write(path.join(dir, `${name}.pub.pem`), publicKey.export({ type: 'spki', format: 'pem' }));
    if (name === 'trusted') trustedPriv = privateKey; else untrustedPriv = privateKey;
  }
  write(path.join(dir, 'synthetic-download-update.js'), SYNTHETIC_DOWNLOADER);
  variants.push(installDownloader('synthetic', path.join(dir, 'synthetic-download-update.js'), false));
  if (STOCK) variants.push(installDownloader('stock', STOCK, true));
  server = http.createServer((req, res) => {
    const route = routes.get(req.url);
    if (!route) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': route.body.length, ...route.headers });
    res.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const digest = (alg, buf) => createHash(alg).update(buf).digest('hex');

/** A release row signed like the publish kit signs it, plus its package bytes. */
function release({ id = 'os-13.0.9-fcs', subsystem = 'os', toVersion = '13.0.9', fromVersion = '*', key = trustedPriv, keyId = KEY_ID, bytes } = {}) {
  const body = bytes || randomBytes(96 * 1024 + 17);
  const row = { id, subsystem, fromVersion, toVersion, filter: 'fcs', dependencies: {} };
  const sig = signRow(row, { length: body.length, sha256: digest('sha256', body), sha1: digest('sha1', body) }, { privateKey: key, keyId });
  return { row, body, sig, sha1: digest('sha1', body) };
}

const headerOf = (sig) => Buffer.from(JSON.stringify(sig), 'utf8').toString('base64');

let serial = 0;
/** Serve `body` with `headers`, run the downloader as the system manager does, report the result. */
function download(variant, { id, subsystem, toVersion, shasum, body, headers }) {
  const route = `/ota/package/${++serial}`;
  routes.set(route, { body, headers });
  const destination = path.join(variant.root, 'opt-ota', `${toVersion}-${subsystem}.tar`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const syslog = path.join(variant.root, `syslog-${serial}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [variant.downloader, '--id', id, '--url', base + route, '--destination', destination, '--shasum', shasum],
      { env: { ...process.env, PHOENIX_TEST_SYSLOG: syslog }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      resolve({
        code, stderr, last: lines[lines.length - 1] || {}, destination,
        written: fs.existsSync(destination) ? fs.readFileSync(destination) : null,
        log: fs.existsSync(syslog) ? fs.readFileSync(syslog, 'utf8') : '',
      });
    });
  });
}

function assertAccepted(r, body) {
  assert.equal(r.code, 0, `expected the download to be accepted: ${JSON.stringify(r.last)} ${r.log} ${r.stderr}`);
  assert.equal(r.last.status, 'finished');
  assert.ok(r.written && r.written.equals(body), 'the exact signed bytes are on disk');
  assert.match(r.log, /^info Phoenix OTA gate admitted update /m);
}

function assertRefused(r, id, reason) {
  assert.notEqual(r.code, 0, `expected a refusal (${reason}) but the downloader accepted the package`);
  assert.equal(r.last.status, 'failed');
  assert.match(String(r.last.reason), /^phoenix-ota-gate: /, `refused by the gate, not something else: ${JSON.stringify(r.last)}`);
  assert.match(String(r.last.reason), reason);
  const escaped = id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  assert.match(r.log, new RegExp(`^error Phoenix OTA gate refused update ${escaped}: `, 'm'), 'one clear log line names the update');
  assert.equal(r.written, null, 'nothing is left in the OTA cache');
  assert.equal(fs.existsSync(r.destination + '.phoenix-signature.json'), false, 'no stale signature receipt survives refusal');
}

const each = (title, fn) => test(title, async (t) => {
  for (const variant of variants) await t.test(variant.name, () => fn(variant));
});

test('the runtime under test', () => {
  const v = spawnSync(NODE, ['-v'], { encoding: 'utf8' }).stdout.trim();
  if (process.env.PHOENIX_TEST_NODE6) assert.equal(v, 'v6.9.2', 'PHOENIX_TEST_NODE6 must be the robot runtime');
  for (const variant of variants) {
    const check = spawnSync(NODE, ['--check', variant.downloader], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
});

each('a signed, newer os release is accepted', async (v) => {
  const rel = release();
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertAccepted(r, rel.body);
});

each('a verified download retains the exact signed envelope for install-time checks', async (v) => {
  const rel = release();
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertAccepted(r, rel.body);
  const receipt = r.destination + '.phoenix-signature.json';
  assert.ok(fs.existsSync(receipt), 'verified signature is retained beside the package');
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), rel.sig);
  assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
});

each('a rejected redownload clears the older signature receipt', async (v) => {
  const rel=release();
  const good=await download(v,{...rel.row,shasum:rel.sha1,body:rel.body,headers:{[HEADER]:headerOf(rel.sig)}});
  assertAccepted(good,rel.body);
  assert.ok(fs.existsSync(good.destination+'.phoenix-signature.json'));
  const bad=await download(v,{...rel.row,shasum:rel.sha1,body:rel.body,headers:{}});
  assertRefused(bad,rel.row.id,/unsigned package/);
});

each('a signed behaviour engine release newer than the installed dev build is accepted', async (v) => {
  const rel = release({ id: 'be-13.9.0-ring', subsystem: '@be/be', toVersion: '13.9.0' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertAccepted(r, rel.body);
});

each('a signed release of a skill that is not installed yet is accepted', async (v) => {
  const rel = release({ id: 'jibo-trivia-1.0.0', subsystem: 'jibo-trivia', toVersion: '1.0.0' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertAccepted(r, rel.body);
});

each('an unsigned package is refused', async (v) => {
  const rel = release();
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: {} });
  assertRefused(r, rel.row.id, /unsigned package/);
});

each('a tampered package with a matching record checksum is refused', async (v) => {
  // A hostile server changes the bytes and the record's shaHash to match them.
  const rel = release();
  const tampered = Buffer.from(rel.body);
  tampered[1234] ^= 0xff;
  const r = await download(v, { ...rel.row, shasum: digest('sha1', tampered), body: tampered, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /offered checksum differs from the signed sha1/);
});

each('tampered bytes under the original record are refused by the signed sha256', async (v) => {
  const rel = release();
  const tampered = Buffer.from(rel.body);
  tampered[rel.body.length - 1] ^= 0x01;
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: tampered, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /package bytes differ from the signed sha256/);
});

each('an edited signed statement is refused', async (v) => {
  const rel = release({ toVersion: '13.0.9' });
  const edited = { ...rel.sig, payload: rel.sig.payload.replace('"toVersion":"13.0.9"', '"toVersion":"13.0.10"') };
  const r = await download(v, { ...rel.row, toVersion: '13.0.10', shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(edited) } });
  assertRefused(r, rel.row.id, /bad signature/);
});

each('a package signed by a key the image does not pin is refused', async (v) => {
  const rel = release({ key: untrustedPriv, keyId: 'phoenix-ota-other' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /key this robot does not trust/);
});

each('the same key id with another key is refused', async (v) => {
  const rel = release({ key: untrustedPriv, keyId: KEY_ID });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /bad signature/);
});

each('an older signed os release is refused (anti-downgrade)', async (v) => {
  const rel = release({ id: 'os-13.0.7-fcs', toVersion: '13.0.7' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /older or same version: os 13\.0\.7 is not newer than the installed 13\.0\.8/);
});

each('re-offering the installed os version is refused', async (v) => {
  const rel = release({ id: 'os-13.0.8-fcs', toVersion: '13.0.8' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /older or same version/);
});

each('an older behaviour engine pre-release is refused', async (v) => {
  const rel = release({ id: 'be-13.9.0-dev.2', subsystem: '@be/be', toVersion: '13.9.0-dev.2' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /older or same version: @be\/be 13\.9\.0-dev\.2 is not newer than the installed 13\.9\.0-dev\.3/);
});

each('a signed package relabelled as another subsystem is refused', async (v) => {
  const rel = release();
  const r = await download(v, { ...rel.row, subsystem: 'services', shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /signed as os 13\.0\.9/);
});

each('a signature for another update id is refused', async (v) => {
  const rel = release({ id: 'os-13.0.9-fcs' });
  const r = await download(v, { ...rel.row, id: 'os-13.0.9-eau', shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, 'os-13.0.9-eau', /signature is for update "os-13\.0\.9-fcs"/);
});

each('a release signed for another starting version is refused', async (v) => {
  const rel = release({ fromVersion: '13.0.7' });
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /signed to update os 13\.0\.7, but this robot runs 13\.0\.8/);
});

each('a padded package is refused before it is written', async (v) => {
  const rel = release();
  const padded = Buffer.concat([rel.body, Buffer.alloc(4096)]);
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: padded, headers: { [HEADER]: headerOf(rel.sig) } });
  assertRefused(r, rel.row.id, /served length \d+ differs from the signed length/);
});

each('a malformed signature header is refused', async (v) => {
  const rel = release();
  const r = await download(v, { ...rel.row, shasum: rel.sha1, body: rel.body, headers: { [HEADER]: 'not-base64-json' } });
  assertRefused(r, rel.row.id, /malformed signature header/);
});

// ---- builder command line: the official image always pins release keys ---------------------

function bakerPlanArgs(extra) {
  const d = fs.mkdtempSync(path.join(dir, 'plan-'));
  for (const n of ['rootfs.ext4', 'services.ext4', 'skills.ext4', 'var.ext4']) write(path.join(d, 'images', n), '');
  for (const n of ['skills.ext4', 'client.js', 'root.pem']) write(path.join(d, n), '');
  return [BAKER, '--legacy-images', path.join(d, 'images'), '--skills-base', path.join(d, 'skills.ext4'),
    '--output', path.join(d, 'out'), '--client-source', path.join(d, 'client.js'), '--root-ca', path.join(d, 'root.pem'), ...extra];
}

function bakerPlan(extra) {
  return spawnSync('python3', bakerPlanArgs(extra), { encoding: 'utf8' });
}

test('builder: an official image pins the reviewed release keys by default, and refuses an altered set', () => {
  const r = bakerPlan([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OTA gate: {5}signed updates only, anti-downgrade; keys phoenix-ota-20261112, phoenix-ota-20261112b \(pinned in deploy\/ota-release-keys\)/);

  const altered = fs.mkdtempSync(path.join(dir, 'pinned-'));
  fs.cpSync(path.join(HERE, '..', 'ota-release-keys'), altered, { recursive: true });
  fs.copyFileSync(path.join(dir, 'trusted.pub.pem'), path.join(altered, 'phoenix-ota-20261112.pub.pem'));
  const refused = spawnSync('python3', bakerPlanArgs([]), { encoding: 'utf8', env: { ...process.env, PHOENIX_OTA_RELEASE_KEYS_DIR: altered } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /pinned OTA release keys .*phoenix-ota-20261112\.pub\.pem does not match its pemSha256/);
});

test('builder: plans the gate with a 3072-bit public key and refuses private or small keys', () => {
  const ok = bakerPlan(['--ota-release-pubkey', `${KEY_ID}=${path.join(dir, 'trusted.pub.pem')}`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /OTA gate: {5}signed updates only, anti-downgrade; keys phoenix-ota-test \(given with --ota-release-pubkey\)/);

  const priv = path.join(dir, 'private.pem');
  write(priv, trustedPriv.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  const leaked = bakerPlan(['--ota-release-pubkey', `${KEY_ID}=${priv}`]);
  assert.equal(leaked.status, 2);
  assert.match(leaked.stderr, /contains a private key/);
  fs.rmSync(priv);

  const small = path.join(dir, 'small.pub.pem');
  write(small, generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }));
  const weak = bakerPlan(['--ota-release-pubkey', `${KEY_ID}=${small}`]);
  assert.equal(weak.status, 2);
  assert.match(weak.stderr, /at least 3072 bits/);

  const three = bakerPlan(['a', 'b', 'c'].flatMap((k) => ['--ota-release-pubkey', `${k}=${path.join(dir, 'trusted.pub.pem')}`]));
  assert.equal(three.status, 2);
  assert.match(three.stderr, /at most 2/);
});

test('builder: an explicit private test image may opt out, and says so', () => {
  const r = bakerPlan(['--no-ota-signature-gate']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OTA gate: {5}DISABLED/);
  const both = bakerPlan(['--no-ota-signature-gate', '--ota-release-pubkey', `${KEY_ID}=${path.join(dir, 'trusted.pub.pem')}`]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /mutually exclusive/);
});

// ---- the image path: real stock downloader inside an ext4 rootfs -----------------------------

const haveE2fs = ['mke2fs', 'debugfs', 'e2fsck'].every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0);

test('builder: patches the downloader inside a rootfs image (stock or its earlier CA-only output)', {
  skip: !STOCK ? 'set PHOENIX_TEST_STOCK_OTA_DOWNLOADER to the reviewed stock downloader' : !haveE2fs ? 'e2fsprogs missing' : false,
}, () => {
  const stockText = fs.readFileSync(STOCK, 'utf8');
  const caOnly = python(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("baker", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
sys.stdout.write(b.render_ota_downloader(b.stock_ota_downloader(json.load(sys.stdin)["text"]), None))
`, { text: stockText });
  for (const [label, input] of [['stock', stockText], ['earlier CA-only output', caOnly]]) {
    const tree = fs.mkdtempSync(path.join(dir, 'tree-'));
    const target = path.join(tree, 'usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js');
    write(target, input, 0o755);
    const image = path.join(dir, `rootfs-${serial++}.ext4`);
    assert.equal(spawnSync('mke2fs', ['-q', '-t', 'ext4', '-d', tree, image, '8M']).status, 0);
    const out = python(`
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("baker", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
req = json.load(sys.stdin)
keys = b.load_ota_release_pubkeys(req["keys"])
print(json.dumps(b.patch_ota_downloader(Path(req["image"]), keys)))
`, { image, keys: [`${KEY_ID}=${path.join(dir, 'trusted.pub.pem')}`] });
    const result = JSON.parse(out);
    assert.equal(result.signature_gate.enabled, true, label);
    assert.equal(result.mode, '0755');
    const dumped = path.join(dir, `dumped-${serial++}.js`);
    spawnSync('debugfs', ['-R', `dump /usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js ${dumped}`, image]);
    const text = fs.readFileSync(dumped, 'utf8');
    assert.equal(digest('sha256', Buffer.from(text)), result.patched_sha256, label);
    assert.match(text, /phoenix-ota-signature-gate/);
    assert.match(text, /JIBO_EXTRA_CA_CERTS/, 'the explicit CA patch is kept');
    const stat = spawnSync('debugfs', ['-R', 'stat /usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js', image], { encoding: 'utf8' }).stdout;
    assert.match(stat, /Mode: +0755/);
    assert.equal(spawnSync('e2fsck', ['-fn', image]).status, 0, 'image stays consistent');
  }
});

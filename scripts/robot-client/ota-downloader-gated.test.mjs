// The console setup helper on a robot whose downloader carries the Phoenix update signature check.
//
// The official Phoenix image (deploy/robot-patches/bake_jibo_io_native_image.py) bakes a
// downloader that installs only signed updates newer than what the robot runs. The setup
// helper's TLS patcher must recognise that downloader and leave it exactly as it is: swapping in
// the CA-only patch would remove the signature check. Gated downloaders are rendered here by the
// image builder itself, with throwaway public keys generated in a temp dir (never committed).
//
// PHOENIX_TEST_STOCK_OTA_DOWNLOADER=<path> also renders from the real, sha256-pinned stock
// downloader and runs the patcher with its committed pins; PHOENIX_TEST_NODE6 runs that check on
// the robot's Node 6.9.2.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const patcher = require('./patch-ota-downloader-tls.cjs');
const PATCHER = new URL('./patch-ota-downloader-tls.cjs', import.meta.url).pathname;
const code = fs.readFileSync(PATCHER, 'utf8');
const BAKER = new URL('../../deploy/robot-patches/bake_jibo_io_native_image.py', import.meta.url).pathname;
const STOCK = process.env.PHOENIX_TEST_STOCK_OTA_DOWNLOADER || '';
const NODE6 = process.env.PHOENIX_TEST_NODE6 || '';

// Phoenix-authored stand-in with the downloader's anchor lines (not a copy of Jibo's file).
const SYNTHETIC = `#!/usr/bin/env node
"use strict";
const crypto = require("crypto");
const fs = require("fs");
let http = require(argv.url.startsWith("https:") ? "https" : "http");
let req = http.get(argv.url, function(res) {
    progress.length = parseInt(res.headers["content-length"]);
    res.on("data", function(chunk) {
        hash.update(chunk, "binary");
    });
    res.on("end", function() {
        let csum = hash.digest("hex");
    });
});
`;

const RENDER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("baker", sys.argv[1])
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
req = json.load(sys.stdin)
source = open(req["source"], encoding="utf-8").read()
if req["pinned"]:
    source = b.stock_ota_downloader(source)
keys = b.load_ota_release_pubkeys(req["keys"])
json.dump({
    "caOnly": b.render_ota_downloader(source, None),
    "gated": b.render_ota_downloader(source, b.ota_gate_config(keys)),
    "template": b.OTA_GATE_DEFINITIONS,
}, sys.stdout)
`;

let keyDir;
test.before(() => {
  keyDir = fs.mkdtempSync(join(tmpdir(), 'phoenix-gated-downloader-keys-'));
  for (const name of ['current', 'next']) {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    fs.writeFileSync(join(keyDir, name + '.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  }
});
test.after(() => fs.rmSync(keyDir, { recursive: true, force: true }));

function render(sourceFile, { pinned = false, keys = ['current'] } = {}) {
  const specs = keys.map(name => `phoenix-ota-${name}=${join(keyDir, name + '.pub.pem')}`);
  const r = spawnSync('python3', ['-c', RENDER, BAKER], {
    input: JSON.stringify({ source: sourceFile, pinned, keys: specs }), encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`image builder failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function renderSynthetic(options) {
  const file = join(keyDir, 'synthetic-download-update.js');
  fs.writeFileSync(file, SYNTHETIC);
  return render(file, options);
}

// Runs the patcher against a temp target. `gatedBase` replaces the committed CA-only pin for
// synthetic downloaders; null keeps every committed pin.
function fixture(content, run, { gatedBase = null, mode = 0o755 } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'phoenix-gated-downloader-'));
  const target = join(dir, 'download.js');
  const receipt = join(dir, 'receipt.json');
  let source = code.replace(/^var TARGET = .*;$/m, 'var TARGET = ' + JSON.stringify(target) + ';')
    .replace(/^var RECEIPT = .*;$/m, 'var RECEIPT = ' + JSON.stringify(receipt) + ';');
  if (gatedBase) source = source.replace(/^var GATED_BASE = .*;$/m, 'var GATED_BASE = ' + JSON.stringify([gatedBase]) + ';');
  source += '\nmodule.exports.apply = apply;';
  const module = { exports: {} };
  vm.runInNewContext(source, { require, module, Buffer, process });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, mode);
  try { run({ dir, target, receipt, source, apply: module.exports.apply }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function assertUntouched(f, content) {
  assert.equal(fs.readFileSync(f.target, 'utf8'), content, 'the gated downloader must keep every byte');
  assert.deepEqual(fs.readdirSync(f.dir), ['download.js'], 'no backup, receipt or temp file');
}

test('the patcher pins the exact signature check template the image builder bakes', () => {
  const { template } = renderSynthetic();
  assert.equal(patcher.sha256(template), patcher.GATE_TEMPLATE_SHA256,
    'bake_jibo_io_native_image.py OTA_GATE_DEFINITIONS changed: review it and update GATE_TEMPLATE_SHA256');
});

test('the CA-only pin a gated downloader is checked against is the image builder\'s earlier output', () => {
  // GATED_BASE must be the CA-only output this patcher already knows how to upgrade, so a gated
  // downloader minus its signature check is byte-for-byte a reviewed downloader.
  assert.deepEqual(patcher.GATED_BASE, ['1a01b446575bc5da145a41e969ea110af62f144d5651ed5b7ca5aee8bfef826a']);
  assert.match(code, /'1a01b446575bc5da145a41e969ea110af62f144d5651ed5b7ca5aee8bfef826a':\s*\n\s*'33f6db14/);
});

for (const keys of [['current'], ['current', 'next']]) {
  test(`a gated downloader (${keys.length} pinned key${keys.length > 1 ? 's' : ''}) is recognised and left exactly as it is`, () => {
    const { caOnly, gated } = renderSynthetic({ keys });
    assert.notEqual(gated, caOnly);
    fixture(gated, f => {
      const dry = f.apply({ dryRun: true });
      assert.equal(dry.state, 'signature-gated');
      assertUntouched(f, gated);
      const result = f.apply({ dryRun: false });
      assert.equal(result.state, 'signature-gated');
      assert.equal(result.sourceHash, patcher.sha256(gated));
      assert.equal(result.patchedSha256, patcher.sha256(gated));
      assertUntouched(f, gated);
      assert.equal(fs.statSync(f.target).mode & 0o777, 0o755);
      // Running the helper again is harmless.
      assert.equal(f.apply({ dryRun: false }).state, 'signature-gated');
      assertUntouched(f, gated);
    }, { gatedBase: patcher.sha256(caOnly) });
  });
}

test('a gated downloader that lost its executable mode gets 0755 back and keeps its bytes', () => {
  const { caOnly, gated } = renderSynthetic();
  fixture(gated, f => {
    const result = f.apply({ dryRun: false });
    assert.equal(result.state, 'signature-gated');
    assert.equal(result.modeBefore, '644');
    assertUntouched(f, gated);
    assert.equal(fs.statSync(f.target).mode & 0o777, 0o755);
  }, { gatedBase: patcher.sha256(caOnly), mode: 0o644 });
});

// Every variant still carries the signature check marker, so none may be "repaired" into the
// CA-only patch (which would drop the check); each is refused and left untouched.
const tampered = {
  'weakened check': gated => gated.replace('if (!header) return _phoenixOtaRefuse(', 'if (false) return _phoenixOtaRefuse('),
  'missing admit hook': gated => gated.replace('    _phoenixOtaAdmit(res);  // phoenix-ota-signature-gate\n', ''),
  'moved finish hook': gated => gated.replace('        _phoenixOtaFinish();  // phoenix-ota-signature-gate\n        let csum', '        let csum')
    .replace('    });\n});\n', '    });\n        _phoenixOtaFinish();  // phoenix-ota-signature-gate\n});\n'),
  'no pinned keys': gated => gated.replace(/"keys": \{[^}]*\}/, '"keys": {}'),
  'private key pinned': gated => gated.replace('-----BEGIN PUBLIC KEY-----', '-----BEGIN PRIVATE KEY-----'),
  'other signature format': gated => gated.replace('"format": "phoenix-ota-release/1"', '"format": "phoenix-ota-release/0"'),
  'changed downloader outside the check': gated => gated.replace('let csum = hash.digest("hex");', 'let csum = argv.shasum;'),
  'duplicated check': gated => gated.replace('// <<< phoenix-ota-signature-gate <<<\n',
    '// <<< phoenix-ota-signature-gate <<<\n// >>> phoenix-ota-signature-gate >>>\n// <<< phoenix-ota-signature-gate <<<\n'),
};
for (const [name, change] of Object.entries(tampered)) {
  test(`a gated downloader is refused and never replaced: ${name}`, () => {
    const { caOnly, gated } = renderSynthetic();
    const changed = change(gated);
    assert.notEqual(changed, gated, 'the tamper case must change the file');
    fixture(changed, f => {
      for (const dryRun of [true, false]) {
        assert.throws(() => f.apply({ dryRun }), /signature check this helper does not recognise/);
        assertUntouched(f, changed);
      }
    }, { gatedBase: patcher.sha256(caOnly) });
  });
}

test('the CA-only downloader is still upgraded as before (no gate marker)', () => {
  const { caOnly } = renderSynthetic();
  fixture(caOnly, f => {
    // Committed pins: the synthetic CA-only output is not a reviewed downloader.
    assert.throws(() => f.apply({ dryRun: true }), /unsupported source hash/);
  });
});

test('real stock downloader: the image builder\'s gated output passes the committed pins untouched',
  { skip: STOCK ? false : 'set PHOENIX_TEST_STOCK_OTA_DOWNLOADER to the pinned stock download-update.js' }, () => {
    const { caOnly, gated } = render(STOCK, { pinned: true, keys: ['current', 'next'] });
    assert.equal(patcher.sha256(caOnly), patcher.GATED_BASE[0]);
    fixture(gated, f => {
      assert.equal(f.apply({ dryRun: false }).state, 'signature-gated');
      assertUntouched(f, gated);
      if (NODE6) {
        // The same check on the robot's runtime, through the helper's command line.
        const script = join(f.dir, '..', `phoenix-gated-patcher-${process.pid}.cjs`);
        fs.writeFileSync(script, f.source.replace(/\nmodule\.exports\.apply = apply;$/, ''));
        try {
          const r = spawnSync(NODE6, [script, '--json'], { encoding: 'utf8' });
          assert.equal(r.status, 0, r.stderr);
          assert.equal(JSON.parse(r.stdout).state, 'signature-gated');
          const changed = gated.replace('if (!header) return _phoenixOtaRefuse(', 'if (false) return _phoenixOtaRefuse(');
          fs.writeFileSync(f.target, changed);
          const refused = spawnSync(NODE6, [script, '--json'], { encoding: 'utf8' });
          assert.equal(refused.status, 2);
          assert.match(refused.stderr, /signature check this helper does not recognise/);
          assert.equal(fs.readFileSync(f.target, 'utf8'), changed);
          fs.writeFileSync(f.target, gated);
        } finally { fs.rmSync(script, { force: true }); }
      }
      assertUntouched(f, gated);
    });
  });

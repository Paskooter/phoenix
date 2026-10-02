#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var patcher = require('./patch-oobe-setup-text.cjs');

// The shape of the setup skill's exported artwork around the two bitmaps (synthetic;
// the real file is hash-pinned by the patcher).
function block(name, bitmap, x, y) {
  return [
    '(lib.' + name + ' = function(mode,startPosition,loop) {',
    '\tvar instance;',
    '\tthis.initialize(mode,startPosition,loop,{});',
    '',
    '\t// bitmap',
    '\tinstance = this.instance = new lib.' + bitmap + '();',
    '\tinstance.setTransform(' + x + ',' + y + ');',
    '',
    '\tthis.timeline.addTween(Tween.get(instance).wait(1));',
    '',
    '}).prototype = p = new MovieClip();'
  ].join('\n');
}
var art = [
  '(function (lib, img, cjs, ss) {', 'var p;', 'var MovieClip = cjs.MovieClip;', 'var Tween = cjs.Tween;', 'var Shape = cjs.Shape;',
  block('NextCode_text', 'NextCode_text1', -461.3, -160),
  'p.nominalBounds = null;',
  block('Go2AppText', 'Go2AppText1', -535.3, -310),
  'p.nominalBounds = null;',
  '})(pixiflash_lib = {}, {}, pixiflash, {});'
].join('\n');

var patched = patcher.patchArt(art, 'jibo.io');
assert.ok(patched.indexOf('new lib.Go2AppText1()') < 0, 'the app bitmap is gone');
assert.ok(patched.indexOf('new lib.NextCode_text1()') < 0, 'the next-code bitmap is gone');
assert.ok(patched.indexOf('"Go to jibo.io\\nto get started"') >= 0);
assert.ok(patched.indexOf('"Now get your next\\nQR code from jibo.io"') >= 0);
assert.ok(patched.indexOf('jibo.io/terms') >= 0);
assert.ok(patched.indexOf('the app') < 0);
new vm.Script(patched); // still parses
assert.throws(function() { patcher.patchArt(patched, 'jibo.io'); }, /already patched/);
assert.throws(function() { patcher.patchArt(art + art, 'jibo.io'); }, /exactly once/);
assert.throws(function() { patcher.patchArt(art, 'jibo.io"; evil()'); }, /invalid server name/);

// The error messages bundled into oobe-config.js, in both of the skill's wordings.
var bundle = 'e={wifi1:{message:"Make sure your router is powered on.\\nGo to the app for help and to get a new QR code."},' +
  'wifix:{message:"Try rebooting him, or go to the app for help."},' +
  'ota1:{instructions:"To reconnect, get a new QR code in the app and tap here."}}';
var bundled = patcher.patchBundle(bundle, 'jibo.io');
assert.strictEqual(bundled.count, 3);
assert.ok(bundled.source.indexOf('Go to jibo.io for help') >= 0);
assert.ok(bundled.source.indexOf('or go to jibo.io for help') >= 0);
assert.ok(bundled.source.indexOf('QR code at jibo.io and tap here') >= 0);
assert.strictEqual(patcher.patchBundle(bundled.source, 'jibo.io').count, 0);

// On a robot: a missing skill is not an error, and unreviewed artwork is refused
// before anything is written.
var script = path.join(__dirname, 'patch-oobe-setup-text.cjs');
// The modern harness supplies an isolated directory when using factory Node 4,
// whose filesystem API predates mkdtempSync. This is test-only, not robot code.
var root = process.env.PHOENIX_TEST_OOBE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'oobe-text-'));
assert.ok(/^not-needed/.test(childProcess.execFileSync(process.execPath, [script, '--root', root, '--dry-run'], { encoding: 'utf8' })));
fs.mkdirSync(path.join(root, 'assets'));
fs.mkdirSync(path.join(root, 'assets', 'oobe'));
fs.writeFileSync(path.join(root, 'assets', 'oobe', 'oobe.js'), art);
fs.writeFileSync(path.join(root, 'oobe-config.js'), bundle);
var refused = childProcess.spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
assert.strictEqual(refused.status, 2);
assert.ok(/not the reviewed version/.test(refused.stderr));
assert.strictEqual(fs.readFileSync(path.join(root, 'oobe-config.js'), 'utf8'), bundle, 'nothing written');

console.log('patch-oobe-setup-text: ok');

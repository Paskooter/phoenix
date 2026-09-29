#!/usr/bin/env node
/*
 * Make Jibo's setup screens point at this server instead of the retired phone app.
 *
 * The setup skill (oobe-config) draws its first screen from a bitmap that reads
 * "Go to the Jibo app on your phone to get started", and a second one, shown
 * when a setup needs several QR codes, that reads "Now get your next QR code
 * from the app". Its error screens say "Go to the app for help". The app is
 * gone, so after a repoint those screens send the owner nowhere.
 *
 * This replaces the two bitmaps with text in the skill's own fonts and layout
 * ("Go to jibo.io to get started"), and rewrites the app phrases in the error
 * messages. Two files change:
 *
 *   assets/oobe/oobe.js   the exported artwork. Unchanged since 2016, so every
 *                         firmware ships the same file; it is hash-pinned.
 *   oobe-config.js        the skill's bundle, which carries the error messages.
 *                         It differs between firmware builds, so only its known
 *                         phrases are rewritten, and at least one must be found.
 *
 * Used on a robot by the repoint helper, and at build time for the OTA skill
 * package (see scripts/build-oobe-config-ota.py). Node 4-compatible.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var SKILL_ROOT = '/opt/jibo/Jibo/Skills/oobe-config';
var ART = 'assets/oobe/oobe.js';
var BUNDLE = 'oobe-config.js';
var MARKER = 'phoenix-oobe-setup-text';
// The stock artwork, and what patchArt makes of it for the default suffix.
var ART_ORIGINAL_SHA256 = '91c28ff8b69b1910bbcf951fa0f666f688e8aba493d52dccfe7623f21723f411';
var ART_PATCHED_SHA256 = '85a14d4717a1b5e19fd9d8b53415848bf8de12652a2f0a765b34bb29eddd0e39';

var GO2APP_BITMAP = [
  '(lib.Go2AppText = function(mode,startPosition,loop) {',
  '\tvar instance;',
  '\tthis.initialize(mode,startPosition,loop,{});',
  '',
  '\t// bitmap',
  '\tinstance = this.instance = new lib.Go2AppText1();',
  '\tinstance.setTransform(-535.3,-310);',
  '',
  '\tthis.timeline.addTween(Tween.get(instance).wait(1));',
  '',
  '}).prototype = p = new MovieClip();'
].join('\n');

var NEXTCODE_BITMAP = [
  '(lib.NextCode_text = function(mode,startPosition,loop) {',
  '\tvar instance;',
  '\tthis.initialize(mode,startPosition,loop,{});',
  '',
  '\t// bitmap',
  '\tinstance = this.instance = new lib.NextCode_text1();',
  '\tinstance.setTransform(-461.3,-160);',
  '',
  '\tthis.timeline.addTween(Tween.get(instance).wait(1));',
  '',
  '}).prototype = p = new MovieClip();'
].join('\n');

// Error-message phrases in the bundle, across the skill's versions.
var PHRASES = [
  ['Go to the app', 'Go to %s'],
  ['go to the app', 'go to %s'],
  ['QR code in the app', 'QR code at %s']
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function utf8Buffer(text) {
  return typeof Buffer.alloc === 'function' ? Buffer.from(text, 'utf8') : new Buffer(text, 'utf8');
}

function checkSuffix(suffix) {
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(suffix)) throw new Error('invalid server name: ' + suffix);
}

// One cjs.Text, laid out the way the exported artwork declares its own text.
function textLines(name, text, font, color, align, lineHeight, x, y) {
  return [
    '\t' + name + ' = this.' + name + ' = new cjs.Text(' + JSON.stringify(text) + ', ' +
      JSON.stringify(font) + ', ' + JSON.stringify(color) + ');',
    '\t' + name + '.name = ' + JSON.stringify(name) + ';',
    '\t' + name + '.textAlign = ' + JSON.stringify(align) + ';',
    '\t' + name + '.lineHeight = ' + lineHeight + ';',
    '\t' + name + '.setTransform(' + x + ',' + y + ');',
    ''
  ];
}

function addTweens(names) {
  return names.map(function(name) { return '\tthis.timeline.addTween(Tween.get(' + name + ').wait(1));'; });
}

function patchArt(source, suffix) {
  checkSuffix(suffix);
  if (source.indexOf(MARKER) >= 0) throw new Error('artwork is already patched');
  [GO2APP_BITMAP, NEXTCODE_BITMAP].forEach(function(block, index) {
    var first = source.indexOf(block);
    if (first < 0 || source.indexOf(block, first + 1) >= 0) {
      throw new Error('artwork anchor ' + (index + 1) + ' was not found exactly once');
    }
  });
  // Positions match the bitmaps they replace (their origin is the clip's centre);
  // PIXI places a Text's top edge at y.
  var go2app = [
    '(lib.Go2AppText = function(mode,startPosition,loop) {',
    '\tvar eula, headline, tap;',
    '\tthis.initialize(mode,startPosition,loop,{});',
    '',
    '\t// ' + MARKER + ': text in place of the bitmap that named the retired phone app',
  ].concat(
    textLines('eula', 'Use of Jibo is subject to the terms at ' + suffix + '/terms',
      "28px 'Proxima Nova Lt'", '#828191', 'center', 30, 0, -315),
    textLines('headline', 'Go to ' + suffix + '\nto get started',
      "bold 96px 'Proxima Nova Soft'", '#FFFFFF', 'center', 110, 0, -150),
    textLines('tap', 'Tap here when you have your QR code...',
      "45px 'Proxima Nova Lt'", '#FFFFFF', 'center', 47, 0, 209),
    addTweens(['eula', 'headline', 'tap']),
    ['', '}).prototype = p = new MovieClip();']
  ).join('\n');
  var nextcode = [
    '(lib.NextCode_text = function(mode,startPosition,loop) {',
    '\tvar headline, tap, dot;',
    '\tthis.initialize(mode,startPosition,loop,{});',
    '',
    '\t// ' + MARKER + ': text in place of the bitmap that named the retired phone app',
  ].concat(
    textLines('headline', 'Now get your next\nQR code from ' + suffix,
      "bold 94px 'Proxima Nova Soft'", '#FFFFFF', 'center', 110, 0, -181),
    textLines('tap', 'Tap here when you have QR code',
      "45px 'Proxima Nova Lt'", '#FFFFFF', 'right', 47, 277, 208),
    [
      '\t// The code counter (NextCode.counter) is drawn inside this dot.',
      '\tdot = this.dot = new Shape();',
      '\tdot.graphics.f("#1CC3DA").dc(331.7,232,37);',
      ''
    ],
    addTweens(['dot', 'headline', 'tap']),
    ['', '}).prototype = p = new MovieClip();']
  ).join('\n');
  return source.replace(GO2APP_BITMAP, go2app).replace(NEXTCODE_BITMAP, nextcode);
}

function patchBundle(source, suffix) {
  checkSuffix(suffix);
  var output = source;
  var count = 0;
  PHRASES.forEach(function(pair) {
    var parts = output.split(pair[0]);
    count += parts.length - 1;
    output = parts.join(pair[1].replace('%s', suffix));
  });
  return { source: output, count: count };
}

function writeAtomic(filename, bytes, stat) {
  var temporary = filename + '.phoenix-oobe-' + process.pid + '-' + Math.random().toString(16).slice(2);
  try {
    fs.writeFileSync(temporary, bytes, { mode: stat.mode & 0o777 });
    fs.chmodSync(temporary, stat.mode & 0o777);
    // The skill's files belong to its own user (jibo-skill, 2000:2000).
    if (typeof process.getuid === 'function' && process.getuid() === 0) fs.chownSync(temporary, stat.uid, stat.gid);
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
}

function regularFile(filename) {
  var stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('must be a regular file: ' + filename);
  return stat;
}

function parseArgs(argv) {
  var result = { dryRun: false, suffix: 'jibo.io', root: SKILL_ROOT };
  for (var index = 0; index < argv.length; index += 1) {
    var arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--suffix') { result.suffix = argv[index + 1]; index += 1; }
    else if (arg === '--root') { result.root = argv[index + 1]; index += 1; }
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: patch-oobe-setup-text.cjs [--suffix jibo.io] [--root <oobe-config dir>] [--dry-run]\n');
      process.exit(0);
    } else throw new Error('unknown argument: ' + arg);
  }
  checkSuffix(result.suffix);
  return result;
}

function apply(options) {
  var artPath = path.join(options.root, ART);
  var bundlePath = path.join(options.root, BUNDLE);
  if (!fs.existsSync(artPath) || !fs.existsSync(bundlePath)) return 'not-needed (no setup skill at ' + options.root + ')';
  var artStat = regularFile(artPath);
  var bundleStat = regularFile(bundlePath);
  var art = fs.readFileSync(artPath);
  var bundle = fs.readFileSync(bundlePath, 'utf8');

  var artOutput = null;
  if (art.toString('utf8').indexOf(MARKER) >= 0) {
    if (art.toString('utf8').indexOf('Go to ' + options.suffix + '\\n') < 0) throw new Error('setup screens were patched for a different server');
  } else if (sha256(art) === ART_ORIGINAL_SHA256) {
    artOutput = utf8Buffer(patchArt(art.toString('utf8'), options.suffix));
    if (options.suffix === 'jibo.io' && sha256(artOutput) !== ART_PATCHED_SHA256) {
      throw new Error('generated setup artwork does not match the reviewed output');
    }
  } else {
    throw new Error('setup artwork is not the reviewed version: ' + sha256(art));
  }
  var bundled = patchBundle(bundle, options.suffix);
  if (bundled.count === 0 && bundle.indexOf('o to ' + options.suffix) < 0) {
    throw new Error('setup messages do not contain the expected app phrases');
  }
  if (!artOutput && bundled.count === 0) return 'already-patched';
  if (options.dryRun) return 'patched';

  if (artOutput) {
    if (!fs.existsSync(artPath + '.phoenix-oobe-text.bak')) writeAtomic(artPath + '.phoenix-oobe-text.bak', art, artStat);
    writeAtomic(artPath, artOutput, artStat);
    if (sha256(fs.readFileSync(artPath)) !== sha256(artOutput)) throw new Error('setup artwork did not verify after writing');
  }
  if (bundled.count > 0) {
    var bundleOutput = utf8Buffer(bundled.source);
    if (!fs.existsSync(bundlePath + '.phoenix-oobe-text.bak')) writeAtomic(bundlePath + '.phoenix-oobe-text.bak', utf8Buffer(bundle), bundleStat);
    writeAtomic(bundlePath, bundleOutput, bundleStat);
    if (sha256(fs.readFileSync(bundlePath)) !== sha256(bundleOutput)) throw new Error('setup messages did not verify after writing');
  }
  return 'patched';
}

if (require.main === module) {
  try { process.stdout.write(apply(parseArgs(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write('patch-oobe-setup-text: ' + error.message + '\n'); process.exit(2); }
}

module.exports = {
  patchArt: patchArt, patchBundle: patchBundle, sha256: sha256,
  ART_ORIGINAL_SHA256: ART_ORIGINAL_SHA256, ART_PATCHED_SHA256: ART_PATCHED_SHA256
};

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var helper = require('./repoint-cloud-config.cjs');

function fixture(run) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-cloud-config-test-'));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function options(kind, file, dryRun) {
  return { kind: kind, file: file, region: 'api', suffix: 'jibo.io',
    dryRun: !!dryRun, stamp: '20260929-120000' };
}

test('a 5x1/OpenJibo-style credential endpoint is replaced without changing identity', function() {
  fixture(function(dir) {
    var file = path.join(dir, 'credentials.json');
    var source = { secretAccessKey: 'S'.repeat(40), region: 'api', endpoint: 'http://joap.5x1.com:80',
      accessKeyId: 'A'.repeat(20), sslEnabled: false, custom: { keep: true } };
    fs.writeFileSync(file, JSON.stringify(source), { mode: 0o644 });
    assert.equal(helper.apply(options('credentials', file, true)), 'patched');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(source));
    assert.equal(helper.apply(options('credentials', file, false)), 'patched');
    var result = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(result.endpoint, 'https://api.jibo.io');
    assert.equal(result.accessKeyId, source.accessKeyId);
    assert.equal(result.secretAccessKey, source.secretAccessKey);
    assert.deepEqual(result.custom, source.custom);
    assert.equal(result.sslEnabled, true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    var backup = file + '.prerepoint-20260929-120000.bak';
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), source);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    assert.equal(helper.apply(options('credentials', file, false)), 'already-patched');
  });
});

test('stock credentials stay stock-shaped with their original service-readable mode', function() {
  fixture(function(dir) {
    var file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({ accessKeyId: 'A'.repeat(20), secretAccessKey: 'S'.repeat(40), region: 'api' }), { mode: 0o644 });
    assert.equal(helper.apply(options('credentials', file, true)), 'already-patched');
    assert.equal(helper.apply(options('credentials', file, false)), 'already-patched');
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).endpoint, undefined);
  });
});

test('third-party service rules and patterns are normalized while local/internal routes survive', function() {
  fixture(function(dir) {
    var file = path.join(dir, 'region_config.json');
    var source = { rules: {
      'local/*': { endpoint: 'http://localhost:8080' },
      'internal/*': { endpoint: 'http://security:8080' },
      'api/media': { endpoint: 'http://joap.5x1.com:80', signatureVersion: 'v4' },
      '*/*': 'openjibo'
    }, patterns: {
      globalSSL: { endpoint: 'https://api.openjibo.com', wsendpoint: 'wss://api.openjibo.com', globalEndpoint: true },
      openjibo: { endpoint: 'https://api.openjibo.com' }
    } };
    fs.writeFileSync(file, JSON.stringify(source), { mode: 0o600 });
    assert.equal(helper.apply(options('region-config', file, true)), 'patched');
    assert.equal(helper.apply(options('region-config', file, false)), 'patched');
    var result = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(result.rules['local/*'], source.rules['local/*']);
    assert.deepEqual(result.rules['internal/*'], source.rules['internal/*']);
    assert.equal(result.rules['api/media'].endpoint, 'https://{region}.jibo.io');
    assert.equal(result.rules['api/media'].wsendpoint, 'wss://{region}-socket.jibo.io');
    assert.equal(result.rules['api/media'].signatureVersion, 'v4');
    assert.equal(result.rules['*/*'], 'globalSSL');
    assert.equal(result.patterns.globalSSL.endpoint, 'https://{region}.jibo.io');
    assert.equal(result.patterns.openjibo.wsendpoint, 'wss://{region}-socket.jibo.io');
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(helper.apply(options('region-config', file, true)), 'already-patched');
  });
});

test('a third-party notification suffix is replaced and a missing config is a no-op', function() {
  fixture(function(dir) {
    var file = path.join(dir, 'server.json');
    assert.equal(helper.apply(options('notification', file, true)), 'not-needed');
    fs.writeFileSync(file, JSON.stringify({ NotificationSubsystem: { serverURLSuffix: '-socket.openjibo.com' } }));
    assert.equal(helper.apply(options('notification', file, false)), 'patched');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).NotificationSubsystem.serverURLSuffix, '-socket.jibo.io');
    assert.equal(helper.apply(options('notification', file, true)), 'already-patched');
  });
});

test('malformed and symlinked inputs are refused before a backup or write', function() {
  fixture(function(dir) {
    var file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{bad');
    assert.throws(function() { helper.apply(options('region-config', file, false)); });
    assert.equal(fs.readdirSync(dir).length, 1);
    var link = path.join(dir, 'link.json');
    fs.symlinkSync(file, link);
    assert.throws(function() { helper.apply(options('region-config', link, false)); }, /symlinked/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  });
});

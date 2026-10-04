#!/usr/bin/env node
'use strict';

var assert = require('assert');
var patcher = require('./patch-ssm-wifi-check.cjs');

// RTM3 and the published jibo-ssm 12/13 have the same Wi-Fi check, with
// different indentation; RTM3 also ships with CRLF line endings.
function stock(eol, requestIndent) {
  var inner = new Array(requestIndent + 1).join(' ');
  var outer = new Array(requestIndent - 3).join(' ');
  return [
    'class Wifi {',
    '    init(cb) {',
    '            if (!err) {',
    '                this._jiboServerUrl = data.region + ".jibo.com";',
    '            }',
    '            else {',
    '                this._jiboServerUrl = this._wifiService.options.region + ".jibo.com";',
    '            }',
    '    }',
    '    _checkJiboServers(cb) {',
    outer + 'let options = {',
    inner + 'host: this._jiboServerUrl,',
    inner + "path: '/'",
    outer + '};',
    outer + 'let req = https.get(options, (res) => {});',
    '    }',
    '}'
  ].join(eol);
}

['\n', '\r\n'].forEach(function(eol) {
  [12, 16].forEach(function(requestIndent) {
    var patched = patcher.patchSource(stock(eol, requestIndent), 'jibo.io', '/etc/ssl/certs/ca-certificates.crt');
    assert.strictEqual(patched.indexOf('".jibo.com"'), -1);
    assert.strictEqual(patched.split('"api.jibo.io"').length - 1, 2);
    assert.ok(patched.indexOf("ca: require('fs').readFileSync(") >= 0);
    assert.ok(patched.indexOf('.match(/-----BEGIN CERTIFICATE-----') >= 0);
    assert.ok(patched.indexOf('rejectUnauthorized') < 0);
    assert.ok(patched.indexOf(new Array(requestIndent + 1).join(' ') + 'ca: require') >= 0);
    // Line endings are preserved: no bare LF appears in a CRLF file.
    if (eol === '\r\n') assert.strictEqual(/[^\r]\n/.test(patched), false);
    // The patched request still parses.
    new (require('vm').Script)("'use strict';\n" + patched);
    assert.strictEqual(patcher.patchSource(patched, 'jibo.io', '/etc/ssl/certs/ca-certificates.crt'), patched);
  });
});
assert.throws(function() { patcher.patchSource(stock('\n', 12) + stock('\n', 12).replace('class Wifi', 'class Other'), 'jibo.io', '/etc/x'); }, /exactly once/);
assert.ok(patcher.patchSource(stock('\n', 14), 'jibo.io', '/etc/x').indexOf('ca: require') >= 0);
assert.throws(function() { patcher.patchSource(stock('\n', 12), 'bad suffix', '/etc/x'); }, /invalid server suffix/);
var partial = stock('\n', 14).replace('data.region + ".jibo.com"', "data.region + '.openjibo.com'");
assert.ok(patcher.patchSource(partial, 'example.net', '/etc/x', 'stg-entrypoint').indexOf('"stg-entrypoint.example.net"') >= 0);
// The owner's 12.10.0 bundle (b0809e59...) has literal OpenJibo hosts in both
// credential branches, plus a separate diagnostic ping target outside Wi-Fi.
// Keep this synthetic regression free of the complete vendor bundle.
var migrated = 'const DOMAIN_LIST = { API: "api.openjibo.com" };\n' + stock('\n', 16)
  .replace('data.region + ".jibo.com"', '"api.openjibo.com"')
  .replace('this._wifiService.options.region + ".jibo.com"', '"api.openjibo.com"');
['api', 'stg-entrypoint'].forEach(function(region) {
  var output = patcher.patchSource(migrated, 'jibo.io', '/etc/ssl/certs/ca-certificates.crt', region);
  assert.strictEqual(output.split('this._jiboServerUrl = "' + region + '.jibo.io";').length - 1, 2);
  assert.strictEqual(output.indexOf('this._jiboServerUrl = "api.openjibo.com";'), -1);
  assert.ok(output.indexOf('const DOMAIN_LIST = { API: "api.openjibo.com" };') === 0);
  assert.ok(output.indexOf('.match(/-----BEGIN CERTIFICATE-----') >= 0);
  assert.strictEqual(patcher.patchSource(output, 'jibo.io', '/etc/ssl/certs/ca-certificates.crt', region), output);
});
assert.strictEqual(patcher.inspect(stock('\n', 12).replace('data.region + ".jibo.com"', "'joap.5x1.com'"), 'jibo.io', '/etc/x').state, 'patched');
var google = 'class Wifi { constructor() { this._jiboServerUrl = "google.com"; } _checkJiboServers() {} }';
assert.strictEqual(patcher.inspect(google, 'jibo.io', '/etc/x').state, 'not-needed (checks google.com)');
assert.strictEqual(patcher.patchSource(google, 'jibo.io', '/etc/x'), google);
var withComments = '// this._jiboServerUrl = data.region + ".jibo.com";\n' + stock('\n', 12);
assert.ok(patcher.patchSource(withComments, 'jibo.io', '/etc/x').indexOf('// this._jiboServerUrl = data.region + ".jibo.com";') === 0);
var formatted = stock('\n', 12).replace('host: this._jiboServerUrl,', "'host' : this._jiboServerUrl, // arbitrary spacing\n")
  .replace("path: '/'", '"path" : "/",');
new (require('vm').Script)("'use strict';\n" + patcher.patchSource(formatted, 'jibo.io', '/etc/x'));
assert.throws(function() { patcher.patchSource(stock('\n', 12).replace('data.region + ".jibo.com"', 'chooseServer()'), 'jibo.io', '/etc/x'); }, /hostname expression/);
assert.throws(function() { patcher.patchSource(stock('\n', 12).replace("path: '/'", "path: '/', rejectUnauthorized: false"), 'jibo.io', '/etc/x'); }, /disabled TLS/);
assert.throws(function() { patcher.patchSource(stock('\n', 12).replace("path: '/'", "path: '/', agent: unsafeAgent"), 'jibo.io', '/etc/x'); }, /request option/);
assert.throws(function() { patcher.patchSource(stock('\n', 12).replace('host: this._jiboServerUrl,', 'host: otherServer,'), 'jibo.io', '/etc/x'); }, /root-check/);
assert.throws(function() { patcher.patchSource(stock('\n', 12).replace("path: '/'", "path: '/', ca: 'fake' /* phoenix-ssm-wifi-check */"), 'jibo.io', '/etc/x'); }, /CA override/);
var once = patcher.patchSource(stock('\n', 12), 'example.net', '/etc/x');
var twice = patcher.patchSource(once, 'jibo.io', '/etc/x', 'api');
assert.strictEqual(twice.indexOf('api.example.net'), -1);
assert.strictEqual(patcher.patchSource(twice, 'jibo.io', '/etc/x'), twice);
process.stdout.write(JSON.stringify({ ok: true, checks: ['structural hostname/request checks', 'split CA bundle', 'arbitrary indentation and quotes', 'partial/third-party repoints', '12.10.0 literal OpenJibo branches', 'CRLF preserved', 'TLS and ambiguity refusal', 'idempotent'] }) + '\n');

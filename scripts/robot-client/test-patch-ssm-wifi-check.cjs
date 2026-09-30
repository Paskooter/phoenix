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
    '    }'
  ].join(eol);
}

['\n', '\r\n'].forEach(function(eol) {
  [12, 16].forEach(function(requestIndent) {
    var patched = patcher.patchSource(stock(eol, requestIndent), 'jibo.io', '/etc/ssl/certs/ca-certificates.crt');
    assert.strictEqual(patched.indexOf('".jibo.com"'), -1);
    assert.strictEqual(patched.split('".jibo.io"').length - 1, 2);
    assert.ok(patched.indexOf("ca: require('fs').readFileSync(") >= 0);
    assert.ok(patched.indexOf('.match(/-----BEGIN CERTIFICATE-----') >= 0);
    assert.ok(patched.indexOf('rejectUnauthorized') < 0);
    assert.ok(patched.indexOf(new Array(requestIndent + 1).join(' ') + 'ca: require') >= 0);
    // Line endings are preserved: no bare LF appears in a CRLF file.
    if (eol === '\r\n') assert.strictEqual(/[^\r]\n/.test(patched), false);
    // The patched request still parses.
    new (require('vm').Script)('(class { ' + patched.replace(/\r/g, '') + ' })');
  });
});
assert.throws(function() { patcher.patchSource(stock('\n', 12) + stock('\n', 12), 'jibo.io', '/etc/x'); }, /exactly once/);
assert.throws(function() { patcher.patchSource(stock('\n', 14), 'jibo.io', '/etc/x'); }, /request anchor/);
assert.throws(function() { patcher.patchSource(stock('\n', 12), 'bad suffix', '/etc/x'); }, /invalid server suffix/);
process.stdout.write(JSON.stringify({ ok: true, checks: ['server suffix', 'split CA bundle', 'RTM3 and jibo-ssm 12/13 indentation', 'CRLF preserved', 'anchor refusal'] }) + '\n');

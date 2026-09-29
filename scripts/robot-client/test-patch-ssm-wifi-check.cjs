#!/usr/bin/env node
'use strict';

var assert = require('assert');
var patcher = require('./patch-ssm-wifi-check.cjs');

// The shape of the RTM3 image's jibo-ssm (skills-service-manager.js), which ships with CRLF.
function stock(eol) {
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
    '        let options = {',
    '            host: this._jiboServerUrl,',
    "            path: '/'",
    '        };',
    '        let req = https.get(options, (res) => {});',
    '    }'
  ].join(eol);
}

['\n', '\r\n'].forEach(function(eol) {
  var patched = patcher.patchSource(stock(eol), 'jibo.io', '/etc/ssl/certs/ca-certificates.crt');
  assert.strictEqual(patched.indexOf('".jibo.com"'), -1);
  assert.strictEqual(patched.split('".jibo.io"').length - 1, 2);
  assert.ok(patched.indexOf("ca: require('fs').readFileSync(") >= 0);
  assert.ok(patched.indexOf('.match(/-----BEGIN CERTIFICATE-----') >= 0);
  assert.ok(patched.indexOf('rejectUnauthorized') < 0);
  // Line endings are preserved: no bare LF appears in a CRLF file.
  if (eol === '\r\n') assert.strictEqual(/[^\r]\n/.test(patched), false);
  // The patched request still parses.
  new (require('vm').Script)('(class { ' + patched.replace(/\r/g, '') + ' })');
});
assert.throws(function() { patcher.patchSource(stock('\n') + stock('\n'), 'jibo.io', '/etc/x'); }, /exactly once/);
assert.throws(function() { patcher.patchSource(stock('\n'), 'bad suffix', '/etc/x'); }, /invalid server suffix/);
process.stdout.write(JSON.stringify({ ok: true, checks: ['server suffix', 'split CA bundle', 'CRLF preserved', 'anchor refusal'] }) + '\n');

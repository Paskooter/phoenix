#!/usr/bin/env node
'use strict';

var assert = require('assert');
var patcher = require('./patch-ota-downloader-tls.cjs');

var stock = [
  "const fs = require('fs');",
  'let http = require("http");',
  'let req = http.get(argv.url, function(res) {',
  '  return res;',
  '});'
].join('\n');
var patched = patcher.patchSource(stock, '/etc/ssl/certs/ca-certificates.crt');
assert.strictEqual(patched.indexOf('JIBO_EXTRA_CA_CERTS') >= 0, true);
assert.strictEqual(patched.indexOf('ca: fs.readFileSync(_caPath)') >= 0, true);
assert.strictEqual(patched.indexOf('http.get(_getOpts') >= 0, true);
assert.strictEqual(patched.indexOf('rejectUnauthorized: false') < 0, true);
assert.throws(function() { patcher.patchSource('let req = http.get(argv.url, function(res) {\nlet req = http.get(argv.url, function(res) {', '/etc/x'); }, /exactly once/);
process.stdout.write(JSON.stringify({ ok: true, checks: ['explicit CA', 'executable helper patch anchor', 'no TLS bypass'] }) + '\n');

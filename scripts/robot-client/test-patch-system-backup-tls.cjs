#!/usr/bin/env node
'use strict';

// Unit-check the exact narrow transformations separately from the physical
// source-hash gate. The production utility refuses any source other than the
// pinned Release-13 helpers; this test deliberately uses compact synthetic
// snippets so the repository does not redistribute original robot source.
var assert = require('assert');
var patcher = require('./patch-system-backup-tls.cjs');

var backup = [
  "var fs = require('fs')",
  "var request = require('request');",
  'var options = {',
  "            method: 'PUT',",
  '            headers: {}',
  '};'
].join('\n');
var patchedBackup = patcher.patchBackup(backup, '/etc/ssl/certs/ca-certificates.crt');
assert.strictEqual(patchedBackup.indexOf('ca: phoenixTlsCA,') >= 0, true);
assert.strictEqual(patchedBackup.indexOf("fs.readFileSync(process.env.JIBO_EXTRA_CA_CERTS || '/etc/ssl/certs/ca-certificates.crt')") >= 0, true);
assert.strictEqual(patchedBackup.indexOf('rejectUnauthorized: false') < 0, true);

var restore = [
  "var fs = require('fs')",
  "var https = require('https');",
  'function download() {',
  '        https.get(downloadUrl, callbackDownload)',
  '}'
].join('\n');
var patchedRestore = patcher.patchRestore(restore, '/etc/ssl/certs/ca-certificates.crt');
assert.strictEqual(patchedRestore.indexOf("var url = require('url');") >= 0, true);
assert.strictEqual(patchedRestore.indexOf('phoenixDownloadOptions.ca = phoenixTlsCA;') >= 0, true);
assert.strictEqual(patchedRestore.indexOf('https.get(downloadUrl, callbackDownload)') < 0, true);

assert.throws(function() { patcher.patchBackup("var request = require('request');\n", '/etc/ssl/certs/ca-certificates.crt'); }, /anchor/);
assert.throws(function() { patcher.patchRestore("var https = require('https');\n", '/etc/ssl/certs/ca-certificates.crt'); }, /anchor/);

process.stdout.write(JSON.stringify({ ok: true, checks: ['explicit request CA', 'explicit https CA', 'no TLS bypass', 'anchor refusal'] }) + '\n');

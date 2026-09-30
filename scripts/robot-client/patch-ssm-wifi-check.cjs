#!/usr/bin/env node
/*
 * Make the Skills Service Manager's Wi-Fi verification reach this server.
 *
 * During setup, and whenever Jibo joins a network, jibo-ssm verifies the new
 * connection in three steps: associated, has an IP, then "can reach Jibo's
 * servers". On older firmware (the RTM2/RTM3 factory images) that third step is
 *
 *   this._jiboServerUrl = <region> + ".jibo.com";           // the original cloud
 *   https.get({ host: this._jiboServerUrl, path: '/' }, ...) // Node's built-in roots
 *
 * The original cloud is gone, and Node 4.1's built-in roots predate the public
 * root this server's certificate chains to, so the check fails either way and
 * setup stops at "Can't connect to Jibo's server" (error 4) before it ever asks
 * the server for credentials. Later firmware checks google.com instead and needs
 * nothing here.
 *
 * The patch changes only that check: the host suffix becomes this server's, and
 * the request gets the robot's maintained public CA bundle. It is anchored, not
 * hash-pinned, because jibo-ssm differs between firmware builds; each anchor must
 * appear exactly once, and anything else is refused. Node 4-compatible.
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var TARGET = '/usr/local/bin/jibo-ssm/lib/skills-service-manager.js';
var CA_PATH = '/etc/ssl/certs/ca-certificates.crt';
var MARKER = 'phoenix-ssm-wifi-check';
var SUFFIX_ANCHORS = [
  'this._jiboServerUrl = data.region + ".jibo.com";',
  'this._jiboServerUrl = this._wifiService.options.region + ".jibo.com";'
];
// RTM3 through jibo-ssm 11 indent this request by 12 spaces; the published
// jibo-ssm 12/13 builds indent it by 16. Both still use the same HTTPS check.
// The file ships with CRLF on at least RTM3, so preserve its line endings too.
function requestAnchor(eol, indent) {
  var inner = new Array(indent + 1).join(' ');
  var outer = new Array(indent - 3).join(' ');
  return [inner + 'host: this._jiboServerUrl,', inner + "path: '/'", outer + '};'].join(eol);
}

function findRequestAnchor(source, eol) {
  var matches = [12, 16].map(function(indent) {
    return { indent: indent, text: requestAnchor(eol, indent) };
  }).filter(function(candidate) {
    return source.indexOf(candidate.text) >= 0;
  });
  if (matches.length !== 1) throw new Error('request anchor was not found exactly once');
  exactlyOnce(source, matches[0].text, 'request anchor');
  return matches[0];
}
var LATER_FIRMWARE = "this._jiboServerUrl = 'google.com';";

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function utf8Buffer(text) {
  return typeof Buffer.alloc === 'function' ? Buffer.from(text, 'utf8') : new Buffer(text, 'utf8');
}

function exactlyOnce(source, needle, label) {
  var first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(label + ' was not found exactly once');
  }
}

function patchSource(source, suffix, caPath) {
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(suffix)) throw new Error('invalid server suffix: ' + suffix);
  SUFFIX_ANCHORS.forEach(function(anchor, index) { exactlyOnce(source, anchor, 'server url anchor ' + (index + 1)); });
  var eol = source.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  var request = findRequestAnchor(source, eol);
  var inner = new Array(request.indent + 1).join(' ');
  var outer = new Array(request.indent - 3).join(' ');
  var output = source;
  SUFFIX_ANCHORS.forEach(function(anchor) {
    output = output.replace(anchor, anchor.replace('".jibo.com"', '".' + suffix + '"'));
  });
  return output.replace(request.text, [
    inner + 'host: this._jiboServerUrl,',
    inner + "path: '/',",
    inner + '// ' + MARKER + ': Node 4 has no root for this server; use the robot\'s maintained bundle,',
    inner + '// split into certificates because Node 4 reads only the first one of a PEM bundle.',
    inner + "ca: require('fs').readFileSync(process.env.JIBO_EXTRA_CA_CERTS || '" + caPath + "', 'utf8')",
    inner + "    .match(/-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----/g)",
    outer + '};'
  ].join(eol));
}

function writeAtomic(filename, bytes, mode) {
  var temporary = filename + '.phoenix-ssm-' + process.pid + '-' + Math.random().toString(16).slice(2);
  try {
    fs.writeFileSync(temporary, bytes, { mode: mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
}

function parseArgs(argv) {
  var result = { dryRun: false, suffix: 'jibo.io', target: TARGET };
  for (var index = 0; index < argv.length; index += 1) {
    var arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--suffix') { result.suffix = argv[index + 1]; index += 1; }
    else if (arg === '--target') { result.target = argv[index + 1]; index += 1; }
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: patch-ssm-wifi-check.cjs [--suffix jibo.io] [--dry-run]\n');
      process.exit(0);
    } else throw new Error('unknown argument: ' + arg);
  }
  return result;
}

function apply(options) {
  if (!fs.existsSync(options.target)) return 'not-needed (no jibo-ssm at ' + options.target + ')';
  var stat = fs.lstatSync(options.target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('jibo-ssm must be a regular file: ' + options.target);
  var source = fs.readFileSync(options.target, 'utf8');
  if (source.indexOf(MARKER) >= 0) {
    if (source.indexOf('".' + options.suffix + '";') < 0) throw new Error('jibo-ssm was patched for a different server');
    return 'already-patched';
  }
  if (source.indexOf(LATER_FIRMWARE) >= 0 && source.indexOf('".jibo.com";') < 0) return 'not-needed (checks google.com)';
  var output = utf8Buffer(patchSource(source, options.suffix, CA_PATH));
  if (options.dryRun) return 'patched';
  var backup = options.target + '.phoenix-ssm.bak';
  if (!fs.existsSync(backup)) writeAtomic(backup, utf8Buffer(source), stat.mode & 0o777);
  writeAtomic(options.target, output, stat.mode & 0o777);
  if (sha256(fs.readFileSync(options.target)) !== sha256(output)) throw new Error('jibo-ssm did not verify after writing');
  return 'patched';
}

if (require.main === module) {
  try { process.stdout.write(apply(parseArgs(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write('patch-ssm-wifi-check: ' + error.message + '\n'); process.exit(2); }
}

module.exports = { patchSource: patchSource };

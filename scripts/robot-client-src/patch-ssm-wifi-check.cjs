#!/usr/bin/env node
/*
 * Source for the self-contained robot patcher. Rebuild with
 * node scripts/build-robot-wifi-patcher.mjs; never hand-edit its generated copy.
 *
 * Inspect syntax, not whole-file hashes or exact indentation. Only the Wi-Fi
 * class's recognized hostname assignments and HTTPS root-check options change.
 * The bundled parser runs on factory Node 4, with no network/npm on the robot.
 */
'use strict';

var acorn = require('acorn'); // replaced with the bundled parser by the builder
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var TARGET = '/usr/local/bin/jibo-ssm/lib/skills-service-manager.js';
var CA_PATH = '/etc/ssl/certs/ca-certificates.crt';
var MARKER = 'phoenix-ssm-wifi-check';

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node) === false) return;
  Object.keys(node).forEach(function(key) {
    var value = node[key];
    if (Array.isArray(value)) value.forEach(function(child) { walk(child, visit); });
    else if (value && typeof value === 'object') walk(value, visit);
  });
}

function name(node) {
  if (!node) return '';
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    var property = node.computed ? (node.property.type === 'Literal' ? node.property.value : '') : name(node.property);
    return property ? name(node.object) + '.' + property : '';
  }
  return '';
}

function propertyName(node) {
  return node.key.type === 'Identifier' && !node.computed ? node.key.name : node.key.value;
}

function exactlyOne(items, label) {
  if (items.length !== 1) throw new Error(label + ' was not found exactly once (found ' + items.length + ')');
  return items[0];
}

function parse(source) {
  return acorn.parse(source, { ecmaVersion: 2018, locations: true });
}

function caExpression(caPath) {
  return "require('fs').readFileSync(process.env.JIBO_EXTRA_CA_CERTS || " + JSON.stringify(caPath) + ", 'utf8')" +
    '.match(/-----BEGIN CERTIFICATE-----[\\s\\S]+?-----END CERTIFICATE-----/g)';
}

function syntaxShape(node) {
  if (Array.isArray(node)) return node.map(syntaxShape);
  if (!node || typeof node !== 'object') return node;
  var shape = {};
  Object.keys(node).forEach(function(key) {
    if (['start', 'end', 'loc', 'raw'].indexOf(key) < 0) shape[key] = syntaxShape(node[key]);
  });
  return shape;
}

function sameSyntax(a, b) {
  return JSON.stringify(syntaxShape(a)) === JSON.stringify(syntaxShape(b));
}

function recognizedHost(node) {
  if (node.type === 'Literal') return typeof node.value === 'string' && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(node.value);
  return node.type === 'BinaryExpression' && node.operator === '+' &&
    ['data.region', 'this._wifiService.options.region'].indexOf(name(node.left)) >= 0 &&
    node.right.type === 'Literal' && typeof node.right.value === 'string' &&
    /^\.[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(node.right.value);
}

function inspect(source, suffix, caPath, region) {
  region = region || 'api';
  if (!/^(?:[a-z0-9][a-z0-9-]*\.)+[a-z0-9][a-z0-9-]*$/.test(suffix)) throw new Error('invalid server suffix');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(region)) throw new Error('invalid server region');
  if (!path.isAbsolute(caPath)) throw new Error('invalid CA path');
  var classes = [];
  walk(parse(source), function(node) {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      var methods = node.body.body.filter(function(method) { return propertyName(method) === '_checkJiboServers'; });
      if (methods.length) classes.push({ node: node, method: exactlyOne(methods, 'Wi-Fi check method') });
    }
  });
  var wifi = exactlyOne(classes, 'Wi-Fi check class');
  var assignments = [];
  walk(wifi.node, function(node) {
    if (node !== wifi.node && (node.type === 'ClassDeclaration' || node.type === 'ClassExpression')) return false;
    if (node.type === 'AssignmentExpression' && name(node.left) === 'this._jiboServerUrl') {
      if (node.operator !== '=') throw new Error('unrecognized Wi-Fi hostname assignment');
      if (node.right.type === 'Literal' && node.right.value === null) return;
      if (!recognizedHost(node.right)) throw new Error('unrecognized Wi-Fi hostname expression');
      assignments.push(node.right);
    }
  });
  if (assignments.length < 1 || assignments.length > 2) throw new Error('unrecognized Wi-Fi hostname initialization');
  if (assignments.length === 1 && assignments[0].type === 'Literal' && assignments[0].value === 'google.com') {
    return { state: 'not-needed (checks google.com)', output: source };
  }
  var calls = [];
  var declarations = [];
  walk(wifi.method.value.body, function(node) {
    if (node.type === 'CallExpression' && name(node.callee) === 'https.get') calls.push(node);
    if (node.type === 'VariableDeclarator') declarations.push(node);
  });
  var request = exactlyOne(calls, 'Wi-Fi HTTPS request');
  if (request.arguments.length !== 2 || request.arguments[0].type !== 'Identifier') throw new Error('unrecognized Wi-Fi request arguments');
  var binding = exactlyOne(declarations.filter(function(node) { return name(node.id) === request.arguments[0].name; }), 'Wi-Fi request options');
  var references = 0;
  walk(wifi.method.value.body, function(node) {
    if (node.type === 'Identifier' && node.name === binding.id.name) references += 1;
  });
  if (references !== 2) throw new Error('Wi-Fi request options are used or modified outside the reviewed request');
  if (!binding.init || binding.init.type !== 'ObjectExpression') throw new Error('Wi-Fi options must be a literal object');
  var options = binding.init;
  var fields = {};
  options.properties.forEach(function(field) {
    var key = propertyName(field);
    if (field.type !== 'Property' || field.computed || field.kind !== 'init' || fields[key] ||
      ['host', 'path', 'port', 'ca', 'rejectUnauthorized'].indexOf(key) < 0) throw new Error('unrecognized or duplicate Wi-Fi request option');
    fields[key] = field;
  });
  if (!fields.host || name(fields.host.value) !== 'this._jiboServerUrl' ||
    !fields.path || fields.path.value.type !== 'Literal' || fields.path.value.value !== '/') throw new Error('unrecognized Wi-Fi root-check request');
  if (fields.port && (fields.port.value.type !== 'Literal' || fields.port.value.value !== 443)) throw new Error('Wi-Fi check must use HTTPS port 443');
  if (fields.rejectUnauthorized && (fields.rejectUnauthorized.value.type !== 'Literal' || fields.rejectUnauthorized.value.value !== true)) {
    throw new Error('Wi-Fi check has disabled TLS verification');
  }
  var ca = caExpression(caPath);
  var expectedCA = parse('(' + ca + ')').body[0].expression;
  if (fields.ca && !sameSyntax(fields.ca.value, expectedCA)) throw new Error('Wi-Fi check has an unrecognized CA override');
  var edits = assignments.map(function(node) { return { start: node.start, end: node.end, value: JSON.stringify(region + '.' + suffix) }; });
  if (!fields.ca) {
    var eol = source.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var indent = new Array(options.properties[0].loc.start.column + 1).join(' ');
    var last = options.properties[options.properties.length - 1];
    edits.push({ start: last.end, end: last.end, value: ',' + eol + indent + '// ' + MARKER + ': use the maintained public CA bundle.' + eol +
      indent + '// Node 4 needs individual PEM certificates, not one concatenated string.' + eol + indent + 'ca: ' + ca });
  }
  edits.sort(function(a, b) { return b.start - a.start; });
  var output = source;
  edits.forEach(function(edit) { output = output.slice(0, edit.start) + edit.value + output.slice(edit.end); });
  parse(output); // Syntax validation before any file is written; never execute SSM.
  return { state: output === source ? 'already-patched' : 'patched', output: output };
}

function patchSource(source, suffix, caPath, region) {
  return inspect(source, suffix, caPath, region).output;
}

function utf8Buffer(text) {
  return typeof Buffer.alloc === 'function' ? Buffer.from(text, 'utf8') : new Buffer(text, 'utf8');
}

function regularFile(filename) {
  var stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('refusing non-regular or symlinked Wi-Fi source/backup');
  return stat;
}

function writeAtomic(filename, bytes, stat) {
  var temporary = filename + '.phoenix-ssm-' + process.pid;
  var fd = fs.openSync(temporary, 'wx', stat.mode & 0o777);
  try {
    try {
      var offset = 0;
      while (offset < bytes.length) {
        var written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) throw new Error('could not complete file write');
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.chownSync(temporary, stat.uid, stat.gid);
    fs.chmodSync(temporary, stat.mode & 0o777);
    fs.renameSync(temporary, filename);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (ignored) {}
    throw error;
  }
}

function parseArgs(argv) {
  var result = { dryRun: false, suffix: 'jibo.io', region: 'api', target: TARGET };
  for (var index = 0; index < argv.length; index += 1) {
    var arg = argv[index];
    if (arg === '--dry-run') result.dryRun = true;
    else if (['--suffix', '--region', '--target'].indexOf(arg) >= 0) {
      if (!argv[index + 1]) throw new Error(arg + ' requires a value');
      result[arg.slice(2)] = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: patch-ssm-wifi-check.cjs [--suffix jibo.io] [--region api] [--dry-run]\n');
      process.exit(0);
    } else throw new Error('unknown argument: ' + arg);
  }
  return result;
}

function apply(options) {
  if (!fs.existsSync(options.target)) return 'not-needed (no jibo-ssm at ' + options.target + ')';
  var stat = regularFile(options.target);
  if (stat.size > 5 * 1024 * 1024) throw new Error('Wi-Fi source exceeds safe parsing limit');
  var original = fs.readFileSync(options.target, 'utf8');
  var result;
  try { result = inspect(original, options.suffix, CA_PATH, options.region); }
  catch (error) { throw new Error(error.message + '; source SHA-256=' + crypto.createHash('sha256').update(original).digest('hex')); }
  if (options.dryRun || result.state !== 'patched') return result.state;
  var backup = options.target + '.phoenix-ssm.bak';
  if (!fs.existsSync(backup)) writeAtomic(backup, utf8Buffer(original), stat);
  else regularFile(backup);
  writeAtomic(options.target, utf8Buffer(result.output), stat);
  if (fs.readFileSync(options.target, 'utf8') !== result.output) throw new Error('Wi-Fi source did not verify after writing');
  return result.state;
}

if (require.main === module) {
  try { process.stdout.write(apply(parseArgs(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write('patch-ssm-wifi-check: ' + error.message + '\n'); process.exit(2); }
}

module.exports = { patchSource: patchSource, inspect: inspect, apply: apply };

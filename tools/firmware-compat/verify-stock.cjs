/* Archive-backed verification, compatible with real Node 4.1.2 and 6.9.2. */
'use strict';
var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var mode = process.argv[2];
var repo = process.argv[3];
var helpers = path.join(repo, 'scripts/robot-client');
var shell = fs.readFileSync(path.join(repo, 'scripts/robot-ota-repoint.sh'), 'utf8');
var checks = [];
var failures = [];
var installedSkills = [];

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function script(bytes) { return String(bytes).replace(/^#![^\n]*\n/, ''); }
function pin(name) { return shell.match(new RegExp('^' + name + '="([a-f0-9]{64})"', 'm'))[1]; }
function check(label, callback) {
  try { checks.push({ check: label, result: callback() || 'passed' }); }
  catch (error) { failures.push({ check: label, error: error.message, stack: error.stack }); }
}
function mkdir(directory) {
  if (fs.existsSync(directory)) return;
  mkdir(path.dirname(directory));
  fs.mkdirSync(directory);
}
function remove(directory) {
  fs.readdirSync(directory).forEach(function(name) {
    var target = path.join(directory, name);
    if (fs.lstatSync(target).isDirectory()) remove(target); else fs.unlinkSync(target);
  });
  fs.rmdirSync(directory);
}

if (mode === 'clients') {
  var skillRoot = null;
  process.argv.slice(4).forEach(function(root) {
    if (root.indexOf('/tree/Skills/') >= 0) skillRoot = root.split('/tree/Skills/')[0] + '/tree/Skills';
    check('client ' + root, function() {
      var handler = path.join(root, 'lib/http/node.js');
      var digest = sha(fs.readFileSync(handler));
      var replacement;
      if (digest === pin('STOCK_CLIENT_V2_SHA256')) replacement = 'node-v2.js';
      else if (digest === pin('STOCK_CLIENT_V3_SHA256')) replacement = 'node.js';
      else throw new Error('unreviewed stock client hash: ' + digest);
      fs.writeFileSync(handler, fs.readFileSync(path.join(helpers, replacement)));
      fs.writeFileSync(path.join(root, 'lib/http/phoenix-ca.pem'), fs.readFileSync(path.join(helpers, 'isrg-root-x1.pem')));
      var config = JSON.parse(fs.readFileSync(path.join(root, 'lib/region_config.json'), 'utf8'));
      require(path.join(helpers, 'repoint-cloud-config.cjs')).normalizeRegionConfig(config, 'api', 'jibo.io');
      fs.writeFileSync(path.join(root, 'lib/region_config.json'), JSON.stringify(config));
      var client = require(root);
      var agent = new client.NodeHttpClient().sslAgent();
      assert.strictEqual(agent.options.rejectUnauthorized, true);
      assert.strictEqual(sha(agent.options.ca), pin('ROOT_PEM_SOURCE_SHA256'));
      var isOtaClient = /\/node_modules\/@jibo\/jibo-server-client$/.test(root);
      if (isOtaClient) assert.strictEqual(typeof client.Update, 'function', 'archived scoped client exposes native OTA API');
      if (typeof client.Update === 'function') {
        ['api', 'stg-entrypoint'].forEach(function(region) {
          var update = new client.Update({ region: region });
          assert.strictEqual(update.endpoint.hostname, region + '.jibo.io');
          assert.strictEqual(update.endpoint.protocol, 'https:');
          assert.strictEqual(typeof update.getUpdateFrom, 'function');
        });
      }
      return { version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
               original_sha256: digest, replacement: replacement, module_load: true, ca_verified: true,
               ota_endpoints: typeof client.Update === 'function' ? ['api.jibo.io', 'stg-entrypoint.jibo.io'] : null,
               role: isOtaClient ? 'scoped client' : 'legacy unscoped dependency' };
    });
  });
  if (skillRoot) {
    function skill(directory) {
      var manifest = path.join(directory, 'package.json');
      if (!fs.existsSync(manifest)) return;
      var data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      installedSkills.push({ name: data.name, version: data.version, package_sha256: sha(fs.readFileSync(manifest)) });
    }
    fs.readdirSync(skillRoot).forEach(function(name) {
      var directory = path.join(skillRoot, name);
      if (!fs.statSync(directory).isDirectory()) return;
      if (name.charAt(0) === '@') fs.readdirSync(directory).forEach(function(child) { skill(path.join(directory, child)); });
      else skill(directory);
    });
  }
} else if (mode === 'files') {
  var report = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  var objects = process.argv[5];
  var sandbox = path.join(objects, 'verify-' + process.pid);
  mkdir(sandbox);
  var entries = [];
  Object.keys(report.images).forEach(function(part) { entries = entries.concat(report.images[part].files); });
  function target(filename) { return filename.charAt(0) === '/' ? sandbox + filename : filename; }
  entries.forEach(function(item) {
    var dest = target(item.path);
    mkdir(path.dirname(dest));
    fs.writeFileSync(dest, fs.readFileSync(path.join(objects, item.sha256)));
    fs.chmodSync(dest, parseInt(item.mode, 8));
  });
  // Execute the exact published CLI with filesystem calls redirected to the
  // isolated archived tree. Absolute robot paths never reach the host filesystem.
  function invoke(name, args) {
    var filename = path.join(helpers, name + '.cjs');
    var redirected = {};
    Object.keys(fs).forEach(function(key) {
      if (typeof fs[key] !== 'function') { redirected[key] = fs[key]; return; }
      redirected[key] = function() {
        var values = Array.prototype.slice.call(arguments);
        if (typeof values[0] === 'string') values[0] = target(values[0]);
        if ((key === 'renameSync' || key === 'linkSync') && typeof values[1] === 'string') values[1] = target(values[1]);
        return fs[key].apply(fs, values);
      };
    });
    var output = '';
    var errors = '';
    var result = { status: 0 };
    var module = { exports: {} };
    function load(name) { return name === 'fs' ? redirected : require(name); }
    load.main = module;
    var context = { require: load, module: module, exports: module.exports, Buffer: Buffer,
      __filename: filename, __dirname: helpers, console: console, process: {
        argv: [process.execPath, filename].concat(args), env: {}, pid: process.pid,
        stdout: { write: function(value) { output += value; } },
        stderr: { write: function(value) { errors += value; } },
        exit: function(code) { result.status = code; throw { cliExit: true }; }
      } };
    try { vm.runInNewContext(script(fs.readFileSync(filename, 'utf8')), context, { filename: filename }); }
    catch (error) { if (!error.cliExit) throw error; }
    assert.strictEqual(result.status, 0, errors);
    return output.trim();
  }
  function cliCycle(name, args, filename, optional) {
    var before = filename && fs.existsSync(target(filename)) ? fs.readFileSync(target(filename)) : null;
    var dry = invoke(name, args.concat(['--dry-run']));
    if (before) assert.strictEqual(sha(fs.readFileSync(target(filename))), sha(before), 'preflight is read-only');
    var applied = invoke(name, args);
    var changed = filename && fs.existsSync(target(filename)) ? sha(fs.readFileSync(target(filename))) : null;
    var repeated = invoke(name, args);
    if (changed) assert.strictEqual(sha(fs.readFileSync(target(filename))), changed, 'repeat preserves output');
    if (!optional && /not-needed/.test(applied)) throw new Error('required target missing');
    return { dry_run: dry, apply: applied, repeat: repeated };
  }
  try {
    entries.filter(function(item) { return /\/jibo-server-client\/lib\/region_config.json$/.test(item.path); }).forEach(function(item) {
      check('region config ' + item.path, function() {
        return cliCycle('repoint-cloud-config', ['--kind', 'region-config', '--file', item.path, '--region', 'api',
          '--suffix', 'jibo.io', '--stamp', '20261003-000000'], item.path);
      });
    });
    [['setup', '/opt/jibo/Jibo/Skills/oobe-config/config.json'],
     ['notification', '/usr/local/etc/jibo-server-service.json']].forEach(function(pair) {
      check(pair[0] + ' config', function() {
        return cliCycle('repoint-cloud-config', ['--kind', pair[0], '--file', pair[1], '--region', 'api',
          '--suffix', 'jibo.io', '--stamp', '20261003-000000'], pair[1], true);
      });
    });
    check('OTA downloader', function() {
      var filename = '/usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js';
      var result = cliCycle('patch-ota-downloader-tls', [], filename);
      assert.strictEqual(fs.statSync(target(filename)).mode & 0o777, 0o755);
      new vm.Script(script(fs.readFileSync(target(filename), 'utf8')));
      return result;
    });
    check('Wi-Fi check', function() {
      var filename = '/usr/local/bin/jibo-ssm/lib/skills-service-manager.js';
      var result = cliCycle('patch-ssm-wifi-check', ['--region', 'api', '--suffix', 'jibo.io'], filename, true);
      // The bundled SSM contains pre-existing default parameters absent from
      // rootfs Node 4's grammar. Apply its patch with the rootfs runtime, but
      // parse the entire SSM with Node 6; never mistake stock syntax for a new
      // patch incompatibility or execute the robot's service during this audit.
      if (fs.existsSync(target(filename))) {
        var parse = require('child_process').spawnSync(process.env.PHOENIX_AUDIT_NODE6 || process.execPath,
          ['-e', 'new (require("vm").Script)(require("fs").readFileSync(process.argv[1],"utf8"));', target(filename)],
          { encoding: 'utf8' });
        assert.strictEqual(parse.status, 0, parse.stderr);
        result.bundle_syntax_runtime = 'v6.9.2';
      }
      return result;
    });
    if (fs.existsSync(target('/usr/local/bin/jibo-system-backup')) || fs.existsSync(target('/usr/local/bin/jibo-system-restore'))) {
      check('backup and restore', function() {
        var result = cliCycle('patch-system-backup-tls', [], '/usr/local/bin/jibo-system-backup');
        ['backup', 'restore'].forEach(function(name) { new vm.Script(script(fs.readFileSync(target('/usr/local/bin/jibo-system-' + name), 'utf8'))); });
        return result;
      });
    }
    check('setup screen text (optional)', function() {
      try { return cliCycle('patch-oobe-setup-text', ['--suffix', 'jibo.io'], '/opt/jibo/Jibo/Skills/oobe-config/assets/oobe/oobe.js', true); }
      catch (error) { return { skipped_by_repoint: true, reason: error.message }; }
    });
    check('native manager OTA route', function() {
      var manager = report.images.services.native_manager;
      assert.ok(manager.bytes > 0);
      assert.ok(manager.update_routes.some(function(value) { return value.indexOf('^/update') === 0; }), 'missing native OTA route');
      assert.ok(manager.query_helpers.indexOf('/usr/bin/jibo-get-update') >= 0, 'missing native query helper');
      var config = JSON.parse(fs.readFileSync(target('/usr/local/etc/jibo-system-manager.json'), 'utf8'));
      var subsystems = config.SystemManager.update.subsystems;
      ['os', 'services', 'oobe-config', '@be/be'].forEach(function(name) {
        assert.ok(subsystems[name], 'native manager does not configure ' + name);
      });
    });
    check('runtime matches the archived binary', function() {
      assert.strictEqual(process.version, 'v' + report.images.rootfs.node_version);
    });
    check('required shell tools', function() {
      var tools = report.images.rootfs.tools;
      Object.keys(tools).forEach(function(name) { assert.ok(tools[name], 'missing ' + name); });
    });
  } finally { remove(sandbox); }
} else throw new Error('expected clients or files');
process.stdout.write(JSON.stringify({ runtime: process.version, checks: checks, failures: failures,
  installed_skills: installedSkills }) + '\n');
process.exit(failures.length ? 1 : 0);

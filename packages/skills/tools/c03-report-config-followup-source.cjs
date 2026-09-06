#!/usr/bin/env node
// Source-only C-03 follow-up probe. Run in pinned Node 8 with the frozen
// Pegasus tree mounted at C03_REPORT_SOURCE. This intentionally exercises the
// source EnvVars cache and the minimist/parseInt expression used by the report
// run-service entrypoint without starting a service.

const path = require('path');

const sourceRoot = process.env.C03_REPORT_SOURCE;
if (!sourceRoot) {
  console.error('C03_REPORT_SOURCE is required');
  process.exit(2);
}

const { EnvVars } = require(path.join(sourceRoot, 'packages/report-skill/lib/EnvVars'));
const minimist = require(path.join(sourceRoot, 'node_modules/minimist'));

const envNames = ['NET_lasso', 'NET_settings', 'prefsFromConfig', 'ETCO_server_port', 'PORT'];
const original = {};
envNames.forEach((name) => {
  original[name] = process.env[name];
  delete process.env[name];
});

function restore() {
  envNames.forEach((name) => {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  });
  EnvVars.clearCache();
}

function snapshot(label) {
  return { label, vars: EnvVars.get() };
}

function runCacheProbe() {
  EnvVars.clearCache();
  process.env.NET_lasso = 'first:1';
  process.env.NET_settings = 'settings:1';
  const first = EnvVars.get();
  first.NET_lasso = 'mutated:in-place';
  process.env.NET_lasso = 'second:2';
  const second = EnvVars.get();
  EnvVars.clearCache();
  const third = EnvVars.get();
  return {
    sameBeforeClear: first === second,
    mutatedValueBeforeClear: second.NET_lasso,
    refreshedAfterClear: first !== third,
    valueAfterClear: third.NET_lasso,
  };
}

function runArgvProbe() {
  const cases = [
    { label: 'repeated-long', args: ['--port', '8123', '--port', '9234'], env: {} },
    { label: 'repeated-short', args: ['-p', '8123', '-p', '9234'], env: {} },
    { label: 'repeated-mixed', args: ['-p=8123', '--p=9234'], env: {} },
    { label: 'short-cluster', args: ['-xp8765'], env: {} },
    { label: 'short-cluster-with-value', args: ['-vp', '8765'], env: {} },
    { label: 'duplicate-zero', args: ['--port=0', '--port=9234'], env: {} },
    { label: 'object-and-scalar', args: ['--port.x=8123', '--port=9234'], env: {} },
    { label: 'short-exponent-plus', args: ['-p1e+3'], env: {} },
    { label: 'negation-after-set', args: ['--p=8123', '--no-p'], env: {} },
    { label: 'negation-before-set', args: ['--no-p', '--port=9234'], env: {} },
    { label: 'positional-and-end', args: ['one', '2', '--', '3'], env: {} },
    { label: 'help', args: ['--help'], env: {} },
    { label: 'short-help', args: ['-h'], env: {} },
    { label: 'default', args: [], env: {} },
    { label: 'short', args: ['-p', '1234'], env: { ETCO_server_port: '2345' } },
    { label: 'long', args: ['--port', '2345'], env: { ETCO_server_port: '3456' } },
    { label: 'long-equals', args: ['--port=3456'], env: {} },
    { label: 'long-short-name', args: ['--p', '3457'], env: {} },
    { label: 'long-short-name-equals', args: ['--p=3458'], env: {} },
    { label: 'short-equals', args: ['-p=4567'], env: {} },
    { label: 'short-wins', args: ['-p', '4567', '--port', '5678'], env: { ETCO_server_port: '6789' } },
    { label: 'etco', args: [], env: { ETCO_server_port: '7890' } },
    { label: 'zero', args: ['--port', '0'], env: { ETCO_server_port: '7890' } },
    { label: 'prefix-parse', args: ['--port', '08tail'], env: {} },
    { label: 'hex-parse', args: ['--port', '0x10'], env: {} },
    { label: 'port-env-is-ignored', args: [], env: { ETCO_server_port: '8123', PORT: '9123' } },
  ];
  return cases.map((entry) => {
    delete process.env.ETCO_server_port;
    delete process.env.PORT;
    if (entry.env.ETCO_server_port !== undefined) process.env.ETCO_server_port = entry.env.ETCO_server_port;
    if (entry.env.PORT !== undefined) process.env.PORT = entry.env.PORT;
    const argv = minimist(entry.args);
    const raw = argv.p || argv.port || process.env.ETCO_server_port || '8080';
    return {
      label: entry.label,
      args: entry.args,
      env: entry.env,
      argv,
      raw,
      port: parseInt(raw),
    };
  });
}

const result = {
  sourceRoot,
  runtime: process.version,
  sourceEnv: path.join(sourceRoot, 'packages/report-skill/lib/EnvVars.js'),
  sourceRunService: path.join(sourceRoot, 'packages/report-skill/scripts/run-service.js'),
  defaults: snapshot('defaults'),
  cache: runCacheProbe(),
  argv: runArgvProbe(),
};

restore();
console.log(JSON.stringify(result));

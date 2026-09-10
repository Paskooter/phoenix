import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnvVars, net, etco, boolEnv } from '../src/env.js';

test('readEnvVars reproduces the reference defaults/precedence contract', () => {
  // packages/utils/src/config/EnvVars.ts:11-19
  const env = { NET_parser: 'parser:9090', ETCO_hub_recordSpeechHistory: '' };
  const resolved = readEnvVars({
    ETCO_hub_disableAuth: 'false',
    NET_parser: 'docker.for.mac.localhost:9005',
    ETCO_hub_recordSpeechHistory: 'false',
  }, env);
  assert.deepEqual(resolved, {
    ETCO_hub_disableAuth: 'false',
    NET_parser: 'parser:9090',
    // source: process.env[key] || defaults[key] - an empty value takes the default.
    ETCO_hub_recordSpeechHistory: 'false',
  });
  assert.equal(Object.getPrototypeOf(resolved), Object.prototype);
  // Key order follows the defaults object, exactly as Object.keys(defaults) does.
  assert.deepEqual(Object.keys(resolved), ['ETCO_hub_disableAuth', 'NET_parser', 'ETCO_hub_recordSpeechHistory']);
});

test('readEnvVars throws the source required-variable message for a null default', () => {
  assert.throws(
    () => readEnvVars({ NET_lasso: null }, {}),
    { name: 'Error', message: "Required env variable 'NET_lasso' does not exist" },
  );
  // Empty is falsy too, so an explicitly empty required value throws as well.
  assert.throws(() => readEnvVars({ NET_lasso: null }, { NET_lasso: '' }), /Required env variable 'NET_lasso' does not exist/);
  // A supplied value satisfies the requirement and stays a string.
  assert.deepEqual(readEnvVars({ NET_lasso: null }, { NET_lasso: 'lasso:8080' }), { NET_lasso: 'lasso:8080' });
  // A non-null default never throws, even when unset.
  assert.deepEqual(readEnvVars({ NET_lasso: 'lasso:8080' }, {}), { NET_lasso: 'lasso:8080' });
});

test('net() prefixes http:// and reads NET_<name>', () => {
  process.env.NET_parser = 'parser:8080';
  assert.equal(net('parser'), 'http://parser:8080');
  process.env.NET_parser = 'https://parser.example';
  assert.equal(net('parser'), 'https://parser.example');
  delete process.env.NET_parser;
});

test('net() required-throws when unset and no default', () => {
  delete process.env.NET_missing;
  assert.throws(() => net('missing'), /NET_missing is required/);
  assert.equal(net('missing', { required: false }), null);
  assert.equal(net('missing', { default: 'host:1' }), 'http://host:1');
});

test('etco() reads ETCO_<scope>_<key> and required-throws', () => {
  process.env.ETCO_hub_disableAuth = 'true';
  assert.equal(etco('hub', 'disableAuth'), 'true');
  delete process.env.ETCO_hub_disableAuth;
  assert.throws(() => etco('hub', 'disableAuth'), /ETCO_hub_disableAuth is required/);
  assert.equal(etco('hub', 'disableAuth', 'false'), 'false');
});

test('boolEnv coerces flag strings', () => {
  assert.equal(boolEnv('true'), true);
  assert.equal(boolEnv('FALSE'), false);
  assert.equal(boolEnv(undefined, true), true);
  assert.equal(boolEnv('', false), false);
});

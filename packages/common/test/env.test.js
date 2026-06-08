import { test } from 'node:test';
import assert from 'node:assert/strict';
import { net, etco, boolEnv } from '../src/env.js';

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

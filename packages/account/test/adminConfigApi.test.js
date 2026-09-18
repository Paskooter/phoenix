// The admin configuration surface over the wire: who may reach it, what it
// reports about where each value came from, and what it refuses to do.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-admin-cfg-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');

// A .env of our own, so the test never reads or writes the repository's.
const envPath = join(dir, '.env');
writeFileSync(envPath, [
  '# a comment that must survive every write',
  'ETCO_account_region=api',
  'HUB_TOKEN_SECRET=dev-hub-token-secret',
  '#PARAKEET_URL=http://192.168.1.252:6972',
  '',
].join('\n'));
process.env.PHOENIX_ENV_FILE = envPath;

// A variable set in the real environment, to prove it is reported locked. It
// must not also be in the file, or it would look like a file value.
process.env.ETCO_classic_upstreamTimeoutMS = '4321';

const { loadDotEnv } = await import('@phoenix/common');
loadDotEnv(); // fills from envPath, recording which keys came from the file

const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');

let server; let base; let store;
const jars = new Map();

async function call(method, path, body, jar = 'admin') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jars.get(jar) ? { cookie: jars.get(jar) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars.set(jar, setCookie.split(';')[0]);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const find = (settings, key) => settings.find((s) => s.key === key);

before(async () => {
  store = new Store(process.env.ETCO_account_dataFile);
  server = await createAccountService({ store }).listen(0);
  base = `http://localhost:${server.address().port}`;

  await call('POST', '/api/signup', { email: 'boss@example.com', password: 'correct-horse-1' }, 'admin');
  await call('POST', '/api/signup', { email: 'normal@example.com', password: 'correct-horse-2' }, 'plain');
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('the configuration surface is closed to everyone who is not an administrator', async () => {
  const anon = await call('GET', '/api/admin/config', null, 'nobody');
  assert.equal(anon.status, 401);

  const plain = await call('GET', '/api/admin/config', null, 'plain');
  assert.equal(plain.status, 403, 'a signed-in non-admin is told that, not asked to sign in again');

  const write = await call('PUT', '/api/admin/config', { changes: { LOG_LEVEL: 'debug' } }, 'plain');
  assert.equal(write.status, 403);
  assert.ok(!readFileSync(envPath, 'utf8').includes('LOG_LEVEL'), 'and nothing was written');
});

test('an administrator reads the catalogue with each value’s source', async () => {
  store.accountByEmail('boss@example.com').isAdmin = true;
  store.flush();

  const res = await call('GET', '/api/admin/config');
  assert.equal(res.status, 200);
  const { settings, groups, envFile } = res.body;

  assert.ok(settings.length > 50, 'the catalogue is the whole surface, not a sample');
  assert.ok(groups.length > 5);
  assert.equal(envFile.path, envPath);

  // From the file: editable.
  const region = find(settings, 'ETCO_account_region');
  assert.equal(region.source, 'file');
  assert.equal(region.locked, false);
  assert.equal(region.value, 'api');

  // From the real environment: reported locked, because dotenv.js would never
  // override it and editing the file would silently do nothing.
  const timeout = find(settings, 'ETCO_classic_upstreamTimeoutMS');
  assert.equal(timeout.source, 'environment');
  assert.equal(timeout.locked, true);
  assert.equal(timeout.value, '4321');

  // Set nowhere: reported as running on its default.
  const unset = find(settings, 'OTA_PUBLIC_URL');
  assert.equal(unset.source, 'default');
  assert.equal(unset.hasValue, false);
});

test('secret values never ride along with the catalogue', async () => {
  const { settings } = (await call('GET', '/api/admin/config')).body;
  const secrets = settings.filter((s) => s.type === 'secret');
  assert.ok(secrets.length >= 3);

  for (const s of secrets) {
    assert.notEqual(s.value, 'dev-hub-token-secret');
    assert.ok(s.value === '' || /^•+$/.test(s.value), `${s.key} leaked a value`);
    assert.equal(s.fileValue, undefined, `${s.key} leaked its file value`);
  }
  // But an administrator who asks for one by name gets it.
  const revealed = await call('POST', '/api/admin/config/reveal', { key: 'HUB_TOKEN_SECRET' });
  assert.equal(revealed.body.value, 'dev-hub-token-secret');

  // And reveal is only for secrets.
  const no = await call('POST', '/api/admin/config/reveal', { key: 'LOG_LEVEL' });
  assert.equal(no.status, 400);
});

test('a write persists, preserves comments, and says what to restart', async () => {
  const res = await call('PUT', '/api/admin/config', {
    changes: { LOG_LEVEL: 'debug', ETCO_account_region: 'api' },
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.applied.includes('LOG_LEVEL'));
  assert.ok(res.body.restartRequired.length > 0, 'the response names what is still running stale');
  assert.match(res.body.note, /restart/i);

  const text = readFileSync(envPath, 'utf8');
  assert.match(text, /^LOG_LEVEL=debug$/m);
  assert.ok(text.includes('# a comment that must survive every write'));
});

test('a commented-out setting is uncommented in place', async () => {
  await call('PUT', '/api/admin/config', { changes: { PARAKEET_URL: 'http://10.0.0.9:6972' } });
  const text = readFileSync(envPath, 'utf8');
  assert.match(text, /^PARAKEET_URL=http:\/\/10\.0\.0\.9:6972$/m);
  assert.ok(!text.includes('#PARAKEET_URL='), 'the old commented line was replaced, not duplicated');
});

test('a locked setting is refused rather than written uselessly', async () => {
  const res = await call('PUT', '/api/admin/config', {
    changes: { ETCO_classic_upstreamTimeoutMS: '9999' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.errors.ETCO_classic_upstreamTimeoutMS, /process environment/);
  assert.ok(!readFileSync(envPath, 'utf8').includes('9999'));
});

test('invalid values are rejected, and one bad key rejects the whole batch', async () => {
  const before = readFileSync(envPath, 'utf8');

  const bad = await call('PUT', '/api/admin/config', {
    changes: { ETCO_hub_accountVerifyTimeoutMs: 'soon', OTA_PUBLIC_URL: 'https://ota.example' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.errors.ETCO_hub_accountVerifyTimeoutMs, /number/);

  // All or nothing: the valid half must not have landed, or the operator cannot
  // tell which of their changes took.
  assert.equal(readFileSync(envPath, 'utf8'), before);

  const unknown = await call('PUT', '/api/admin/config', { changes: { NOT_A_SETTING: 'x' } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.errors.NOT_A_SETTING, /not a known setting/);

  const enumBad = await call('PUT', '/api/admin/config', { changes: { LOG_LEVEL: 'chatty' } });
  assert.equal(enumBad.status, 400);
  assert.match(enumBad.body.errors.LOG_LEVEL, /must be one of/);
});

test('clearing a setting comments it out instead of leaving an empty assignment', async () => {
  await call('PUT', '/api/admin/config', { changes: { LOG_LEVEL: '' } });
  const text = readFileSync(envPath, 'utf8');
  assert.ok(!/^LOG_LEVEL=debug$/m.test(text));
  assert.match(text, /^#LOG_LEVEL=debug$/m);
});

test('generated secrets are long, random and distinct', async () => {
  const a = (await call('POST', '/api/admin/config/generate', {})).body.value;
  const b = (await call('POST', '/api/admin/config/generate', {})).body.value;
  assert.ok(a.length >= 40);
  assert.notEqual(a, b);
});

test('status reports this process without leaking credentials', async () => {
  const res = await call('GET', '/api/admin/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.config.envFile, envPath);
  assert.ok(res.body.runtime.node.startsWith('v'));
  assert.equal(typeof res.body.store.accounts, 'number');

  const serialised = JSON.stringify(res.body);
  assert.ok(!serialised.includes('dev-hub-token-secret'), 'status must not carry secrets');
});

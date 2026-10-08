// The admin settings and service-control API over the wire: who may reach it,
// what it says about where each value comes from, what it saves (and never
// writes), and how it asks the launcher to restart services. The launcher itself
// is faked here; scripts/run-compose-stack.test.mjs drives the real one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'phx-admin-settings-'));
process.env.ETCO_account_dataFile = join(dir, 'store.json');
process.env.PHOENIX_CONSOLE_SETTINGS_FILE = join(dir, 'config', 'console-settings.json');

// The server's own environment file. Invented values only.
const envPath = join(dir, 'server.env');
const envText = [
  '# installed by the operator; the console must never write this file',
  'LLM_MODEL=fixture/model-a',
  'TOMTOM_API_KEY=fixture-tomtom-key-0123456789abcd',
  'HUB_TOKEN_SECRET=fixture-hub-secret-never-shown',
  '',
].join('\n');
writeFileSync(envPath, envText);
process.env.PHOENIX_ENV_FILE = envPath;
delete process.env.PARAKEET_URL;
delete process.env.ETCO_account_mailSmtpHost;

// A launcher of our own: a run directory with services.json, and a record of restart requests.
const runDir = join(dir, 'run');
const services = {
  hub: { pid: 101, port: 1, startedAt: Date.now() - 60_000, revision: 0, state: 'running', safeMode: false, restarts: 0, exitCode: null },
  parser: { pid: 102, port: 2, startedAt: Date.now() - 60_000, revision: 0, state: 'running', safeMode: false, restarts: 0, exitCode: null },
  'answer-skill': { pid: 103, port: 3, startedAt: Date.now() - 60_000, revision: 0, state: 'running', safeMode: false, restarts: 0, exitCode: null },
  account: { pid: 104, port: 4, startedAt: Date.now() - 60_000, revision: 0, state: 'running', safeMode: false, restarts: 0, exitCode: null },
  lasso: { pid: 105, port: 5, startedAt: null, revision: 0, state: 'stopped', safeMode: false, restarts: 0, exitCode: 1 },
};
const writeLauncherState = () => {
  writeFileSync(join(runDir, 'services.json'), JSON.stringify({ version: 1, launcherPid: 99, startedAt: Date.now() - 60_000, bindHost: '127.0.0.1', services }));
};
let launcherAvailable = false;
const restarts = [];
const control = () => (launcherAvailable ? { available: true, pid: 99, dir: runDir } : { available: false, reason: 'no-launcher' });
const healthy = async () => new Response('ok', { status: 200 });

const { mkdirSync } = await import('node:fs');
mkdirSync(runDir, { recursive: true });
writeLauncherState();

const { Store } = await import('../src/store.js');
const { createAccountService } = await import('../src/index.js');
const { createLoop } = await import('../src/model.js');

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
  server = await createAccountService({
    store,
    adminSettings: { control, fetchImpl: healthy, restart: (_control, ids) => { restarts.push(ids); return ids; } },
    adminOps: { control, fetchImpl: healthy, presence: async () => true },
  }).listen(0);
  base = `http://localhost:${server.address().port}`;

  await call('POST', '/api/signup', { email: 'boss@example.test', password: 'correct-horse-1' }, 'admin');
  await call('POST', '/api/signup', { email: 'normal@example.test', password: 'correct-horse-2' }, 'plain');
  store.accountByEmail('boss@example.test').isAdmin = true;
  // A robot account, which is not a person and never appears among them.
  createLoop(store, { owner: store.accountByEmail('boss@example.test'), robotId: 'fixture-robot-name-one' });
  store.flush();
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

test('settings and services are closed to everyone who is not an administrator', async () => {
  assert.equal((await call('GET', '/api/admin/settings', null, 'nobody')).status, 401);
  assert.equal((await call('GET', '/api/admin/settings', null, 'plain')).status, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { changes: { LOG_LEVEL: 'debug' } }, 'plain')).status, 403);
  assert.equal((await call('POST', '/api/admin/services/restart', { services: ['hub'] }, 'plain')).status, 403);
  assert.equal((await call('GET', '/api/admin/overview', null, 'plain')).status, 403);
  assert.equal(existsSync(process.env.PHOENIX_CONSOLE_SETTINGS_FILE), false, 'nothing was saved');
});

test('without the launcher, settings are shown but cannot be saved or applied', async () => {
  launcherAvailable = false;
  const res = await call('GET', '/api/admin/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.control.available, false);
  assert.match(res.body.control.message, /launcher/);
  const save = await call('PUT', '/api/admin/settings', { changes: { LOG_LEVEL: 'debug' } });
  assert.equal(save.status, 409);
  assert.equal(save.body.code, 'NO_LAUNCHER');
  assert.equal((await call('POST', '/api/admin/services/restart', { services: ['hub'] })).status, 409);
});

test('every setting says where its value comes from, and secrets stay on the server', async () => {
  launcherAvailable = true;
  const { settings, groups, serverFile } = (await call('GET', '/api/admin/settings')).body;
  assert.equal(serverFile.path, envPath);
  assert.ok(groups.some((g) => g.editable) && groups.some((g) => !g.editable));

  const model = find(settings, 'LLM_MODEL');
  assert.equal(model.source, 'server');
  assert.equal(model.value, 'fixture/model-a');
  assert.equal(model.editable, true);

  const tomtom = find(settings, 'TOMTOM_API_KEY');
  assert.equal(tomtom.source, 'server');
  assert.equal(tomtom.isSet, true);
  assert.equal(tomtom.value, null, 'a secret’s value is never sent');
  assert.equal(tomtom.hint, 'abcd', 'only the last four characters of a long one');

  const hub = find(settings, 'HUB_TOKEN_SECRET');
  assert.equal(hub.editable, false);
  assert.equal(hub.value, null);

  assert.equal(find(settings, 'PARAKEET_URL').source, 'default');
  const json = JSON.stringify(settings);
  assert.ok(!json.includes('fixture-hub-secret-never-shown') && !json.includes('fixture-tomtom-key'));
});

test('invalid, unknown and server-owned values are refused, and nothing is saved', async () => {
  const bad = await call('PUT', '/api/admin/settings', {
    changes: { LOG_LEVEL: 'loud', PARAKEET_URL: 'parakeet:6972', HUB_TOKEN_SECRET: 'x', NODE_OPTIONS: '--inspect' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.errors.LOG_LEVEL, /choices/);
  assert.match(bad.body.errors.PARAKEET_URL, /http/);
  assert.match(bad.body.errors.HUB_TOKEN_SECRET, /installed/);
  assert.match(bad.body.errors.NODE_OPTIONS, /know/);
  assert.equal(existsSync(process.env.PHOENIX_CONSOLE_SETTINGS_FILE), false);

  // A mail port without a mail server would stop the console's own service from starting.
  const half = await call('PUT', '/api/admin/settings', { changes: { ETCO_account_mailSmtpPort: '587' } });
  assert.equal(half.status, 400);
  assert.ok(half.body.errors.ETCO_account_mailSmtpHost);
  assert.equal(existsSync(process.env.PHOENIX_CONSOLE_SETTINGS_FILE), false);
});

test('a save is kept beside the data, never in the server file, and says what must restart', async () => {
  const res = await call('PUT', '/api/admin/settings', {
    changes: { LOG_LEVEL: 'debug', ETCO_gqa_wolframKey: 'FIXTURE-APPID', LLM_MODEL: 'fixture/model-b' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.saved.sort(), ['ETCO_gqa_wolframKey', 'LLM_MODEL', 'LOG_LEVEL']);
  assert.deepEqual(res.body.restart, ['hub', 'parser', 'answer-skill', 'lasso', 'account'],
    'only the services that read them, in the launcher’s order');

  assert.equal(readFileSync(envPath, 'utf8'), envText, 'the server’s file is untouched');
  const file = process.env.PHOENIX_CONSOLE_SETTINGS_FILE;
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.revision, 1);
  assert.equal(saved.settings.LOG_LEVEL.value, 'debug');
  assert.equal(saved.history[0].by, 'boss@example.test');
  assert.ok(!JSON.stringify(saved.history).includes('FIXTURE-APPID'), 'history never holds a secret');

  const model = find(res.body.settings, 'LLM_MODEL');
  assert.equal(model.source, 'console');
  assert.equal(model.overrides, true);
  assert.equal(model.serverValue, 'fixture/model-a');
  assert.deepEqual(model.pending, ['parser', 'answer-skill'], 'still running with the old value');
  assert.equal(find(res.body.settings, 'ETCO_gqa_wolframKey').value, null);

  // Saving the same value again is not a change.
  const again = await call('PUT', '/api/admin/settings', { changes: { LOG_LEVEL: 'debug' } });
  assert.deepEqual(again.body.saved, []);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 1);
});

test('a service restarted with the saved revision is no longer waiting for it', async () => {
  services.parser.revision = 1;
  services['answer-skill'].revision = 1;
  writeLauncherState();
  const { settings } = (await call('GET', '/api/admin/settings')).body;
  assert.deepEqual(find(settings, 'LLM_MODEL').pending, []);
  assert.ok(find(settings, 'LOG_LEVEL').pending.includes('hub'));

  const list = (await call('GET', '/api/admin/services')).body;
  const hub = list.services.find((s) => s.id === 'hub');
  assert.equal(hub.healthy, true);
  assert.equal(hub.pendingSettings, 1);
  assert.equal(list.services.find((s) => s.id === 'parser').pendingSettings, 0);
  assert.equal(list.services.find((s) => s.id === 'lasso').state, 'stopped');
});

test('removing a saved value falls back to the server’s', async () => {
  const res = await call('PUT', '/api/admin/settings', { changes: { LLM_MODEL: null } });
  assert.equal(res.status, 200);
  const model = find(res.body.settings, 'LLM_MODEL');
  assert.equal(model.source, 'server');
  assert.equal(model.value, 'fixture/model-a');
  assert.deepEqual(model.pending, ['parser', 'answer-skill'], 'they still hold the removed value');
  const history = res.body.history[0];
  assert.deepEqual(history.changes, [{ key: 'LLM_MODEL', label: 'Model', action: 'removed' }]);
});

test('restart requests name real services and reach the launcher', async () => {
  assert.equal((await call('POST', '/api/admin/services/restart', { services: ['nope'] })).status, 400);
  assert.equal((await call('POST', '/api/admin/services/restart', { services: [] })).status, 400);
  const one = await call('POST', '/api/admin/services/restart', { services: ['parser', 'hub'] });
  assert.equal(one.status, 202);
  assert.deepEqual(one.body.restarting, ['hub', 'parser'], 'in the launcher’s order');
  assert.deepEqual(restarts.at(-1), ['hub', 'parser']);
  const all = await call('POST', '/api/admin/services/restart', { services: 'all' });
  assert.deepEqual(all.body.restarting, ['hub', 'parser', 'answer-skill', 'lasso', 'account']);
  // The console's own service is restarted after it has answered.
  const self = await call('POST', '/api/admin/services/restart', { services: ['account'] });
  assert.equal(self.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(restarts.at(-1), ['account']);
});

test('the overview counts people, not robots, and says what needs attention', async () => {
  const res = await call('GET', '/api/admin/overview');
  assert.equal(res.status, 200);
  const { counts, attention, services: list, control: overviewControl } = res.body;
  assert.equal(overviewControl.available, true);
  assert.equal(counts.people, 2);
  assert.equal(counts.admins, 1);
  assert.equal(counts.robots, 1);
  assert.equal(counts.online, 1);
  const titles = attention.map((item) => item.title);
  assert.ok(titles.includes('Data relay isn’t running'), titles.join(' | '));
  assert.ok(titles.includes('You’re the only administrator'));
  assert.ok(titles.includes('Speech recognition isn’t set up'));
  assert.ok(titles.includes('Email isn’t set up'));
  assert.equal(attention[0].level, 'error', 'most serious first');
  assert.ok(list.some((s) => s.id === 'hub' && s.pendingSettings === 1));
  assert.ok(!JSON.stringify(res.body).includes('fixture-tomtom-key'));
});

test('the people list holds people who can sign in, never robots', async () => {
  const { accounts, adminCount } = (await call('GET', '/api/admin/admins')).body;
  assert.equal(adminCount, 1);
  assert.deepEqual(accounts.map((a) => a.email), ['boss@example.test', 'normal@example.test']);
  assert.equal(accounts[0].loops, 1);
  const fleet = (await call('GET', '/api/admin/fleet')).body;
  assert.equal(fleet.robots.length, 1);
  assert.equal(fleet.robots[0].friendlyId, 'fixture-robot-name-one');
  assert.equal(fleet.robots[0].online, true);
  assert.equal(fleet.robots[0].owner.email, 'boss@example.test');
  assert.equal(fleet.loops.length, 1);
});

test('Google ASR settings validate provider, region and caps; credential and ledger paths remain server-owned', async () => {
  const bad = await call('PUT', '/api/admin/settings', { changes: {
    PHOENIX_ASR_PROVIDER: 'other', PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '-1',
    PHOENIX_GOOGLE_STT_DAILY_MINUTES: 'Infinity', PHOENIX_GOOGLE_STT_MAX_STREAMS: '9',
    PHOENIX_GOOGLE_STT_CREDENTIALS_FILE: '/synthetic/credential.json', PHOENIX_GOOGLE_STT_USAGE_FILE: '/synthetic/reset.json',
  } });
  assert.equal(bad.status, 400);
  for (const key of ['PHOENIX_ASR_PROVIDER', 'PHOENIX_GOOGLE_STT_MONTHLY_MINUTES', 'PHOENIX_GOOGLE_STT_DAILY_MINUTES',
    'PHOENIX_GOOGLE_STT_MAX_STREAMS', 'PHOENIX_GOOGLE_STT_CREDENTIALS_FILE', 'PHOENIX_GOOGLE_STT_USAGE_FILE']) assert.ok(bad.body.errors[key]);
  const incompatible = await call('PUT', '/api/admin/settings', { changes: {
    PHOENIX_ASR_PROVIDER: 'google', PHOENIX_GOOGLE_STT_MODEL: 'chirp_2', PHOENIX_GOOGLE_STT_LOCATION: 'us',
  } });
  assert.equal(incompatible.status, 400); assert.ok(incompatible.body.errors.PHOENIX_GOOGLE_STT_LOCATION);
  const saved = await call('PUT', '/api/admin/settings', { changes: {
    PHOENIX_ASR_PROVIDER: 'auto', PHOENIX_GOOGLE_STT_PROJECT: 'synthetic-project', PHOENIX_GOOGLE_STT_MODEL: 'chirp_2',
    PHOENIX_GOOGLE_STT_LOCATION: 'us-central1', PHOENIX_GOOGLE_STT_MONTHLY_MINUTES: '560',
    PHOENIX_GOOGLE_STT_DAILY_MINUTES: '56', PHOENIX_GOOGLE_STT_MAX_STREAMS: '2', PHOENIX_GOOGLE_STT_DENOISE: 'true',
  } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.deepEqual(saved.body.restart, ['hub']);
  assert.equal(find(saved.body.settings, 'PHOENIX_ASR_PROVIDER').value, 'auto');
  assert.equal(find(saved.body.settings, 'PHOENIX_GOOGLE_STT_CREDENTIALS_FILE').editable, false);
  assert.equal(readFileSync(envPath, 'utf8'), envText, 'operator configuration stays unchanged');
  assert.equal((await call('GET', '/api/admin/asr', null, 'anonymous')).status, 401);
  assert.equal((await call('GET', '/api/admin/asr', null, 'plain')).status, 403);
});

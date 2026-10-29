// Drive the launcher's real Classic executable against a deliberately late
// Account listener. All stores, credentials and peers are disposable/loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signSigV4, jwt } from '../packages/common/src/index.js';
import { createAccountService, Store } from '../packages/account/src/index.js';
import { createOwnerAccount, createLoop } from '../packages/account/src/model.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = 'startup-only-fixture-secret';
async function freeOffset() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const offset = 5000 + Math.floor(Math.random() * 40000);
    const servers = [];
    try {
      for (const port of [9000, 9011, 9012]) {
        const server = createServer();
        await new Promise((resolve, reject) => server.once('error', reject).listen(port + offset, '127.0.0.1', resolve));
        servers.push(server);
      }
      return offset;
    } catch { /* try another free block */ }
    finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
  }
  throw new Error('no free startup fixture ports');
}
async function healthy(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/healthcheck`, { signal: AbortSignal.timeout(200) })).ok; }
  catch { return false; }
}
async function until(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(message);
}
async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'classic-startup-'));
  const offset = await freeOffset();
  const file = join(dir, 'account/store.json');
  const store = new Store(file);
  const owner = createOwnerAccount(store, { email: 'startup-owner@example.test', password: 'fixture-only-password' });
  const { robot } = createLoop(store, { owner, robotId: 'startup-fixture-robot' });
  store.flush();
  const accountPort = offset + 9011;
  const classicPort = offset + 9012;
  const child = spawn('bash', ['scripts/run-compose-stack.sh', '--no-env', '--only', 'classic'], {
    cwd: repo, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      PHOENIX_ENV_FILE: '/dev/null', PHOENIX_BIND_HOST: '127.0.0.1',
      PHOENIX_PORT_OFFSET: String(offset), PHOENIX_DATA_DIR: dir, PHOENIX_LOG_DIR: join(dir, 'logs'),
      HUB_TOKEN_SECRET: secret, CLASSIC_PUBLIC_URL: 'http://startup.example.test',
      ETCO_classic_accountReadyTimeoutMS: '6000', ...overrides,
    },
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  let result;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { result = { code, signal }; resolve(result); }));
  t.after(async () => {
    if (!result) child.kill('SIGTERM');
    if (!await Promise.race([exited, sleep(1500).then(() => false)])) {
      child.kill('SIGKILL'); await exited;
    }
    // --only leaves the offset registry to its launcher; this fixture is that
    // owner, so remove only the mirror generated for its own selected offset.
    rmSync(join(repo, `packages/gateway/resources/skills/skills-native-offset-${offset}.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, robot, accountPort, classicPort, child, exited, output: () => output, result: () => result };
}
function signedTokenRequest(f) {
  const body = '{}';
  const signed = signSigV4({
    method: 'POST', path: '/', body,
    headers: { Host: `127.0.0.1:${f.classicPort}`, 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'Account_20151111.CreateHubToken' },
    accessKeyId: f.robot.accessKeyId, secretAccessKey: f.robot.secretAccessKey, region: 'global', service: 'jibo',
  });
  return fetch(`http://127.0.0.1:${f.classicPort}/`, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(3000) });
}

test('native launcher withholds Classic until Account is ready to issue the first startup token', { timeout: 20_000 }, async (t) => {
  const oldSecret = process.env.HUB_TOKEN_SECRET;
  process.env.HUB_TOKEN_SECRET = secret;
  t.after(() => { if (oldSecret === undefined) delete process.env.HUB_TOKEN_SECRET; else process.env.HUB_TOKEN_SECRET = oldSecret; });
  const f = await fixture(t);
  const state = await until(async () => {
    if (f.output().includes('waiting for Account readiness')) return 'waiting';
    if (await healthy(f.classicPort)) return 'exposed';
    assert.equal(f.result(), undefined, 'Classic must not exit before dependency readiness');
  }, 'Classic neither waited nor listened');
  if (state === 'exposed') {
    const early = await signedTokenRequest(f);
    assert.equal(early.status, 200, 'a startup token must not receive 502 ECONNREFUSED before Account listens');
    assert.fail('Classic must wait before exposing its public listener');
  }
  // Marker is emitted after imports, immediately before the real readiness wait.
  // Keep Account absent so removing only the wait still exposes Classic here.
  await sleep(600);
  assert.equal(await healthy(f.classicPort), false, 'Classic stays unbound while Account is absent');
  const account = await createAccountService({ store: f.store }).listen(f.accountPort, '127.0.0.1');
  t.after(() => new Promise(resolve => account.close(resolve)));
  await until(() => healthy(f.classicPort), 'Classic did not recover when Account became ready');
  const response = await signedTokenRequest(f);
  assert.equal(response.status, 200);
  const issued = await response.json();
  const claims = jwt.verify(issued.token, secret);
  assert.equal(claims.id, f.robot._id);
  assert.equal(claims.accessKeyId, f.robot.accessKeyId);
  assert.ok(issued.expires > Date.now());
  const unsigned = await fetch(`http://127.0.0.1:${f.classicPort}/`, {
    method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Account_20151111.CreateHubToken' }, body: '{}',
  });
  assert.equal(unsigned.status, 401, 'readiness must not weaken authentication');
  assert.doesNotMatch(f.output(), /proxy failed|ECONNREFUSED/);
});

test('native launcher fails closed when Account never becomes ready', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { ETCO_classic_accountReadyTimeoutMS: '250' });
  const result = await Promise.race([f.exited, sleep(6000).then(() => null)]);
  assert.ok(result, 'readiness has a bounded startup deadline');
  assert.equal(result.code, 1);
  assert.match(f.output(), /Account readiness deadline exceeded after 250ms/);
  assert.doesNotMatch(f.output(), /"msg":"listening"/);
  assert.equal(await healthy(f.classicPort), false);
});

test('ACCOUNT=0 retains the independent Classic profile without a readiness wait', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { ACCOUNT: '0' });
  await until(() => healthy(f.classicPort), 'independent Classic profile did not listen');
  assert.doesNotMatch(f.output(), /waiting for Account readiness/);
});

test('SIGTERM stops Classic while it waits for Account without leaving a listener', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await until(() => f.output().includes('waiting for Account readiness'), 'readiness was never entered');
  f.child.kill('SIGTERM');
  const result = await Promise.race([f.exited, sleep(1500).then(() => null)]);
  assert.ok(result, 'the waiting service terminates promptly');
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(await healthy(f.classicPort), false);
});

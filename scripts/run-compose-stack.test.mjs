// The native launcher, run for real: every service started, a setting saved from
// the admin console and applied by restarting only the service that reads it, a
// bad saved value survived by starting that service without the console's
// settings, and a SIGTERM that stops everything cleanly.
//
// It needs Linux (the launcher watches /proc) and a block of 15 free ports, and
// takes about half a minute. Everything it writes is in a temporary directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** An offset whose fifteen ports (9000-9014 + offset) are all free. */
async function freeOffset() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const offset = 3000 + 100 * Math.floor(Math.random() * 500);
    const checks = await Promise.all(Array.from({ length: 15 }, (_, i) => portFree(9000 + offset + i)));
    if (checks.every(Boolean)) return offset;
  }
  throw new Error('no free block of ports');
}

async function until(what, check, { timeoutMs = 30_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

const environOf = (pid) => Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the launcher applies console settings, restarts one service on request, survives a bad value and stops cleanly',
  { skip: process.platform !== 'linux' ? 'needs Linux' : false, timeout: 150_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phx-launcher-'));
    const data = join(dir, 'data');
    const logs = join(dir, 'logs');
    mkdirSync(join(data, 'ota'), { recursive: true });
    mkdirSync(join(data, 'account'), { recursive: true });
    copyFileSync(join(repo, 'packages/ota/manifest.json'), join(data, 'ota/manifest.json'));

    // An administrator to sign in as. Invented for this test.
    const { Store } = await import('../packages/account/src/store.js');
    const { createOwnerAccount } = await import('../packages/account/src/model.js');
    const store = new Store(join(data, 'account/store.json'));
    createOwnerAccount(store, { email: 'operator@example.test', password: 'launcher-test-1' }).isAdmin = true;
    store.flush();

    const offset = await freeOffset();
    const port = (reference) => reference + offset;
    const launcher = spawn('bash', ['scripts/run-compose-stack.sh'], {
      cwd: repo,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PHOENIX_PORT_OFFSET: String(offset),
        PHOENIX_DATA_DIR: data,
        PHOENIX_LOG_DIR: logs,
        PHOENIX_ENV_FILE: '/dev/null',
        CLASSIC_PUBLIC_URL: 'http://classic.example.test',
        OTA_PUBLIC_URL: 'http://ota.example.test',
        HUB_TOKEN_SECRET: 'launcher-test-hub-secret',
        ETCO_account_internalPeerToken: 'launcher-test-peer',
        ETCO_account_secureCookies: 'false',
      },
    });
    let stdout = '';
    let stderr = '';
    launcher.stdout.on('data', (chunk) => { stdout += chunk; });
    launcher.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => launcher.once('exit', (code, signal) => resolve({ code, signal })));
    const state = () => JSON.parse(readFileSync(join(data, 'run/services.json'), 'utf8'));
    const base = `http://127.0.0.1:${port(9011)}`;
    let cookie = '';
    const api = async (method, path, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    try {
      await until('every service', async () => {
        const s = state();
        const running = Object.values(s.services).filter((v) => v.state === 'running').length;
        return running === 13 && (await fetch(`${base}/healthcheck`)).ok;
      });
      assert.equal((await api('POST', '/api/login', { email: 'operator@example.test', password: 'launcher-test-1' })).status, 200);

      const settings = await api('GET', '/api/admin/settings');
      assert.equal(settings.body.control.available, true, JSON.stringify(settings.body.control));

      // Save a setting the answer skill reads; only it needs restarting.
      const userAgent = 'LauncherTest/1.0 (https://example.test; ops@example.test)';
      const saved = await api('PUT', '/api/admin/settings', { changes: { ETCO_gqa_wikiUserAgent: userAgent } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body.restart, ['answer-skill']);

      const before = state().services;
      assert.equal((await api('POST', '/api/admin/services/restart', { services: ['answer-skill'] })).status, 202);
      const answer = await until('the answer skill to restart', async () => {
        const list = await api('GET', '/api/admin/services');
        const service = list.body?.services?.find((s) => s.id === 'answer-skill');
        return service && service.revision >= 1 && service.healthy ? service : null;
      });
      const after = state().services;
      assert.notEqual(after['answer-skill'].pid, before['answer-skill'].pid);
      assert.equal(after.hub.pid, before.hub.pid, 'nothing else was restarted');
      assert.equal(after.account.pid, before.account.pid);
      assert.equal(answer.pendingSettings, 0);
      const env = environOf(after['answer-skill'].pid);
      assert.equal(env.ETCO_gqa_wikiUserAgent, userAgent);
      assert.equal(env.PHOENIX_CONSOLE_SETTINGS_REVISION, '1');
      const view = (await api('GET', '/api/admin/settings')).body.settings.find((s) => s.key === 'ETCO_gqa_wikiUserAgent');
      assert.deepEqual(view.pending, []);

      // A value the console would refuse, written by hand: SMTP without a host stops the account
      // service from starting. The launcher starts it again without the console's settings.
      const file = join(data, 'config/console-settings.json');
      const current = JSON.parse(readFileSync(file, 'utf8'));
      current.revision = 2;
      current.settings.ETCO_account_mailSmtpPort = { value: '587', revision: 2, changedAt: Date.now(), changedBy: null };
      writeFileSync(file, JSON.stringify(current));
      assert.equal((await api('POST', '/api/admin/services/restart', { services: ['account'] })).status, 202);
      const recovered = await until('the console to come back without the bad value', async () => {
        const list = await api('GET', '/api/admin/services');
        const service = list.body?.services?.find((s) => s.id === 'account');
        return service && service.safeMode && service.state === 'running' && service.healthy ? service : null;
      }, { timeoutMs: 45_000 });
      assert.equal(recovered.revision, 0, 'it runs without any console settings');
      assert.match(stderr, /account stopped \(exit 1\) right after starting with console settings/);
      const overview = await api('GET', '/api/admin/overview');
      assert.ok(overview.body.attention.some((item) => item.title === 'Console and accounts is running without your saved settings'));

      // A clean stop: every service gets SIGTERM, and the launcher exits after them.
      const pids = Object.values(state().services).map((s) => s.pid).filter(Boolean);
      process.kill(launcher.pid, 'SIGTERM');
      const result = await Promise.race([exited, sleep(30_000).then(() => null)]);
      assert.ok(result, 'the launcher exited');
      assert.equal(result.code, 0);
      assert.deepEqual(pids.filter(alive), [], 'no service was left running');
      assert.ok(Object.values(state().services).every((s) => s.state === 'stopped'));
      assert.doesNotMatch(stderr, /unbound variable|no such job|syntax error/);
    } finally {
      try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      if (process.exitCode && stdout) process.stderr.write(`--- launcher stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
    }
  });

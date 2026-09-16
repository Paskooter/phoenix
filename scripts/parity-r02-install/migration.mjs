// R-02 migration lane (D): temporary store + fixture accounts only. Never touches
// ~/.local/share/phoenix or any real robot. Sequences:
//   seed a fixture store (owner account + loop + robot) via the model,
//   start the account service, read the data back,
//   stop and restart on the SAME store (persistence = migration claim),
//   take a backup, mutate, restore the backup, confirm the mutation is gone (rollback).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnv, runCapture, sleep, writeJson, gitShort } from './lib.mjs';

export const MIGRATION_ACCOUNT_PORT = 9401; // clear of 9013 and the 9200 lane range

export const FIXTURE = {
  email: 'fixture@r02.phoenix.local',
  password: 'fixture-pass-1234',
  firstName: 'R02Fixture',
  robot: 'fixture-robot-alpha',
  mutationEmail: 'mutation@r02.phoenix.local',
  mutationPassword: 'mutation-pass-5678',
};

function sha256(path) {
  const buf = existsSync(path) ? readFileSync(path) : Buffer.from('');
  return createHash('sha256').update(buf).digest('hex');
}

async function httpJson(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, cookie: res.headers.get('set-cookie') || '', json };
}

async function waitHealthy(api, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(`${api}/healthcheck`, { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) return true;
    } catch { /* retry */ }
    await sleep(250);
  }
  return false;
}

/** Account service as a directly-supervised child (harness is the parent, so the
 *  real exit code / signal is observable on SIGTERM). */
async function startAccount(clean, env) {
  const proc = spawn('node', ['packages/account/src/index.js'], {
    cwd: clean,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = { stdout: '', stderr: '' };
  proc.stdout.on('data', (d) => { chunks.stdout += d; });
  proc.stderr.on('data', (d) => { chunks.stderr += d; });
  const exitPromise = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  return {
    proc,
    log: () => ({ ...chunks }),
    stop: () => proc.kill('SIGTERM'),
    waitExit: () => exitPromise,
  };
}

export async function runMigration(ctx) {
  const { clean, runDir, home } = ctx;
  const migDir = join(runDir, 'migration');
  mkdirSync(migDir, { recursive: true });
  const storeFile = join(migDir, 'store.json');
  const backupFile = join(migDir, 'store.backup.json');
  const steps = [];
  const record = (name, ok, detail = null) => {
    steps.push({ name, ok: !!ok, detail: detail == null ? null : String(detail).slice(0, 800) });
    return ok;
  };

  const baseEnv = buildEnv({ home });
  const api = `http://127.0.0.1:${MIGRATION_ACCOUNT_PORT}`;
  const stopAccount = async (handle) => {
    handle.stop();
    return handle.waitExit();
  };

  // -- 1. seed the fixture store -------------------------------------------------
  const seedEnv = {
    ...baseEnv,
    ETCO_account_dataFile: storeFile,
    R02_FIXTURE_EMAIL: FIXTURE.email,
    R02_FIXTURE_PASSWORD: FIXTURE.password,
    R02_FIXTURE_ROBOT: FIXTURE.robot,
  };
  rmSync(storeFile, { force: true });
  const seedScript = `
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const model = await import(pathToFileURL(root + '/packages/account/src/model.js'));
const { Store } = await import(pathToFileURL(root + '/packages/account/src/store.js'));
const store = new Store();
const owner = model.createOwnerAccount(store, {
  email: process.env.R02_FIXTURE_EMAIL,
  password: process.env.R02_FIXTURE_PASSWORD,
  firstName: 'R02Fixture',
});
const { loop } = model.createLoop(store, { owner, robotId: process.env.R02_FIXTURE_ROBOT });
console.log(JSON.stringify({ counts: {
  accounts: store.accounts.size,
  loops: store.loops.size,
  robotFriendlyId: store.accounts.get(loop.robot)?.friendlyId,
} }));
`;
  const seed = await runCapture(process.execPath, ['--input-type=module', '--eval', seedScript], {
    cwd: clean, env: seedEnv, timeoutMs: 60000,
  });
  let seeded = null;
  try { seeded = JSON.parse(seed.stdout.trim().split('\n').pop()); } catch { /* empty */ }
  const seedOk = record('seed-fixture-store',
    seed.code === 0 && seeded && seeded.counts.accounts === 2 && seeded.counts.loops === 1
      && seeded.counts.robotFriendlyId === FIXTURE.robot,
    seed.code === 0
      ? `accounts=${seeded?.counts?.accounts} loops=${seeded?.counts?.loops} robots=${seeded?.counts?.robotFriendlyId}`
      : seed.stderr.slice(0, 400));
  if (!seedOk) {
    await writeJson(join(runDir, 'state/migration.json'), { lane: 'migration', steps, summary: 'seed failed' });
    return { ok: false, steps, summary: 'seed failed' };
  }

  // -- 2-4. start, read back, stop ----------------------------------------------
  let handle = await startAccount(clean, { ...baseEnv, ETCO_account_dataFile: storeFile });
  const ready1 = await waitHealthy(api);
  record('account-start-1', ready1, ready1 ? '' : handle.log().stderr.slice(0, 400));
  if (!ready1) {
    await stopAccount(handle);
    await writeJson(join(runDir, 'state/migration.json'), { lane: 'migration', steps, summary: 'account did not become ready' });
    return { ok: false, steps, summary: 'account did not become ready' };
  }

  const login1 = await httpJson(`${api}/api/login`, { method: 'POST', body: { email: FIXTURE.email, password: FIXTURE.password } });
  record('read-back-login', login1.status === 200 && login1.cookie.includes('phoenix'), `status=${login1.status}`);
  const robots1 = await httpJson(`${api}/api/robots`, { headers: { cookie: login1.cookie } });
  record('read-back-robots', robots1.status === 200 && Array.isArray(robots1.json)
    && robots1.json.length === 1 && robots1.json[0].friendlyId === FIXTURE.robot,
    JSON.stringify(robots1.json).slice(0, 200));

  const stop1 = await stopAccount(handle);
  record('stop-1', stop1.signal === 'SIGTERM' || stop1.code === 0, `code=${stop1.code} signal=${stop1.signal}`);

  // -- 5-7. restart on the same store --------------------------------------------
  handle = await startAccount(clean, { ...baseEnv, ETCO_account_dataFile: storeFile });
  const ready2 = await waitHealthy(api);
  record('restart-same-store', ready2);
  const login2 = await httpJson(`${api}/api/login`, { method: 'POST', body: { email: FIXTURE.email, password: FIXTURE.password } });
  const robots2 = await httpJson(`${api}/api/robots`, { headers: { cookie: login2.cookie } });
  record('read-back-after-restart', login2.status === 200
    && robots2.status === 200 && robots2.json?.length === 1 && robots2.json[0].friendlyId === FIXTURE.robot,
    `login=${login2.status} robots=${robots2.status} length=${robots2.json?.length}`);

  // -- 8. backup ----------------------------------------------------------------
  const stop2 = await stopAccount(handle);
  record('stop-2-before-backup', stop2.signal === 'SIGTERM' || stop2.code === 0, `code=${stop2.code} signal=${stop2.signal}`);
  cpSync(storeFile, backupFile);
  const hashBefore = sha256(storeFile);
  const hashBackup = sha256(backupFile);
  record('backup-copy', existsSync(backupFile) && hashBefore === hashBackup, `sha256=${hashBefore.slice(0, 16)}…`);

  // -- 9. mutate (a second signup, persisted to the same store) -------------------
  handle = await startAccount(clean, { ...baseEnv, ETCO_account_dataFile: storeFile });
  const ready3 = await waitHealthy(api);
  const signup = await httpJson(`${api}/api/signup`, { method: 'POST', body: { email: FIXTURE.mutationEmail, password: FIXTURE.mutationPassword, firstName: 'Mutation' } });
  record('mutate-signup', ready3 && signup.status === 200, `signup=${signup.status}`);
  const stop3 = await stopAccount(handle);
  record('stop-3-after-mutation', stop3.signal === 'SIGTERM' || stop3.code === 0, `code=${stop3.code} signal=${stop3.signal}`);
  const storeAfterMutate = JSON.parse(readFileSync(storeFile, 'utf8'));
  record('mutation-persisted', (storeAfterMutate.accounts || []).length === 3,
    `accounts=${storeAfterMutate.accounts.length} (2 fixture + 1 mutation)`);

  // -- 10-11. restore the backup, confirm the mutation is gone (rollback) ---------
  cpSync(backupFile, storeFile, { force: true });
  const hashRestored = sha256(storeFile);
  record('restore-backup', hashRestored === hashBackup, `${hashRestored.slice(0, 16)}…`);

  handle = await startAccount(clean, { ...baseEnv, ETCO_account_dataFile: storeFile });
  const ready4 = await waitHealthy(api);
  record('restart-after-restore', ready4);
  const loginOK = await httpJson(`${api}/api/login`, { method: 'POST', body: { email: FIXTURE.email, password: FIXTURE.password } });
  const loginMutant = await httpJson(`${api}/api/login`, { method: 'POST', body: { email: FIXTURE.mutationEmail, password: FIXTURE.mutationPassword } });
  const robotsRestored = await httpJson(`${api}/api/robots`, { headers: { cookie: loginOK.cookie } });
  const storeAfterRestore = JSON.parse(readFileSync(storeFile, 'utf8'));
  record('rollback-mutation-gone', loginOK.status === 200 && loginMutant.status === 401
    && (storeAfterRestore.accounts || []).length === 2 && robotsRestored.json?.length === 1,
    `fixtureLogin=${loginOK.status} mutationLogin=${loginMutant.status} accounts=${storeAfterRestore.accounts.length}`);

  const stop4 = await stopAccount(handle);
  record('stop-4-final', stop4.signal === 'SIGTERM' || stop4.code === 0, `code=${stop4.code} signal=${stop4.signal}`);

  // -- 12. original database fixtures (explicitly skipped, with reason) -----------
  record('original-db-fixtures', false,
    'SKIPPED: no original Pegasus database fixture dump is available in JSON store shape. The original account/loop data lived in MongoDB (account/loop/robot collections) and no restorable fixture is part of the Jibo archive; the Phoenix JSON store migration path (seed -> restart persistence -> backup/restore -> rollback) is exercised above instead.');

  const summary = {
    lane: 'migration',
    revision: gitShort(),
    port: MIGRATION_ACCOUNT_PORT,
    store: storeFile,
    counts: { steps: steps.length, passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length },
  };
  await writeJson(join(runDir, 'state/migration.json'), { ...summary, steps });
  return { ok: summary.failed === 0, ...summary, steps };
}
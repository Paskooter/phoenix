#!/usr/bin/env node
// R-02 install verification harness — clean install, hermetic native lane, isolated
// compose lane, migration/backup/restore/rollback, machine-readable receipt.
//
// Usage (from the repo root):
//   node scripts/parity-r02-install/run.mjs preflight
//   node scripts/parity-r02-install/run.mjs install
//   node scripts/parity-r02-install/run.mjs native
//   node scripts/parity-r02-install/run.mjs compose
//   node scripts/parity-r02-install/run.mjs migration
//   node scripts/parity-r02-install/run.mjs all                 (A -> B -> C -> D -> receipt)
//   node scripts/parity-r02-install/run.mjs falsify native-leak
//   node scripts/parity-r02-install/run.mjs falsify compose-leak
//   node scripts/parity-r02-install/run.mjs falsify native-collision
//   node scripts/parity-r02-install/run.mjs falsify compose-collision
//   node scripts/parity-r02-install/run.mjs receipt
//   node scripts/parity-r02-install/run.mjs clean
//
// Everything the harness does is confined to RUN_DIR (default .parity/runs/r02): the exported
// clean tree, HOME, logs, npm cache and the temporary account store. It never reads .env, never
// touches ~/.local/share/phoenix, and never contacts a robot.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  repo, REF_PORTS, COMPOSE_PORT_VARS, CONTRACT_SERVICES, offsetPorts,
  RESERVED_HOST_PORTS, COMPOSE_PROJECT, DEFAULT_OFFSET, buildEnv, portFree,
  runCapture, runSync, gitRev, gitShort, sleep, waitReady, countContractOutput,
  parseLauncherLines, writeJson, readJson, logTail, offsetRegistryLeftovers, humanMs,
} from './lib.mjs';
import { runMigration, MIGRATION_ACCOUNT_PORT } from './migration.mjs';

function parseArgs(argv) {
  const args = { runDir: join(repo, '.parity/runs/r02'), offset: null, timeout: 120000, cmd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run-dir') args.runDir = resolve(argv[++i]);
    else if (a === '--offset') { const v = Number(argv[++i]); if (!Number.isInteger(v)) throw new Error('--offset must be an integer'); args.offset = v; }
    else if (a === '--timeout') { const v = Number(argv[++i]); if (!Number.isInteger(v)) throw new Error('--timeout must be ms'); args.timeout = v; }
    else if (args.cmd === null) args.cmd = a;
    else args.arg = a;
  }
  return args;
}

const CANARY_ADMIN_PASSWORD = 'r02-canary-password';
const CANARY_ENV_CONTENT = `ADMIN_PASSWORD=${CANARY_ADMIN_PASSWORD}\n`;

async function chooseOffset(args, runDir, state) {
  if (args.offset != null) {
    const busy = await offsetCollisions(args.offset);
    if (busy.length) {
      return { offset: args.offset, ok: false, reason: 'PORT_COLLISION', collisions: busy };
    }
    return { offset: args.offset, ok: true };
  }
  const candidates = [DEFAULT_OFFSET, 100, 110, 50, 300, 25, 10];
  const referenceTaken = {};
  for (const svc of CONTRACT_SERVICES) if (!(await portFree(REF_PORTS[svc]))) referenceTaken[svc] = REF_PORTS[svc];
  for (const offset of candidates) {
    const busy = await offsetCollisions(offset);
    if (!busy.length) {
      return { offset, ok: true, referenceTaken, note: `reference port ${JSON.stringify(referenceTaken)} taken; chose offset ${offset}` };
    }
  }
  return { offset: null, ok: false, reason: 'NO_FREE_PORT_RANGE', referenceTaken };
}

async function offsetCollisions(offset) {
  const busy = [];
  for (const svc of CONTRACT_SERVICES) {
    const port = REF_PORTS[svc] + offset;
    if (RESERVED_HOST_PORTS.has(port)) { busy.push({ svc, port, reason: 'reserved' }); continue; }
    if (!(await portFree(port))) busy.push({ svc, port, reason: 'in-use' });
  }
  return busy;
}

async function containerNameCollisions() {
  const names = new Set(CONTRACT_SERVICES.map((s) => s.toLowerCase()));
  const all = runSync('docker', ['ps', '-a', '--format', '{{.Names}}']);
  const hits = all.stdout.split('\n').map((n) => n.trim()).filter((n) => names.has(n));
  return hits;
}

const probeAdminLogin = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CANARY_ADMIN_PASSWORD }),
      signal: AbortSignal.timeout(4000),
    });
    return res.status;
  } catch { return -1; }
};

// ------------------------------------------------------------- A: clean install

async function cleanInstall(ctx) {
  const { runDir, clean, home } = ctx;
  const t0 = Date.now();
  const revision = gitRev();
  rmSync(clean, { recursive: true, force: true });
  mkdirSync(clean, { recursive: true });
  mkdirSync(join(home, 'npm-cache'), { recursive: true });

  const tar = runSync('git', ['archive', 'HEAD'], { cwd: repo, maxBuffer: 1024 * 1024 * 768, encoding: 'buffer' });
  if (tar.status !== 0) throw new Error(`git archive failed: ${String(tar.stderr).trim()}`);
  const extract = runSync('tar', ['-x', '-C', clean], { input: tar.stdout, encoding: 'buffer' });
  if (extract.status !== 0) throw new Error(`tar extract failed: ${String(extract.stderr).trim()}`);

  const envAbsent = !existsSync(join(clean, '.env'));
  const envReq = runSync('git', ['ls-files', '.env'], { cwd: repo });
  const envTrackedInRepo = envReq.stdout.trim().length > 0;

  const npmEnv = {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8',
    PHOENIX_ENV_FILE: '/dev/null',
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_update_notifier: 'false',
  };
  const t1 = Date.now();
  const ci = await runCapture('npm', ['ci'], { cwd: clean, env: npmEnv, timeoutMs: 900000 });
  const installMs = Date.now() - t1;

  const nodeVersion = (runSync('node', ['--version'], { cwd: clean }).stdout || '').trim();
  const npmVersion = (runSync('npm', ['--version'], { cwd: clean }).stdout || '').trim();
  const ping = runSync('npm', ['ping'], { cwd: clean, env: npmEnv, timeout: 30000 });

  const nonce = gitShort();
  const result = {
    lane: 'clean-install',
    revision,
    revisionShort: nonce,
    envAbsent: { asserted: envAbsent, envTrackedInRepo },
    install: { exitCode: ci.code, durationMs: installMs, nodeVersion, npmVersion },
    registryReachable: ping.status === 0,
    totalMs: Date.now() - t0,
  };
  // npm ci feeds install.duration; the receipt timings are in ms.
  writeJson(join(runDir, 'state/clean-install.json'), result);
  console.log(`[clean-install] revision ${nonce} env.absent=${envAbsent} npm.exit=${ci.code} install=${humanMs(installMs)}`);
  return { ok: ci.code === 0 && envAbsent && !envTrackedInRepo, ...result };
}

// ------------------------------------------------- N: the native (no-docker) lane

// leak mode = deliberately run WITH a planted .env and no --no-env so the lane demonstrates
// criterion 3 is load-bearing (the harness catches the leak instead of papering over it).
async function nativeLane(ctx, { offset, mode = 'hermetic' }) {
  const { runDir, clean, home, timeoutMs } = ctx;
  const logsDir = join(runDir, 'logs', 'native');
  mkdirSync(logsDir, { recursive: true });
  const ports = offsetPorts(offset);
  const launcher = mode === 'leak'
    ? ['bash', ['scripts/run-compose-stack.sh']]
    : ['bash', ['scripts/run-compose-stack.sh', '--no-env']];

  const env = buildEnv({ home, extra: {
    PHOENIX_PORT_OFFSET: String(offset),
    PHOENIX_LOG_DIR: logsDir,
  } });
  if (mode === 'leak') {
    // Leak falsification: the planted .env must be loadable, so drop the /dev/null pin —
    // a run WITH this leak present is exactly what criterion 3 forbids, and the harness
    // must catch it by name. The production hermetic lane keeps PHOENIX_ENV_FILE=/dev/null.
    delete env.PHOENIX_ENV_FILE;
  }

  const child = spawn(launcher[0], launcher[1], { cwd: clean, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exitPromise = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));

  const t0 = Date.now();
  const readiness = await waitReady(ports, { timeoutMs, startMs: t0 });
  const pids = parseLauncherLines(stdout).pids;

  const teardown = async () => {
    for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    const grace = 30000;
    const res = await Promise.race([
      exitPromise,
      sleep(grace).then(() => ({ code: 'timeout' })),
    ]);
    if (res.code === 'timeout') {
      for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      await Promise.race([exitPromise, sleep(5000)]);
    }
    return res;
  };

  let readySummary = { ok: true };
  let envLeakStatus = null;
  let contract = null;
  let shutdown = null;
  let named = null;

  if (readiness.timedOut.length) {
    // A service that is not listening cannot be under test — abort with a named failure.
    named = {
      name: 'READINESS_TIMEOUT',
      detail: readiness.timedOut.map((s) => `${s}:${ports[s]} (${logTail(logsDir, s) || 'no log'})`).join(' | '),
    };
    readySummary = { ok: false, timedOut: readiness.timedOut };
    await teardown();
  } else {
    envLeakStatus = await probeAdminLogin(ports.account);
    const leakDetected = envLeakStatus !== 503;

    const cv = await runCapture('node', ['scripts/verify-compose-contract.mjs'], {
      cwd: clean,
      env: { ...env, HOST: '127.0.0.1', PHOENIX_PORT_OFFSET: String(offset) },
      timeoutMs: 120000,
    });
    contract = { exitCode: cv.code, ...countContractOutput(cv.stdout), raw: cv.stdout.slice(0, 2000) };

    const shutdownRes = await teardown();
    const parsed = parseLauncherLines(stdout);
    shutdown = {
      launcherExit: { code: shutdownRes.code, signal: shutdownRes.signal },
      services: parsed.exits,
      missing: CONTRACT_SERVICES.filter((s) => parsed.exits[s] === undefined && pids[s] !== undefined),
      portsFreeAfter: {},
    };
    for (const [svc, port] of Object.entries(ports)) shutdown.portsFreeAfter[svc] = await portFree(port);

    if (mode === 'hermetic' && leakDetected) {
      named = { name: 'ENV_LEAK_DETECTED', detail: `admin/login returned ${envLeakStatus} while PHOENIX_ENV_FILE=/dev/null + --no-env expected 503 (a .env value reached the account service)` };
    }
    if (mode === 'leak' && !leakDetected) {
      named = { name: 'EXPECTED_ENV_LEAK_NOT_DETECTED', detail: 'planted a .env with ADMIN_PASSWORD but the account service reported admin disabled (503) — the falsification control failed to fail' };
    }
  }

  const registryClean = !mode || offsetRegistryLeftovers(clean).length === 0;
  const result = {
    lane: 'native',
    mode,
    revision: gitShort(),
    offset,
    ports,
    readiness: {
      ok: readiness.timedOut.length === 0,
      timedOut: readiness.timedOut,
      perServiceMs: readiness.ready,
      totalMs: readiness.readyMs,
    },
    contract,
    envLeak: { adminStatus: envLeakStatus, expectedExactly: mode === 'hermetic' ? 503 : 200 },
    shutdown,
    registryClean,
    namedFailure: named,
    ok: readiness.timedOut.length === 0 && (mode === 'hermetic' ? !(envLeakStatus !== 503) : envLeakStatus !== 503),
  };
  writeFileSync(join(runDir, 'logs', 'native', `lane-${mode}.log`), stdout);
  writeJson(join(runDir, 'state', `native-${mode}.json`), result);
  console.log(`[native ${mode}] readiness=${readiness.timedOut.length === 0 ? 'OK' : `TIMEOUT:${readiness.timedOut.join(',')}`} contract=${contract ? `${contract.pass}P/${contract.fail}F` : 'n/a'} leak=${envLeakStatus} named=${named ? named.name : 'none'}`);
  return result;
}

// ------------------------------------------------- C: the compose (docker) lane

async function composeLane(ctx, { offset, mode = 'hermetic' }) {
  const { runDir, clean, home, timeoutMs } = ctx;
  const env = buildEnv({ home, extra: {
    ...Object.fromEntries(CONTRACT_SERVICES.map((s) => [COMPOSE_PORT_VARS[s], String(REF_PORTS[s] + offset)])),
  } });
  const ports = offsetPorts(offset);
  const proj = ['-p', COMPOSE_PROJECT];

  const image = runSync('docker', ['image', 'inspect', 'phoenix-runtime:local', '--format', '{{.Id}}']);
  const buildArgs = image.status === 0 ? [] : ['--build'];
  const t0 = Date.now();
  const up = await runCapture('docker', ['compose', ...proj, 'up', '-d', '--remove-orphans', ...buildArgs], {
    cwd: clean, env, timeoutMs: 900000,
  });
  writeFileSync(join(runDir, 'logs', 'compose', `up-${mode}.log`), up.stdout + up.stderr);
  const readiness = up.code === 0 ? await waitReady(ports, { timeoutMs: 180000, startMs: t0 }) : { ready: {}, timedOut: CONTRACT_SERVICES, readyMs: Date.now() - t0 };

  let contract = null;
  let envLeakStatus = null;
  let stopExit = null;
  let named = null;
  if (up.code !== 0) {
    named = { name: 'COMPOSE_UP_FAILED', detail: (up.stderr + up.stdout).trim().slice(-1500) };
    await dockerDown(env, proj);
  } else if (readiness.timedOut.length) {
    named = { name: 'READINESS_TIMEOUT', detail: readiness.timedOut.map((s) => `${s}:${ports[s]}`).join(',') };
    await dockerDown(env, proj);
  } else {
    envLeakStatus = await probeAdminLogin(ports.account);
    const leakDetected = envLeakStatus !== 503;
    const cv = await runCapture('node', ['scripts/verify-compose-contract.mjs'], {
      cwd: clean,
      env: { ...env, HOST: '127.0.0.1', PHOENIX_PORT_OFFSET: String(offset) },
      timeoutMs: 120000,
    });
    contract = { exitCode: cv.code, ...countContractOutput(cv.stdout), raw: cv.stdout.slice(0, 2000) };

    // graceful stop (SIGTERM) then read each container's real exit code before teardown.
    const stop = await runCapture('docker', ['compose', ...proj, 'stop'], { cwd: clean, env, timeoutMs: 120000 });
    const ps = runSync('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`, '--format', '{{.Names}}\t{{.State.ExitCode}}\t{{.State.Status}}']);
    const serviceExit = {};
    for (const line of ps.stdout.split('\n').filter(Boolean)) {
      const [name, code, status] = line.split('\t');
      serviceExit[name] = { code: Number(code), status };
    }
    stopExit = { stopCode: stop.code, serviceExit };

    if (mode === 'hermetic' && leakDetected) {
      named = { name: 'ENV_LEAK_DETECTED', detail: `admin/login returned ${envLeakStatus}; expected 503 with no .env in the clean tree` };
    }
    if (mode === 'leak' && !leakDetected) {
      named = { name: 'EXPECTED_ENV_LEAK_NOT_DETECTED', detail: 'planted .env with ADMIN_PASSWORD but account reported 503' };
    }
    await dockerDown(env, proj);
  }

  const result = {
    lane: 'compose',
    mode,
    revision: gitShort(),
    offset,
    ports,
    up: { exitCode: up.code, durationMs: Date.now() - t0 },
    readiness: {
      ok: readiness.timedOut.length === 0,
      timedOut: readiness.timedOut,
      perServiceMs: readiness.ready,
      totalMs: readiness.readyMs,
    },
    contract,
    envLeak: { adminStatus: envLeakStatus, expectedExactly: mode === 'hermetic' ? 503 : 200 },
    shutdown: stopExit,
    namedFailure: named,
    ok: up.code === 0 && readiness.timedOut.length === 0 && (mode === 'hermetic' ? !(envLeakStatus !== 503) : envLeakStatus !== 503),
  };
  writeJson(join(runDir, 'state', `compose-${mode}.json`), result);
  console.log(`[compose ${mode}] up=${up.code === 0 ? 'OK' : `FAIL:${up.code}`} readiness=${readiness.timedOut.length === 0 ? 'OK' : `TIMEOUT:${readiness.timedOut.join(',')}`} contract=${contract ? `${contract.pass}P/${contract.fail}F` : 'n/a'} leak=${envLeakStatus} named=${named ? named.name : 'none'}`);
  return result;
}

async function dockerDown(env, proj) {
  await runCapture('docker', ['compose', ...proj, 'down', '-v', '--remove-orphans'], { env, timeoutMs: 120000 });
}

// ------------------------------------------------------------ preflight / receipt

async function preflight(ctx) {
  const { runDir } = ctx;
  const offsetChoice = await chooseOffset(ctx.args, runDir, {});
  const collisions = await containerNameCollisions();
  const dockerOk = runSync('docker', ['info', '--format', '{{.ServerVersion}}']);
  const result = {
    lane: 'preflight',
    revision: gitShort(),
    docker: { available: dockerOk.status === 0, version: dockerOk.stdout.trim() },
    offsetChoice,
    containerNameCollisions: collisions,
    reservedPorts: [...RESERVED_HOST_PORTS].sort((a, b) => a - b),
  };
  writeJson(join(runDir, 'state/preflight.json'), result);
  const bad = !result.docker.available || !offsetChoice.ok || collisions.length;
  console.log(`[preflight] docker=${result.docker.available} offset=${offsetChoice.ok ? offsetChoice.offset : offsetChoice.reason} collisions=${collisions.length}`);
  return { ok: !bad, ...result };
}

function receipt(ctx) {
  const { runDir } = ctx;
  const s = (f) => readJson(join(runDir, 'state', f));
  const bins = {
    cleanInstall: s('clean-install.json'),
    preflight: s('preflight.json'),
    native: s('native-hermetic.json'),
    compose: s('compose-hermetic.json'),
    migration: s('migration.json'),
    falsifications: [
      s('falsify-native-leak.json'),
      s('falsify-compose-collision.json'),
      s('falsify-compose-leak.json'),
      s('falsify-native-collision.json'),
    ].filter(Boolean),
  };
  const skipped = [];
  if (bins.migration) {
    for (const step of bins.migration.steps || []) {
      if (!step.ok && step.detail && step.detail.includes('SKIPPED:')) skipped.push({ step: step.name, reason: step.detail.replace('SKIPPED: ', '') });
    }
  }
  const migrationScore = (() => {
    if (!bins.migration) return null;
    const steps = bins.migration.steps || [];
    const real = steps.filter((s) => s.name !== 'original-db-fixtures');
    return real.length > 0 && real.every((s) => s.ok);
  })();
  const score = {
    cleanInstall: bins.cleanInstall ? (bins.cleanInstall.install.exitCode === 0 && bins.cleanInstall.envAbsent.asserted) : null,
    native: bins.native ? (bins.native.readiness?.ok && bins.native.contract && bins.native.contract.fail === 0 && bins.native.envLeak?.adminStatus === 503 && !bins.native.namedFailure) : null,
    compose: bins.compose ? (bins.compose.readiness?.ok && bins.compose.contract && bins.compose.contract.fail === 0 && bins.compose.envLeak?.adminStatus === 503 && !bins.compose.namedFailure) : null,
    migration: bins.migration ? migrationScore : null,
  };
  const receiptJson = {
    schema: 'phoenix.r02.install-verification.v1',
    task: 'R-02',
    revision: gitRev(),
    date: new Date().toISOString(),
    machine: {
      hostname: runSync('hostname', []).stdout.trim(),
      node: runSync('node', ['--version']).stdout.trim(),
      docker: bins.preflight?.docker?.version || runSync('docker', ['info', '--format', '{{.ServerVersion}}']).stdout.trim(),
    },
    harness: {
      runDir,
      commands: 'node scripts/parity-r02-install/run.mjs [preflight|install|native|compose|migration|all|falsify|receipt|clean]',
    },
    lanes: bins,
    skipped,
    score,
    summary: `cleanInstall=${score.cleanInstall} native=${score.native} compose=${score.compose} migration=${score.migration} (migration score ignores the single named SKIPPED original-fixture step)`,
  };
  writeJson(join(runDir, 'receipt.json'), receiptJson);
  console.log(JSON.stringify(receiptJson, null, 2));
  return receiptJson;
}

function clean(ctx) {
  const { runDir, clean } = ctx;
  // Stop anything this harness left running, scoped to what it started.
  for (const f of ['native-hermetic.json', 'native-leak.json']) {
    const st = readJson(join(runDir, 'state', f));
    if (!st) continue;
    for (const pid of Object.values(st?.shutdown?.services || {})) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
  }
  for (const pid of Object.values(parseLauncherLines(readFileSafe(join(runDir, 'logs/native/lane-hermetic.log'), '')).pids)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  }
  runSync('docker', ['compose', '-p', COMPOSE_PROJECT, 'down', '-v', '--remove-orphans']);
  const leftovers = offsetRegistryLeftovers(clean);
  for (const f of leftovers) rmSync(join(clean, 'packages/gateway/resources/skills', f), { force: true });
  rmSync(runDir, { recursive: true, force: true });
  console.log('[clean] removed ' + runDir);
  return { ok: true };
}

function readFileSafe(path, fallback) {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
}

// ---------------------------------------------------------------- falsification

async function falsify(ctx, mode) {
  const { runDir, clean, args } = ctx;
  const offsetRes = await chooseOffset(args, runDir, {});
  if (!offsetRes.ok) return { ok: false, name: offsetRes.reason };
  const offset = offsetRes.offset;
  const logs = join(runDir, 'logs', 'falsify');
  mkdirSync(logs, { recursive: true });
  const t0 = Date.now();
  let observed = null;
  let namedFailure = null;
  let restored = false;

  if (mode === 'native-leak' || mode === 'compose-leak') {
    writeFileSync(join(clean, '.env'), CANARY_ENV_CONTENT);
    try {
      if (mode === 'native-leak') observed = await nativeLane(ctx, { offset, mode: 'leak' });
      else observed = await composeLane(ctx, { offset, mode: 'leak' });
      namedFailure = observed.namedFailure || { name: 'NO_LEAK', detail: 'the planted .env leak was not observed by the lane (unexpected)' };
    } finally {
      rmSync(join(clean, '.env'), { force: true });
      restored = !existsSync(join(clean, '.env'));
    }
  } else if (mode === 'native-collision' || mode === 'compose-collision') {
    // Occupy one of the lane ports (example-skill's) and prove the collision surfaces as a
    // NAMED failure — port preflight and/or the lane's readiness guard — instead of a
    // confusing downstream error.
    const holder = await holdPort(REF_PORTS['example-skill'] + offset);
    try {
      const pf = await preflight(ctx);
      if (mode === 'native-collision') observed = await nativeLane(ctx, { offset, mode: 'collision' });
      else observed = await composeLane(ctx, { offset, mode: 'collision' });
      namedFailure = observed.namedFailure
        || (pf.offsetChoice.ok ? null : { name: pf.offsetChoice.reason, detail: JSON.stringify(pf.offsetChoice.collisions || []) })
        || { name: 'NO_COLLISION_FAILURE', detail: 'the lane reported no failure while example-skill\'s port was held by another listener' };
    } finally {
      holder.close();
      restored = await portFree(REF_PORTS['example-skill'] + offset);
    }
  } else {
    throw new Error(`unknown falsify mode ${mode}`);
  }

  const result = {
    lane: 'falsify',
    mode,
    offset,
    namedFailure,
    observed: summarizeLane(observed),
    restored,
    durationMs: Date.now() - t0,
    ok: namedFailure !== null && namedFailure.name !== 'NO_LEAK' && namedFailure.name !== 'NO_COLLISION_FAILURE',
  };

  // Restore = put the environment back AND prove the lane passes again. Rerunning the full
  // hermetic lane after the deliberate breakage is what "record both outputs" means here.
  let restoredLane = null;
  if (result.ok) {
    if (mode === 'native-leak' || mode === 'native-collision') {
      restoredLane = await nativeLane(ctx, { offset, mode: 'hermetic' });
    } else {
      restoredLane = await composeLane(ctx, { offset, mode: 'hermetic' });
    }
    result.restoredLane = summarizeLane(restoredLane);
    result.restoredOk = restoredLane.namedFailure === null && restoredLane.readiness?.ok
      && restoredLane.envLeak?.adminStatus === 503 && (restoredLane.contract?.fail ?? -1) === 0;
  }
  writeFileSync(join(runDir, 'logs', 'falsify', `${mode}.log`), `${JSON.stringify(result, null, 2)}\n`);
  writeJson(join(runDir, 'state', `falsify-${mode}.json`), result);
  console.log(`[falsify ${mode}] named=${namedFailure && namedFailure.name} restored=${restored} restoredLane=${result.restoredOk == null ? 'n/a' : result.restoredOk}`);
  return result;
}

async function holdPort(port) {
  const { createServer } = await import('node:net');
  const srv = createServer();
  await new Promise((resolveListener, rejectListener) => {
    srv.once('error', rejectListener);
    srv.listen(port, '0.0.0.0', resolveListener);
  });
  return { close: () => new Promise((r) => srv.close(r)) };
}

function summarizeLane(lane) {
  if (!lane) return null;
  return {
    lane: lane.lane,
    readiness: lane.readiness && { ok: lane.readiness.ok, timedOut: lane.readiness.timedOut },
    contract: lane.contract && { exitCode: lane.contract.exitCode, pass: lane.contract.pass, fail: lane.contract.fail, warn: lane.contract.warn },
    envLeak: lane.envLeak,
    up: lane.up && { exitCode: lane.up.exitCode },
  };
}

// --------------------------------------------------------------------- dispatch

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.runDir;
  const clean = join(runDir, 'clean');
  const home = join(runDir, 'home');
  for (const d of [runDir, join(runDir, 'logs'), join(runDir, 'state'), home]) mkdirSync(d, { recursive: true });
  const ctx = { args, runDir, clean, home, timeoutMs: args.timeout };

  switch (args.cmd) {
    case 'preflight': {
      const res = await preflight(ctx);
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'install': {
      const res = await cleanInstall(ctx);
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'native': {
      const off = await chooseOffset(args, runDir, {});
      if (!off.ok) { console.error(`ABORT ${off.reason}: ${JSON.stringify(off.collisions || [])}`); process.exit(1); }
      const res = await nativeLane(ctx, { offset: off.offset, mode: 'hermetic' });
      process.exit(res.ok && res.namedFailure === null ? 0 : 1);
      break;
    }
    case 'compose': {
      const off = await chooseOffset(args, runDir, {});
      if (!off.ok) { console.error(`ABORT ${off.reason}: ${JSON.stringify(off.collisions || [])}`); process.exit(1); }
      const res = await composeLane(ctx, { offset: off.offset, mode: 'hermetic' });
      process.exit(res.ok && res.namedFailure === null ? 0 : 1);
      break;
    }
    case 'migration': {
      const res = await runMigration(ctx);
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'all': {
      const pf = await preflight(ctx);
      if (!pf.ok) { console.error('[all] preflight aborted'); process.exit(1); return; }
      const a = await cleanInstall(ctx);
      if (!a.ok) { console.error('[all] clean install failed'); process.exit(1); return; }
      const n = await nativeLane(ctx, { offset: pf.offsetChoice.offset, mode: 'hermetic' });
      const c = await composeLane(ctx, { offset: pf.offsetChoice.offset, mode: 'hermetic' });
      const m = await runMigration(ctx);
      receipt(ctx);
      const pass = n.ok && c.ok && m.ok;
      console.log(`[all] native=${n.ok} compose=${c.ok} migration=${m.ok}`);
      process.exit(pass ? 0 : 1);
      break;
    }
    case 'falsify': {
      if (!args.arg) throw new Error('falsify needs a mode: native-leak|compose-leak|native-collision|compose-collision');
      if (!existsSync(clean)) { await cleanInstall(ctx); }
      const res = await falsify(ctx, args.arg);
      process.exit(res.ok ? 0 : 1);
      break;
    }
    case 'receipt': {
      receipt(ctx);
      break;
    }
    case 'clean': {
      clean(ctx);
      break;
    }
    default:
      console.log(`usage: node ${process.argv[1]} [preflight|install|native|compose|migration|all|falsify <mode>|receipt|clean] [--offset N] [--run-dir D]`);
      process.exit(2);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
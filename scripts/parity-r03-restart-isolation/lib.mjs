// R-03 restart/isolation harness helpers. The child environment is built from scratch so
// the native full-stack lane cannot read the invoking shell's .env or live stores.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '..', '..');

// The native launcher exposes this complete Phoenix stack. Keep this list in lockstep with the
// launcher so readiness and release checks cannot accidentally cover only the hub.
export const REF_PORTS = Object.freeze({
  hub: 9000,
  'report-skill': 9003,
  'chitchat-skill': 9004,
  parser: 9005,
  history: 9006,
  lasso: 9007,
  'color-skill': 9008,
  'answer-skill': 9009,
  ota: 9010,
  account: 9011,
  classic: 9012,
  'example-skill': 9013,
  'template-skill': 9014,
});
export const CONTRACT_SERVICES = Object.freeze(Object.keys(REF_PORTS));
export const RESERVED_HOST_PORTS = new Set([443, 9013, ...range(29000, 29011)]);

function range(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) values.push(value);
  return values;
}

export function offsetPorts(offset) {
  return Object.fromEntries(CONTRACT_SERVICES.map((name) => [name, REF_PORTS[name] + offset]));
}

export function percentiles(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const nearestRank = (percentile) => sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
  return {
    n: sorted.length,
    p50: nearestRank(50),
    p95: nearestRank(95),
    max: sorted.at(-1),
  };
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function portFree(port, host = '0.0.0.0') {
  return new Promise((resolvePort) => {
    const server = createServer();
    const failed = () => resolvePort(false);
    server.once('error', failed);
    server.once('listening', () => {
      server.close(() => resolvePort(true));
    });
    server.listen({ port, host, exclusive: true });
  });
}

/** Bind and close a real TCP listener; this is the positive port-reuse probe. */
export async function rebindPort(port, host = '0.0.0.0') {
  const startedAt = Date.now();
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host, exclusive: true });
  });
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return { port, ok: true, elapsedMs: Date.now() - startedAt };
}

export function rebindFailureName(error) {
  return error?.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'REBIND_FAILED';
}

export async function rebindAll(ports) {
  const rows = {};
  for (const [name, port] of Object.entries(ports)) {
    try {
      rows[name] = await rebindPort(port);
    } catch (error) {
      rows[name] = { port, ok: false, error: rebindFailureName(error), message: error.message };
    }
  }
  return rows;
}

export async function chooseOffset({ candidates = [700, 800, 600, 1000, 1100, 1200, 1300, 1400, 1500] } = {}) {
  const rejected = [];
  for (const offset of candidates) {
    const ports = offsetPorts(offset);
    const collisions = [];
    for (const [name, port] of Object.entries(ports)) {
      if (RESERVED_HOST_PORTS.has(port)) collisions.push({ name, port, reason: 'reserved' });
      else if (!(await portFree(port))) collisions.push({ name, port, reason: 'in-use' });
    }
    if (!collisions.length) return { ok: true, offset, ports, rejected };
    rejected.push({ offset, collisions });
  }
  return { ok: false, reason: 'NO_FREE_PORT_RANGE', rejected };
}

/**
 * Construct only deliberate child variables. `LLM_URL` is a loopback fixture owned by the
 * harness; it is not a machine or LAN dependency. All stores live under the supplied run dir.
 */
export function hermeticEnv({ home, runDir, offset, ports, llmUrl, asrUrl, tokenSecret }) {
  const stores = join(runDir, 'stores');
  const logs = join(runDir, 'logs');
  const tmp = join(home, 'tmp');
  for (const dir of [home, stores, logs, tmp]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    TMPDIR: tmp,
    PHOENIX_ENV_FILE: '/dev/null',
    PHOENIX_PORT_OFFSET: String(offset),
    PHOENIX_LOG_DIR: logs,
    ETCO_account_dataFile: join(stores, 'account.json'),
    ETCO_history_dataFile: join(stores, 'history.json'),
    ETCO_gqa_attributionFile: join(stores, 'gqa-attribution.json'),
    ETCO_account_photoDirectory: join(stores, 'member-photos'),
    ETCO_hub_recordSpeechHistory: 'true',
    ETCO_hub_recordLaunchHistory: 'true',
    NET_settings: `localhost:${ports.account}`,
    HUB_TOKEN_SECRET: tokenSecret,
    DISABLE_AUTH: 'false',
    PHOENIX_GQA_DEFAULT_PROFILE: 'phoenix-answer',
    LLM_URL: llmUrl,
    PARAKEET_URL: asrUrl,
    LLM_MODEL: 'r03-loopback-fixture',
    ACCOUNT: '1',
    CLASSIC: '1',
    OTA: '1',
  };
}

export async function waitReady(ports, { timeoutMs = 60000, startMs = Date.now() } = {}) {
  const ready = {};
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Promise.all(Object.entries(ports).map(async ([name, port]) => {
      if (ready[name] !== undefined) return;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthcheck`, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.status === 200) ready[name] = Date.now() - startMs;
      } catch { /* service not ready yet */ }
    }));
    if (Object.keys(ready).length === Object.keys(ports).length) {
      return { ok: true, ready, readyMs: Date.now() - startMs, timedOut: [] };
    }
    await sleep(150);
  }
  return {
    ok: false,
    ready,
    readyMs: Date.now() - startMs,
    timedOut: Object.keys(ports).filter((name) => ready[name] === undefined),
  };
}

export function parseLauncherPids(output) {
  const pids = {};
  const exits = {};
  for (const line of output.split('\n')) {
    const pid = line.match(/^compose-contract pid (\S+) (\d+)$/);
    if (pid) pids[pid[1]] = Number(pid[2]);
    const exit = line.match(/^compose-contract exit (\S+) (\d+)$/);
    if (exit) exits[exit[1]] = Number(exit[2]);
  }
  return { pids, exits };
}

export function spawnStack({ env, logPath }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const child = spawn('bash', ['scripts/run-compose-stack.sh', '--no-env'], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const done = new Promise((resolveDone) => {
    child.once('exit', (code, signal) => resolveDone({ code, signal }));
  });
  done.then(() => writeFileSync(logPath, `${stdout}\n--- stderr ---\n${stderr}`));
  return {
    child,
    done,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    pids() { return parseLauncherPids(stdout).pids; },
  };
}

function signal(pid, name) {
  if (!pid) return;
  try { process.kill(pid, name); } catch { /* already gone */ }
}

export async function stopStack(stack, { graceMs = 15000 } = {}) {
  const pids = stack.pids();
  const group = stack.child.pid;
  // Signal each service first and leave the launcher alive to wait for every child. Killing the
  // launcher group first makes its parent exit before the children have released their listeners,
  // which would turn a measurement of the stack into a measurement of this harness bug.
  for (const pid of Object.values(pids)) signal(pid, 'SIGTERM');
  let result = await Promise.race([
    stack.done,
    sleep(graceMs).then(() => ({ code: 'timeout', signal: null })),
  ]);
  if (result.code === 'timeout') {
    if (group) signal(-group, 'SIGKILL');
    for (const pid of Object.values(pids)) signal(pid, 'SIGKILL');
    result = await Promise.race([stack.done, sleep(5000).then(() => ({ code: 'kill-timeout', signal: null }))]);
  }
  // A launcher exit is not itself proof that every service has left; give the kernel a short
  // scheduling turn before the caller performs the bind probes.
  await sleep(25);
  return {
    ...result,
    launcherPids: pids,
    childPid: stack.child.pid,
    stdout: stack.stdout,
    stderr: stack.stderr,
  };
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function gitRev() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function gitDirty() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '';
}

export function removePath(path) {
  rmSync(path, { recursive: true, force: true });
}

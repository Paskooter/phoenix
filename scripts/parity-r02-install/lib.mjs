// Shared helpers for the R-02 install harness. Nothing here reads .env, the
// real account store (~/.local/share/phoenix), or the live robot stack.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '..', '..');

// Ground truth — the reference compose contract (host ports, spacing fixed).
export const REF_PORTS = {
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
};
export const CONTRACT_SERVICES = Object.keys(REF_PORTS);

// Compose host-port environment variable per service (docker-compose.yml). The
// container-side port stays 8080; only the published host port is parametrized.
export const COMPOSE_PORT_VARS = {
  hub: 'HUB_PORT',
  'report-skill': 'REPORT_SKILL_PORT',
  'chitchat-skill': 'CHITCHAT_SKILL_PORT',
  parser: 'PARSER_PORT',
  history: 'HISTORY_PORT',
  lasso: 'LASSO_PORT',
  'color-skill': 'COLOR_SKILL_PORT',
  'answer-skill': 'ANSWER_SKILL_PORT',
  ota: 'OTA_PORT',
  account: 'ACCOUNT_PORT',
  classic: 'CLASSIC_PORT',
  'example-skill': 'EXAMPLE_SKILL_PORT',
  'template-skill': 'TEMPLATE_SKILL_PORT',
};

// Host ports the verification may never touch: the live robot stack, plain HTTPS,
// and the browser-proxy that already holds 9013 on this machine.
export const RESERVED_HOST_PORTS = new Set([443, 9013, ...range(29000, 29012)]);

export const DEFAULT_OFFSET = 200; // reference range 9000-9014 -> 9200-9214, clear of 9013

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

export const COMPOSE_PROJECT = 'phoenix-r02';

export function offsetPorts(offset) {
  return Object.fromEntries(CONTRACT_SERVICES.map((s) => [s, REF_PORTS[s] + offset]));
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when a TCP listener can bind the port (i.e. it is currently free). */
export function portFree(port, host = '0.0.0.0') {
  return new Promise((resolveListener) => {
    const srv = createServer();
    srv.once('error', () => resolveListener(false));
    srv.once('listening', () => { srv.close(() => resolveListener(true)); });
    srv.listen(port, host);
  });
}

// A verification env is built FROM SCRATCH: nothing is inherited from the
// parent shell. The launcher and the node services must not see this machine's
// ETCO_*/NET_*/PARAKEET_*/LLM_*/PHOENIX_* configuration, only what the harness
// deliberately sets (port offset, log dir, PHOENIX_ENV_FILE=/dev/null).
const BLOCKED_PREFIXES = ['ETCO_', 'NET_'];
const BLOCKED_NAMES = new Set([
  'PARAKEET_URL', 'LLM_URL', 'LLM_MODEL', 'LLM_API_KEY', 'OPENROUTER_API_KEY',
  'HUB_TOKEN_SECRET', 'ADMIN_PASSWORD', 'DISABLE_AUTH', 'OTA_PUBLIC_URL',
  'PHOTO_PUBLIC_URL', 'CLASSIC_PUBLIC_URL', 'PREFS_FROM_CONFIG',
]);

export function buildEnv({ home, extra = {} } = {}) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: home,
    LANG: process.env.LANG || 'C.UTF-8',
    TMPDIR: join(home, 'tmp'),
    // The services load .env through @phoenix/common's dotenv loader; pointing it at
    // /dev/null makes "load nothing" explicit even when a .env exists in the tree.
    PHOENIX_ENV_FILE: '/dev/null',
    ...extra,
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  for (const key of Object.keys(env)) {
    if (BLOCKED_PREFIXES.some((p) => key.startsWith(p))) {
      throw new Error(`r02: refusing to construct an env that sets ${key}`);
    }
    if (BLOCKED_NAMES.has(key) && extra[key] === undefined) {
      throw new Error(`r02: refusing to construct an env that sets ${key}`);
    }
  }
  return env;
}

/** Spawn and run to completion, returning { code, signal, stdout, stderr }. */
export async function runCapture(cmd, args, { timeoutMs = Infinity, ...opts } = {}) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.once('error', (err) => { if (timer) clearTimeout(timer); rejectChild(err); });
    child.once('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolveChild({ code, signal, stdout, stderr });
    });
  });
}

/** Synchronous spawn; used for quick docker/git/npm one-offs. */
export function runSync(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

export function gitRev() {
  const r = runSync('git', ['rev-parse', 'HEAD'], { cwd: repo });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function gitShort() {
  return (gitRev() || '').slice(0, 10);
}

// Poll GET /healthcheck on each service's (offset) port until every one answers 200.
// A service that is not listening cannot be under test — resolve the lane as a named
// READINESS_TIMEOUT listing the offenders rather than reporting a meaningless result.
export async function waitReady(ports, { timeoutMs, startMs = Date.now(), host = '127.0.0.1' } = {}) {
  const ready = {};
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let all = true;
    for (const [name, port] of Object.entries(ports)) {
      if (ready[name] !== undefined) continue;
      try {
        const res = await fetch(`http://${host}:${port}/healthcheck`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          ready[name] = Date.now() - startMs;
          continue;
        }
      } catch { /* not up yet */ }
      all = false;
    }
    if (all) return { ready, readyMs: Date.now() - startMs, timedOut: [] };
    await sleep(250);
  }
  const never = CONTRACT_SERVICES.filter((s) => ready[s] === undefined);
  return { ready, readyMs: Date.now() - startMs, timedOut: never };
}

export function countContractOutput(output) {
  const pass = (output.match(/^PASS\b/gm) || []).length;
  const fail = (output.match(/^FAIL\b/gm) || []).length;
  const warn = (output.match(/^WARN\b/gm) || []).length;
  const summary = (output.match(/CONTRACT VERIFY: (.*)$/m) || [])[1] || null;
  return { pass, fail, warn, summary, detail: fail + warn > 0 ? output.trim().slice(-4000) : null };
}

export function parseLauncherLines(stdout) {
  const pids = {};
  const exits = {};
  for (const line of stdout.split('\n')) {
    let m = line.match(/^compose-contract pid (\S+) (\d+)$/);
    if (m) { pids[m[1]] = Number(m[2]); continue; }
    m = line.match(/^compose-contract exit (\S+) (\d+)$/);
    if (m) { exits[m[1]] = Number(m[2]); }
  }
  return { pids, exits };
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function humanMs(ms) {
  return ms == null ? null : `${(ms / 1000).toFixed(2)}s`;
}

// Tail of a service log for the named-failure detail (native logs are per-service
// files under the run's log dir; compose lanes pass the docker compose logs command
// separately and provide `logsDir` as null).
export function logTail(logsDir, name, lines = 12) {
  if (!logsDir) return '';
  const path = join(logsDir, `phx-compose-${name}.log`);
  if (!existsSync(path)) return '(no log file)';
  return readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join('\n');
}

// Assert the offset registry the launcher generates is never left behind: S-06 pins
// packages/gateway/resources/skills to its committed file list.
export function offsetRegistryLeftovers(tree) {
  let entries = [];
  try { entries = readdirSync(join(tree, 'packages/gateway/resources/skills')); }
  catch { return [`cannot read resources dir (tree=${tree})`]; }
  return entries.filter((e) => e.startsWith('skills-native-offset-'));
}

// The compose lane runs its containers as root against the bind-mounted ./packages, so it can
// leave a root-owned account store (packages/account/data/store.json) that a subsequent native
// lane — running as the invoking user — could no longer read (EACCES). Reset the mutable data
// dirs in the exported tree before each lane so no lane inherits another lane's writes.
export function resetCleanTree(tree) {
  const dir = join(tree, 'packages/account/data');
  const rm = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
  rm(join(dir, 'store.json'));
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e.startsWith('store.json') || e === 'member-photos' || e === 'gqa-attribution.json') {
      rm(join(dir, e));
    }
  }
}
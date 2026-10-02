#!/usr/bin/env node
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readDeploymentLease } from '../packages/common/src/deploymentActivity.js';

export const QUIET_MS = 60_000;
const LEASE_MS = 15_000;
const SERVICES = ['hub', 'ota'];
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function readActivity(runtimeDir, { legacy = false, now = Date.now() } = {}) {
  const registry = json(join(runtimeDir, 'services.json'));
  const services = SERVICES.map(name => {
    const service = registry.services?.[name];
    if (!service || service.state !== 'running' || !alive(service.pid)) {
      throw new Error(`Cannot confirm running ${name}; refusing deployment`);
    }
    return { ...service, name };
  });
  if (legacy) {
    // One-time bootstrap for releases predating the activity protocol. Watch
    // persisted turns AND established voice/OTA sockets for the entire minute.
    // After this rollout all deployments require live counters and drain ACKs.
    const turnsFile = process.env.PHOENIX_VOICE_TURN_FILE || join(runtimeDir, '..', 'observability', 'voice-turns.json');
    const saved = json(turnsFile);
    if (!Array.isArray(saved.turns)) throw new Error('Cannot read legacy voice activity');
    const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
    const turns = saved.turns.filter(turn => timestamp(turn.startedAt) >= services[0].startedAt);
    const activeTurns = turns.filter(turn => !turn.completedAt).length;
    const connections = execFileSync('ss', ['-Htn', 'state', 'established',
      `( sport = :${services[0].port} or sport = :${services[1].port} )`], { encoding: 'utf8', timeout: 5000 }).trim();
    const socketCount = connections ? connections.split('\n').length : 0;
    return { active: activeTurns + socketCount, lastActivityAt: Math.max(0,
      ...turns.map(turn => timestamp(turn.completedAt || turn.startedAt))), acknowledged: [],
    detail: `voice=${activeTurns}, voice/OTA connections=${socketCount}` };
  }
  const states = services.map(service => {
    const state = json(join(runtimeDir, 'deployment', service.name + '.json'));
    if (state.version !== 1 || state.service !== service.name || state.pid !== service.pid
      || !Number.isFinite(state.heartbeatAt) || now - state.heartbeatAt > 5000 || state.heartbeatAt > now + 3000
      || !Number.isFinite(state.lastActivityAt) || !state.active || typeof state.active !== 'object'
      || Object.values(state.active).some(count => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error(`Missing or stale ${service.name} activity; refusing deployment`);
    }
    return state;
  });
  const count = state => Object.values(state.active).reduce((sum, value) => sum + value, 0);
  return { active: states.reduce((sum, state) => sum + count(state), 0),
    lastActivityAt: Math.max(...states.map(state => state.lastActivityAt)),
    acknowledged: states.map(state => state.drainId),
    detail: states.map(state => `${state.service}=${count(state)}`).join(', ') };
}

/** Require a continuously observed quiet interval, then close the admission race. */
export async function waitForQuiescence({ read, claim, release, now = Date.now, sleep = delay,
  quietMs = QUIET_MS, timeoutMs = 3600000, legacy = false, report = console.log,
}) {
  const started = now();
  let quietSince = started;
  let previousActivity = -1;
  let nextReport = 0;
  while (now() - started < timeoutMs) {
    const snapshot = read(); // unavailable telemetry always fails closed
    if (snapshot.active || snapshot.lastActivityAt !== previousActivity) quietSince = now();
    previousActivity = snapshot.lastActivityAt;
    if (now() >= nextReport) {
      report(`release deploy: waiting (${snapshot.detail}); quiet ${Math.floor((now() - quietSince) / 1000)}/${quietMs / 1000}s`);
      nextReport = now() + 10000;
    }
    if (!snapshot.active && now() - quietSince >= quietMs) {
      const id = claim();
      let accepted = false;
      try {
        const claimedAt = now();
        while (now() - claimedAt < 6000) {
          const current = read();
          if (current.active || current.lastActivityAt !== snapshot.lastActivityAt) break;
          if (legacy || (current.acknowledged.length === SERVICES.length && current.acknowledged.every(value => value === id))) {
            accepted = true;
            report(legacy ? 'release deploy: full quiet minute observed; legacy activity rechecked before restart'
              : 'release deploy: full quiet minute observed; admission paused for restart');
            return id;
          }
          await sleep(200);
        }
      } finally { if (!accepted) release(); }
      quietSince = now();
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for a safe deployment window; service was not restarted');
}

function leaseOwner(runtimeDir) {
  const directory = join(runtimeDir, 'deployment');
  const owner = statSync(runtimeDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) chownSync(directory, owner.uid, owner.gid);
  const id = randomUUID();
  let timer;
  let held = false;
  function write() {
    const file = join(directory, 'drain.json');
    const temp = `${file}.${id}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, id, ownerPid: process.pid, expiresAt: Date.now() + LEASE_MS }), { mode: 0o600 });
      chmodSync(temp, 0o600);
      if (process.getuid?.() === 0) chownSync(temp, owner.uid, owner.gid);
      renameSync(temp, file);
    } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
  }
  const release = () => {
    clearInterval(timer);
    if (held) {
      try { if (json(join(directory, 'drain.json')).id === id) unlinkSync(join(directory, 'drain.json')); }
      catch (error) { if (error.code !== 'ENOENT') console.error('release deploy: lease cleanup failed; it expires automatically in 15 seconds'); }
    }
    held = false;
  };
  return { release, claim() {
    if (readDeploymentLease(directory)) throw new Error('Another deployment holds the admission lease');
    write(); held = true;
    timer = setInterval(() => {
      try { write(); }
      catch { console.error('release deploy: cannot renew admission lease'); process.kill(process.pid, 'SIGTERM'); }
    }, 2000);
    return id;
  } };
}

function liveLease(runtimeDir) {
  const lease = readDeploymentLease(join(runtimeDir, 'deployment'));
  if (!lease || !process.env.PHOENIX_DEPLOY_LEASE || lease.id !== process.env.PHOENIX_DEPLOY_LEASE || !alive(lease.ownerPid)) {
    throw new Error('Activation requires a live safe-deployment lease');
  }
  return lease;
}

export function verifyLease(runtimeDir, legacy = false) {
  const lease = liveLease(runtimeDir);
  const snapshot = readActivity(runtimeDir, { legacy });
  if (snapshot.active || (!legacy && !snapshot.acknowledged.every(id => id === lease.id))) {
    throw new Error('Work resumed before activation; refusing restart');
  }
}

async function main() {
  const runtimeDir = process.env.PHOENIX_DEPLOY_RUNTIME_DIR || process.env.PHOENIX_RUNTIME_DIR
    || join(process.env.PHOENIX_DATA_DIR || '/var/lib/phoenix', 'run');
  const args = process.argv.slice(2);
  const legacy = args.includes('--legacy');
  if (args.includes('--verify-owner')) { liveLease(runtimeDir); return; }
  if (args.includes('--verify')) { verifyLease(runtimeDir, legacy); return; }
  const command = args.slice(args.indexOf('--') + 1);
  if (!args.includes('--') || !command.length) throw new Error('Expected -- command [arguments]');
  if (legacy) console.log('release deploy: bootstrapping activity tracking; observing existing turn records and voice/OTA connections');
  const owner = leaseOwner(runtimeDir);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const id = await waitForQuiescence({ read: () => readActivity(runtimeDir, { legacy }),
      ...owner, legacy, sleep: ms => delay(ms, undefined, { signal: controller.signal }) });
    controller.signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit',
        env: { ...process.env, PHOENIX_DEPLOY_LEASE: id, PHOENIX_DEPLOY_RUNTIME_DIR: runtimeDir,
          PHOENIX_DEPLOY_LEGACY: legacy ? '1' : '0' } });
      const stop = () => child.kill('SIGTERM');
      controller.signal.addEventListener('abort', stop, { once: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        controller.signal.removeEventListener('abort', stop);
        if (code === 0) resolve();
        else reject(new Error(`Activation failed (${signal || code})`));
      });
    });
  } finally {
    owner.release();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`release deploy: ${error.message}`); process.exitCode = 1; });
}

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readDeploymentLease(directory, now = Date.now()) {
  let lease;
  try { lease = JSON.parse(readFileSync(join(directory, 'drain.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (lease.version !== 1 || typeof lease.id !== 'string' || !Number.isFinite(lease.expiresAt)) {
    throw new Error('Invalid deployment drain lease');
  }
  return lease.expiresAt > now ? lease : null;
}

/** Count work through its actual completion; no audio, account IDs or URLs. */
export function createDeploymentActivity(service, {
  runtimeDir = process.env.PHOENIX_RUNTIME_DIR, now = Date.now,
  heartbeatMs = 1000, log = console,
} = {}) {
  if (!runtimeDir) return { begin: () => () => {}, stop() {} };
  if (!/^[a-z-]+$/.test(service)) throw new Error('Invalid deployment activity service');
  const directory = join(runtimeDir, 'deployment');
  const file = join(directory, service + '.json');
  const state = { version: 1, service, pid: process.pid, instance: randomUUID(),
    heartbeatAt: now(), lastActivityAt: now(), active: {}, drainId: null };
  let warned = false;
  let stopped = false;
  function publish() {
    if (stopped) return;
    const temp = `${file}.${state.instance}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      state.heartbeatAt = now();
      state.drainId = readDeploymentLease(directory, now())?.id || null;
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, file);
      warned = false;
    } catch {
      // Missing/stale telemetry makes the deployer wait or abort. Ordinary
      // service traffic should not fail merely because this disk is full.
      if (!warned) log.warn?.('Deployment activity unavailable; deployment will be blocked');
      warned = true;
    } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
  }
  function draining() {
    try { return !!readDeploymentLease(directory, now()); }
    catch { return true; } // unreadable admission barrier must fail closed
  }
  publish();
  const timer = setInterval(publish, heartbeatMs);
  timer.unref();
  return {
    begin(kind) {
      if (stopped || draining()) return null;
      state.active[kind] = (state.active[kind] || 0) + 1;
      state.lastActivityAt = now();
      publish();
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        state.active[kind]--;
        state.lastActivityAt = now();
        publish();
      };
      // A deployer may have claimed its lease during the preceding write.
      // The deployer also waits for every process to acknowledge that lease.
      if (draining()) { end(); return null; }
      return end;
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}

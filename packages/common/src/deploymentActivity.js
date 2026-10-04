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
  heartbeatMs = 1000, log = console, onStartup,
} = {}) {
  if (!runtimeDir) {
    const activity = { begin: () => () => {}, trackExisting: () => () => {}, stop() {} };
    onStartup?.(activity);
    return activity;
  }
  if (!/^[a-z-]+$/.test(service)) throw new Error('Invalid deployment activity service');
  const directory = join(runtimeDir, 'deployment');
  const file = join(directory, service + '.json');
  const state = { version: 1, service, pid: process.pid, instance: randomUUID(),
    heartbeatAt: now(), lastActivityAt: now(), active: {}, drainId: null };
  let warned = false;
  let stopped = false;
  let initializing = true;
  let timer;
  function publish() {
    if (stopped || initializing) return;
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
  function trackExisting(kind) {
    if (stopped) return null;
    state.active[kind] = (state.active[kind] || 0) + 1;
    state.lastActivityAt = now();
    publish();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      state.active[kind]--;
      state.lastActivityAt = now();
      publish();
    };
  }
  const activity = {
    begin(kind) {
      if (stopped || draining()) return null;
      const end = trackExisting(kind);
      // A deployer may have claimed its lease during the preceding write.
      // The deployer also waits for every process to acknowledge that lease.
      if (draining()) { end(); return null; }
      return end;
    },
    // Observe work that is already executing; this never authorizes dispatch.
    // A replacement process must restore that count even under a drain lease.
    trackExisting,
    stop() { stopped = true; clearInterval(timer); },
  };
  // Restore observed outstanding work before publishing this process's first
  // heartbeat. A crashed predecessor must never be replaced by a fresh zero.
  onStartup?.(activity);
  initializing = false;
  publish();
  timer = setInterval(publish, heartbeatMs);
  timer.unref();
  return activity;
}

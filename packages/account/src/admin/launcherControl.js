// What the console can see of, and ask of, the native launcher
// (scripts/run-compose-stack.sh) that runs every Phoenix service.
//
// The launcher tells each service its pid and its run directory. In that
// directory it keeps services.json, rewritten whenever a service starts or
// stops, and it reads restart-request when it receives SIGUSR1. The console only
// signals the launcher that actually started it: a pid that merely names some
// other process gets nothing.
//
// Under Docker Compose, or any service started by hand, there is no launcher:
// the console says so and does not offer to restart or apply anything.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES, SERVICE_IDS } from './configCatalog.js';

const PROBE_TIMEOUT_MS = 1500;

/** @returns {{available: true, pid: number, dir: string} | {available: false, reason: string}} */
export function launcherControl(env = process.env, { ppid = process.ppid } = {}) {
  const pid = Number(env.PHOENIX_LAUNCHER_PID);
  const dir = env.PHOENIX_RUNTIME_DIR;
  if (!Number.isSafeInteger(pid) || pid <= 1 || !dir) return { available: false, reason: 'no-launcher' };
  if (pid !== ppid) return { available: false, reason: 'not-parent' };
  if (!existsSync(join(dir, 'services.json'))) return { available: false, reason: 'no-state' };
  return { available: true, pid, dir };
}

/** What the browser is told about restart control: never the pid or a path. */
export function controlView(control) {
  if (control.available) return { available: true };
  return {
    available: false,
    reason: control.reason,
    message: control.reason === 'no-launcher'
      ? 'This server’s services aren’t run by Phoenix’s launcher, so the console can’t restart them or '
        + 'apply settings. Change settings where the services are configured, then restart them there.'
      : 'The launcher that started this console isn’t reachable, so the console can’t restart services '
        + 'or apply settings right now. Restarting Phoenix fixes this.',
  };
}

/** The launcher's services.json, or null when it cannot be read. */
export function readLauncherState(control) {
  if (!control?.available) return null;
  try {
    const raw = JSON.parse(readFileSync(join(control.dir, 'services.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.services || typeof raw.services !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

function probeHost(bindHost) {
  if (!bindHost || bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::' || bindHost === '[::]') return '[::1]';
  if (bindHost.includes(':') && !bindHost.startsWith('[')) return `[${bindHost}]`;
  return bindHost;
}

/** One health check: a live service answers /healthcheck quickly. */
export async function probeService(host, port, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const res = await fetchImpl(`http://${host}:${port}/healthcheck`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // Drain the body so the socket is released.
    await res.text().catch(() => '');
    return { healthy: res.ok, latencyMs: Date.now() - started };
  } catch {
    return { healthy: false, latencyMs: null };
  }
}

/**
 * Every service the launcher runs, in the catalogue's order, with labels and,
 * when `probe` is set, a live health check of each running one.
 */
export async function servicesStatus(control, { probe = true, fetchImpl = fetch } = {}) {
  const state = readLauncherState(control);
  if (!state) return { launcher: null, services: [] };
  const host = probeHost(state.bindHost);
  const ids = SERVICE_IDS.filter((id) => state.services[id]);
  const services = await Promise.all(ids.map(async (id) => {
    const s = state.services[id];
    const running = s.state === 'running' && Number.isSafeInteger(s.pid);
    const check = probe && running ? await probeService(host, s.port, fetchImpl) : { healthy: null, latencyMs: null };
    return {
      id,
      label: SERVICES[id].label,
      description: SERVICES[id].description,
      minor: !!SERVICES[id].minor,
      state: ['running', 'restarting', 'stopped'].includes(s.state) ? s.state : 'stopped',
      startedAt: Number.isFinite(s.startedAt) ? s.startedAt : null,
      revision: Number.isSafeInteger(s.revision) ? s.revision : 0,
      safeMode: s.safeMode === true,
      restarts: Number.isSafeInteger(s.restarts) ? s.restarts : 0,
      exitCode: Number.isSafeInteger(s.exitCode) ? s.exitCode : null,
      healthy: check.healthy,
      latencyMs: check.latencyMs,
    };
  }));
  return { launcher: { startedAt: Number.isFinite(state.startedAt) ? state.startedAt : null }, services };
}

/**
 * Ask the launcher to restart services. Names are appended, so two requests in
 * quick succession are both served, then the launcher is signalled.
 */
export function requestRestart(control, ids) {
  if (!control?.available) throw new Error('the launcher is not reachable');
  const names = ids.filter((id) => SERVICE_IDS.includes(id));
  if (!names.length) return [];
  appendFileSync(join(control.dir, 'restart-request'), `${names.join('\n')}\n`, { mode: 0o600 });
  process.kill(control.pid, 'SIGUSR1');
  return names;
}

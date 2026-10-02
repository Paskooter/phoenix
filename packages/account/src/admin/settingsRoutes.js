// Admin settings and service control.
//
//   GET  /api/admin/settings          every setting: where its value comes from, and whether a
//                                      saved change is still waiting for a restart
//   PUT  /api/admin/settings          { changes: { KEY: value | null } } — save, all or nothing
//   GET  /api/admin/services          the services the launcher runs, each health-checked now
//   POST /api/admin/services/restart  { services: [id…] | 'all' } — restart them
//
// A setting's value comes from, in order: what was saved here (consoleSettings.js),
// the server's environment file, or the built-in default. Saving here never edits
// the environment file. A saved change takes effect when the services that read it
// restart, which this API can ask the launcher to do; until then the setting says
// which services are still running without it.
//
// Secrets never leave the server: the browser learns only whether one is set,
// and for a long one its last four characters, so two keys can be told apart.

import { logger } from '@phoenix/common';
import {
  BY_KEY, GROUPS, SERVICES, SERVICE_IDS, SETTINGS, checkTogether, servicesFor, validate,
} from './configCatalog.js';
import {
  applyConsoleChanges, consoleSettingsFile, readConsoleSettings, writeConsoleSettings,
} from './consoleSettings.js';
import { envFilePath, readEnvFile } from './envFile.js';
import { controlView, launcherControl, readLauncherState, requestRestart, servicesStatus } from './launcherControl.js';

const log = logger('account.admin');

/** The server's own values: its environment file, and what this process was started with. */
export function readServerValues(env = process.env) {
  const path = envFilePath(env);
  let file = { values: {}, exists: false };
  let readable = true;
  try { file = readEnvFile(path); } catch { readable = false; }
  return { path, exists: !!file.exists, readable, file: file.values, env };
}

/**
 * A setting's value on the server, ignoring anything saved here. The environment
 * file is authoritative; this process's environment covers values a supervisor set
 * directly. An editable setting that has been saved here is read from the file
 * alone, because this process may have been started with the saved value.
 */
function serverValue(server, key, savedHere) {
  if (Object.prototype.hasOwnProperty.call(server.file, key)) {
    return server.file[key] === '' ? null : server.file[key];
  }
  if (savedHere) return null;
  const live = server.env[key];
  return live === undefined || live === '' ? null : String(live);
}

/** What every setting is now, as the services would see it after a restart. */
export function effectiveValues(state, server) {
  const out = {};
  for (const spec of SETTINGS) {
    const entry = state.settings[spec.key];
    const value = entry && entry.value !== null ? entry.value : serverValue(server, spec.key, !!entry);
    if (value !== null) out[spec.key] = value;
  }
  // Read by the services but not a setting of its own here.
  if (server.env.OPENROUTER_API_KEY) out.OPENROUTER_API_KEY = server.env.OPENROUTER_API_KEY;
  return out;
}

/** Services still running without a change saved here: started before it, or not running. */
function pendingServices(spec, entry, launcher) {
  if (!entry || !launcher) return [];
  return (spec.restart || []).filter((id) => {
    const s = launcher.services[id];
    if (!s) return false;
    return s.state !== 'running' || !(Number(s.revision) >= entry.revision);
  });
}

function describe(spec, state, server, launcher) {
  const entry = state.settings[spec.key] || null;
  const saved = entry && entry.value !== null ? entry.value : null;
  const fromServer = serverValue(server, spec.key, !!entry);
  const value = saved ?? fromServer;
  const secret = spec.type === 'secret';
  const view = {
    key: spec.key,
    label: spec.label,
    group: spec.group,
    type: spec.type,
    help: spec.help,
    editable: !!spec.editable,
    advanced: !!spec.advanced,
    default: spec.default ?? null,
    options: spec.options,
    placeholder: spec.placeholder,
    min: spec.min,
    max: spec.max,
    integer: !!spec.integer,
    unit: spec.unit,
    restart: spec.restart || [],
    source: saved !== null ? 'console' : fromServer !== null ? 'server' : 'default',
    isSet: value !== null,
    value: secret ? null : value,
    // Only an API key the console manages gets a hint; a server's own secrets get none.
    hint: secret && spec.editable && value && value.length >= 16 ? value.slice(-4) : null,
  };
  if (spec.editable && saved !== null) {
    view.overrides = fromServer !== null;
    if (!secret) view.serverValue = fromServer;
  }
  if (entry) {
    view.changedAt = entry.changedAt;
    view.changedBy = entry.changedBy;
    view.pending = pendingServices(spec, entry, launcher);
  }
  return view;
}

function historyView(item) {
  return {
    revision: item.revision,
    at: item.at,
    by: typeof item.by === 'string' ? item.by : null,
    changes: (Array.isArray(item.changes) ? item.changes : []).map((change) => {
      const spec = BY_KEY.get(change.key);
      const out = { key: change.key, label: spec?.label || change.key, action: change.action };
      // Only non-secret values were ever recorded.
      if (spec && spec.type !== 'secret' && change.action === 'changed') {
        out.from = change.from ?? null;
        out.to = change.to ?? null;
      }
      if (spec && spec.type !== 'secret' && change.action === 'set') out.to = change.to ?? null;
      return out;
    }),
  };
}

function normalizeValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : undefined;
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw;
  return undefined;
}

export function adminSettingsRoutes(store, {
  requireAdmin, sendJson, currentAccount, env = process.env, now = Date.now, fetchImpl = fetch,
  control: controlFor = () => launcherControl(env),
  restart = requestRestart,
}) {
  const settingsFile = () => consoleSettingsFile({ env, storeFile: store.file });

  const settingsView = () => {
    const control = controlFor();
    const { state, error } = readConsoleSettings(settingsFile());
    const server = readServerValues(env);
    const launcher = readLauncherState(control);
    const { warnings } = checkTogether(effectiveValues(state, server));
    return {
      control: controlView(control),
      revision: state.revision,
      settingsError: error ? 'Saved settings could not be read, so none of them are in use.' : null,
      serverFile: { path: server.path, exists: server.exists, readable: server.readable },
      groups: GROUPS,
      services: Object.fromEntries(SERVICE_IDS.map((id) => [id, { label: SERVICES[id].label }])),
      running: launcher ? SERVICE_IDS.filter((id) => launcher.services[id]) : [],
      settings: SETTINGS.map((spec) => describe(spec, state, server, launcher)),
      warnings,
      history: state.history.slice(0, 30).map(historyView),
    };
  };

  return {
    'GET /api/admin/settings': ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      return settingsView();
    },

    'PUT /api/admin/settings': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const control = controlFor();
      if (!control.available) {
        return sendJson(res, 409, { error: controlView(control).message, code: 'NO_LAUNCHER' });
      }
      const changes = body && typeof body.changes === 'object' && !Array.isArray(body.changes) ? body.changes : null;
      if (!changes || !Object.keys(changes).length) return sendJson(res, 400, { error: 'Nothing to save.' });

      const errors = {};
      const accepted = {};
      for (const [key, raw] of Object.entries(changes)) {
        const spec = BY_KEY.get(key);
        if (!spec) { errors[key] = 'isn’t a setting this server knows'; continue; }
        if (!spec.editable) { errors[key] = 'is part of how this server is installed, so it can’t be changed here'; continue; }
        const value = normalizeValue(raw);
        if (value === undefined) { errors[key] = 'must be text'; continue; }
        const problem = value === null ? null : validate(key, value);
        if (problem) { errors[key] = problem; continue; }
        accepted[key] = value;
      }
      // All or nothing: half a saved change is harder to reason about than none.
      if (Object.keys(errors).length) return sendJson(res, 400, { error: 'Some values need fixing.', errors });

      const file = settingsFile();
      const { state, error } = readConsoleSettings(file);
      if (error) return sendJson(res, 500, { error: 'Saved settings could not be read, so nothing was saved.' });
      const actor = currentAccount(store, req);
      const label = actor?.email || actor?.firstName || null;
      const next = applyConsoleChanges(state, accepted, { actor: label, now: now() });

      // Settings that only fail together, checked as the services would see them.
      const together = checkTogether(effectiveValues(next.state, readServerValues(env)));
      if (Object.keys(together.errors).length) {
        return sendJson(res, 400, { error: 'Some values need fixing.', errors: together.errors });
      }
      if (next.changed.length) {
        try {
          writeConsoleSettings(file, next.state);
        } catch {
          return sendJson(res, 500, { error: 'The settings could not be saved on the server.' });
        }
        log.info('settings saved', { revision: next.state.revision, keys: next.changed.join(','), by: label || 'unknown' });
      }
      const launcher = readLauncherState(control);
      return {
        ...settingsView(),
        saved: next.changed,
        restart: servicesFor(next.changed).filter((id) => launcher?.services[id]),
      };
    },

    'GET /api/admin/services': async ({ req, res }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const control = controlFor();
      const { state } = readConsoleSettings(settingsFile());
      const status = await servicesStatus(control, { fetchImpl });
      const services = status.services.map((service) => ({
        ...service,
        // Saved changes this service is not running with yet.
        pendingSettings: Object.entries(state.settings).filter(([key, entry]) => service.revision < entry.revision
          && (BY_KEY.get(key)?.restart || []).includes(service.id)).length,
      }));
      return { control: controlView(control), launcher: status.launcher, revision: state.revision, services };
    },

    'POST /api/admin/services/restart': ({ req, res, body }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const control = controlFor();
      if (!control.available) {
        return sendJson(res, 409, { error: controlView(control).message, code: 'NO_LAUNCHER' });
      }
      const launcher = readLauncherState(control);
      const known = launcher ? SERVICE_IDS.filter((id) => launcher.services[id]) : [];
      const asked = body?.services === 'all' ? known : (Array.isArray(body?.services) ? body.services : []);
      const ids = known.filter((id) => asked.includes(id));
      const unknown = asked.filter((id) => !known.includes(id));
      if (unknown.length || !ids.length) {
        return sendJson(res, 400, { error: 'Name the services to restart.', unknown });
      }
      const actor = currentAccount(store, req);
      log.info('restart requested', { services: ids.join(','), by: actor?.email || 'unknown' });
      const at = now();
      // Restarting this service ends this request's process: answer first.
      if (ids.includes('account')) {
        setTimeout(() => {
          try { restart(control, ids); } catch (error) { log.error('restart request failed', { error: error.message }); }
        }, 400);
      } else {
        try { restart(control, ids); } catch {
          return sendJson(res, 503, { error: 'The launcher couldn’t be asked to restart anything.' });
        }
      }
      sendJson(res, 202, { restarting: ids, requestedAt: at });
      return undefined;
    },
  };
}

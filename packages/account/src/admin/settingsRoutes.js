// Admin settings and service control.
//
//   GET  /api/admin/settings          every setting: where its value comes from, and whether a
//                                      saved change is still waiting for a restart
//   PUT  /api/admin/settings          { changes: { KEY: value | null } } — save, all or nothing
//   GET  /api/admin/services          the services the launcher runs, each health-checked now
//   POST /api/admin/services/restart  { services: [id…] | 'all' } — restart them
//   GET  /api/admin/settings/models?key=KEY[&url=…]
//                                      the models a model setting can choose from, listed by its
//                                      endpoint (GET <endpoint>/models). Unavailable is not an
//                                      error: the console then asks for the name by hand.
//
// A setting's value comes from, in order: what was saved here (consoleSettings.js),
// the server's environment file, or the built-in default. Saving here never edits
// the environment file. A saved change takes effect when the services that read it
// restart, which this API can ask the launcher to do; until then the setting says
// which services are still running without it.
//
// Secrets never leave the server: the browser learns only whether one is set,
// and for a long one its last four characters, so two keys can be told apart.
//
// Every AI feature shares one OpenRouter key (OPENROUTER_API_KEY). When this
// service starts it moves a key saved under an older per-feature setting there,
// once (openRouterMigration.js).

import { logger } from '@phoenix/common';
import { OPENROUTER_API_URL, isOpenRouterUrl } from '@phoenix/contracts';
import {
  BY_KEY, GROUPS, SERVICES, SERVICE_IDS, SETTINGS, checkTogether, servicesFor, validate,
} from './configCatalog.js';
import {
  applyConsoleChanges, consoleSettingsFile, readConsoleSettings, writeConsoleSettings,
} from './consoleSettings.js';
import { envFilePath, readEnvFile } from './envFile.js';
import { controlView, launcherControl, readLauncherState, requestRestart, servicesStatus } from './launcherControl.js';
import { migrateOpenRouterKey } from './openRouterMigration.js';

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
    // An older setting another one replaced can be removed here, not set.
    editable: !!spec.editable && !spec.replacedBy,
    advanced: !!spec.advanced,
    default: spec.default ?? null,
    options: spec.options,
    placeholder: spec.placeholder,
    min: spec.min,
    max: spec.max,
    integer: !!spec.integer,
    unit: spec.unit,
    models: spec.models,
    modelFilter: spec.modelFilter,
    presets: spec.presets,
    replacedBy: spec.replacedBy,
    removable: !!(spec.replacedBy && spec.editable && saved !== null),
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
      // A setting's name, never a value.
      if (typeof change.movedFrom === 'string' && BY_KEY.has(change.movedFrom)) {
        out.movedFrom = BY_KEY.get(change.movedFrom).label;
      }
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

/* -- model lists --------------------------------------------------------- */

const MODEL_LIST_TIMEOUT_MS = 8000;
const MODEL_LIST_MAX_BYTES = 16 * 1024 * 1024;
const MODEL_LIST_MAX = 3000;
const MODEL_LIST_CACHE_MS = 10 * 60_000;
const modelCache = new Map();

/** Where a list came from, for the console: scheme, host and path only. */
function endpointLabel(endpoint) {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

async function boundedJson(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

const isZero = (value) => value !== undefined && value !== null && value !== '' && Number(value) === 0;

/** One model as the console shows it. Accepts OpenAI's shape, and OpenRouter's richer one. */
function modelEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const id = raw.id.trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(id)) return null;
  const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing : null;
  const out = { id };
  if (typeof raw.name === 'string' && raw.name.trim() && raw.name.length <= 200) out.name = raw.name.trim();
  if (Number.isSafeInteger(raw.context_length) && raw.context_length > 0) out.context = raw.context_length;
  out.free = id.endsWith(':free') || !!(pricing && isZero(pricing.prompt) && isZero(pricing.completion));
  return out;
}

/**
 * GET <endpoint>/models, bounded in time and size, never following a redirect.
 * @returns {Promise<{ok: true, models: object[]} | {ok: false, message: string}>}
 */
export async function listModels(endpoint, { apiKey = '', fetchImpl = fetch, cache = null, now = Date.now } = {}) {
  const target = `${String(endpoint).replace(/\/+$/, '')}/models`;
  const cacheKey = `${target}\n${apiKey ? 'key' : 'none'}`;
  const hit = cache?.get(cacheKey);
  if (hit && now() - hit.at < MODEL_LIST_CACHE_MS) return { ok: true, models: hit.models };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, message: `The endpoint answered ${response.status} when asked for its models.` };
    }
    const body = await boundedJson(response, MODEL_LIST_MAX_BYTES);
    const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
    if (!rows) return { ok: false, message: 'The endpoint didn’t return a list of models.' };
    const seen = new Set();
    const models = [];
    for (const raw of rows.slice(0, MODEL_LIST_MAX)) {
      const entry = modelEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      models.push(entry);
    }
    if (!models.length) return { ok: false, message: 'The endpoint listed no models.' };
    // OpenRouter's "~vendor/…-latest" aliases sort beside their vendor's models.
    models.sort((a, b) => a.id.replace(/^~/, '').localeCompare(b.id.replace(/^~/, '')) || a.id.localeCompare(b.id));
    cache?.set(cacheKey, { at: now(), models });
    return { ok: true, models };
  } catch {
    return { ok: false, message: controller.signal.aborted
      ? 'The endpoint took too long to list its models.' : 'The endpoint couldn’t be reached to list its models.' };
  } finally {
    clearTimeout(timer);
  }
}

export function adminSettingsRoutes(store, {
  requireAdmin, sendJson, currentAccount, env = process.env, now = Date.now, fetchImpl = fetch,
  control: controlFor = () => launcherControl(env),
  restart = requestRestart,
  migrate = true,
}) {
  const settingsFile = () => consoleSettingsFile({ env, storeFile: store.file });
  if (migrate) migrateOpenRouterKey({ file: settingsFile(), server: readServerValues(env), now: now() });

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
        if (spec.replacedBy && value !== null) {
          errors[key] = `is replaced by the ${BY_KEY.get(spec.replacedBy)?.label || spec.replacedBy}; set that instead`;
          continue;
        }
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

    'GET /api/admin/settings/models': async ({ req, res, url }) => {
      if (!requireAdmin(store, req, res)) return undefined;
      const spec = BY_KEY.get(url.searchParams.get('key') || '');
      if (!spec || spec.type !== 'model') return sendJson(res, 400, { error: 'Name a model setting.' });
      const { state } = readConsoleSettings(settingsFile());
      const values = effectiveValues(state, readServerValues(env));
      let endpoint = OPENROUTER_API_URL;
      let apiKey = '';
      if (spec.models === 'endpoint') {
        const asked = url.searchParams.get('url');
        endpoint = asked || values.LLM_URL || '';
        if (!endpoint) return { available: false, message: 'Set the endpoint first, then its models are listed here.' };
        if (validate('LLM_URL', endpoint)) return sendJson(res, 400, { error: 'That endpoint isn’t a web address.' });
        // A custom endpoint's own key goes only to the endpoint it was saved for.
        // OpenRouter lists its models without one, and its key never goes elsewhere.
        if (!isOpenRouterUrl(endpoint) && endpoint === values.LLM_URL) apiKey = values.PHOENIX_LLM_API_KEY || '';
      }
      const listed = await listModels(endpoint, { apiKey, fetchImpl, cache: modelCache, now });
      if (!listed.ok) return { available: false, endpoint: endpointLabel(endpoint), message: listed.message };
      const models = spec.modelFilter === 'free' ? listed.models.filter((m) => m.free) : listed.models;
      return { available: true, endpoint: endpointLabel(endpoint), models };
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

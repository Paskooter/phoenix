// The one-time move to a single OpenRouter key.
//
// Free AI chat, the decision layer (Jev) and news briefings each used to have
// their own OpenRouter key. They now share OPENROUTER_API_KEY. So that nobody
// has to paste a key again, the account service copies the key Phoenix was
// already using into that setting when it starts, once:
//
//   * Only when the console has never had an OpenRouter key entry. An entry an
//     administrator removed stays removed.
//   * A key saved in the console wins over one in the server's environment file,
//     as it does for every setting. Of the older keys, the decision layer's comes
//     first: it is the key an administrator most recently chose for Phoenix alone.
//   * When the server's file already sets OPENROUTER_API_KEY, only a key saved in
//     the console is moved (it was overriding the file's for its feature).
//   * The older keys are copied, never removed, so a server rolled back to an
//     earlier release still finds them. The services use them only while the
//     OpenRouter key is not set.
//
// Neither the log nor the settings history ever holds a key: only which setting
// it was copied from.

import { logger } from '@phoenix/common';
import { LEGACY_OPENROUTER_KEYS, OPENROUTER_KEY_SETTING, isOpenRouterUrl } from '@phoenix/contracts';
import { applyConsoleChanges, readConsoleSettings, writeConsoleSettings } from './consoleSettings.js';

const log = logger('account.admin');

export const MIGRATION_ACTOR = 'Phoenix (one OpenRouter key)';

/** The older keys, in the order they are preferred. */
const ORDER = [LEGACY_OPENROUTER_KEYS.decision, LEGACY_OPENROUTER_KEYS.news, LEGACY_OPENROUTER_KEYS.freeChat];

const present = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Which key to move, if any.
 * @param {object} state  console settings (consoleSettings.js)
 * @param {{file: Record<string,string>, env: Record<string,string|undefined>}} server
 *        the server's environment file, and this process's environment
 * @returns {null | {value: string, from: string, where: 'console'|'server'}}
 */
export function planOpenRouterMigration(state, server) {
  if (Object.prototype.hasOwnProperty.call(state.settings, OPENROUTER_KEY_SETTING)) return null;
  const saved = (key) => state.settings[key]?.value ?? null;
  const fromServer = (key) => {
    if (Object.prototype.hasOwnProperty.call(server.file || {}, key)) return server.file[key];
    return server.env?.[key];
  };

  for (const key of ORDER) {
    if (present(saved(key))) return { value: saved(key).trim(), from: key, where: 'console' };
  }
  if (present(fromServer(OPENROUTER_KEY_SETTING))) return null;
  for (const key of ORDER) {
    if (present(fromServer(key))) return { value: fromServer(key).trim(), from: key, where: 'server' };
  }
  // A shared model key used with OpenRouter as the endpoint was an OpenRouter key too.
  const endpoint = saved('LLM_URL') ?? fromServer('LLM_URL');
  if (isOpenRouterUrl(endpoint)) {
    if (present(saved('PHOENIX_LLM_API_KEY'))) return { value: saved('PHOENIX_LLM_API_KEY').trim(), from: 'PHOENIX_LLM_API_KEY', where: 'console' };
    if (present(fromServer('PHOENIX_LLM_API_KEY'))) return { value: fromServer('PHOENIX_LLM_API_KEY').trim(), from: 'PHOENIX_LLM_API_KEY', where: 'server' };
  }
  return null;
}

/** Apply a plan to a console-settings state. Returns the next state, or null when there is nothing to do. */
export function applyOpenRouterMigration(state, plan, { now = Date.now() } = {}) {
  if (!plan) return null;
  const next = applyConsoleChanges(state, { [OPENROUTER_KEY_SETTING]: plan.value }, { actor: MIGRATION_ACTOR, now });
  if (!next.changed.length) return null;
  // Say where it came from (a setting's name, never its value).
  next.state.history[0] = {
    ...next.state.history[0],
    changes: next.state.history[0].changes.map((change) => ({ ...change, movedFrom: plan.from })),
  };
  return next.state;
}

/**
 * Run the move against the console settings file. Never throws: a failure is
 * logged and the services keep using the older keys, which still work.
 * @returns {{migrated: boolean, from?: string, where?: string, error?: string}}
 */
export function migrateOpenRouterKey({ file, server, now = Date.now() }) {
  try {
    const { state, error } = readConsoleSettings(file);
    if (error) return { migrated: false, error: 'unreadable' };
    const plan = planOpenRouterMigration(state, server);
    const next = applyOpenRouterMigration(state, plan, { now });
    if (!next) return { migrated: false };
    writeConsoleSettings(file, next);
    log.info('moved the OpenRouter key to the one shared setting', { from: plan.from, where: plan.where, revision: next.revision });
    return { migrated: true, from: plan.from, where: plan.where };
  } catch (error) {
    log.warn('could not move the OpenRouter key to the shared setting; the older keys keep working', { error: error.code || 'error' });
    return { migrated: false, error: 'failed' };
  }
}

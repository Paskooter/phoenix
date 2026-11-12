// The one OpenRouter key every Phoenix AI feature uses.
//
// Free AI chat, the decision layer (Jev), news briefings and the language model
// (when its endpoint is OpenRouter) all talk to OpenRouter. Each used to have
// its own key setting. They now share OPENROUTER_API_KEY, and each feature only
// chooses its model.
//
// The per-feature keys that came first still work, but only as a fallback when
// the one key is not set, so an older server keeps running unchanged until its
// administrator (or the console's one-time move, see
// packages/account/src/admin/openRouterMigration.js) sets the one key.
//
// The OpenRouter key is only ever sent to https://openrouter.ai. A custom
// endpoint gets its own key (PHOENIX_LLM_API_KEY), never this one, and that key
// goes to OpenRouter only when the shared endpoint is OpenRouter itself.

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_KEY_SETTING = 'OPENROUTER_API_KEY';

/**
 * The per-feature keys the one key replaced, by feature, in the order the
 * console's one-time move prefers them. The decision layer's comes first: it is
 * the key an administrator most recently chose for Phoenix alone.
 */
export const LEGACY_OPENROUTER_KEYS = Object.freeze({
  decision: 'ETCO_parser_decisionApiKey',
  news: 'ETCO_news_llmApiKey',
  freeChat: 'PHOENIX_FREE_CHAT_API_KEY',
});

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

/** True only for an https URL on openrouter.ai itself. */
export function isOpenRouterUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:' && parsed.hostname.replace(/^www\./, '').toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}

/**
 * The shared endpoint's key (PHOENIX_LLM_API_KEY), when it may stand in for an
 * OpenRouter key: only when the shared endpoint (PHOENIX_LLM_URL, or LLM_URL as
 * the console names it) is OpenRouter itself, as older servers set it up.
 * Otherwise that key belongs to a custom endpoint and never goes to OpenRouter.
 * @param {Record<string,string|undefined>} env
 */
export function sharedKeyForOpenRouter(env = process.env) {
  const endpoint = trimmed(env?.PHOENIX_LLM_URL) || trimmed(env?.LLM_URL);
  return isOpenRouterUrl(endpoint) ? trimmed(env?.PHOENIX_LLM_API_KEY) : '';
}

/**
 * The OpenRouter key for one feature: the one key, else that feature's own
 * older key(s), in order. Empty when none is set.
 * @param {Record<string,string|undefined>} env
 * @param {...string} legacyNames older per-feature setting names to fall back on
 */
export function openRouterKey(env = process.env, ...legacyNames) {
  for (const name of [OPENROUTER_KEY_SETTING, ...legacyNames]) {
    const value = trimmed(env?.[name]);
    if (value) return value;
  }
  return '';
}

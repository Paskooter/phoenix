import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isOpenRouterUrl, openRouterKey, resolveLlmProvider, sharedKeyForOpenRouter } from '@phoenix/contracts';

const number = (value, fallback, min, max) => value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Number(value))) : fallback;
export const briefingsEnabled = (env = process.env) => /^(true|1)$/i.test(env.PHOENIX_NEWS_BRIEFINGS_ENABLED || '');

export function newsBriefingConfig(env = process.env) {
  // News has its own pinned model; changing the chat/intent model must not change
  // the cost or schema of every scheduled briefing.
  const llm = resolveLlmProvider('news', { env: {
    ...env,
    PHOENIX_LLM_URL: '', PHOENIX_LLM_MODEL: '', PHOENIX_LLM_HEADERS: '',
    ETCO_news_llmUrl: env.ETCO_news_llmUrl || 'https://openrouter.ai/api/v1',
    ETCO_news_llmModel: env.ETCO_news_llmModel || 'deepseek/deepseek-v4.1-flash',
  }, defaultTimeoutMs: 30000 });
  // Only https://openrouter.ai counts: no key goes to OpenRouter over plain http.
  const openRouter = isOpenRouterUrl(llm.url);
  let host = '';
  try { host = new URL(llm.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* invalid config stays unready */ }
  // On OpenRouter, news uses Phoenix's one OpenRouter key. Older servers kept a
  // news key, or only the decision layer's key: those are the fallbacks, in that
  // order, then the shared endpoint's key if that endpoint is OpenRouter too.
  // None of them is ever sent to a custom endpoint, and a custom endpoint's own
  // key is never sent to OpenRouter.
  if (openRouter) {
    llm.apiKey = openRouterKey(env, 'ETCO_news_llmApiKey', 'ETCO_parser_decisionApiKey') || sharedKeyForOpenRouter(env);
  } else if (host === 'openrouter.ai') {
    llm.apiKey = '';
  }
  const provider = env.PHOENIX_NEWS_PROVIDER || (env.LUMENFEED_API_KEY ? 'lumenfeed' : 'worldnews');
  return {
    enabled: briefingsEnabled(env), provider,
    // Curated uses public publisher feeds, never either paid provider's key.
    fallbackProvider: ['worldnews', 'lumenfeed'].includes(provider) ? 'curated' : null,
    apiKey: (provider === 'lumenfeed' ? env.LUMENFEED_API_KEY : provider === 'worldnews' ? env.WORLD_NEWS_API_KEY : '') || '', llm, openRouter,
    file: env.PHOENIX_NEWS_BRIEFINGS_FILE || join(env.PHOENIX_DATA_DIR
      || fileURLToPath(new URL('../../data/', import.meta.url)), 'news/briefings.json'),
    intervalMs: number(env.PHOENIX_NEWS_REFRESH_HOURS, 12, 6, 24) * 3600000,
    maxAgeMs: 36 * 3600000, storiesPerCategory: 5, candidatesPerCategory: 10,
    dailyPoints: number(env.PHOENIX_NEWS_DAILY_POINTS, 40, 0, 45),
    dailyLlmUsd: number(env.PHOENIX_NEWS_DAILY_LLM_USD, 0.15, 0, 5),
    maxLlmCalls: 220,
  };
}

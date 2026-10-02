import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolveLlmProvider } from '@phoenix/contracts';

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
  let openRouter = false;
  try { openRouter = new URL(llm.url).hostname === 'openrouter.ai'; } catch { /* invalid config stays unready */ }
  // The existing deployment stores its OpenRouter key in the intent decision
  // setting. Reuse that only for OpenRouter, never send it to a custom endpoint.
  if (!llm.apiKey && openRouter) llm.apiKey = env.ETCO_parser_decisionApiKey || '';
  return {
    enabled: briefingsEnabled(env), provider: env.PHOENIX_NEWS_PROVIDER || 'worldnews',
    apiKey: env.WORLD_NEWS_API_KEY || '', llm, openRouter,
    country: /^[a-z]{2}$/i.test(env.PHOENIX_NEWS_COUNTRY || '') ? env.PHOENIX_NEWS_COUNTRY.toLowerCase() : 'us',
    file: env.PHOENIX_NEWS_BRIEFINGS_FILE || join(env.PHOENIX_DATA_DIR
      || fileURLToPath(new URL('../../data/', import.meta.url)), 'news/briefings.json'),
    intervalMs: number(env.PHOENIX_NEWS_REFRESH_HOURS, 12, 6, 24) * 3600000,
    maxAgeMs: 36 * 3600000, storiesPerCategory: 5, candidatesPerCategory: 10,
    dailyPoints: number(env.PHOENIX_NEWS_DAILY_POINTS, 40, 0, 45),
    dailyLlmUsd: number(env.PHOENIX_NEWS_DAILY_LLM_USD, 0.15, 0, 5),
    maxLlmCalls: 220,
  };
}

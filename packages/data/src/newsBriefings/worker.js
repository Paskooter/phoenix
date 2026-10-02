import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sendJson } from '@phoenix/common';
import { NEWS_BRIEFING_VERSION, NEWS_PROMPT_VERSION, classifyNewsContent, validateNewsBriefing } from '@phoenix/contracts';
import { CATEGORIES } from '../news.js';
import { newsBriefingConfig } from './config.js';
import { createWorldNewsProvider, NEWS_EDITION } from './worldNews.js';
import { createBriefingGenerator } from './generate.js';

const HOUR = 3600000;
const day = ms => new Date(ms).toISOString().slice(0, 10);
const tomorrow = ms => Date.parse(day(ms)) + 24 * HOUR;
const emptyState = () => ({ version: 1, categories: {}, articles: {}, budget: null, blockedUntil: 0 });
const budgetError = message => Object.assign(new Error(message), { budget: true });
const CATEGORY_PRIORITY = ['general', 'national', 'international', 'technology', 'science', 'business', 'health', 'sports', 'politics', 'entertainment', 'strange'];

/** One background worker per Lasso process. Requests only read its snapshots. */
export function createNewsBriefingWorker({
  config = newsBriefingConfig(), provider = createWorldNewsProvider(config),
  generate = createBriefingGenerator(config), now = Date.now, log = console,
  categories = CATEGORIES, providerSpacingMs = 1100,
} = {}) {
  let state = emptyState();
  let loaded = false;
  let storageError = false;
  let running = null;
  let timer;
  let nextProviderAt = 0;
  const configurationId = createHash('sha256').update(JSON.stringify([
    config.apiKey, config.llm.url, config.llm.apiKey, config.llm.model, NEWS_PROMPT_VERSION,
  ])).digest('hex');
  const controller = new AbortController();
  const { signal } = controller;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (statSync(config.file).size > 8 * 1024 * 1024) throw new Error('Oversized news state');
      const saved = JSON.parse(readFileSync(config.file, 'utf8'));
      if (saved.version !== 1 || !saved.categories || !saved.articles
          || !Number.isFinite(saved.blockedUntil)
          || (saved.budget && (!/^\d{4}-\d{2}-\d{2}$/.test(saved.budget.day)
            || ['points', 'llmUsd', 'llmCalls'].some(k => !Number.isFinite(saved.budget[k]) || saved.budget[k] < 0)))) {
        throw new Error('Invalid news state');
      }
      for (const cat of Object.values(saved.categories)) {
        if (!Array.isArray(cat.items) || !Number.isFinite(cat.nextFetchAt)) throw new Error('Invalid news category');
        cat.items.forEach(validateNewsBriefing);
      }
      for (const cached of Object.values(saved.articles)) {
        if (!Number.isFinite(cached.expiresAt)) throw new Error('Invalid news cache');
        if (cached.item) validateNewsBriefing(cached.item);
      }
      state = saved;
      if (state.edition !== NEWS_EDITION) {
        // Drop worldwide snapshots, retaining the spend ledger and reusable
        // article drafts. A rollout must not reset today's paid allowance.
        state.categories = {};
      }
      if (state.configurationId !== configurationId) {
        // Correcting a key or changing models may retry immediately, while the
        // already-spent daily budget still survives the configuration change.
        state.blockedUntil = 0;
        for (const cat of Object.values(state.categories)) cat.nextFetchAt = 0;
      }
    } catch (error) {
      // Losing a spend ledger must never silently reset today's allowance.
      if (error.code !== 'ENOENT') {
        storageError = true;
        log.warn?.('News briefing storage unavailable; paid refreshes paused');
      }
    }
  }

  function persist() {
    const temporary = `${config.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      state.configurationId = configurationId;
      state.edition = NEWS_EDITION;
      mkdirSync(dirname(config.file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, config.file);
    } catch (error) {
      storageError = true;
      throw new Error('News briefing storage write failed', { cause: error });
    } finally { try { unlinkSync(temporary); } catch { /* rename already removed it */ } }
  }

  function budget() {
    if (state.budget?.day !== day(now())) state.budget = { day: day(now()), points: 0, llmUsd: 0, llmCalls: 0 };
    return state.budget;
  }

  function readyReason() {
    if (!config.enabled) return 'disabled';
    if (storageError) return 'storage-unavailable';
    if (config.provider !== provider.id) return 'unknown-provider';
    if (!config.apiKey) return 'missing-world-news-key';
    if (!config.llm.configured || (config.openRouter && !config.llm.apiKey)) return 'missing-news-model-configuration';
    return null;
  }

  const fresh = item => now() - Date.parse(item.publishedAt) < config.maxAgeMs
    && now() - Date.parse(item.generatedAt) < config.maxAgeMs
    && Date.parse(item.publishedAt) <= now() + 300000 && Date.parse(item.generatedAt) <= now() + 300000;

  function items(sourceID) {
    load();
    if (!config.enabled || storageError) return [];
    return (state.categories[sourceID]?.items || []).filter(fresh);
  }

  function status() {
    load();
    return {
      enabled: config.enabled, provider: config.provider, model: config.llm.model, edition: NEWS_EDITION,
      reason: readyReason(), refreshing: !!running, blockedUntil: state.blockedUntil || null,
      budget: state.budget?.day === day(now()) ? { ...state.budget } : { day: day(now()), points: 0, llmUsd: 0, llmCalls: 0 },
      limits: { dailyPoints: config.dailyPoints, dailyLlmUsd: config.dailyLlmUsd },
      categories: Object.fromEntries(Object.entries(categories).map(([id, name]) => [name, {
        stories: items(id).length, generatedAt: state.categories[id]?.generatedAt || null,
        nextFetchAt: state.categories[id]?.nextFetchAt || null, lastError: state.categories[id]?.lastError || null,
      }])),
    };
  }

  async function update() {
    load();
    if (readyReason() || signal.aborted || state.blockedUntil > now()) return;
    // Prune old source revisions, including skipped/unusable articles.
    state.articles = Object.fromEntries(Object.entries(state.articles)
      .filter(([, entry]) => entry.expiresAt > now()).slice(-220));
    const due = Object.entries(categories).filter(([id]) => (state.categories[id]?.nextFetchAt || 0) <= now())
      .sort(([a, nameA], [b, nameB]) => (state.categories[a]?.lastAttempt || 0) - (state.categories[b]?.lastAttempt || 0)
        || CATEGORY_PRIORITY.indexOf(nameA) - CATEGORY_PRIORITY.indexOf(nameB));
    // Take one candidate per category per round. A slow or rejected model draft
    // must not hold up every other category throughout the first refresh.
    const jobs = due.map(([id, category]) => updateCategory(id, category));
    while (jobs.length && !signal.aborted && !storageError && state.blockedUntil <= now()) {
      for (let index = 0; index < jobs.length;) {
        if (signal.aborted || storageError || state.blockedUntil > now()) break;
        const { done } = await jobs[index].next();
        if (done) jobs.splice(index, 1);
        else index++;
      }
    }
  }

  async function* updateCategory(sourceID, category) {
    const cat = state.categories[sourceID] ||= { items: [], nextFetchAt: 0 };
    let stage = 'provider';
    let failures = 0;
    try {
      if (budget().points + provider.requestPoints > config.dailyPoints) throw budgetError('Daily news request limit');
      if (nextProviderAt > now()) await delay(nextProviderAt - now(), undefined, { signal });
      signal.throwIfAborted();
      cat.lastAttempt = now();
      // Reserve before HTTP, and retain reservations on uncertain failures.
      budget().points += provider.requestPoints;
      persist();
      nextProviderAt = now() + providerSpacingMs;
      const { articles } = await provider.fetchCategory(category, { now: now(), signal });
      const edition = [];
      const seen = new Set();
      stage = 'generation';
      for (const article of articles) {
        signal.throwIfAborted();
        if (seen.has(article.id)) continue;
        seen.add(article.id);
        const flags = article.flags || classifyNewsContent(article.title + ' ' + article.fullText);
        const key = [NEWS_PROMPT_VERSION, config.llm.model, article.id, article.contentHash].join(':');
        let cached = state.articles[key];
        const excluded = flags.banned || /\bcorrection:/i.test(article.title);
        if (excluded || !cached) {
          // Once we know a source changed, stop serving its older version,
          // even if the replacement cannot be summarized successfully.
          for (const prior of Object.values(state.categories)) prior.items = prior.items.filter(item => item.id !== article.id);
        }
        if (excluded) continue;
        if (!cached || cached.expiresAt <= now() || (cached.item && !fresh(cached.item))) {
          let reservation;
          const reserve = async (amount = 0.02) => {
            signal.throwIfAborted();
            const ledger = budget();
            if (!Number.isFinite(amount) || amount <= 0 || ledger.llmUsd + amount > config.dailyLlmUsd
                || ledger.llmCalls >= config.maxLlmCalls) throw budgetError('Daily news model limit');
            reservation = { day: ledger.day, amount };
            ledger.llmUsd += amount;
            ledger.llmCalls++;
            persist();
          };
          const settle = async cost => {
            if (reservation && state.budget.day === reservation.day && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
              state.budget.llmUsd = Math.max(0, state.budget.llmUsd - reservation.amount + cost);
              persist();
            }
            reservation = null;
          };
          let draft;
          try { draft = await generate(article, category, { signal, reserve, settle }); }
          catch (error) {
            if (error.budget || signal.aborted || storageError || [401, 402, 403, 429].includes(error.status)) throw error;
            // An isolated invalid draft must not hold up the remaining categories.
            failures++;
            yield;
            continue;
          }
          const item = draft ? validateNewsBriefing({
            id: article.id, title: article.title, publisher: article.publisher, url: article.url,
            publishedAt: article.publishedAt, generatedAt: new Date(now()).toISOString(),
            adult: flags.adult || draft.adult, speech: draft.speech,
          }) : null;
          cached = { item, expiresAt: Math.min(now(), Date.parse(article.publishedAt)) + config.maxAgeMs };
          state.articles[key] = cached;
          persist();
        }
        if (cached.item) {
          // A shared story can appear in several categories; tone must stay
          // restrained when a light story is selected for a serious category.
          const item = structuredClone(cached.item);
          if (!['science', 'technology', 'entertainment', 'strange'].includes(category)) item.speech.tone = 'neutral';
          edition.push(item);
          // Publish immediately, retaining other fresh stories until this
          // edition finishes. The next robot request can use this snapshot
          // while the rest of the shared refresh is still in progress.
          const chosen = new Set(edition.map(entry => entry.id));
          cat.items = [...edition, ...cat.items.filter(entry => fresh(entry) && !chosen.has(entry.id))]
            .slice(0, config.storiesPerCategory);
          cat.generatedAt = new Date(now()).toISOString();
          persist();
        }
        if (edition.length >= config.storiesPerCategory) break;
        yield;
      }
      if (edition.length) {
        cat.items = edition;
        cat.generatedAt = new Date(now()).toISOString();
      }
      cat.lastError = failures ? 'Some drafts failed validation or generation' : (edition.length ? null : 'No usable articles');
      cat.nextFetchAt = now() + config.intervalMs;
    } catch (error) {
      if (signal.aborted || storageError) return;
      cat.lastError = error.budget ? error.message : `News ${stage} failed${error.status ? ` (HTTP ${error.status})` : ''}`;
      if (error.budget || [401, 402, 403, 429].includes(error.status)) {
        state.blockedUntil = tomorrow(now());
      }
      cat.nextFetchAt = state.blockedUntil > now() ? state.blockedUntil : now() + HOUR;
      log.warn?.('News briefing refresh deferred', { category, reason: cat.lastError });
    }
    if (!storageError) persist();
  }

  function refresh() {
    if (running) return running;
    running = update().catch(() => {
      log.warn?.('News briefing refresh unavailable; retaining cached stories');
    }).finally(() => { running = null; });
    return running;
  }

  return {
    load, items, status, refresh,
    start() {
      load();
      if (timer || !config.enabled || signal.aborted) return;
      void refresh();
      timer = setInterval(() => void refresh(), 60000);
      timer.unref();
    },
    async stop() { clearInterval(timer); timer = null; controller.abort(); await running; },
    handle({ req, res, url }) {
      const id = url.searchParams.get('sourceID');
      if (!Object.hasOwn(categories, id)) return sendJson(res, 400, { error: 'Invalid news category' });
      const snapshot = items(id);
      if (!snapshot.length) return sendJson(res, 503, { error: 'News briefings are not ready' });
      if (req.method === 'HEAD') { res.statusCode = 200; res.end(); return; }
      return sendJson(res, 200, { relayData: { version: NEWS_BRIEFING_VERSION, category: categories[id], items: snapshot }, lassoDataFromRedis: false });
    },
    handleStatus({ res }) { return sendJson(res, 200, status()); },
  };
}

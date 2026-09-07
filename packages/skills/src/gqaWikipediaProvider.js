// Source-backed Wikipedia provider for the GQA adapter.
//
// The recovered srv-gqa-ws implementation calls gqa.wiki.call(query,
// question_type).  Its output is the same structured provider object used by
// GqaParallelQuery: a successful result has source/response, while a blocked
// or failed lookup has source/message.  This factory deliberately stays
// opt-in; importing it does not add a network provider to the Phoenix skill
// registry.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIKIPEDIA_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const WIKIPEDIA_SOURCE_API = 'https://en.wikipedia.org/w/api.php';
export const WIKIPEDIA_SOURCE_USER_AGENT = 'wikipedia (https://github.com/goldsmith/Wikipedia/)';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BLACKLIST_PATH = join(MODULE_DIR, '../resources/gqa/wikipedia_blacklist_complete.json');
const BLACKLIST = JSON.parse(readFileSync(BLACKLIST_PATH, 'utf8'));

// This list follows the stopword seam used by the recovered source fixture.
// The historical service obtains it from NLTK; keeping the fixture's stable
// words local avoids adding an unpinned Python/NLTK dependency to Phoenix.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
  'i', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to',
  'was', 'what', 'when', 'where', 'which', 'who', 'with',
]);

const QUESTION_WORDS = Object.freeze([
  'what', 'where', 'when', 'who', 'waddya', 'watcha', 'whadaya', 'whadda',
  'whaddaya', 'whaddo', 'whaddya', 'whadiya', 'whadja', 'whadya', 'whatcha',
  'whatchu', 'whatchya', "what's", "what'd", "whate'er", "what'll", "what'm",
  "what're", 'whattaya', "what've", 'whatya', "when'd", "whene'er", "when'll",
  "when's", "where'd", 'wheredja', "where'er", "where'm", "where're",
  "where's", "where've", "who'd", "who'da", "who'd've", "who'll", "who'm",
  "who're", "who's", "who've", 'whoze', 'wossat', 'wossit', 'wotcha',
]);
const QUESTION_WORD_SET = new Set(QUESTION_WORDS);
const WH_PHRASES = new Set(['what', 'when', 'who', 'where', 'how', 'which', ...QUESTION_WORDS]);
const DISAMBIGUATE_1 = Object.freeze([
  "I found a few things. Here's one of them. ",
  "Looks like a few things match what you asked for. Here's my favorite. ",
  "A few things match what you asked for. I'll give you the one at the top of the list. ",
  "I found more than one thing for that. I'll go with this one. ",
  "I found a few things for that. I'll tell you about one of them. ",
  "I found a few things for that. This one in particular seemed interesting. ",
]);

const PAGE_PARAMS = Object.freeze([
  ['prop', 'info|pageprops|extracts|categories'],
  ['inprop', 'url'],
  ['ppprop', 'disambiguation'],
  ['explaintext', ''],
  ['exintro', ''],
  ['titles', ''],
  ['redirects', ''],
  ['format', 'json'],
  ['action', 'query'],
  ['cllimit', 'max'],
]);

function normalizeWikiName(value) {
  return String(value).toLowerCase().replace(/ /g, '_');
}

const BLACKLIST_CATEGORIES = new Set((BLACKLIST.blacklist_categories || []).map(normalizeWikiName));
const BLACKLIST_ARTICLES = new Set((BLACKLIST.blacklist_articles || []).map(normalizeWikiName));

function normalizeWhitespace(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

function removeInitialStopWords(value) {
  const words = normalizeWhitespace(value).split(' ').filter(Boolean);
  while (words.length > 0) {
    const word = words[0];
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower) || WH_PHRASES.has(lower)) {
      words.shift();
      continue;
    }
    break;
  }
  return words.join(' ');
}

function canAnswer(value, questionType) {
  const type = questionType === undefined || questionType === null ? '' : String(questionType);
  if (type) {
    if (QUESTION_WORD_SET.has(type)) return true;
    if (type !== 'generic') return false;
  }
  return normalizeWhitespace(value).toLowerCase().split(' ').some((word) => QUESTION_WORD_SET.has(word));
}

function comparisonSet(value) {
  return new Set(String(value).toLowerCase().replace(/[^a-z]/g, ' ').split(/\s+/).filter(Boolean));
}

function cleanParentheses(value) {
  let result = String(value);
  let previous;
  do {
    previous = result;
    result = result.replace(/\([^()]*\)/g, '');
  } while (result !== previous);
  return result;
}

function firstSentence(value) {
  const text = normalizeWhitespace(cleanParentheses(value));
  if (!text) return '';
  // This is intentionally small and deterministic for the source's first
  // sentence boundary.  Punkt remains a named historical dependency seam;
  // common prose punctuation has the same boundary used by the fixture.
  return text.split(/(?<=[.!?])\s+/u)[0];
}

function sourceMessage(query, detail) {
  const suffix = detail instanceof Error
    ? `${detail.name || 'Error'}${detail.message ? `: ${detail.message}` : ''}`
    : String(detail);
  return `Wikipedia query '${query}' raised unexpected exception\n${suffix}`;
}

function createAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const listeners = [];
  let timer;
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) abort();
    else {
      externalSignal.addEventListener('abort', abort, { once: true });
      listeners.push(() => externalSignal.removeEventListener('abort', abort));
    }
  }
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Wikipedia timeoutMs must be a non-negative number');
    timer = setTimeout(() => controller.abort(new Error('Wikipedia request timed out')), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of listeners) remove();
    },
  };
}

function buildUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url;
}

function pageParams(query) {
  return PAGE_PARAMS.map(([key, value]) => [key, key === 'titles' ? query : value]);
}

function revisionParams(query) {
  return [
    ['prop', 'revisions'],
    ['rvprop', 'content'],
    ['rvparse', ''],
    ['rvlimit', '1'],
    ['titles', query],
    ['format', 'json'],
    ['action', 'query'],
  ];
}

async function readJson(response) {
  if (!response || typeof response.text !== 'function') throw new TypeError('Wikipedia transport returned no text() response');
  const raw = await response.text();
  try {
    return { raw, body: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`invalid JSON response: ${error.message}`);
  }
}

async function requestJson({ endpoint, params, fetchImpl, headers, signal }) {
  const url = buildUrl(endpoint, params);
  const response = await fetchImpl(url, { method: 'GET', headers, signal });
  const result = await readJson(response);
  if (response && response.ok === false) {
    const info = result.body?.error?.info || `HTTP ${response.status}`;
    throw new Error(`Wikipedia API request failed: ${info}`);
  }
  if (result.body && result.body.error) {
    throw new Error(`Wikipedia API error: ${result.body.error.info || 'unknown error'}`);
  }
  return { ...result, url: String(url), status: response?.status };
}

function pageFromBody(body, query) {
  const pages = body?.query?.pages;
  if (!pages || typeof pages !== 'object' || Array.isArray(pages)) {
    throw new Error('Wikipedia response has no query.pages object');
  }
  const keys = Object.keys(pages);
  if (keys.length === 0) throw new Error('Wikipedia response has no page');
  const page = pages[keys[0]];
  if (!page || typeof page !== 'object') throw new Error('Wikipedia response page is not an object');
  return {
    ...page,
    requestedTitle: query,
  };
}

function stripHtml(value) {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function optionsFromRevisionHtml(html) {
  const options = [];
  const pattern = /<li\b[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/li>/gi;
  let match;
  while ((match = pattern.exec(String(html))) !== null) {
    const title = normalizeWhitespace(stripHtml(match[1]));
    if (title) options.push(title);
  }
  return options;
}

function pageCategories(page) {
  if (!Array.isArray(page.categories)) return [];
  return page.categories.map((category) => {
    const title = typeof category === 'string' ? category : category?.title;
    return String(title || '').replace(/^Category:/, '');
  }).filter(Boolean);
}

async function loadPage({ endpoint, query, fetchImpl, headers, signal }) {
  const response = await requestJson({ endpoint, params: pageParams(query), fetchImpl, headers, signal });
  const page = pageFromBody(response.body, query);
  if (page.missing !== undefined) return { page, response };
  if (page.pageprops?.disambiguation !== undefined || page.disambiguation === true) {
    let options = page.disambiguationOptions || page.options || page.links;
    if (!Array.isArray(options)) {
      const revision = await requestJson({ endpoint, params: revisionParams(query), fetchImpl, headers, signal });
      const revisionPages = revision.body?.query?.pages;
      const revisionPage = revisionPages && revisionPages[Object.keys(revisionPages)[0]];
      const html = revisionPage?.revisions?.[0]?.['*'] || revisionPage?.revisions?.[0]?.content || '';
      options = optionsFromRevisionHtml(html);
    }
    return { page: { ...page, disambiguationOptions: options || [] }, response };
  }
  return { page, response };
}

function choose(random, values) {
  if (values.length === 0) return undefined;
  const value = Number(random());
  const index = Number.isFinite(value) ? Math.min(values.length - 1, Math.max(0, Math.floor(value * values.length))) : 0;
  return values[index];
}

async function searchArticle({ query, endpoint, fetchImpl, headers, signal, random, depth = 0 }) {
  if (!query) return { answer: '', errors: ['Empty query'] };
  if (BLACKLIST_ARTICLES.has(normalizeWikiName(query))) {
    return { answer: '', errors: [`Blocked query on '${query}' due to article blacklist`] };
  }
  if (depth > 20) return { answer: '', errors: [`Wikipedia query '${query}' exceeded disambiguation depth`] };

  let loaded;
  try {
    loaded = await loadPage({ endpoint, query, fetchImpl, headers, signal });
  } catch (error) {
    return { answer: '', errors: [sourceMessage(query, error)] };
  }

  const page = loaded.page;
  if (page.missing !== undefined) return { answer: '', errors: [`No match for query '${query}'`] };

  if (Array.isArray(page.disambiguationOptions)) {
    const errors = [];
    for (const option of page.disambiguationOptions) {
      const optionText = String(option);
      if (optionText.toLowerCase().includes('disambig')) {
        errors.push(`Skipping disambiguation page ${optionText}`);
        continue;
      }
      const result = await searchArticle({
        query: optionText, endpoint, fetchImpl, headers, signal, random, depth: depth + 1,
      });
      if (result.answer) {
        return { answer: `${choose(random, DISAMBIGUATE_1)} ${result.answer}`, errors: [] };
      }
      errors.push(...result.errors);
    }
    return { answer: '', errors };
  }

  const categories = pageCategories(page);
  for (const category of categories) {
    if (BLACKLIST_CATEGORIES.has(normalizeWikiName(category))) {
      return { answer: '', errors: [`Blocked query on '${query}' due to blacklisted category '${category}'`] };
    }
  }
  const title = String(page.title || query);
  if (['List of', 'Lists of'].some((prefix) => title.startsWith(prefix))) {
    return { answer: '', errors: [`Blocked query on '${query}' due to title contains word indicating it's list`] };
  }

  const summary = page.extract ?? page.summary ?? '';
  if (!summary) return { answer: '', errors: [`Unexpected empty summary for query '${query}'`] };
  const articleWords = comparisonSet(summary);
  const queryWords = comparisonSet(query);
  if ([...queryWords].every((word) => !articleWords.has(word))) {
    return { answer: '', errors: [`Query on '${query}' apparently got article on related but different topic`] };
  }

  const result = firstSentence(summary);
  if (!result) return { answer: '', errors: [`Wikipedia query '${query}' produced empty reply after cleanup!`] };
  if (result.includes('|') || result.includes('{') || result.includes('}')) {
    return { answer: '', errors: ['Blocked due to apparently broken template'] };
  }
  const firstWord = result.split(/\s+/)[0];
  if ((firstWord === 'This' || firstWord === 'These')
    && !['This', 'this', 'These', 'these'].some((word) => title.includes(word))) {
    return { answer: '', errors: ['Blocked due to answer not suited for speak out'] };
  }
  return { answer: result, errors: [] };
}

function combineSignals(parentSignal, factorySignal, timeoutMs) {
  if (!parentSignal && !factorySignal) return createAbortSignal(undefined, timeoutMs);
  if (parentSignal && !factorySignal) return createAbortSignal(parentSignal, timeoutMs);
  if (!parentSignal && factorySignal) return createAbortSignal(factorySignal, timeoutMs);
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason || factorySignal.reason);
  if (parentSignal.aborted || factorySignal.aborted) abort();
  else {
    parentSignal.addEventListener('abort', abort, { once: true });
    factorySignal.addEventListener('abort', abort, { once: true });
  }
  const combined = createAbortSignal(controller.signal, timeoutMs);
  const cleanup = combined.cleanup;
  combined.cleanup = () => {
    parentSignal.removeEventListener('abort', abort);
    factorySignal.removeEventListener('abort', abort);
    cleanup();
  };
  return combined;
}

/**
 * Create an opt-in Wikipedia adapter for createGqaProviderPipeline.
 *
 * `fetchImpl` is the only transport seam. It has the native fetch signature
 * and receives the MediaWiki GET URL, source User-Agent/headers, and an
 * AbortSignal. `endpoint`, `timeoutMs`, `headers`, `signal`, `clock`, and
 * `random` are configurable for local fixture controls. The adapter never
 * persists attribution: the source Wikipedia path intentionally did not add
 * a URL to its output.
 */
export function createWikipediaProvider({
  endpoint = WIKIPEDIA_SOURCE_API,
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs,
  signal,
  clock = Date.now,
  random = Math.random,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Wikipedia fetchImpl must be a function');
  if (typeof clock !== 'function') throw new TypeError('Wikipedia clock must be a function');
  if (typeof random !== 'function') throw new TypeError('Wikipedia random must be a function');
  const requestHeaders = {
    'user-agent': WIKIPEDIA_SOURCE_USER_AGENT,
    ...headers,
  };
  return async function wikipediaProvider(context = {}) {
    const query = String(context.queryText ?? '');
    const questionType = context.questionType ?? '';
    const output = { source: 'Wikipedia', timestamps: {}, logs: {} };
    output.timestamps.wiki_begin_tokenization = Math.trunc(clock());
    const strictQuery = removeInitialStopWords(query);
    output.logs.strict_query = strictQuery;
    if (!canAnswer(query, questionType)) {
      output.message = 'Blocked by WIKIPEDIA_QUESTION_WORDS restriction.';
      return output;
    }

    output.timestamps.wiki_request = Math.trunc(clock());
    const factorySignal = typeof signal === 'function' ? signal(context) : signal;
    const requestState = combineSignals(context.signal, factorySignal, timeoutMs);
    try {
      const result = await searchArticle({
        query: strictQuery,
        endpoint: typeof endpoint === 'function' ? endpoint(context) : endpoint,
        fetchImpl,
        headers: requestHeaders,
        signal: requestState.signal,
        random,
      });
      output.timestamps.wiki_response = Math.trunc(clock());
      if (result.answer) output.response = { type: 'string', payload: result.answer };
      if (result.errors.length > 0) output.message = result.errors.join('\n');
      return output;
    } finally {
      requestState.cleanup();
    }
  };
}

export const wikipediaProviderContract = Object.freeze({
  source: 'Wikipedia',
  response: { type: 'string', payload: 'first source sentence' },
  errors: 'message string on blocked, no-result, malformed, HTTP, or cancelled lookup',
  attribution: 'omitted; source gqa.wiki.call does not persist a Wikipedia URL',
  request: PAGE_PARAMS,
});

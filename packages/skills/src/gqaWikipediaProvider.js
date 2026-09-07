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
const STOP_WORDS_PATH = join(MODULE_DIR, '../resources/gqa/wikipedia_stopwords_english.txt');
const PUNKT_PARAMS_PATH = join(MODULE_DIR, '../resources/gqa/wikipedia_punkt_english.json');
const BLACKLIST = JSON.parse(readFileSync(BLACKLIST_PATH, 'utf8'));

// The recovered service loads stopwords.words('english') from NLTK for every
// call.  Keep the source corpus as data rather than reducing it to a fixture
// list: in particular, words such as "about", "been", and "their" affect the
// strict Wikipedia title sent to the API.
const STOP_WORDS = new Set(
  readFileSync(STOP_WORDS_PATH, 'utf8')
    .split(/\r?\n/u)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean),
);

// NLTK's Punkt model is data, not a collection of article-specific rules.
// The small JavaScript interpreter below uses the same trained abbreviation,
// collocation, sentence-starter, and orthographic-context tables.  This keeps
// first-sentence extraction independent of a Python child process while
// retaining the source model's general behavior.
const PUNKT_PARAMS = JSON.parse(readFileSync(PUNKT_PARAMS_PATH, 'utf8'));
const PUNKT_ABBREVIATIONS = new Set(PUNKT_PARAMS.abbrev_types);
const PUNKT_SENT_STARTERS = new Set(PUNKT_PARAMS.sent_starters);
const PUNKT_COLLOCATIONS = new Set(
  PUNKT_PARAMS.collocations.map(([first, second]) => `${first}\u0000${second}`),
);
const PUNKT_ORTHO_CONTEXT = PUNKT_PARAMS.ortho_context;

const ORTHO_MID_UC = 1 << 2;
const ORTHO_BEG_LC = 1 << 4;
const ORTHO_MID_LC = 1 << 5;
const ORTHO_UC = (1 << 1) | ORTHO_MID_UC | (1 << 3);
const ORTHO_LC = ORTHO_BEG_LC | ORTHO_MID_LC | (1 << 6);
const PUNKT_PUNCTUATION = new Set([';', ':', ',', '.', '!', '?']);

// Keep the exact Unicode whitespace set used by Python's Unicode-aware
// ``re``.  JavaScript's \s differs in two material ways for this adapter:
// it includes U+FEFF, while Python does not, and it omits the C0 information
// separators plus NEXT LINE.  U+FEFF must therefore remain part of a token.
const PYTHON_WHITESPACE_CLASS = '\\t-\\r \\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYTHON_WHITESPACE_PATTERN = `[${PYTHON_WHITESPACE_CLASS}]`;
const PYTHON_WHITESPACE = new RegExp(PYTHON_WHITESPACE_PATTERN, 'u');
const PYTHON_WHITESPACE_RUN = new RegExp(`${PYTHON_WHITESPACE_PATTERN}+`, 'gu');

function isPunktWhitespace(character) {
  return PYTHON_WHITESPACE.test(character);
}

function isPythonInitialCharacter(character) {
  // Punkt 3.2.5 uses ``[^\\W\\d]`` for an initial.  This includes letters,
  // non-decimal Unicode numbers, and underscore, while excluding every
  // Unicode decimal digit.  Python's ``\\w`` does not include arbitrary
  // connector punctuation or combining marks, so those are intentionally
  // excluded here.
  return /^[\p{Letter}\p{Number}_]$/u.test(character)
    && !/^\p{Decimal_Number}$/u.test(character);
}

const PYTHON_NUMBER_RE = /^-?[.,]?\p{Decimal_Number}[\p{Decimal_Number},.-]*\.?$/u;

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
  ['cllimit', 'max'],
  ['explaintext', ''],
  ['exintro', ''],
  ['list', 'allcategories'],
  ['inprop', 'url'],
  ['ppprop', 'disambiguation'],
  ['redirects', ''],
  ['titles', ''],
  ['format', 'json'],
  ['action', 'query'],
]);

function normalizeWikiName(value) {
  return String(value).toLowerCase().replace(/ /g, '_');
}

const BLACKLIST_CATEGORIES = new Set((BLACKLIST.blacklist_categories || []).map(normalizeWikiName));
const BLACKLIST_ARTICLES = new Set((BLACKLIST.blacklist_articles || []).map(normalizeWikiName));

function normalizeWhitespace(value) {
  let normalized = '';
  let pendingSpace = false;
  for (const character of String(value)) {
    if (isPunktWhitespace(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && normalized) normalized += ' ';
    normalized += character;
    pendingSpace = false;
  }
  return normalized;
}

export function removeInitialStopWords(value) {
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

const PUNKT_NON_WORD = String.raw`[?!)";}\]\*:@'\(\[]`;
const PUNKT_WORD_START = '[^("`{\\[:;&*@)}\\]\\-,]';
const PUNKT_NON_WHITESPACE = `[^${PYTHON_WHITESPACE_CLASS}]`;
const PUNKT_MULTI_CHAR = `(?:-{2,}|\\.{2,}|(?:\\.${PYTHON_WHITESPACE_PATTERN}){2,}\\.)`;

// This is PunktLanguageVars._word_tokenize_fmt from the pinned NLTK 3.2.5
// source, with Python's \s/\S expanded to the explicit classes above.  The
// lazy word branch is significant: in ``Hello!world`` it produces ``Hello``
// and ``!world``; splitting each punctuation mark independently changes the
// period-context decision.
const PUNKT_WORD_TOKENIZER = new RegExp(
  `(?:${PUNKT_MULTI_CHAR}|(?=${PUNKT_WORD_START})${PUNKT_NON_WHITESPACE}+?(?=${PYTHON_WHITESPACE_RUN.source}|$|${PUNKT_NON_WORD}|${PUNKT_MULTI_CHAR}|,(?=$|${PYTHON_WHITESPACE_RUN.source}|${PUNKT_NON_WORD}|${PUNKT_MULTI_CHAR}))|${PUNKT_NON_WHITESPACE})`,
  'gu',
);

const PUNKT_PERIOD_CONTEXT = new RegExp(
  `${PUNKT_NON_WHITESPACE}*[.!?](?=(?<after>${PUNKT_NON_WORD}|${PYTHON_WHITESPACE_RUN.source}(?<next>${PUNKT_NON_WHITESPACE}+)))`,
  'gu',
);

const PUNKT_REALIGN_BOUNDARIES = new RegExp(
  `^["')\\]}]+?(?:${PYTHON_WHITESPACE_RUN.source}|(?=--)|$)`,
  'u',
);

function punktTokens(text) {
  const tokens = [];
  PUNKT_WORD_TOKENIZER.lastIndex = 0;
  for (const match of text.matchAll(PUNKT_WORD_TOKENIZER)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function punktType(token) {
  const text = token.text;
  if (PYTHON_NUMBER_RE.test(text)) return '##number##';
  return text.toLowerCase();
}

function punktTypeNoPeriod(token) {
  const type = punktType(token);
  return type.length > 1 && type.endsWith('.') ? type.slice(0, -1) : type;
}

function punktTypeNoSentencePeriod(token) {
  return token.sentbreak ? punktTypeNoPeriod(token) : punktType(token);
}

function punktIsInitial(token) {
  const characters = [...token.text];
  return characters.length === 2
    && characters[1] === '.'
    && isPythonInitialCharacter(characters[0]);
}

function punktIsNumber(token) {
  return PYTHON_NUMBER_RE.test(token.text);
}

function punktFirstCase(token) {
  const first = [...token.text][0] || '';
  if (/^\p{Ll}$/u.test(first)) return 'lower';
  if (/^\p{Lu}$/u.test(first)) return 'upper';
  return 'none';
}

function punktOrthographicHeuristic(token) {
  // This mirrors PunktSentenceTokenizer._ortho_heuristic.  Punctuation never
  // starts a sentence, even if a model entry happens to exist for its type.
  if (PUNKT_PUNCTUATION.has(token.text)) return false;
  const context = Number(PUNKT_ORTHO_CONTEXT[punktTypeNoSentencePeriod(token)] || 0);
  const firstCase = punktFirstCase(token);
  if (firstCase === 'upper' && (context & ORTHO_LC) && !(context & ORTHO_MID_UC)) return true;
  if (firstCase === 'lower' && ((context & ORTHO_UC) || !(context & ORTHO_BEG_LC))) return false;
  return 'unknown';
}

function punktFirstPass(tokens) {
  for (const token of tokens) {
    token.periodFinal = token.text.endsWith('.');
    token.ellipsis = /\.\.+$/u.test(token.text);
    token.abbr = false;
    token.sentbreak = false;
    if (token.text === '?' || token.text === '!') {
      token.sentbreak = true;
    } else if (token.ellipsis) {
      // Ellipses are reclassified by the second pass when the next token is
      // a likely sentence starter.
    } else if (token.periodFinal) {
      const type = punktTypeNoPeriod(token);
      const finalHyphenPart = type.split('-').slice(-1)[0];
      if (PUNKT_ABBREVIATIONS.has(type) || PUNKT_ABBREVIATIONS.has(finalHyphenPart)) {
        token.abbr = true;
      } else {
        token.sentbreak = true;
      }
    }
  }
}

function punktSecondPass(tokens) {
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (!current.periodFinal) continue;
    const type = punktTypeNoPeriod(current);
    const nextType = punktTypeNoSentencePeriod(next);
    if (PUNKT_COLLOCATIONS.has(`${type}\u0000${nextType}`)) {
      current.sentbreak = false;
      current.abbr = true;
      continue;
    }

    const initial = punktIsInitial(current);
    if ((current.abbr || current.ellipsis) && !initial) {
      const sentenceStarter = punktOrthographicHeuristic(next);
      if (sentenceStarter === true) {
        current.sentbreak = true;
        continue;
      }
      if (/^\p{Lu}/u.test(next.text) && PUNKT_SENT_STARTERS.has(nextType)) {
        current.sentbreak = true;
        continue;
      }
    }

    if (initial || punktIsNumber(current)) {
      const sentenceStarter = punktOrthographicHeuristic(next);
      if (sentenceStarter === false) {
        current.sentbreak = false;
        current.abbr = true;
        continue;
      }
      if (sentenceStarter === 'unknown' && initial && /^\p{Lu}/u.test(next.text)) {
        const nextContext = Number(PUNKT_ORTHO_CONTEXT[nextType] || 0);
        if (!(nextContext & ORTHO_LC)) {
          current.sentbreak = false;
          current.abbr = true;
        }
      }
    }
  }
}

function trimPunktWhitespaceEnd(value) {
  let end = value.length;
  while (end > 0 && isPunktWhitespace(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function textContainsSentbreak(text) {
  let found = false;
  const tokens = punktTokens(text);
  punktFirstPass(tokens);
  punktSecondPass(tokens);
  for (const token of tokens) {
    // Punkt deliberately waits for a token after a marked break.  This is
    // what makes a context such as ``Hello!!world. Next`` choose the final
    // period-context boundary rather than splitting at the first ``!``.
    if (found) return true;
    if (token.sentbreak) found = true;
  }
  return false;
}

function sentenceBoundaryEnd(text) {
  PUNKT_PERIOD_CONTEXT.lastIndex = 0;
  for (const match of text.matchAll(PUNKT_PERIOD_CONTEXT)) {
    const after = match.groups.after;
    const context = match[0] + after;
    if (!textContainsSentbreak(context)) continue;

    const boundaryEnd = match.index + match[0].length;
    let nextStart = boundaryEnd;
    if (match.groups.next) {
      nextStart = boundaryEnd + after.length - match.groups.next.length;
    }

    // This is PunktSentenceTokenizer._realign_boundaries for the first
    // sentence.  Closing quotes/brackets belong to the sentence only when
    // followed by whitespace, ``--``, or end-of-text.
    const remainder = text.slice(nextStart);
    const realignment = PUNKT_REALIGN_BOUNDARIES.exec(remainder);
    if (realignment) {
      return nextStart + trimPunktWhitespaceEnd(realignment[0]).length;
    }
    return boundaryEnd;
  }
  return text.length;
}

export function firstSentence(value) {
  const text = normalizeWhitespace(cleanParentheses(value));
  if (!text) return '';
  return text.slice(0, sentenceBoundaryEnd(text));
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
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (entity, value) => {
      if (value.toLowerCase() === 'amp') return '&';
      if (value.toLowerCase() === 'lt') return '<';
      if (value.toLowerCase() === 'gt') return '>';
      if (value.toLowerCase() === 'quot') return '"';
      if (value.toLowerCase() === 'apos') return "'";
      if (value.toLowerCase() === 'nbsp') return '\u00a0';
      const codePoint = value[0].toLowerCase() === '#'
        ? (value[1].toLowerCase() === 'x'
          ? Number.parseInt(value.slice(2), 16)
          : Number.parseInt(value.slice(1), 10))
        : Number.NaN;
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
}

function optionsFromRevisionHtml(html) {
  const options = [];
  // The pinned Python dependency uses BeautifulSoup.find_all('li'), skips
  // every li whose class string contains "tocsection", then reads the first
  // descendant anchor's text. Keep the same ordering and filtering for the
  // revision HTML path without adding an HTML dependency to the skill bundle.
  const pattern = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = pattern.exec(String(html))) !== null) {
    const classMatch = match[1].match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
    const classes = classMatch ? (classMatch[1] ?? classMatch[2] ?? classMatch[3] ?? '') : '';
    if (classes.replace(/\s+/gu, '').toLowerCase().includes('tocsection')) continue;
    const anchor = match[2].match(/<a\b[^>]*>([\s\S]*?)<\/a>/iu);
    if (!anchor) continue;
    const title = normalizeWhitespace(stripHtml(anchor[1]));
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

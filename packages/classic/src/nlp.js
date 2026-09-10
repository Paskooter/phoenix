// `nlp` service (NLP_20161031) — Jibo's cloud NLP (part-of-speech + named-entity) wire surface.
//
// The pinned source (read through the Jibo archive MCP, cited by file):
//   apis/nlp-2016-10-31.normal.json                    2 operations; targetPrefix NLP_20161031
//   jiborobot/srv-nlp-ws nlp.py                        Flask POST /POS and /NER (the real service)
//   jiborobot/srv-nlp-ws jibospacy.py                  clean_input + the spaCy `en` model load
//   jiborobot/srv-nlp-ws requirements.txt              spacy==1.2.0, Flask==0.11.1 (Python 2)
//
// DEAD THIRD PARTY (explicit, never faked):
//   The tag/entity CONTENT comes from `spacy.load('en')` inside a Python-2 Flask app running
//   spaCy 1.2.0 (jibospacy.py:12, requirements.txt). That runtime and the hosted service are
//   gone, and this environment has no spaCy at all, so Phoenix cannot compute real POS/NER tags.
//   Fabricating tags from a modern tagger would be plausible-looking fake data for the dead
//   provider, so Phoenix does NOT: the provider is an explicit injectable seam whose DEFAULT
//   answers "unavailable" (empty arrays + a warn) and can be pointed at a recovered service with
//   ETCO_nlp_upstream. What Phoenix DOES reproduce exactly is the source `clean_input` transform
//   and the full response contract ({word,pos} / {start,end,text,label} members).
//
//   This cloud spaCy service is NOT the on-robot NLU grammar engine (N-08); N-08 findings are
//   not applied here.

import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';

// jibospacy.py:14 and clean_input (jibospacy.py:51-62). Order matters — the source re-slices
// from the last WH-word in this list that is present.
export const WH_WORDS = ['what', 'when', 'who', 'where', 'how', 'which'];

/** jibospacy.py:51-62 clean_input — drop '?', keep from the last present WH word, trim. */
export function cleanInput(text) {
  let out = String(text == null ? '' : text).replace(/\?/g, '');
  for (const wh of WH_WORDS) {
    if (out.toLowerCase().includes(wh)) out = out.slice(out.toLowerCase().lastIndexOf(wh));
  }
  return out.trim();
}

/**
 * Default provider for the dead spaCy service: it reports that it cannot answer. `null` means
 * "no provider available" — the handler then serves the documented empty shape, never a guess.
 */
export function unavailableNlpProvider() {
  return {
    available: false,
    async pos() { return null; },
    async ner() { return null; },
  };
}

/**
 * Provider that talks to the ORIGINAL Flask surface (nlp.py `/POS` and `/NER`), so a recovered
 * spaCy 1.2.0 deployment can be wired in without touching the wire contract. The body is the
 * pinned request shape, `{"Input": <cleaned text>}`.
 */
export function createHttpNlpProvider(baseUrl, { timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const base = String(baseUrl).replace(/\/$/, '');
  const post = async (path, Input) => {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const doc = await res.json().catch(() => null);
    return doc && typeof doc === 'object' ? doc : null;
  };
  return {
    available: true,
    async pos(text) { const doc = await post('/POS', text); return doc && Array.isArray(doc.partsOfSpeech) ? doc.partsOfSpeech : null; },
    async ner(text) { const doc = await post('/NER', text); return doc && Array.isArray(doc.namedEntities) ? doc.namedEntities : null; },
  };
}

/** Provider from the environment: ETCO_nlp_upstream (a recovered spaCy service), else unavailable. */
export function nlpProviderFromEnv(env = process.env) {
  const upstream = env.ETCO_nlp_upstream;
  return upstream ? createHttpNlpProvider(upstream) : unavailableNlpProvider();
}

// PartOfSpeech / NamedEntity are declared shapes in the pinned API model; the SDK strips anything
// undeclared, so each emitted row is reduced to exactly those members.
function posView(row) {
  if (row == null || typeof row !== 'object') return null;
  return { word: row.word === undefined ? null : String(row.word), pos: row.pos === undefined ? null : String(row.pos) };
}

function nerView(row) {
  if (row == null || typeof row !== 'object') return null;
  const out = {};
  if (row.start !== undefined) out.start = row.start;
  if (row.end !== undefined) out.end = row.end;
  if (row.text !== undefined) out.text = String(row.text);
  if (row.label !== undefined) out.label = String(row.label);
  return out;
}

/**
 * @param {object} [options]
 * @param {{available?:boolean, pos:Function, ner:Function}} [options.provider]
 * @param {{warn?:Function, info?:Function}} [options.logger]
 */
export function makeNlpHandler({ provider = nlpProviderFromEnv(), logger } = {}) {
  const log = logger || { warn: () => {}, info: () => {} };

  async function partOfSpeech({ res, body, log: requestLog }) {
    const source = (body && typeof body === 'object' && !Array.isArray(body)) ? body : null;
    if (source === null) return void sendAmz(res, 200, []); // source returned [] for a non-JSON body
    if (source.Input === undefined || source.Input === null) {
      // The source raised KeyError here (Flask 500). Phoenix answers a declared client error.
      return void sendAmzError(res, ValidationException, 'child "Input" fails because ["Input" is required]');
    }
    const cleaned = cleanInput(source.Input);
    const tags = await provider.pos(cleaned);
    if (tags === null) {
      (requestLog || log).warn?.('nlp: POS provider unavailable (spaCy 1.2.0 service is dead)', { cleaned });
      return void sendAmz(res, 200, { partsOfSpeech: [] });
    }
    return void sendAmz(res, 200, { partsOfSpeech: tags.map(posView).filter(Boolean) });
  }

  async function namedEntityRecognition({ res, body, log: requestLog }) {
    const source = (body && typeof body === 'object' && !Array.isArray(body)) ? body : null;
    if (source === null) return void sendAmz(res, 200, []);
    if (source.Input === undefined || source.Input === null) {
      return void sendAmzError(res, ValidationException, 'child "Input" fails because ["Input" is required]');
    }
    const cleaned = cleanInput(source.Input);
    const entities = await provider.ner(cleaned);
    if (entities === null) {
      (requestLog || log).warn?.('nlp: NER provider unavailable (spaCy 1.2.0 service is dead)', { cleaned });
      return void sendAmz(res, 200, { namedEntities: [] });
    }
    return void sendAmz(res, 200, { namedEntities: entities.map(nerView).filter(Boolean) });
  }

  const mapping = { partofspeech: partOfSpeech, namedentityrecognition: namedEntityRecognition };

  return async function nlpHandler({ req, res, body, op, log: requestLog }) {
    const method = mapping[op.toLowerCase()];
    if (!method) return void sendAmzError(res, ValidationException, `unknown nlp operation: ${op}`);
    await method({ res, body: body || {}, req, log: requestLog });
  };
}

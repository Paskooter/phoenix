// Read Jibo's REAL intent surface out of the robust-parser FST rule sources.
//
// WHY THIS FILE EXISTS
// Phoenix's LLM NLU shipped a hand-written 15-tool catalog, and an earlier
// attempt replaced it with one generated from the Dialogflow agent. Both were
// wrong about where Jibo's intents actually lived:
//
//   * The hand-written 15 used invented names. Only 5 of them (whatsUp, thanks,
//     cancel, yes, no) are real Jibo intents. `whatTimeIsIt` was really
//     `askForTime`, `whoAmI` was `launchWhoAmI`, and `tellAJoke` was three
//     separate intents (jokeKnockKnock / jokeChickenCrossRoad / jokeDentistTime).
//   * The Dialogflow agent is only the ML backstop for the *chitchat* space:
//     99 intents, 74 of which chitchat already covered by rule. It carries no
//     timer, alarm, clock, radio, lights, gallery, camera or settings intent,
//     because those never went through Dialogflow at all.
//
// The real surface is the FST rule sources: ~611 intents across 21 domains,
// scoped the way the runtime scoped them (always-on globals, per-skill rule
// sets, and the open-domain chitchat set).
//
// Grammar shape, enough of it to render an example phrase:
//   literal words            tell me the time
//   ?x / ?(x y)              optional
//   a | b                    alternation
//   $NONTERM / $factory:x    reference to another production
//   $w03 / $*                wildcards
//   [word?s]                 morphological expansion
//   {...} / {%...%}          semantic actions, where intent= lives
//   ~0.1 / <1.0>             fuzz and weights

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INTENT_RE = /_?intent\s*=\s*'([^']+)'/g;
const DOMAIN_RE = /_?domain\s*=\s*'([^']+)'/g;
/** Any other assignment in a semantic action is a slot the rule fills. */
const SLOT_RE = /\{%?\s*_?([A-Za-z]\w*)\s*=/g;
/** Assignments that are routing metadata, not slots. */
const NOT_SLOT = new Set(['intent', 'domain', 'priority', 'nl', 'this']);
/** Wildcards and machine-generated helpers that never read as speech. */
const NOT_SPEECH = /^(w\d+|\*|\+)$/i;

/** Every `*.rule` under `root`, as { domain, file, path }. */
function ruleFiles(root) {
  const out = [];
  for (const domain of readdirSync(root)) {
    const dir = join(root, domain);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.rule')) out.push({ domain, file, path: join(dir, file) });
    }
  }
  return out;
}

/**
 * Split a rule file into productions. A production ends at a top-level `;`:
 * one outside every bracket and semantic action. Comments are stripped first
 * so a `;` in prose cannot end a production early.
 */
function productions(text) {
  const stripped = text.replace(/^\s*#.*$/gm, '');
  const out = [];
  let depth = 0;
  let action = 0;
  let start = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '{') action += 1;
    else if (c === '}') action = Math.max(0, action - 1);
    else if (c === '(' || c === '[' || c === '<') depth += 1;
    else if (c === ')' || c === ']' || c === '>') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0 && action === 0) {
      out.push(stripped.slice(start, i));
      start = i + 1;
    }
  }
  if (start < stripped.length) out.push(stripped.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

function splitProduction(production) {
  const eq = production.indexOf('=');
  if (eq < 0) return { name: null, body: production };
  const name = production.slice(0, eq).replace(/^!/, '').trim();
  if (!/^[\w.:-]+$/.test(name)) return { name: null, body: production };
  return { name, body: production.slice(eq + 1) };
}

function matchAll(text, re) {
  const out = new Set();
  re.lastIndex = 0;
  let m = re.exec(text);
  while (m) { out.add(m[1].trim()); m = re.exec(text); }
  return [...out];
}

/** The literal, speakable words in a grammar fragment. */
function words(text) {
  return String(text)
    .replace(/\\'/g, "'")
    .replace(/[^\w'\s.-]/g, ' ')
    .split(/\s+/)
    .filter((w) => /^[a-z][a-z'.-]*$/i.test(w) && !NOT_SPEECH.test(w));
}

/**
 * Render a `[...]` word-form bracket as a single word. The bracket is one word
 * with optional letter groups and in-word alternation, so `[present?s]` is
 * present/presents and `[mak(e|(ing))]` is make/making. The fullest form is
 * kept, which reads more naturally than the stem alone.
 */
function bracketWord(inner) {
  let s = inner;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = s.replace(/\(([^()]*)\)/g, (_, group) => group
      .split('|')
      .reduce((best, branch) => (branch.length > best.length ? branch : best), ''));
    if (next === s) break;
    s = next;
  }
  return s.replace(/[?\\\s]/g, '');
}

/** The branch of an alternation with the most literal words; it reads best. */
function richest(text) {
  return text
    .split('|')
    .map((branch) => branch.trim())
    .reduce((best, branch) => (words(branch).length > words(best).length ? branch : best), '');
}

/**
 * Render one readable example phrase from a grammar fragment.
 *
 * `resolve(name)` supplies the body of a referenced production so that a branch
 * whose words live behind `$SOME_RULE` still yields a phrase; without it,
 * intents defined purely by reference (askForTime, get_track, goodBye) render
 * as nothing at all.
 */
export function renderExample(fragment, resolve = () => null, depth = 2) {
  // Tolerate a whole production: `NAME =` is grammar, never speech. Callers
  // inside this module pass a body that has already had it removed, but the
  // export is also used directly.
  let s = fragment.replace(/^\s*!?[\w.:-]+\s*=(?!=)/, ' ');
  s = s.replace(/\{%[\s\S]*?%\}/g, ' ').replace(/\{[^{}]*\}/g, ' '); // semantic actions
  s = s.replace(/<[^<>]*>/g, ' ').replace(/~[\d.]+/g, ' ');          // weights and fuzz
  s = s.replace(/\[([^\][]*)\]/g, (_, inner) => ` ${bracketWord(inner)} `); // word forms
  s = s.replace(/\?\([^()]*\)/g, ' ');                                // optional groups
  s = s.replace(/\?\$?[\w:.-]+/g, ' ');                               // optional single terms

  // Inline references before discarding them, so the words behind a rule name
  // are still available to this branch.
  s = s.replace(/\$([\w:.-]+)/g, (whole, name) => {
    if (depth <= 0) return ' ';
    const body = resolve(name);
    if (!body) return ' ';
    const inner = renderExample(body, resolve, depth - 1);
    return inner ? ` ${inner} ` : ' ';
  });

  for (let pass = 0; pass < 12; pass += 1) {
    const next = s.replace(/\(([^()]*)\)/g, (_, inner) => ` ${richest(inner)} `);
    if (next === s) break;
    s = next;
  }
  s = richest(s);

  const picked = words(s);
  if (!picked.length) return null;
  return picked.slice(0, 10).join(' ').toLowerCase();
}

/**
 * The spans enclosing `index`, innermost first: each balanced bracket group
 * containing it, then the whole fragment. An example phrase is scoped this way
 * because one production commonly assigns a different intent on each branch.
 */
function enclosingSpans(text, index) {
  const opens = [];
  const spans = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '(') opens.push(i);
    else if (c === ')') {
      const open = opens.pop();
      if (open !== undefined && open < index && i > index) spans.push([open, i + 1]);
    }
  }
  spans.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  return [...spans.map(([a, b]) => text.slice(a, b)), text];
}

/**
 * The semantic-action cluster an intent assignment sits in: the run of adjacent
 * `{...}` / `{%...%}` groups around it. A rule tags one match with its intent,
 * its domain and its slots in a single cluster, so reading those from the
 * cluster rather than the whole production keeps them attached to the right
 * intent when a production declares several.
 */
function actionCluster(body, index) {
  const groupAt = (start) => {
    let depth = 0;
    for (let i = start; i < body.length; i += 1) {
      if (body[i] === '\\') { i += 1; continue; }
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') { depth -= 1; if (!depth) return i + 1; }
    }
    return -1;
  };
  let start = body.lastIndexOf('{', index);
  if (start < 0) return body;
  // Walk left over adjacent groups.
  for (;;) {
    let j = start - 1;
    while (j >= 0 && /\s/.test(body[j])) j -= 1;
    if (j < 0 || body[j] !== '}') break;
    let depth = 0;
    let k = j;
    while (k >= 0) {
      if (body[k] === '}') depth += 1;
      else if (body[k] === '{') { depth -= 1; if (!depth) break; }
      k -= 1;
    }
    if (k < 0) break;
    start = k;
  }
  // Walk right over adjacent groups.
  let end = groupAt(start);
  if (end < 0) return body;
  for (;;) {
    let j = end;
    while (j < body.length && /\s/.test(body[j])) j += 1;
    if (body[j] !== '{') break;
    const next = groupAt(j);
    if (next < 0) break;
    end = next;
  }
  return body.slice(start, end);
}

/**
 * The grammar element an intent assignment is attached to: walk left past the
 * semantic-action cluster (`{...}{...}`) and take the term before it, which is
 * the `$REF`, `(group)`, `[word?s]` or bare word that the intent labels.
 *
 * Without this, sibling intents declared in one production (askForTime and
 * askForDate, or requestCommute / requestCalendar / requestNews) all widen to
 * the same enclosing branch and end up sharing an example phrase.
 */
function attachedTerm(body, index) {
  let i = body.lastIndexOf('{', index);
  for (;;) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(body[j])) j -= 1;
    if (j >= 0 && body[j] === '}') { // another action in the cluster; keep walking
      let depth = 0;
      while (j >= 0) {
        if (body[j] === '}') depth += 1;
        else if (body[j] === '{') { depth -= 1; if (!depth) break; }
        j -= 1;
      }
      i = j;
      continue;
    }
    if (j < 0) return null;
    const close = body[j];
    const open = close === ')' ? '(' : close === ']' ? '[' : null;
    if (open) {
      let depth = 0;
      let k = j;
      while (k >= 0) {
        if (body[k] === close) depth += 1;
        else if (body[k] === open) { depth -= 1; if (!depth) break; }
        k -= 1;
      }
      return k >= 0 ? body.slice(k, j + 1) : null;
    }
    const start = /[\w$:.-]/.test(close) ? (() => {
      let k = j;
      while (k >= 0 && /[\w$:.'-]/.test(body[k])) k -= 1;
      return k + 1;
    })() : -1;
    return start >= 0 ? body.slice(start, j + 1) : null;
  }
}

function exampleForIntentAt(body, index, resolve) {
  const attached = attachedTerm(body, index);
  if (attached) {
    const phrase = renderExample(attached, resolve);
    if (phrase && phrase.split(' ').length >= 2) return phrase;
  }
  for (const span of enclosingSpans(body, index)) {
    const phrase = renderExample(span, resolve);
    if (phrase && phrase.split(' ').length >= 2) return phrase;
  }
  return null;
}

/**
 * The full FST intent surface.
 * @returns {Map<string, {intent, domains:Set<string>, ruleDomains:Set<string>,
 *                        files:Set<string>, examples:Set<string>}>}
 */
export function readFstIntents(rulesSrc) {
  const files = ruleFiles(rulesSrc);

  // Productions are resolved per rule-set directory: rule names are reused
  // across domains (LAUNCH, TopRule, YES), so a global map would cross wires.
  const bodies = new Map(); // domain -> Map(name -> body)
  const parsed = [];
  for (const entry of files) {
    const text = readFileSync(entry.path, 'utf8');
    const rows = productions(text).map(splitProduction);
    if (!bodies.has(entry.domain)) bodies.set(entry.domain, new Map());
    const scope = bodies.get(entry.domain);
    for (const { name, body } of rows) {
      if (name && !scope.has(name)) scope.set(name, body);
    }
    parsed.push({ ...entry, rows });
  }

  const byIntent = new Map();
  for (const { domain, file, rows } of parsed) {
    const scope = bodies.get(domain);
    const resolve = (name) => scope.get(name) || scope.get(name.replace(/^factory:/, '')) || null;
    for (const { name, body } of rows) {
      INTENT_RE.lastIndex = 0;
      let match = INTENT_RE.exec(body);
      while (match) {
        const intent = match[1].trim();
        if (!byIntent.has(intent)) {
          byIntent.set(intent, {
            intent,
            domains: new Set(),
            ruleDomains: new Set(),
            files: new Set(),
            examples: new Set(),
            slots: new Set(),
          });
        }
        const row = byIntent.get(intent);
        row.ruleDomains.add(domain);
        row.files.add(`${domain}/${file}`);
        const cluster = actionCluster(body, match.index);
        for (const d of matchAll(cluster, DOMAIN_RE)) row.domains.add(d);
        for (const slot of matchAll(cluster, SLOT_RE)) {
          if (!NOT_SLOT.has(slot)) row.slots.add(slot);
        }
        const phrase = exampleForIntentAt(body, match.index, resolve);
        if (phrase) row.examples.add(phrase);
        match = INTENT_RE.exec(body);
      }
      void name;
    }
  }
  return byIntent;
}

// Request-scoped parser for the Pegasus NLU contract.
//
// The legacy parse(text) entry point intentionally keeps Phoenix's broad
// launch/question behavior for existing callers. HTTP parser requests use this
// module instead: rules are loaded from the frozen source inventory and only
// the requested rule files are evaluated.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseRules } from './grammar/parser.js';
import { matchRule, parseScore, tokenize } from './grammar/matcher.js';
import { loadEqWords } from './grammar/eqWords.js';
import { buildFactoryWords, undeclaredFactoryWordFile } from './grammar/factoryWords.js';
import { getCompiledFstRuntime, matchCompiledRule } from './compiledFstRuntime.js';
import { selectBestNative } from './arbitration.js';

const RESOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');
const INVENTORY_PATH = join(RESOURCE_ROOT, 'rule-inventory.json');
// ParseRequestHandler's no-result contract uses JSON null for entities. Keep
// the legacy parse(text) wrapper's object-shaped no-match result separate.
const EMPTY_NLU = Object.freeze({ rules: [], intent: null, entities: null });
// The original handler dereferences the disabled Dialogflow result when a
// truthy external-agent request is present. Keep its Node 8 wire message until
// the external-agent adapter is implemented; this is deliberately not a new
// product-facing candidate error.
const DISABLED_EXTERNAL_ERROR = "Cannot read property 'external' of null";

let loaded;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isEquivalentWordsEnabled(ast) {
  return (ast.directives || []).some(d => /use_equivalent_words\s*=\s*true/.test(d));
}

function factoryNames(source) {
  return [...new Set([...source.matchAll(/\$factory:([A-Za-z0-9_-]+)/g)].map(m => m[1]))].sort();
}

function sameNames(a, b) {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function readChecked(path, expected, label) {
  if (!existsSync(path)) throw new Error(`Missing NLU ${label}: ${path}`);
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`NLU ${label} hash mismatch: ${path}`);
  return bytes.toString('utf8');
}

function load() {
  if (loaded) return loaded;
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  const supportingText = new Map();
  for (const [name, entry] of Object.entries(inventory.supporting || {})) {
    supportingText.set(name, readChecked(join(RESOURCE_ROOT, entry.path), entry.sha256, `supporting resource '${name}'`));
  }
  const rules = new Map();
  const factories = new Map();

  for (const [name, entry] of Object.entries(inventory.rules || {})) {
    const path = join(RESOURCE_ROOT, entry.path);
    const source = readChecked(path, entry.sha256, `rule '${name}'`);
    let ast;
    try { ast = parseRules(source); }
    catch (error) { throw new Error(`Cannot parse NLU rule '${name}': ${error.message}`); }
    if (!ast.rules.TopRule) throw new Error(`NLU rule '${name}' has no TopRule`);
    rules.set(name, { name, path, ast, factories: factoryNames(source) });
  }
  if (rules.size !== inventory.ruleCount) throw new Error(`NLU rule inventory count mismatch: ${rules.size} !== ${inventory.ruleCount}`);

  for (const [name, entry] of Object.entries(inventory.factories || {})) {
    const path = join(RESOURCE_ROOT, entry.path);
    const source = readChecked(path, entry.sha256, `factory '${name}'`);
    let ast;
    try { ast = parseRules(source); }
    catch (error) { throw new Error(`Cannot parse NLU factory '${name}': ${error.message}`); }
    const topRuleName = ast.rules.TopRule ? 'TopRule' : Object.keys(ast.rules)[0];
    if (!topRuleName) throw new Error(`NLU factory '${name}' has no rules`);
    factories.set(name, { name, path, ast, top: ast.rules[topRuleName] });
  }

  if (factories.size !== inventory.factoryCount) throw new Error(`NLU factory inventory count mismatch: ${factories.size} !== ${inventory.factoryCount}`);
  const dependencyInventory = inventory.ruleDependencies || {};
  const sourceNames = [...rules.keys()].sort();
  const dependencyNames = Object.keys(dependencyInventory).sort();
  if (!sameNames(sourceNames, dependencyNames)) throw new Error('NLU rule dependency inventory does not cover every source rule');
  for (const [name, entry] of rules) {
    const dependency = dependencyInventory[name];
    const expected = Array.isArray(dependency.factories) ? [...dependency.factories].sort() : [];
    if (!sameNames(entry.factories, expected)) throw new Error(`NLU dependency inventory mismatch for rule '${name}'`);
    const unsupported = Array.isArray(dependency.unsupported) ? [...dependency.unsupported].sort() : [];
    const bounded = Array.isArray(dependency.bounded) ? [...dependency.bounded].sort() : [];
    const actualUnsupported = expected.filter(factory => inventory.factoryDependencies?.[factory]?.status === 'unsupported');
    const actualBounded = expected.filter(factory => inventory.factoryDependencies?.[factory]?.status === 'bounded-compatibility');
    if (!sameNames(unsupported, actualUnsupported) || !sameNames(bounded, actualBounded)) {
      throw new Error(`NLU dependency support inventory mismatch for rule '${name}'`);
    }
  }
  // Every bundled factory word list must be declared — and therefore hash
  // verified — by the inventory before it can feed the matcher. An undeclared
  // file is a dependency with no anchor, so refuse it instead of importing it.
  const wordListNames = [...supportingText.keys()]
    .filter(name => name.startsWith('factory-words/'))
    .map(name => name.slice('factory-words/'.length))
    .sort();
  const wordListDir = join(RESOURCE_ROOT, 'factory-words');
  const undeclaredWordList = undeclaredFactoryWordFile(wordListNames, existsSync(wordListDir) ? readdirSync(wordListDir) : []);
  if (undeclaredWordList) {
    throw new Error(`NLU factory word list '${undeclaredWordList}' has no rule-inventory entry`);
  }
  const factoryWords = buildFactoryWords(wordListNames.map(name => ({
    name,
    text: supportingText.get(`factory-words/${name}`),
  })));
  if (factoryWords.size !== wordListNames.length) {
    throw new Error('NLU factory word-list inventory is incomplete');
  }
  // Anchored semantics for the word-list factories: the private output field
  // each one publishes and any literal value per entry, re-derived from the
  // version-matched factory sources under resources/factory-sources (see
  // manifest.json for their origin and hashes; extractFactoryWordSemantics.mjs
  // regenerates this file from those sources). Word-list spellings alone cannot
  // express `state` = the two-letter code. A missing file leaves the matcher on
  // the historical `_<name>` field.
  const factoryFields = new Map();
  const semanticsPath = join(RESOURCE_ROOT, 'factory-sources', 'word-list-semantics.json');
  if (existsSync(semanticsPath)) {
    const semantics = JSON.parse(readFileSync(semanticsPath, 'utf8'));
    for (const [name, spec] of Object.entries(semantics.factories || {})) factoryFields.set(name, spec);
  }
  for (const [name, dependency] of Object.entries(inventory.factoryDependencies || {})) {
    if (dependency.status === 'bounded-compatibility') {
      const active = inventory.factories?.[name];
      if (!active || active.path !== dependency.implementation) throw new Error(`NLU bounded factory '${name}' has no implementation provenance`);
    }
    if (dependency.status === 'word-list' && !factoryWords.has(name)) throw new Error(`NLU word-list factory '${name}' is missing`);
  }

  const factoryRules = {};
  for (const factory of factories.values()) Object.assign(factoryRules, factory.ast.rules);
  const publicRules = new Map();
  for (const [name, entry] of Object.entries(inventory.publicRules || {})) {
    const sources = Array.isArray(entry.sources) ? entry.sources.slice() : [];
    if (!sources.length || sources.some(source => !rules.has(source))) throw new Error(`NLU public rule '${name}' has missing source dependencies`);
    if (name === 'launch' && (!entry.sourceHandles || sources.some(source => typeof entry.sourceHandles[source] !== 'string'))) {
      throw new Error("NLU launch handle is missing source provenance");
    }
    publicRules.set(name, { name, sources, sourceHandles: entry.sourceHandles || {}, compiledPath: entry.compiledPath, sha256: entry.sha256 });
  }
  if (publicRules.size !== inventory.publicRuleCount) throw new Error(`NLU public rule inventory count mismatch: ${publicRules.size} !== ${inventory.publicRuleCount}`);
  if (!publicRules.has('launch')) throw new Error('NLU public rule inventory has no launch handle');
  loaded = {
    inventory,
    rules,
    publicRules,
    factories,
    factoryRules,
    eq: loadEqWords(),
    factoryWords,
    factoryFields,
    factoryWordNames: Object.freeze(wordListNames),
  };
  return loaded;
}

function emptyResult() {
  return { intent: EMPTY_NLU.intent, entities: EMPTY_NLU.entities, rules: EMPTY_NLU.rules.slice() };
}

function compiledHasRule(runtime, name) {
  if (!runtime) return false;
  if (typeof runtime.hasRule === 'function') return runtime.hasRule(name);
  try {
    runtime.getExecutor(name);
    return true;
  } catch {
    return false;
  }
}

function requestedEntries(requested, state, compiledRuntime) {
  const seen = new Set();
  const entries = [];
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = state.publicRules.get(name);
    if (entry) entries.push({ name, names: entry.sources });
    else if (compiledHasRule(compiledRuntime, name)) {
      // RobustParserClient keeps any requested name present in the discovered
      // FST registry, including graphs that are not in the closed 98-rule map.
      entries.push({ name, names: [name], compiledOnly: true });
    }
  }
  return entries;
}

function unsupportedDependencies(name, state) {
  if (name === 'launch') return [];
  const publicRule = state.publicRules.get(name);
  if (!publicRule) return [];
  return [...new Set(publicRule.sources.flatMap(source => state.inventory.ruleDependencies[source]?.unsupported || []))].sort();
}

function matchNamedRule(name, text, state, options = {}) {
  const entry = state.rules.get(name);
  if (!entry) throw new Error(`Missing loaded NLU rule: ${name}`);
  // The matcher compiles the source heuristic/reference tree behind a WeakMap
  // keyed by the rule map. Keep this merged map stable for the lifetime of the
  // loaded inventory; rebuilding it for every request defeats that cache and
  // turns the 20k parser replay into repeated AST cloning and GC work.
  if (!entry.matchRules) entry.matchRules = Object.assign({}, state.factoryRules, entry.ast.rules);
  const ctx = {
    rules: entry.matchRules,
    eq: isEquivalentWordsEnabled(entry.ast) ? state.eq : null,
    factoryWords: state.factoryWords,
    factoryFields: state.factoryFields,
    strictFactories: true,
    factoryHook: factoryName => {
      const factory = state.factories.get(factoryName);
      return factory ? factory.top : null;
    },
  };
  const match = matchRule(entry.ast.rules.TopRule, tokenize(text), ctx);
  if (!match || !match.entities || !match.entities.intent) return null;
  const entities = Object.assign({}, match.entities);
  const priority = typeof match.entities.priority === 'string' ? match.entities.priority : '';
  delete entities.intent;
  delete entities.priority;
  // Launch is a native UNION of every */launch graph. Native scores that union
  // as input_length - heuristic and copies priority onto NLParse after
  // selection. Do not mix priorityRank * 1e6 into the launch-member score.
  return {
    rule: name,
    entities,
    intent: match.entities.intent,
    priority,
    score: parseScore(match.entities, match.specificity, match.cost, {
      includePriority: options.includePriority !== false,
    }),
  };
}

function chooseBest(requested, text, state, compiledRuntime) {
  if (!compiledRuntime) {
    const candidates = [];
    for (const requestedEntry of requested) {
      for (const name of requestedEntry.names) {
        const candidate = matchNamedRule(name, text, state, {
          includePriority: requestedEntry.name !== 'launch',
        });
        if (!candidate) continue;
        if (requestedEntry.name !== name) candidate.requestedName = requestedEntry.name;
        candidates.push(candidate);
      }
    }
    return selectBestNative(candidates);
  }
  const candidates = [];
  for (const requestedEntry of requested) {
    // The explicit archived profile supplies one verified graph for every requested
    // public rule. Never compare its native byte score with the AST matcher's priority
    // score: those are different scales. A compiled no-match must not fall back to AST
    // matching and hide a missing graph branch.
    try {
      const candidate = matchCompiledRule(requestedEntry.name, text, compiledRuntime);
      if (candidate) candidates.push(candidate);
    } catch (error) {
      // RobustParserClient.getRuleResponse converts one failed native request
      // to null, so other requested rules still participate in arbitration.
      // Profile loading and artifact verification happen before this boundary.
      console.error(`Request to rule ${requestedEntry.name} failed:`, error.message);
    }
  }
  if (!candidates.length) return null;

  // RobustParserClient.getBestResult compares native heuristic scores directly. On an
  // equal score it keeps request order, then removes the designated losers only when a
  // non-loser also tied. This is the source arbitration contract; no priority constants
  // are mixed into the graph score.
  return selectBestNative(candidates);
}

function equalName(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function addLoopMember(request, result) {
  const users = request.loop && Array.isArray(request.loop.users) ? request.loop.users : null;
  if (!users || !result || !result.intent) return result;

  const entities = result.entities || {};
  const hasGivenName = Object.prototype.hasOwnProperty.call(entities, 'given-name');
  const hasGivenNameAlias = Object.prototype.hasOwnProperty.call(entities, 'GivenName');
  const givenNameEntityExpected = hasGivenName || hasGivenNameAlias;
  const given = [hasGivenName ? entities['given-name'] : null, hasGivenNameAlias ? entities.GivenName : null]
    .find(value => typeof value === 'string' && value.length > 0) || null;
  const last = [
    Object.prototype.hasOwnProperty.call(entities, 'last-name') ? entities['last-name'] : null,
    Object.prototype.hasOwnProperty.call(entities, 'LastName') ? entities.LastName : null,
  ].find(value => typeof value === 'string' && value.length > 0) || null;
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = (firstName, lastName) => typeof firstName === 'string' && firstName.length > 0
    && typeof lastName === 'string' && lastName.length > 0;
  const enrich = member => member ? {
    ...result,
    entities: { ...entities, loopMemberReferent: member.id, 'given-name': member.firstName, 'last-name': member.lastName },
  } : result;

  // Match LoopMemberDetector's ordered checks. A failed given-name or
  // given-name+last-name lookup returns unchanged; it does not fall through to
  // a text search. Text search is only reached when no non-empty given name was
  // emitted by the selected source rule.
  if (given && last) {
    return enrich(users.find(user => equalName(user.firstName, given) && equalName(user.lastName, last)));
  }
  if (given && !last) {
    return enrich(users.find(user => equalName(user.firstName, given)));
  }

  if (!given) {
    const mentionedUser = users.find(user => {
      if (!named(user.firstName, user.lastName)) return false;
      const fullNameRegExp = new RegExp(`\\b${escapeRegExp(user.firstName)} ${escapeRegExp(user.lastName)}\\b`, 'i');
      return fullNameRegExp.test(request.text);
    });
    if (mentionedUser) return enrich(mentionedUser);
  }

  if (givenNameEntityExpected) {
    const mentionedByName = users.find(user => {
      if (typeof user.firstName !== 'string' || user.firstName.length === 0) return false;
      const firstNameRegExp = new RegExp(`\\b${escapeRegExp(user.firstName)}\\b`, 'i');
      return firstNameRegExp.test(request.text);
    });
    if (mentionedByName) return enrich(mentionedByName);
  }
  return result;
}

function applyExternalCompatibility(request, result) {
  // ParseRequestHandler performs this after empty-text handling and result
  // selection. Dialogflow is disabled in this candidate, so the original
  // null.external failure is the source-backed boundary for truthy requests.
  if (request.external) throw new Error(DISABLED_EXTERNAL_ERROR);
  return result;
}

/**
 * Parse one complete NLU request. Missing, empty, or unknown rule lists return
 * EMPTY_NLU just as the reference handler does after its parser client rejects;
 * they never fall back to the broad launch parser. Inventory and source parse
 * failures throw so a broken imported rule cannot be hidden as a no-match.
 */
export function parseRequest(request) {
  if (!request || typeof request.text !== 'string') throw new TypeError(`Bad NLU request: ${JSON.stringify(request)}`);
  const text = request.text.trim();
  if (!text) return emptyResult();
  if (!Array.isArray(request.rules)) return applyExternalCompatibility(request, emptyResult());
  const state = load();
  const compiledRuntime = getCompiledFstRuntime();
  const requested = requestedEntries(request.rules.filter(name => typeof name === 'string'), state, compiledRuntime);
  if (!requested.length) return applyExternalCompatibility(request, emptyResult());
  if (!compiledRuntime) {
    for (const entry of requested) {
      const unsupported = unsupportedDependencies(entry.name, state);
      if (unsupported.length) {
        // The source performs the external-agent attachment only after result
        // selection. A truthy external request therefore retains that boundary
        // error even when this bounded candidate cannot load a requested rule's
        // factory dependency.
        if (request.external) return applyExternalCompatibility(request, emptyResult());
        throw new Error(`Unsupported NLU factory dependencies for public rule '${entry.name}': ${unsupported.join(', ')}`);
      }
    }
  }
  const winner = chooseBest(requested, text, state, compiledRuntime);
  // ParseRequestHandler validates only the selected result. A missing intent or SKIP
  // priority therefore returns the empty NLU result and must not promote another final
  // from the same rule or a lower-ranked rule.
  if (!winner || (compiledRuntime && (!winner.intent || winner.priority === 'SKIP'))) {
    return applyExternalCompatibility(request, emptyResult());
  }
  let entities = winner.entities;
  if (winner.requestedName === 'launch') {
    const launch = state.publicRules.get('launch');
    entities = { ...entities, union_original_fst_name: launch.sourceHandles[winner.rule] };
  }
  const result = { entities, intent: winner.intent, rules: [winner.requestedName || winner.rule] };
  return addLoopMember({ ...request, text }, applyExternalCompatibility(request, result));
}

export function ruleInventory() {
  const state = load();
  const dependencyEntries = Object.values(state.inventory.ruleDependencies || {});
  return {
    referenceRevision: state.inventory.referenceRevision,
    sourceRuleCount: state.rules.size,
    publicRuleCount: state.publicRules.size,
    factoryCount: state.factories.size,
    boundedFactoryCount: Object.values(state.inventory.factoryDependencies || {}).filter(entry => entry.status === 'bounded-compatibility').length,
    unsupportedFactoryCount: Object.values(state.inventory.factoryDependencies || {}).filter(entry => entry.status === 'unsupported').length,
    unsupportedRuleCount: dependencyEntries.filter(entry => entry.status === 'unsupported-dependencies').length,
    factoryWordCount: state.factoryWordNames.length,
  };
}

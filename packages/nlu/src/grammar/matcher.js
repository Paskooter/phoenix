// .rule AST matcher.
//
// Generator-based backtracking walk of the AST built by parser.js. Yields
// each possible parse position the AST can reach starting from a given
// input position, so the caller can pick the first/longest/highest-priority
// match. For our purposes the FIRST successful end-of-input parse wins —
// matching the cloud's first-match-wins behaviour on the intent-router side.
//
// Each yielded result is { end: number, entities: object, subFields: object }:
//   end       — input position after the match
//   entities  — entity tags collected (the parent skill reads from .entities)
//   subFields — `_field` private tags exposed back to the parent for
//               sub-rule field reads (e.g. {key=Sub._field} on the parent
//               picks up `_field` from the sub-rule's subFields).
//
// The matcher takes a `ctx` with:
//   rules        — { ruleName: AstNode }   the rule registry (from parser.js)
//   tokens       — string[]                 lowercased + tokenized input
//   factoryHook  — optional (name) => AstNode|null for $factory:NAME refs;
//                  returns null to treat as `$*` (any words)
//   handleHook   — same idea for $handle:NAME refs (e.g. crew names)
//   maxDepth     — safeguard against runaway recursion (default 200)
//   eq           — optional Map from eqWords.js: homophone-equivalence for literal
//                  compares (the `!use_equivalent_words = true` grammar directive)

import { eqEquals } from './eqWords.js';

const EMPTY = Object.freeze({});
const COMPILED_WEIGHT_CACHE = new WeakMap();
const CLASS_EQUIVALENT_CACHE = new WeakMap();

// The native compiler's result_fst score is input-string byte length minus the
// accumulated arc heuristic. The compiler's generated `$*` factory surrounds
// its repeated `$w` with <1.0> and <0.0>, so the active heuristic applies to
// every byte in each repeated word, including its appended separator, until
// the reset marker. Explicit `<N>` markers use the same persistent state.
// Literal specificity remains the existing grammar-word unit in this slice
// because changing all literal path widths also changes established
// holiday/entity arbitration.
function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

// Speech tokenization discards the separator that the native FST retains as a
// SPACE_WS arc after every ordinary word. Include that byte when a literal is
// under an explicit per-character heuristic. It is zero at the default
// heuristic and therefore preserves the existing unweighted path scores.
function sourceWordCost(token, heuristic) {
  return heuristic * (utf8Bytes(token) + 1);
}

// The native compiler flattens referenced rules and walks alternatives in
// source order through one rule_cmp instance. Its heuristic-per-character
// register therefore survives an alternative/reference boundary. Lower that
// compile-order state once per match tree so the runtime matcher does not
// accidentally make the state path-local. Each static reference occurrence is
// cloned because the native compiler expands each occurrence independently.
function compileHeuristicTree(node, rules, state, stack = new Set()) {
  const input = state.value;
  const copy = Object.assign({}, node, {
    __heuristicIn: input,
    __heuristicOut: input,
    __heuristicExplicit: state.explicit,
  });
  switch (node.type) {
    case 'heuristic':
      state.value = node.value;
      state.explicit = true;
      copy.__heuristicOut = state.value;
      copy.__heuristicExplicit = true;
      return copy;
    case 'lit':
    case 'class':
      copy.__charHeuristic = input;
      return copy;
    case 'star':
      // `$*`, `$wNN`, and the native zero-to-three factory are generated with
      // their own <1.0> body and <0.0> reset, regardless of the surrounding
      // compiler register.
      state.value = 0;
      state.explicit = true;
      copy.__charHeuristic = 1;
      copy.__heuristicOut = 0;
      copy.__heuristicExplicit = true;
      return copy;
    case 'opt':
      copy.item = compileHeuristicTree(node.item, rules, state, stack);
      copy.__heuristicOut = state.value;
      return copy;
    case 'plus':
      copy.item = compileHeuristicTree(node.item, rules, state, stack);
      copy.__heuristicOut = state.value;
      return copy;
    case 'seq':
      copy.items = node.items.map((item) => compileHeuristicTree(item, rules, state, stack));
      copy.__heuristicOut = state.value;
      return copy;
    case 'alt':
      copy.alts = node.alts.map((item) => compileHeuristicTree(item, rules, state, stack));
      copy.__heuristicOut = state.value;
      return copy;
    case 'ref':
      if (!node.prefix && rules[node.name] && !stack.has(node.name)) {
        const nestedStack = new Set(stack);
        nestedStack.add(node.name);
        copy.__compiledTarget = compileHeuristicTree(rules[node.name], rules, state, nestedStack);
        copy.__heuristicOut = state.value;
      }
      return copy;
    default:
      return copy;
  }
}

function compiledHeuristicTree(node, rules) {
  let byRules = COMPILED_WEIGHT_CACHE.get(node);
  if (!byRules) {
    byRules = new WeakMap();
    COMPILED_WEIGHT_CACHE.set(node, byRules);
  }
  let compiled = byRules.get(rules);
  if (!compiled) {
    compiled = compileHeuristicTree(node, rules, { value: 0, explicit: false });
    byRules.set(rules, compiled);
  }
  return compiled;
}

function sourceWildcardCost(tokens, start, count, prefix) {
  if (prefix) return prefix[start + count] - prefix[start];
  let cost = 0;
  for (let index = start; index < start + count; index += 1) cost += utf8Bytes(tokens[index]);
  return cost;
}

function freshEnts(prev) { return Object.assign({}, prev); }

// Tokenize an input string into lowercased word tokens. Matches the
// cloud's tokenization closely enough — strip punctuation, split on
// whitespace, lowercase. Contractions get split on apostrophe to mirror
// the cloud which sees `i'm` as `i 'm` or `i'm` per its tokenizer; we
// keep them whole and let rules handle `i\'m` literals as one token.
export function tokenize(text) {
  if (!text) return [];
  // Strip apostrophes: typed input frequently lacks them ("whats" vs "what's"),
  // and ASR transcripts vary. Comparing both sides apostrophe-free in `lit`
  // matching makes `what's` in the rule and "whats" in the input equivalent.
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[.,!?;:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
// Same strip applied to rule lits so they compare equal to tokenized input.
function _norm(s) {
  // The source grammar spells abbreviations inside character classes as
  // `u?.s?.`/`b?.e?.t?.`; the reference token matcher treats those optional
  // punctuation marks as part of the same word. Normalize them on rule arcs
  // just as tokenize() normalizes apostrophes, so source-backed event and
  // entity vocabularies remain usable for ordinary ASR text ("us", "bet").
  return String(s).toLowerCase().replace(/['’]/g, '').replace(/[.,!?;:]+/g, '');
}

// Apply tag specs (from a node's .tags) against a sub-match's subFields,
// producing entity updates for the parent. `lit` tags drop their value as-is;
// `subfield` tags read SubRule._field from `subFields`. `op` is 'set' (the
// `=` operator, overwriting) or 'append' (the `+=` operator, concatenating
// to whatever the same key already holds in this scope). Append is how
// on-robot rules compose mim ids from a prefix plus the matched entity name.
function applyTags(tags, prevEntities, prevSubFields, subFields, parsedText) {
  if (!tags || tags.length === 0) return { entities: prevEntities, subFields: prevSubFields };
  const ent = freshEnts(prevEntities);
  const sub = freshEnts(prevSubFields);
  for (const tag of tags) {
    let val;
    if (tag.kind === 'lit') val = tag.value;
    else if (tag.kind === 'parsed') val = parsedText;   // `this._parsed` → text this node matched
    else val = (subFields[tag.subRule] && subFields[tag.subRule][tag.subField]) || (subFields[tag.subField] !== undefined ? subFields[tag.subField] : undefined);
    if (val === undefined) continue;
    // Keys starting with `_` are private to the rule — they propagate to the
    // parent via subFields, NOT into the public entities map.
    const target = tag.key.startsWith('_') ? sub : ent;
    if (tag.op === 'append') {
      const prev = target[tag.key];
      target[tag.key] = (prev === undefined ? '' : String(prev)) + String(val);
    } else {
      target[tag.key] = val;
    }
  }
  return { entities: ent, subFields: sub };
}

// Generator: yield {end, entities, subFields} for each successful match
// of `node` starting at `start` in `ctx.tokens`. Recursive via rule refs.
function* match(node, start, ctx, depth, charHeuristic = 0) {
  if (depth > (ctx.maxDepth || 200)) return;
  const { tokens } = ctx;
  const compiled = Object.prototype.hasOwnProperty.call(node, '__heuristicIn');
  const effectiveHeuristic = compiled
    ? (node.__charHeuristic ?? node.__heuristicIn)
    : charHeuristic;
  const effectiveExit = compiled ? node.__heuristicOut : null;
  const effectiveExplicit = compiled ? Boolean(node.__heuristicExplicit) : false;

  switch (node.type) {
    case 'heuristic': {
      // `<N>` is an epsilon state transition in the native compiler. It
      // changes the heuristic attached to subsequent character arcs and
      // consumes no input of its own.
      const tagged = applyTags(node.tags, EMPTY, EMPTY, {}, '');
      yield {
        end: start,
        entities: tagged.entities,
        subFields: tagged.subFields,
        specificity: 0,
        cost: node.cost || 0,
        charHeuristic: effectiveExit ?? node.value,
      };
      return;
    }
    case 'lit': {
      // Lowercased + apostrophe-stripped equality (see tokenize/_norm).
      // Keep literal specificity at one grammar-word unit. Wildcard arc costs
      // below use the source's byte heuristic in this bounded repair.
      if (start < tokens.length && (tokens[start] === _norm(node.word) || eqEquals(ctx.eq, tokens[start], _norm(node.word)))) {
        const ent = freshEnts(EMPTY); const sub = freshEnts(EMPTY);
        const tagged = applyTags(node.tags, ent, sub, { /* no sub */ }, tokens[start]);
        yield {
          end: start + 1,
          entities: tagged.entities,
          subFields: tagged.subFields,
          specificity: 1,
          cost: (node.cost || 0) + sourceWordCost(tokens[start], effectiveHeuristic),
          charHeuristic: effectiveExit ?? charHeuristic,
        };
      }
      return;
    }
    case 'class': {
      // Inside [], ? makes the next character or parenthesized group
      // optional. Match the expanded words against the next input token.
      const variants = expandCharClass(node.body, ctx.eq);
      for (const v of variants) {
        // Bare bracketed character words are compiled with `new_word`, whereas
        // ordinary word constants and a syntactically plain parenthesized
        // character word use `new_word_and_equivalents`. `expandCharClass`
        // expands only that parenthesized atom; matching each resulting
        // spelling exactly keeps a bare class such as `[georgia]` from
        // accepting the unrelated-length `george` equivalent.
        if (start < tokens.length && tokens[start] === _norm(v)) {
          const tagged = applyTags(node.tags, EMPTY, EMPTY, {}, tokens[start]);
          yield {
            end: start + 1,
            entities: tagged.entities,
            subFields: tagged.subFields,
            specificity: 1,
            cost: (node.cost || 0) + sourceWordCost(tokens[start], effectiveHeuristic),
            charHeuristic: effectiveExit ?? charHeuristic,
          };
        }
      }
      return;
    }
    case 'star': {
      // Kleene-star: yield 0..N word matches. `max` caps the count (for `$wNN`);
      // unbounded otherwise. Yield SHORTEST first (lazy) so callers favour
      // tight matches; alternatives like `?a` after `$*` then naturally fill
      // in. Without lazy, `$*` eagerly grabs everything and adjacent literals
      // never match.
      // specificity: 0 — star matches don't count, so longest-match across
      // skills picks the rule that's filled with literal content, not the one
      // that wraps a single literal in `$* X $*`.
      // The compiler's wildcard factory assigns heuristic 1.0 to every byte in
      // its repeated `$w`, including the appended separator, and resets only
      // after the repeated body. This token-level adapter retains the earlier
      // non-space-byte cost for wildcard ranking; explicit literal markers use
      // sourceWordCost below, including their separator byte.
      const maxN = (typeof node.max === 'number') ? node.max : (tokens.length - start);
      for (let n = 0; n <= maxN; n += 1) {
        if (start + n > tokens.length) break;
        const tagged = applyTags(node.tags, EMPTY, EMPTY, {}, tokens.slice(start, start + n).join(' '));
        yield {
          end: start + n,
          entities: tagged.entities,
          subFields: tagged.subFields,
          specificity: 0,
          cost: (node.cost || 0) + sourceWildcardCost(tokens, start, n, ctx.wildcardPrefix),
          // `$*`, `$wNN`, and the native zero-to-three factory are generated
          // rules with their own <1.0>/<0.0> markers. Do not leak a caller's
          // explicit state through them: each factory resets to zero after its
          // repeated wildcard body.
          charHeuristic: effectiveExit ?? 0,
        };
      }
      return;
    }
    case 'opt': {
      // Try zero-match first, then a real match. (Zero-match keeps parent
      // pos at `start`; tags attached to the optional group still run on
      // this epsilon path, just as the native FST action on `(?X){...}` does
      // when X is absent.)
      const zeroTagged = applyTags(node.tags, EMPTY, EMPTY, EMPTY, '');
      yield {
        end: start,
        entities: zeroTagged.entities,
        subFields: zeroTagged.subFields,
        specificity: 0,
        cost: 0,
        charHeuristic: effectiveExit ?? charHeuristic,
      };
      for (const m of match(node.item, start, ctx, depth + 1, effectiveHeuristic)) {
        const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields, tokens.slice(start, m.end).join(' '));
        yield {
          end: m.end,
          entities: tagged.entities,
          subFields: tagged.subFields,
          specificity: m.specificity || 0,
          cost: (m.cost || 0) + (node.cost || 0),
          charHeuristic: effectiveExit ?? m.charHeuristic,
        };
      }
      return;
    }
    case 'plus': {
      // Native `+X` is PLUS_KLEENE: one or more repetitions of X. The
      // repeated item normally makes progress. Native PLUS_KLEENE also
      // permits one epsilon repetition when X itself is nullable (`+?a`,
      // `+$*`); recurse only through progress-making matches so that this
      // source-valid case cannot create a zero-progress loop.
      function* repeat(pos, ents, subs, specSoFar, costSoFar, currentHeuristic, count) {
        if (count > 0) {
          const tagged = applyTags(node.tags, ents, subs, subs, tokens.slice(start, pos).join(' '));
          yield {
            end: pos,
            entities: tagged.entities,
            subFields: tagged.subFields,
            specificity: specSoFar,
            cost: costSoFar + (node.cost || 0),
            charHeuristic: effectiveExit ?? currentHeuristic,
          };
        }
        // Once one repetition has been emitted at end-of-input, no further
        // progress is possible. At count zero we still inspect the operand so
        // a nullable item can contribute its one permitted epsilon repeat.
        if (count > 0 && pos >= tokens.length) return;
        for (const m of match(node.item, pos, ctx, depth + 1, currentHeuristic)) {
          if (m.end < pos) continue;
          if (m.end === pos) {
            // PLUS_KLEENE's lower bound is satisfied by exactly one empty
            // operand match. Do not recurse with the same position. This
            // preserves outer tags/entities for `(+?a){...}` and
            // `(+ $*){...}` while preventing infinite nullable recursion.
            if (count !== 0) continue;
            const nextEnts = mergeObj(ents, m.entities);
            const nextSubs = mergeObj(subs, m.subFields);
            const tagged = applyTags(node.tags, nextEnts, nextSubs, nextSubs, tokens.slice(start, pos).join(' '));
            yield {
              end: pos,
              entities: tagged.entities,
              subFields: tagged.subFields,
              specificity: specSoFar + (m.specificity || 0),
              cost: costSoFar + (m.cost || 0) + (node.cost || 0),
              charHeuristic: effectiveExit ?? m.charHeuristic,
            };
            continue;
          }
          yield* repeat(
            m.end,
            mergeObj(ents, m.entities),
            mergeObj(subs, m.subFields),
            specSoFar + (m.specificity || 0),
            costSoFar + (m.cost || 0),
            m.charHeuristic,
            count + 1,
          );
        }
      }
      yield* repeat(start, EMPTY, EMPTY, 0, 0, effectiveHeuristic, 0);
      return;
    }
    case 'seq': {
      // Match each item in order, backtracking on failure of later items.
      // Apply seq-level tags (hoisted from the trailing `(X Y {tag})` block
      // by the parser) AFTER the full sequence has matched, with visibility
      // into all accumulated subFields — that's how `{intent=Sub._field}`
      // group tags work in the cloud's compiler.
      for (const m of matchSeq(node.items, 0, start, EMPTY, EMPTY, 0, ctx, depth, effectiveHeuristic)) {
        const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields, tokens.slice(start, m.end).join(' '));
        yield {
          end: m.end,
          entities: tagged.entities,
          subFields: tagged.subFields,
          specificity: m.specificity || 0,
          cost: (m.cost || 0) + (node.cost || 0),
          charHeuristic: effectiveExit ?? m.charHeuristic,
        };
      }
      return;
    }
    case 'alt': {
      // Try each alternative in order; yield matches from each.
      for (const a of node.alts) {
        for (const m of match(a, start, ctx, depth + 1, effectiveHeuristic)) {
          const tagged = applyTags(node.tags, m.entities, m.subFields, m.subFields, tokens.slice(start, m.end).join(' '));
          yield {
            end: m.end,
            entities: tagged.entities,
            subFields: tagged.subFields,
            specificity: m.specificity || 0,
            cost: (m.cost || 0) + (node.cost || 0),
            charHeuristic: effectiveExit ?? m.charHeuristic,
          };
        }
      }
      return;
    }
    case 'ref': {
      let target = null;
      // Factory / handle references: ask the host hooks; otherwise treat
      // as a wildcard so the parse can continue (and the entity tag that
      // references the sub-rule's field gets `null` since there's no sub).
      if (node.prefix === 'factory') {
        target = ctx.factoryHook ? ctx.factoryHook(node.name) : null;
      } else if (node.prefix === 'handle') {
        target = ctx.handleHook ? ctx.handleHook(node.name) : null;
      } else {
        target = node.__compiledTarget || ctx.rules[node.name];
      }
      if (!target && node.prefix === 'factory' && ctx.factoryWords && ctx.factoryWords.has(node.name)) {
        // Word-list factory (extracted reference vocab): match ONLY listed
        // phrases, longest-first. Verified content counts as literal grammar
        // words (with no wildcard cost). Exposes the matched
        // text as the `_<name>` sub-field (e.g. `{_selfid=first_name._first_name}`)
        // alongside the usual `this._parsed` capture.
        const byFirst = ctx.factoryWords.get(node.name);
        const candidates = (start < tokens.length && byFirst.get(tokens[start])) || [];
        for (const phrase of candidates) {
          if (start + phrase.length > tokens.length) continue;
          let okPhrase = true;
          for (let k = 0; k < phrase.length; k += 1) if (tokens[start + k] !== phrase[k]) { okPhrase = false; break; }
          if (!okPhrase) continue;
          const text = tokens.slice(start, start + phrase.length).join(' ');
          const subs = { [`_${node.name}`]: text };
          const tagged = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: subs, ...subs }, text);
          const subsForParent = Object.assign({}, tagged.subFields, { [node.name]: subs });
          yield {
            end: start + phrase.length,
            entities: tagged.entities,
            subFields: subsForParent,
            specificity: phrase.length,
            cost: node.cost || 0,
            charHeuristic: effectiveExit ?? charHeuristic,
          };
        }
        return; // membership is a CONSTRAINT — no wildcard fallback for listed factories
      }
      if (!target && node.prefix === 'factory' && ctx.strictFactories) {
        // A request-scoped source rule must not turn an unavailable factory
        // dependency into an arbitrary 1..3-word wildcard. The broad legacy
        // parser keeps its historical fallback; named requests opt into this
        // strict path so missing factory support becomes a no-match.
        return;
      }
      if (!target) {
        // Fallback: match 1..3 words greedily (factory slots typically span
        // a short noun phrase). The lit-vs-subfield tag eval handles missing
        // values gracefully (undefined → not set). specificity: 0 because we
        // didn't actually verify factory content — counted as a wildcard.
        // `$w` is the native one-word wildcard: compiler.cpp constructs it
        // from one-or-more nonblank characters followed by one SPACE_WS arc.
        // The older Phoenix fallback admitted up to three words for every
        // unresolved reference. Preserve that adapter for unknown names, but
        // give the reserved base word factory its source cardinality.
        const maxN = node.name === 'w' ? 1 : 3;
        const explicitWordWildcard = node.name === 'w' && effectiveExplicit;
        for (let n = 1; n <= maxN; n += 1) {
          if (start + n > tokens.length) break;
          const tagged = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: { /* no fields */ } }, tokens.slice(start, start + n).join(' '));
          yield {
            end: start + n,
            entities: tagged.entities,
            subFields: tagged.subFields,
            specificity: 0,
            // A source-authored `<N>` (or the generated wildcard's internal
            // reset marker) makes `$w` use the native per-character arc
            // heuristic, including its trailing separator. At the default
            // state retain the historical token-level adapter until the
            // other wildcard factories are migrated as a separate scope.
            cost: (node.cost || 0) + (explicitWordWildcard
              ? sourceWordCost(tokens[start], effectiveHeuristic)
              : sourceWildcardCost(tokens, start, n, ctx.wildcardPrefix)),
            charHeuristic: effectiveExit ?? charHeuristic,
          };
        }
        // The reserved `$w` source rule has a mandatory nonblank body and a
        // trailing SPACE_WS arc, so it cannot take the legacy zero-word
        // fallback. Keep zero-match for unresolved application-specific refs,
        // whose older adapter explicitly allowed an optional slot.
        if (node.name !== 'w') {
          const tagged0 = applyTags(node.tags, EMPTY, EMPTY, { [node.name]: {} }, '');
          yield {
            end: start,
            entities: tagged0.entities,
            subFields: tagged0.subFields,
            specificity: 0,
            cost: node.cost || 0,
            charHeuristic: effectiveExit ?? charHeuristic,
          };
        }
        return;
      }
      // Real ref: match the sub-rule, then expose its subFields to our tags
      // under the sub-rule's name (so `{key=SubRule._field}` works on this
      // ref's own tags). Also merge that namespace INTO the returned subFields
      // so an enclosing seq's group-level tag can later read `SubRule._field`
      // — the matchSeq accumulator will carry the namespaced map up.
      for (const m of match(target, start, ctx, depth + 1, effectiveHeuristic)) {
        const exposed = { [node.name]: m.subFields };
        const tagged = applyTags(node.tags, m.entities, m.subFields, exposed, tokens.slice(start, m.end).join(' '));
        const subsForParent = Object.assign({}, tagged.subFields, exposed);
        yield {
          end: m.end,
          entities: tagged.entities,
          subFields: subsForParent,
          specificity: m.specificity || 0,
          cost: (m.cost || 0) + (node.cost || 0),
          charHeuristic: effectiveExit ?? m.charHeuristic,
        };
      }
      return;
    }
    default:
      return;
  }
}

// Sequence helper — recursively threads through each item, accumulating
// entities + subFields. Yields on full completion of the sequence.
// Specificity sums across items so a seq of literals out-scores a seq with
// the same overall length but more wildcard kleene/factory slots.
function* matchSeq(items, idx, pos, ents, subs, specSoFar, ctx, depth, charHeuristic = 0, costSoFar = 0) {
  if (idx >= items.length) {
    yield {
      end: pos,
      entities: ents,
      subFields: subs,
      specificity: specSoFar,
      cost: costSoFar,
      charHeuristic,
    };
    return;
  }
  for (const m of match(items[idx], pos, ctx, depth + 1, charHeuristic)) {
    const nextEnts = mergeObj(ents, m.entities);
    const nextSubs = mergeObj(subs, m.subFields);
    yield* matchSeq(
      items,
      idx + 1,
      m.end,
      nextEnts,
      nextSubs,
      specSoFar + (m.specificity || 0),
      ctx,
      depth + 1,
      m.charHeuristic,
      costSoFar + (m.cost || 0),
    );
  }
}
function mergeObj(a, b) {
  if (!a || !Object.keys(a).length) return b;
  if (!b || !Object.keys(b).length) return a;
  return Object.assign({}, a, b);
}

// Expand a char-class body into all literal word variants. The char-class
// body accepts the same constructs as the outer rule grammar — concatenation,
// `|` alternation, `?X` optionals, `(...)` grouping — applied
// character-by-character with no inter-token space. So:
//   `[salutation?s]`   → ['salutation', 'salutations']
//   `[me?et]`          → ['met', 'meet']
//   `[danc(e|(ing))]`  → ['dance', 'dancing']
//   `[do?(ing)]`       → ['do', 'doing']
//   `[is?(n\'t)]`      → ['is', "isn't"]
//   `[ha(s|(ve))?(n\'t)]` → ['has','have',"hasn't","haven't"]
// Implementation: recursive descent over the body that returns the full set
// of strings each subexpression can produce. Cross-products on concatenation,
// union on `|`, `['', X]` on `?X`.
function classEquivalentVariants(eq, word) {
  if (!eq) return [word];
  let byWord = CLASS_EQUIVALENT_CACHE.get(eq);
  if (!byWord) {
    byWord = new Map();
    CLASS_EQUIVALENT_CACHE.set(eq, byWord);
  }
  const source = String(word);
  const normalized = _norm(source);
  const cacheKey = source.toLowerCase();
  const cached = byWord.get(cacheKey);
  if (cached) return cached;

  // The source map is keyed by the spelling emitted by the grammar lexer. Try
  // the source spelling first, then the matcher-normalized spelling used for
  // input tokens. This matters for escaped apostrophes such as `(we\'re)`.
  const canonical = eq.get(source.toLowerCase()) ?? eq.get(normalized);
  if (canonical === undefined) {
    const result = Object.freeze([source]);
    byWord.set(cacheKey, result);
    return result;
  }

  const result = [];
  const seen = new Set();
  for (const [candidate, representative] of eq) {
    if (representative !== canonical) continue;
    const value = String(candidate);
    const valueKey = value.toLowerCase();
    if (seen.has(valueKey)) continue;
    seen.add(valueKey);
    result.push(value);
  }
  if (!seen.has(source.toLowerCase())) result.unshift(source);
  const frozen = Object.freeze(result);
  byWord.set(cacheKey, frozen);
  return frozen;
}

function readParenthesizedWord(body, start) {
  if (body[start] !== '(') return null;
  let pos = start + 1;
  let word = '';
  while (pos < body.length && body[pos] !== ')') {
    const character = body[pos];
    if (character === '\\') {
      if (pos + 1 >= body.length) return null;
      word += body[pos + 1];
      pos += 2;
      continue;
    }
    // `?`, `|`, `*`, `+`, nested parentheses, and `~` are char-rule
    // operators, so this is a generic group rather than the native `(wrd)`
    // production. Whitespace likewise means it is not one lexical word.
    if (/\s/.test(character) || '?|*+()~'.includes(character)) return null;
    word += character;
    pos += 1;
  }
  if (body[pos] !== ')' || word.length === 0) return null;
  return { end: pos + 1, word };
}

function expandCharClass(body, eq = null) {
  let pos = 0;
  function parseSeq() {
    let acc = [''];
    while (pos < body.length && body[pos] !== '|' && body[pos] !== ')') {
      // The native character grammar gives `|` the same tight binding as
      // the outer rule grammar. An alternation therefore belongs to the
      // immediately preceding item while surrounding atoms concatenate:
      // `g(ed)|(ing)` means `g(ed|ing)`, not `g(ed)|ing`.
      const part = parseAltItem();
      if (!part.length) continue;
      const next = [];
      for (const a of acc) for (const b of part) next.push(a + b);
      acc = next;
    }
    return acc;
  }
  function parseAltItem() {
    const out = [...parseItem()];
    while (pos < body.length && body[pos] === '|') {
      pos += 1;
      out.push(...parseItem());
    }
    return out;
  }
  function parseItem() {
    if (body[pos] === '?') {
      pos += 1;
      const sub = parseAtom();
      return ['', ...sub];
    }
    return parseAtom();
  }
  function parseAtom() {
    if (pos >= body.length) return [''];
    if (body[pos] === '(') {
      const simple = readParenthesizedWord(body, pos);
      if (simple) {
        pos = simple.end;
        return classEquivalentVariants(eq, simple.word);
      }
      pos += 1;
      const r = parseSeq();
      if (body[pos] === ')') pos += 1;
      return r;
    }
    // A bare atom is one character. Consuming the whole following word
    // here incorrectly made ? discard every remaining character in it.
    if (body[pos] === '\\' && pos + 1 < body.length) pos += 1;
    const character = String.fromCodePoint(body.codePointAt(pos));
    pos += character.length;
    return [character];
  }
  return parseSeq();
}

// Public: try to match a TopRule against the input tokens. Returns the BEST
// full-input match — highest grammar specificity minus accumulated arc cost. On
// ties, returns the first one discovered, mirroring the
// cloud's first-best behaviour. Returns null when no full match exists.
// Rank a parse the way the real engine's union arbitration does: by the
// `priority` the grammar assigned (HIGH > unset > LOW), then by the bounded
// source-like wildcard heuristic score. LOW is the deflector/catch-all tier
// (`{% intent='idle' %}`, generic GQA) — it only wins when nothing better matches.
export function priorityRank(p) {
  // Source rule files contain both the legacy upper-case spelling and the
  // lower-case spelling used by newer skill grammars. The reference treats
  // these as the same arbitration tier; preserving case here silently demotes
  // report-skill HIGH results below chitchat's catch-all arms.
  const priority = typeof p === 'string' ? p.trim().toUpperCase() : '';
  return priority === 'HIGH' ? 2 : (priority === 'LOW' ? 0 : 1);
}
// The bounded matcher score keeps its existing grammar-word specificity and
// now uses the native wildcard arc heuristic for its accumulated cost. The
// priority term remains the Phoenix cross-grammar arbitration layer.
export function parseScore(entities, specificity, cost = 0) {
  return priorityRank(entities && entities.priority) * 1e6 + (specificity || 0) - (cost || 0);
}

export function matchRule(node, tokens, ctx) {
  const fullCtx = Object.assign({ tokens, rules: ctx.rules || {}, maxDepth: 250 }, ctx);
  if (!fullCtx.wildcardPrefix) {
    fullCtx.wildcardPrefix = [0];
    for (const token of tokens) {
      const previous = fullCtx.wildcardPrefix[fullCtx.wildcardPrefix.length - 1];
      fullCtx.wildcardPrefix.push(previous + utf8Bytes(token));
    }
  }
  const compiledNode = compiledHeuristicTree(node, fullCtx.rules);
  // INTRA-grammar path selection is pure FST shortest-path: maximize
  // (specificity - cost). `priority` is hub-level arbitration metadata carried in
  // the tags — the FST never sees it, so it must NOT bias which arm wins here
  // ("can you see the moon" must take the specific CanYouSeeThing arm over the
  // HIGH-tagged generic AreYouAbleTo catch-all). Cross-grammar ranking (fullParse)
  // applies priority via parseScore on the winner this returns.
  let best = null; let bestScore = -Infinity;
  for (const m of match(compiledNode, 0, fullCtx, 0, 0)) {
    if (m.end !== tokens.length) continue;
    const spec = m.specificity || 0;
    const cost = m.cost || 0;
    const score = spec - cost;
    if (!best || score > bestScore) {
      best = { entities: m.entities, subFields: m.subFields, specificity: spec, cost, priority: (m.entities && m.entities.priority) || '', score };
      bestScore = score;
    }
  }
  return best;
}

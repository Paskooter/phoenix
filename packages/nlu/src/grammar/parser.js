// .rule DSL parser. Walks the token stream from lexer.js and builds an AST
// per rule. Output: { directives: [...], rules: { name: AstNode, ... } }.
//
// AST node kinds (all `{type, ...fields, tags?}`):
//   alt    — { type:'alt', alts: AstNode[] }                — `A | B | C`
//   seq    — { type:'seq', items: AstNode[] }               — `A B C`
//   opt    — { type:'opt', item: AstNode }                  — `?A`
//   lit    — { type:'lit', word: string }                   — bareword like "time"
//   heuristic — { type:'heuristic', value: number }         — persistent `<N>`
//   star   — { type:'star', max?: number }                  — `$*` or `$wNN`
//   plus   — { type:'plus', item: AstNode }                 — native `+X`
//   ref    — { type:'ref', name, prefix?: 'factory'|'handle' }  — `$Rule`, `$factory:X`
//   class  — { type:'class', body }                         — `[salutation?s]` → 'salutation'|'salutations'
//
// Every node may carry `.tags` — an array of {key, kind:'lit'|'subfield',
// value, subRule?, subField?} entity-assignment specs that fire when the
// node matches. Tags are attached during parsing per `{key=...}` blocks
// that immediately follow an item/group.

import { lex } from './lexer.js';

// `[...]` is the native bracket group (compiler.ypp
// `brackets_and_charrulecontent`). A body made purely of character-class atoms
// (`[day?s]`, `[(time)]`, `[georgia]`) keeps the `class` node whose word
// variants the matcher expands with expandCharClass. A body that also carries
// rule references, tag blocks or kleene/plus operators — as in the factory
// grammars (`[$digit{_nl=digit._nl} *$digit{_nl+=digit._nl}]`) — is a general
// group, so the raw body is re-parsed as an ordinary expression. The predicate
// was checked against every bundled rule: all 5 183 existing bracket bodies are
// pure character classes, so this split changes nothing for the
// already-supported grammars.
const SIMPLE_CLASS_BODY = /^[^$*+{}]*$/;

export function parse(source) {
  const tokens = lex(source);
  let pos = 0;
  const peek = (k = 0) => tokens[pos + k];
  const eat = (kind) => {
    const t = tokens[pos];
    if (t.kind !== kind) throw new Error(`parser: expected ${kind} got ${t.kind} (${t.value}) at ${t.line}:${t.col}`);
    pos += 1;
    return t;
  };

  const out = { directives: [], rules: {} };

  while (peek().kind !== 'EOF') {
    if (peek().kind === 'DIRECTIVE') { out.directives.push(peek().value); pos += 1; continue; }
    // Rule: Identifier = Expression ;
    const nameTok = eat('ID');
    // Native also admits the bracket rule form `Name [ charrule ];`
    // (compiler.ypp `rule: rulename brackets_and_charrulecontent ';'`, used by
    // the factory grammars: `digit [ 0{_nl='0'} | ... ];`, `number [ ... ];`).
    if (peek().kind === 'CHARCLASS') {
      out.rules[nameTok.value] = parseAtom();
      eat('SEMI');
      continue;
    }
    eat('EQ');
    const body = parseExpr();
    eat('SEMI');
    out.rules[nameTok.value] = body;
  }
  return out;

  // ---- expression grammar ----
  // The `.rule` DSL binds `|` tighter than sequence — opposite of standard
  // regex/BNF. So `do i|we|you have` parses as `do (i|we|you) have`, not
  // `(do i)|(we)|(you have)`. Patterns throughout the on-robot launch rules
  // rely on this: e.g. `(what time is|will $w03 show ?be $w03 on)` is
  // `what time (is|will) $w03 show ?be $w03 on`, and
  // `(?$V_CANYOU get|give|access)` is `?$V_CANYOU (get|give|access)`.
  // Reading these with alt < seq drops most of the meaningful match.
  //
  // Expression  = SeqExpr
  // SeqExpr     = AltItem+
  // AltItem     = Item ('|' Item)*       (alt of single items — tight binding)
  // Item        = ['?'] Atom Tags?
  // Atom        = '(' Expression ')' | RULEREF | STAR | STRING | ID | CHARCLASS
  // Tags        = '{' Tag '}' ('{' Tag '}')*
  // Tag         = ID '=' (STRING | (ID '.' ID))

  function parseExpr() { return parseSeq(); }

  function parseAlt() {
    // Tight alternation: each alt arm is a single item (with optional tags),
    // NOT a full seq. To express "loose" alt across whole sequences, the
    // author must use explicit parens: `(A B) | (C D)`.
    const left = parseItem();
    if (peek().kind !== 'PIPE') return left;
    const alts = [left];
    while (peek().kind === 'PIPE') {
      pos += 1;
      alts.push(parseItem());
    }
    return { type: 'alt', alts };
  }

  function parseSeq() {
    // Each seq element is itself an AltItem (tight `X|Y|Z` chain) so that
    // `A B|C D` parses as `A (B|C) D`, not `(A B)|(C D)`.
    const items = [];
    while (canStartItem(peek())) items.push(parseAlt());
    if (items.length === 0) throw new Error(`parser: empty sequence at ${peek().line}:${peek().col}`);
    if (items.length === 1) return items[0];
    // `(X Y {tag=X._field})` — the trailing tag block on the LAST item is
    // semantically a group tag in the cloud's FST: it fires at the end of the
    // sequence with visibility into every prior item's subFields. We model this
    // by hoisting the last item's trailing tags up to the seq node, where the
    // matcher applies them against accumulated subFields after the full match.
    // Tags on non-last items stay local (e.g. `$X {a=b} $Y`).
    const seq = { type: 'seq', items };
    const last = items[items.length - 1];
    if (last.tags && last.tags.length) {
      seq.tags = last.tags;
      delete last.tags;
    }
    return seq;
  }
  function canStartItem(t) {
    return t.kind === 'ID' || t.kind === 'STRING' || t.kind === 'LPAREN' ||
           t.kind === 'RULEREF' || t.kind === 'STAR' || t.kind === 'PLUS' || t.kind === 'CHARCLASS' ||
           t.kind === 'QMARK' || t.kind === 'KLEENE' || t.kind === 'WEIGHT';
  }

  function parseItem() {
    // `<N>` is a compiler heuristic-per-character state marker, not an arc
    // cost. The native grammar emits HEURISTIC_PER_CHAR_ELTYPE for this token
    // (compiler.ypp:153-154); fixed arc weights use `~N` instead. Keep the
    // marker as an AST item so the matcher can carry it across words, groups,
    // and inlined rule references until another marker changes it.
    if (peek().kind === 'WEIGHT') {
      const t = peek();
      pos += 1;
      return { type: 'heuristic', value: t.value };
    }
    let cost = 0;
    // Native rulecontent is recursive on all unary operators (`?`, `*`,
    // `+`), so prefixes can be nested and can occur in either order. Keep
    // their source order and wrap the atom from the inside out below. The
    // earlier one-optional/one-plus parser rejected valid forms such as
    // `+?a` and `++a` before the matcher could apply their source semantics.
    const prefixes = [];
    while (peek().kind === 'QMARK' || peek().kind === 'PLUS' || peek().kind === 'KLEENE') {
      prefixes.push(peek().kind);
      pos += 1;
    }
    const atom = parseAtom();
    // Consume any consecutive entity-tag blocks attached to this item: both the
    // FST `{key=value}` form and the `{% key='value' %}` semantic-action form.
    // Trailing TILDE (`(...)~2.5`) blocks may interleave with tags.
    const tags = [];
    for (;;) {
      const k = peek().kind;
      if (k === 'LBRACE') { tags.push(...parseTagBlock()); continue; }
      if (k === 'ACTION') { tags.push(...parseActionBlock(eat('ACTION').value)); continue; }
      if (k === 'TILDE') { cost += peek().value; pos += 1; continue; }   // `~N` is postfix
      break;
    }
    // A native plus operator owns the following rule content and its trailing
    // semantic action. Keep tags on the repeated node so `_parsed` represents
    // the whole repetition rather than only its final word.
    if (tags.length) atom.tags = (atom.tags || []).concat(tags);
    let node = atom;
    for (let index = prefixes.length - 1; index >= 0; index -= 1) {
      if (prefixes[index] === 'QMARK') {
        node = { type: 'opt', item: node };
        continue;
      }
      if (prefixes[index] === 'KLEENE') {
        // Native `*X` (add_kleene) is a zero-or-more repetition of the
        // following rule content, distinct from the `$*` wildcard atom.
        const outerTags = node.tags;
        const outerCost = node.cost;
        if (outerTags) delete node.tags;
        if (outerCost) delete node.cost;
        node = { type: 'kleene', item: node };
        if (outerTags) node.tags = outerTags;
        if (outerCost) node.cost = outerCost;
        continue;
      }
      // Move tags/cost from the operand onto each enclosing repetition. This
      // is the source shape for `+$w {tag=...}`; an action after a plus
      // applies after the repeated content has matched. Applying this while
      // walking nested prefixes preserves the distinct scopes of `+?a` and
      // `?+a`: the former leaves the tag on the nullable operand, while the
      // latter attaches it to the inner plus.
      const outerTags = node.tags;
      const outerCost = node.cost;
      if (outerTags) delete node.tags;
      if (outerCost) delete node.cost;
      node = { type: 'plus', item: node };
      if (outerTags) node.tags = outerTags;
      if (outerCost) node.cost = outerCost;
    }
    if (cost) node.cost = (node.cost || 0) + cost;
    return node;
  }

  // `[...]` is the native bracket group (compiler.ypp
  // `brackets_and_charrulecontent`). See SIMPLE_CLASS_BODY above.
  function bracketAtom(body) {
    if (SIMPLE_CLASS_BODY.test(body)) return { type: 'class', body };
    return parse(`TopRule = (${body});`).rules.TopRule;
  }

  function parseAtom() {
    const t = peek();
    if (t.kind === 'LPAREN') {
      pos += 1;
      const e = parseExpr();
      eat('RPAREN');
      return e;
    }
    if (t.kind === 'RULEREF') {
      pos += 1;
      return t.prefix
        ? { type: 'ref', name: t.value, prefix: t.prefix }
        : { type: 'ref', name: t.value };
    }
    if (t.kind === 'STAR') { pos += 1; return t.max != null ? { type: 'star', max: t.max } : { type: 'star' }; }
    if (t.kind === 'STRING') { pos += 1; return { type: 'lit', word: t.value }; }
    if (t.kind === 'ID') { pos += 1; return { type: 'lit', word: t.value }; }
    if (t.kind === 'CHARCLASS') { pos += 1; return bracketAtom(t.value); }
    throw new Error(`parser: unexpected ${t.kind} (${t.value}) at ${t.line}:${t.col}`);
  }

  // Parse a `{% ... %}` semantic-action body into the same tag specs the FST
  // `{key=value}` blocks produce. Supported statement forms (the only ones the
  // launch grammars use), `;`-separated:
  //   key = 'literal'        → lit tag
  //   key = this._parsed     → parsed tag (value = the text this node matched)
  //   key = Sub._field       → subfield tag (read a sub-rule's private field)
  //   key = bareword         → lit tag (treated as a literal string)
  // Keys starting with `_` stay private (propagate via subFields), same as the
  // FST tags. Unparseable statements are skipped rather than throwing — a single
  // exotic action shouldn't break a whole grammar.
  function parseActionBlock(body) {
    const tags = [];
    for (const raw of String(body).split(';')) {
      const stmt = raw.trim();
      if (!stmt) continue;
      const m = stmt.match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/);
      if (!m) continue;
      const key = m[1];
      let rhs = m[2].trim();
      if (/^'.*'$/.test(rhs) || /^".*"$/.test(rhs)) {
        // The native action parser trims semantic-action literals. A few
        // source rules carry an incidental space before the closing quote
        // (for example `whyDidJiboAction ` and `JiboBirth `); preserving that
        // source formatting changes the public intent/entity value.
        tags.push({ key, op: 'set', kind: 'lit', value: rhs.slice(1, -1).trim() });
      } else if (rhs === 'this._parsed' || rhs === 'this.parsed') {
        tags.push({ key, op: 'set', kind: 'parsed' });
      } else {
        const dot = rhs.indexOf('.');
        if (dot >= 0 && !rhs.startsWith('this.')) {
          tags.push({ key, op: 'set', kind: 'subfield', subRule: rhs.slice(0, dot), subField: rhs.slice(dot + 1) });
        } else if (/^[A-Za-z_][\w]*$/.test(rhs)) {
          tags.push({ key, op: 'set', kind: 'lit', value: rhs });
        }
        // anything else (computed expressions) — skip
      }
    }
    return tags;
  }

  // `{key=value}{key2=value2}` — one tag-block per call, returns the list
  // of `{key,...}` specs (one block can hold multiple key=value pairs in
  // some dialects; the on-robot rules consistently use one pair per block).
  // `op` distinguishes `=` (set) from `+=` (append). Append concatenates the
  // value onto whatever the key already holds in the same scope (private
  // subFields or public entities), matching standard tag semantics.
  function parseTagBlock() {
    eat('LBRACE');
    const tags = [];
    while (peek().kind !== 'RBRACE') {
      const key = eat('ID').value;
      let op = 'set';
      if (peek().kind === 'PLUSEQ') { pos += 1; op = 'append'; }
      else eat('EQ');
      // Value: STRING ('quoted'), or `SubRule._field` reference (single
      // ID token with embedded `.`, the lexer doesn't break on dots — we
      // split here). Tolerate either form.
      if (peek().kind === 'STRING') {
        tags.push({ key, op, kind: 'lit', value: eat('STRING').value });
      } else if (peek().kind === 'ID') {
        const raw = eat('ID').value;
        const dot = raw.indexOf('.');
        if (dot >= 0) {
          tags.push({ key, op, kind: 'subfield', subRule: raw.slice(0, dot), subField: raw.slice(dot + 1) });
        } else if (raw === '_parsed') {
          // Native `nl_right` accepts a VARIABLE_OR_RULENAME, and the
          // interpreter seeds the reserved `_parsed` variable with the current
          // rule's accumulated matched text (parser/interpreter.cpp:33,
          // 90-95, 138-147). `{key=_parsed}` therefore assigns that text — the
          // same value as `{% key = this._parsed %}` — never the literal
          // string "_parsed".
          tags.push({ key, op, kind: 'parsed' });
        } else {
          // Bare identifier as a value — treat as a literal string (rare).
          tags.push({ key, op, kind: 'lit', value: raw });
        }
      } else {
        throw new Error(`parser: tag value expected at ${peek().line}:${peek().col}`);
      }
      if (peek().kind === 'COMMA') pos += 1;     // tolerate `{a=1,b=2}` if it ever appears
    }
    eat('RBRACE');
    return tags;
  }
}

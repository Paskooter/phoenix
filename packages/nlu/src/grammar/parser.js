// .rule DSL parser. Walks the token stream from lexer.js and builds an AST
// per rule. Output: { directives: [...], rules: { name: AstNode, ... } }.
//
// AST node kinds (all `{type, ...fields, tags?}`):
//   alt    — { type:'alt', alts: AstNode[] }                — `A | B | C`
//   seq    — { type:'seq', items: AstNode[] }               — `A B C`
//   opt    — { type:'opt', item: AstNode }                  — `?A`
//   lit    — { type:'lit', word: string }                   — bareword like "time"
//   star   — { type:'star', max?: number }                  — `$*` or `$wNN`
//   ref    — { type:'ref', name, prefix?: 'factory'|'handle' }  — `$Rule`, `$factory:X`
//   class  — { type:'class', body }                         — `[salutation?s]` → 'salutation'|'salutations'
//
// Every node may carry `.tags` — an array of {key, kind:'lit'|'subfield',
// value, subRule?, subField?} entity-assignment specs that fire when the
// node matches. Tags are attached during parsing per `{key=...}` blocks
// that immediately follow an item/group.

import { lex } from './lexer.js';

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
           t.kind === 'RULEREF' || t.kind === 'STAR' || t.kind === 'CHARCLASS' ||
           t.kind === 'QMARK' || t.kind === 'WEIGHT';
  }

  function parseItem() {
    // Leading FST weight blocks (`<0.4>(...)`) — cost onto this item.
    let cost = 0;
    while (peek().kind === 'WEIGHT') { cost += peek().value; pos += 1; }
    let optional = false;
    if (peek().kind === 'QMARK') { pos += 1; optional = true; }
    const atom = parseAtom();
    // Consume any consecutive entity-tag blocks attached to this item: both the
    // FST `{key=value}` form and the `{% key='value' %}` semantic-action form.
    // Trailing WEIGHT (`(...)​<0.0>`) and TILDE (`(...)~2.5`) blocks interleave
    // with tags in the wild — accept them in any order.
    const tags = [];
    for (;;) {
      const k = peek().kind;
      if (k === 'LBRACE') { tags.push(...parseTagBlock()); continue; }
      if (k === 'ACTION') { tags.push(...parseActionBlock(eat('ACTION').value)); continue; }
      if (k === 'TILDE') { cost += peek().value; pos += 1; continue; }   // `~N` is postfix
      if (k === 'WEIGHT') {
        // `<W>` is an ENTRY weight for the item that follows it (`<1.0>+$w<0.0>`
        // weights the $w, not the preceding optional). Only consume it as a
        // trailing/exit weight when no item follows (end of group/alternative);
        // otherwise leave it for the next parseItem's leading-weight loop.
        if (canStartItem(peek(1)) && peek(1).kind !== 'WEIGHT') break;
        cost += peek().value; pos += 1; continue;
      }
      break;
    }
    if (tags.length) atom.tags = (atom.tags || []).concat(tags);
    const node = optional ? { type: 'opt', item: atom } : atom;
    if (cost) node.cost = (node.cost || 0) + cost;
    return node;
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
    if (t.kind === 'CHARCLASS') { pos += 1; return { type: 'class', body: t.value }; }
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
        tags.push({ key, op: 'set', kind: 'lit', value: rhs.slice(1, -1) });
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

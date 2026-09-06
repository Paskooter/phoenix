import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';

test('wildcard arbitration follows native byte cost when token counts tie', () => {
  // Archived grm2fst + parse, native source 91b1bb6 / Pegasus 5c0a739:
  // both arms consume two wildcard words, but "huge x" costs fewer bytes
  // than "i enormous". The native winner is long_literals. This control
  // deliberately uses no explicit weights, factories, or equal-cost tie.
  const grammar = parse("TopRule = (($* huge x){intent='short_literals'}|(i enormous $*){intent='long_literals'});");
  const result = matchRule(grammar.rules.TopRule, tokenize('i enormous huge x'), { rules: grammar.rules });
  assert.equal(result.entities.intent, 'long_literals');
});

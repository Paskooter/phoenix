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

test('a w03 c still beats a * c on input a one c', () => {
  // Root rejected 700e40c for flipping this native-confirmed contrast from
  // w03 to star. Launch-union scoring must not change intra-grammar wildcard
  // ranking. Native and the accepted AST baseline both select w03.
  const grammar = parse("TopRule = ((a $w03 c){% intent='w03' %}|(a $* c){% intent='star' %});");
  const result = matchRule(grammar.rules.TopRule, tokenize('a one c'), { rules: grammar.rules });
  assert.equal(result.entities.intent, 'w03');
});

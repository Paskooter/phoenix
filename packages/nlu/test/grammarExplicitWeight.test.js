import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';

function run(grammar, input) {
  const ast = parse(grammar);
  return matchRule(ast.rules.TopRule, tokenize(input), { rules: ast.rules });
}

test('explicit heuristic markers charge every word byte and separator', () => {
  const result = run("TopRule = (<1.0>alpha beta<0.0>){intent='weighted'};", 'alpha beta');
  assert.equal(result.entities.intent, 'weighted');
  // Native initialize_input_symbols retains one SPACE_WS arc per word. The
  // source input therefore has 6 + 5 bytes under <1.0>.
  assert.equal(result.cost, 11);
});

test('heuristic markers cross groups and referenced rules until reset', () => {
  const grouped = run("TopRule = (<1.0>(alpha beta)<0.0>){intent='grouped'};", 'alpha beta');
  assert.equal(grouped.cost, 11);

  const referenced = run("SUB = (alpha beta); TopRule = (<1.0>$SUB<0.0>){intent='ref'};", 'alpha beta');
  assert.equal(referenced.cost, 11);

  const reset = run("TopRule = (<1.0>alpha<0.0> beta){intent='reset'};", 'alpha beta');
  assert.equal(reset.cost, 6);
});

test('heuristic markers persist through a referenced rule and explicit reset clears them', () => {
  const carried = run("SUB = (<1.0>alpha); TopRule = ($SUB beta){intent='carried'};", 'alpha beta');
  assert.equal(carried.cost, 11);

  const cleared = run("SUB = (<1.0>alpha<0.0>); TopRule = ($SUB beta){intent='cleared'};", 'alpha beta');
  assert.equal(cleared.cost, 6);
});

test('generated wildcard arbitration sees explicit per-character weight', () => {
  const result = run(
    "TopRule = (($* alpha){intent='wild'}|(<1.0>one alpha<0.0>){intent='weighted'});",
    'one alpha',
  );
  assert.equal(result.entities.intent, 'wild');
});

test('bounded generated wildcard resets its enclosing heuristic before later words', () => {
  const result = run("TopRule = (<2.0>$w03 beta){intent='bounded'};", 'one two beta');
  // The established wildcard adapter counts the two wildcard words' bytes;
  // beta is unweighted because the generated $w03 ends with <0.0>.
  assert.equal(result.cost, 6);
});

test('base word wildcard inherits explicit state but has no internal reset', () => {
  const inherited = run("TopRule = (<2.0>$w beta){intent='word_inherits'};", 'one beta');
  // compiler.cpp builds $w from one nonblank-word body plus SPACE_WS. Its
  // state is inherited by the following beta because only $*/$wNN add the
  // generated <0.0> reset.
  assert.equal(inherited.cost, 18);

  const reset = run("TopRule = (<2.0>$w<0.0> beta){intent='word_reset'};", 'one beta');
  assert.equal(reset.cost, 8);

  const fractional = run("TopRule = (<0.4>$w<0.0> beta){intent='word_fraction'};", 'one beta');
  assert.equal(fractional.cost, 1.6);

  // The source $w rule has a mandatory separator after its nonblank-word
  // body, so it consumes one word; it is not the three-word legacy fallback.
  assert.equal(run("TopRule = (<2.0>$w){intent='word_only'};", 'one two'), null);

  // An unresolved application-specific reference keeps the old bounded
  // adapter; the `$w` source special case must not retag every `$name`.
  const unknown = run("TopRule = (<2.0>$made_up beta){intent='unknown'};", 'one two beta');
  assert.equal(unknown.cost, 16);
});

test('base word wildcard requires its source nonblank body', () => {
  assert.equal(run("TopRule = (<2.0>$w beta){intent='weighted_empty'};", 'beta'), null);
  assert.equal(run("TopRule = (<0.0>$w beta){intent='reset_empty'};", 'beta'), null);
  assert.equal(run("TopRule = ($w beta){intent='default_empty'};", 'beta'), null);
});

test('an empty base word wildcard cannot shadow a competing literal arm', () => {
  const result = run("TopRule = (($w beta){intent='word'}|(beta){intent='plain'});", 'beta');
  assert.equal(result.entities.intent, 'plain');
});

test('tilde remains a fixed arc cost, separate from per-character markers', () => {
  const result = run("TopRule = (alpha~2 beta){intent='fixed'};", 'alpha beta');
  assert.equal(result.entities.intent, 'fixed');
  assert.equal(result.cost, 2);
});

test('compile-order heuristic state crosses alternatives and references until reset', () => {
  const altLeak = run("TopRule = ((<1.0>alpha){intent='weighted'}|(beta){intent='plain'});", 'beta');
  assert.equal(altLeak.cost, 5);

  const altReset = run("TopRule = ((<1.0>alpha<0.0>){intent='weighted'}|(beta){intent='plain'});", 'beta');
  assert.equal(altReset.cost, 0);

  const refLeak = run("SUB = (<1.0>alpha); TopRule = (($SUB)|beta){intent='ref_leak'};", 'beta');
  assert.equal(refLeak.cost, 5);
});

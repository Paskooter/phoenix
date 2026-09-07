import test from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';

function run(grammar, input) {
  const ast = parse(grammar);
  return matchRule(ast.rules.TopRule, tokenize(input), { rules: ast.rules });
}

test('nested and nullable plus forms match one native epsilon repetition without looping', () => {
  const plusOptional = "TopRule = (+?a){intent='plus_optional'};";
  assert.equal(run(plusOptional, '').entities.intent, 'plus_optional');
  assert.equal(run(plusOptional, 'a').entities.intent, 'plus_optional');
  assert.equal(run(plusOptional, 'a a').entities.intent, 'plus_optional');
  assert.equal(run(plusOptional, 'b'), null);

  const optionalPlus = "TopRule = (?+a){intent='optional_plus'};";
  assert.equal(run(optionalPlus, '').entities.intent, 'optional_plus');
  assert.equal(run(optionalPlus, 'a a').entities.intent, 'optional_plus');

  const nested = "TopRule = (++a){intent='nested'};";
  assert.equal(run(nested, 'a a').entities.intent, 'nested');
  assert.equal(run(nested, ''), null);

  const nullableWildcard = "TopRule = (+$*) b{intent='wildcard_suffix'};";
  assert.equal(run(nullableWildcard, 'b').entities.intent, 'wildcard_suffix');
  assert.equal(run(nullableWildcard, 'a a b').entities.intent, 'wildcard_suffix');
});

test('nullable plus keeps operand and outer tag scope distinct', () => {
  const operandTag = "TopRule = +?a{seen='operand'};";
  assert.deepEqual(run(operandTag, '').entities, {});
  assert.deepEqual(run(operandTag, 'a').entities, { seen: 'operand' });

  const outerTag = "TopRule = (+?a){intent='outer'};";
  assert.deepEqual(run(outerTag, '').entities, { intent: 'outer' });
  assert.deepEqual(run(outerTag, 'a a').entities, { intent: 'outer' });

  const nestedOperandTag = "TopRule = (+(a){seen='inner'}){intent='outer'};";
  assert.deepEqual(run(nestedOperandTag, 'a a').entities, { seen: 'inner', intent: 'outer' });
});

test('repeated grouped operands preserve suffix, tags, and postfix cost', () => {
  const grouped = "TopRule = (+(ha ho){seen='pair'}~2){intent='grouped'};";
  assert.deepEqual(run(grouped, 'ha ho ha ho').entities, { seen: 'pair', intent: 'grouped' });
  assert.equal(run(grouped, 'ha ho ha'), null);

  const suffix = "TopRule = (+a b){intent='suffix'};";
  assert.equal(run(suffix, 'a a b').entities.intent, 'suffix');
  assert.equal(run(suffix, 'a'), null);
});

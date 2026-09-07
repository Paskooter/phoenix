import test from 'node:test';
import assert from 'node:assert/strict';

import { lex } from '../src/grammar/lexer.js';
import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';

function run(grammar, input) {
  const ast = parse(grammar);
  return matchRule(ast.rules.TopRule, tokenize(input), { rules: ast.rules });
}

test('the lexer and parser preserve native plus-kleene syntax', () => {
  const tokens = lex("TopRule = (+$w beta){intent='plus'};");
  assert.deepEqual(tokens.map(({ kind, value }) => ({ kind, value })), [
    { kind: 'ID', value: 'TopRule' },
    { kind: 'EQ', value: '=' },
    { kind: 'LPAREN', value: '(' },
    { kind: 'PLUS', value: '+' },
    { kind: 'RULEREF', value: 'w' },
    { kind: 'ID', value: 'beta' },
    { kind: 'RPAREN', value: ')' },
    { kind: 'LBRACE', value: '{' },
    { kind: 'ID', value: 'intent' },
    { kind: 'EQ', value: '=' },
    { kind: 'STRING', value: 'plus' },
    { kind: 'RBRACE', value: '}' },
    { kind: 'SEMI', value: ';' },
    { kind: 'EOF', value: null },
  ]);

  const ast = parse("TopRule = (+$w beta){intent='plus'};");
  assert.equal(ast.rules.TopRule.type, 'seq');
  assert.equal(ast.rules.TopRule.items[0].type, 'plus');
  assert.equal(ast.rules.TopRule.items[0].item.type, 'ref');
  assert.equal(ast.rules.TopRule.items[0].item.name, 'w');
});

test('plain $w remains one mandatory word while +$w repeats one or more words', () => {
  const plain = "TopRule = ($w beta){intent='plain'};";
  assert.equal(run(plain, 'beta'), null);
  assert.equal(run(plain, 'one beta').entities.intent, 'plain');
  assert.equal(run(plain, 'one two beta'), null);

  const repeated = "TopRule = (+$w beta){intent='plus'};";
  assert.equal(run(repeated, 'beta'), null);
  assert.equal(run(repeated, 'one beta').entities.intent, 'plus');
  assert.equal(run(repeated, 'one two beta').entities.intent, 'plus');
  assert.equal(run(repeated, 'one two three beta').entities.intent, 'plus');
});

test('plus repeats a literal or grouped sequence and never accepts a zero-length arm', () => {
  const literal = "TopRule = (+ha){intent='ha'};";
  assert.equal(run(literal, 'ha').entities.intent, 'ha');
  assert.equal(run(literal, 'ha ha').entities.intent, 'ha');
  assert.equal(run(literal, 'ha ha ha').entities.intent, 'ha');
  assert.equal(run(literal, ''), null);
  assert.equal(run(literal, 'ha ho'), null);

  const group = "TopRule = (+(ha ho)){intent='pair'};";
  assert.equal(run(group, 'ha ho').entities.intent, 'pair');
  assert.equal(run(group, 'ha ho ha ho').entities.intent, 'pair');
  assert.equal(run(group, 'ha'), null);
});

test('weighted +$w keeps the explicit heuristic over each repetition and resets after it', () => {
  const grammar = "TopRule = (<1.0>+$w<0.0> beta){intent='weighted'};";
  const result = run(grammar, 'one two beta');
  assert.equal(result.entities.intent, 'weighted');
  // one and two each contribute their three bytes plus the native trailing
  // SPACE_WS byte; beta follows the explicit reset.
  assert.equal(result.cost, 8);
});

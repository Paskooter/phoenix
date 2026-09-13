import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';

const timeSource = readFileSync(new URL('../resources/factory-sources/time.grm', import.meta.url), 'utf8');

test('recovered time factory parses numeric clock punctuation and executes source actions', () => {
  const ast = parse(timeSource);
  const match = matchRule(ast.rules.TopRule, tokenize('5:30 pm'), { rules: ast.rules });

  assert.deepEqual(tokenize('5:30 pm'), ['5', ':', '3', '0', 'pm']);
  assert.equal(match.subFields._time_time, '05:30');
  assert.equal(match.subFields._time_ampm, 'PM');
  assert.equal(match.subFields._time_rel, 'null');
});

test('semantic action evaluator handles computed fields, conditionals, concat, and delete', () => {
  const ast = parse(`
    TopRule = (hello){%
      this.base = '1';
      this.value = parseInt(this.base) + 1;
      this.text = '0'.concat(this.value);
      if (this.value == 2) {this.result = 'ok'}
      delete this.base
    %};
  `);
  const match = matchRule(ast.rules.TopRule, tokenize('hello'), { rules: ast.rules });

  assert.equal(match.subFields.value, 2);
  assert.equal(match.subFields.text, '02');
  assert.equal(match.subFields.result, 'ok');
  assert.equal(Object.prototype.hasOwnProperty.call(match.subFields, 'base'), false);
});

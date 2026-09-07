import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/grammar/parser.js';
import { matchRule, tokenize } from '../src/grammar/matcher.js';

// The pinned public parser trims in ParseRequestHandler, lowercases in
// RobustParserClient, and the native parser then consumes the remaining bytes.
// Apostrophe presence is therefore a source-visible part of a word token.
test('apostrophes remain source-visible in public parser tokens', () => {
  assert.deepEqual(tokenize("We're"), ["we're"]);
  assert.deepEqual(tokenize('were'), ['were']);
  assert.deepEqual(tokenize('we’re'), ['we’re']);
});

test('a character rule with an explicit apostrophe rejects its unpunctuated spelling', () => {
  const grammar = "TopRule = ([(we?(\\'re))]) {% intent='apostrophe' %};";
  const ast = parse(grammar);
  const context = { rules: ast.rules };
  const withApostrophe = matchRule(ast.rules.TopRule, tokenize("we're"), context);
  const withoutApostrophe = matchRule(ast.rules.TopRule, tokenize('were'), context);
  assert.equal(withApostrophe.entities.intent, 'apostrophe');
  assert.equal(withoutApostrophe, null);
});

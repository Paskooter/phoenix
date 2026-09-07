import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule } from '../src/grammar/matcher.js';
import { loadEqWords } from '../src/grammar/eqWords.js';

// Observed with the archived native jibo-nlu 2.8.3 grm2fst/parse binaries.
// Prefix ? selects the next character or group inside [], not the rest of
// the word. Test both admitted words and rejected truncations.
const cases = [
  { body: 'me?et', accepted: ['met', 'meet'], rejected: ['me'] },
  { body: 'cat?s', accepted: ['cat', 'cats'], rejected: ['ca'] },
  { body: 'ab?cd', accepted: ['abd', 'abcd'], rejected: ['ab', 'abc'] },
  { body: 'ab?cde', accepted: ['abde', 'abcde'], rejected: ['ab', 'abe', 'abcd'] },
  { body: 'ab?(cd)e', accepted: ['abe', 'abcde'], rejected: ['ab', 'abde'] },
  { body: 'ab?(c|d)e', accepted: ['abe', 'abce', 'abde'], rejected: ['ab'] },
  // Native character grammar binds `|` to the immediately preceding item.
  // Thus the source form `g(ed)|(ing)` inside `bug(...)` is `g(ed|ing)`,
  // which admits both bugged and bugging.
  { body: 'bug(g(ed)|(ing))', accepted: ['bugged', 'bugging'], rejected: ['buging'] },
  { body: 'ab?éd', accepted: ['abd', 'abéd'], rejected: ['ab'] },
  { body: 'ab?😀d', accepted: ['abd', 'ab😀d'], rejected: ['ab'] },
];

for (const { body, accepted, rejected } of cases) {
  test(`native character-class optional scope: [${body}]`, () => {
    const rule = { type: 'class', body };
    for (const word of accepted) {
      assert.notEqual(matchRule(rule, [word], { rules: {} }), null, `accept ${word}`);
    }
    for (const word of rejected) {
      assert.equal(matchRule(rule, [word], { rules: {} }), null, `reject ${word}`);
    }
  });
}

test('character classes keep literal spelling when equivalence expansion is enabled', () => {
  const eq = loadEqWords();
  const context = { rules: {}, eq };

  // compiler.ypp sends a bare word through new_word_and_equivalents, but a
  // word inside [] through new_word.  The archived compiler therefore accepts
  // `george` for an ordinary `georgia` word and rejects it for `[georgia]`.
  assert.notEqual(matchRule({ type: 'lit', word: 'georgia' }, ['george'], context), null);
  assert.equal(matchRule({ type: 'class', body: 'georgia' }, ['george'], context), null);
  assert.notEqual(matchRule({ type: 'class', body: 'georgia' }, ['georgia'], context), null);

  // A plain parenthesized word inside [] is the separate native
  // new_word_and_equivalents production.  Expansion is local to that atom,
  // so suffixes and surrounding characters remain exact class content.
  assert.notEqual(matchRule({ type: 'class', body: '(time)' }, ['thyme'], context), null);
  assert.notEqual(matchRule({ type: 'class', body: '(time)s' }, ['thymes'], context), null);
  assert.notEqual(matchRule({ type: 'class', body: 'a(time)b' }, ['athymeb'], context), null);
  assert.equal(matchRule({ type: 'class', body: 't(i|y)me' }, ['thyme'], context), null);
});

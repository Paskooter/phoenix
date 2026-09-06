import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule } from '../src/grammar/matcher.js';

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

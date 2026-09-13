import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gqaBannedWordPresent } from '../src/gqaBannedWords.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/q01-banned-dictionary.json', import.meta.url), 'utf8'));

test('Q-01 archived blocked_dictionary_words.out rows replay against the banned-word matcher', () => {
  const expected = fixture.expectedBlockedWords;
  assert.equal(fixture.sourceRevision, 'ebe1a7d38f511570060c1fbf61bec89d58419b26');
  assert.equal(fixture.expectedBlockedCount, 344);
  const sourceOutput = `${expected.join('\n')}\n\n`;
  assert.equal(createHash('sha256').update(sourceOutput).digest('hex'), fixture.sourceOutputSha256);
  assert.equal(expected.length, fixture.expectedBlockedCount);
  assert.deepEqual(expected, [...expected].sort(), 'archived output must remain lexically ordered');
  assert.equal(new Set(expected).size, expected.length, 'archived output must contain no duplicate rows');

  const actual = expected.filter((word) => gqaBannedWordPresent(word));
  assert.deepEqual(actual, expected, 'every archived dictionary output row must remain blocked');
  assert.equal(expected[0], 'apeshit');
  assert.equal(expected.at(-1), 'whoresons');
});

test('Q-01 blocked dictionary fixture has a mutation falsifier', () => {
  const expected = fixture.expectedBlockedWords;
  const mutated = [...expected];
  mutated[0] = 'ordinary';
  const replayed = mutated.filter((word) => gqaBannedWordPresent(word));
  assert.notDeepEqual(replayed, expected, 'changing one expected output row must be observable');
  assert.equal(gqaBannedWordPresent('ordinary'), false);
});

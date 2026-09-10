// N-01 acceptance 2: "Inventory and import every required named rule and
// dependency with hashes; do not silently skip parse/load failures."
//
// The `$factory:` word lists are matcher dependencies. The request parser must
// build them from the inventory-declared, hash-verified entries only, and must
// refuse an undeclared file in the bundled directory (which would otherwise
// join the matcher vocabulary with no hash anchor at all).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildFactoryWords, loadFactoryWords, undeclaredFactoryWordFile } from '../src/grammar/factoryWords.js';
import { ruleInventory } from '../src/requestParser.js';

const resources = new URL('../resources/', import.meta.url);
const inventory = JSON.parse(readFileSync(new URL('rule-inventory.json', resources)));
const declaredWordLists = Object.entries(inventory.supporting)
  .filter(([name]) => name.startsWith('factory-words/'))
  .map(([name, entry]) => [name.slice('factory-words/'.length), entry.path.replace(/^factory-words\//, '')])
  .sort();

test('the bundled factory word directory is fully declared by the inventory', () => {
  const actual = readdirSync(new URL('factory-words/', resources));
  assert.equal(undeclaredFactoryWordFile(declaredWordLists.map(([name]) => name), actual), null);
  assert.deepEqual(declaredWordLists.map(([, file]) => file).sort(), [...actual].sort());
  assert.equal(ruleInventory().factoryWordCount, declaredWordLists.length);
});

test('an undeclared bundled word list is refused, not imported', () => {
  assert.equal(undeclaredFactoryWordFile(['country', 'state'], ['country.txt', 'state.txt']), null);
  assert.equal(undeclaredFactoryWordFile(['country'], ['country.txt', 'smuggled.txt']), 'smuggled.txt');
  // Dotfiles and non-.txt files are not word lists.
  assert.equal(undeclaredFactoryWordFile(['country'], ['country.txt', '.DS_Store', 'README.md']), null);
});

test('verified word-list content builds the same index as the bundled files', () => {
  const verified = buildFactoryWords(declaredWordLists.map(([name, file]) => ({
    name,
    text: readFileSync(new URL(`factory-words/${file}`, resources), 'utf8'),
  })));
  const bundled = loadFactoryWords();
  assert.deepEqual([...verified.keys()].sort(), [...bundled.keys()].sort());
  for (const [name, index] of bundled) {
    assert.deepEqual([...verified.get(name).keys()].sort(), [...index.keys()].sort());
  }
  // $factory:first_name must still resolve to real name phrases for the matcher.
  assert.ok(verified.get('first_name').get('jane')?.some(phrase => phrase.join(' ') === 'jane'));
});

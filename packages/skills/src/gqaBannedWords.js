// srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26
// gqa/banned_words.py: preserve its whitelist, partial matches and repeated
// whole-word matches. Python's word boundaries include Unicode letters and
// numbers; JavaScript's built-in \b would falsely split those words.
import { readFileSync } from 'node:fs';

const source = JSON.parse(readFileSync(new URL('../resources/gqa/banned_words.json', import.meta.url), 'utf8'));
const word = '[\\p{L}\\p{N}_]';
const before = `(?<!${word})`;
const after = `(?!${word})`;
const whitelist = source.WHITELIST.map(pattern => new RegExp(`${before}(?:${pattern})${after}`, 'gu'));
const banned = new RegExp(
  `${before}(?:${source.WHOLE_WORD_MATCH_LIST.join('|')})+${after}|${source.PARTIAL_WORD_MATCH_LIST.join('|')}`,
  'u',
);

export function gqaBannedWordPresent(text) {
  let value = text.toLowerCase();
  for (const pattern of whitelist) value = value.replace(pattern, '_');
  return banned.test(value);
}

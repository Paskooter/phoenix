import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpinionNews } from '../src/newsEditorial.js';

test('rejects explicit opinion/editorial labels without depending on publisher', () => {
  for (const title of [
    'Opinion: A new policy', 'OP-ED — What should happen next', 'Editorial | The budget',
    'A new policy | Opinion', 'The budget (Editorial)', 'Policy changes [opinion]',
    'Commentary: Changing direction', 'Our View: The local vote', 'Guest essay: A personal account',
    'The FCC Targeting Disney is Another Trump Attack on Press Freedom | Opinion',
  ]) assert.equal(isOpinionNews({ title }), true, title);
  for (const article of [
    { url: 'https://fixture.test/opinion/a-story' },
    { url: 'https://fixture.test/news/%6fp-ed/a-story' },
    { url: 'https://fixture.test/editorials/2026/article.html' },
    { url: 'https://fixture.test/commentary/article' },
    { url: 'https://fixture.test/guest-essays/article' },
    { categories: ['politics', 'opinion'] }, { genre: 'Editorial' }, { tags: ['op-ed'] },
    { section: 'Commentary' }, { category: 'politics,opinion' },
  ]) assert.equal(isOpinionNews(article), true, JSON.stringify(article));
});

test('retains factual stories about court opinions, polling, and attributed statements', () => {
  for (const article of [
    { title: 'Supreme Court releases its opinion in a tax case', url: 'https://fixture.test/news/court-opinion-tax' },
    { title: 'Public opinion poll finds mixed views', tags: ['politics', 'public opinion'] },
    { title: 'Opinion polls show changes in support' },
    { title: 'An editorial board announces a new editor' },
    { title: 'Governor says the proposal would reduce costs', category: 'politics' },
    { title: 'Analysis: How the approved budget changes transit funding' },
    { title: 'Concrete bridge column repaired' },
  ]) assert.equal(isOpinionNews(article), false, JSON.stringify(article));
});

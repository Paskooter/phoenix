import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPreview } from './index.js';
const skill = JSON.parse(readFileSync(new URL('./skill.json', import.meta.url), 'utf8'));

test('greeting, page navigation and close work in the computer preview', () => {
  const preview = createPreview(skill);
  assert.equal(preview.start().id, 'welcome');
  assert.match(preview.tap(0).speech, /Hello, friend/);
  assert.equal(preview.tap(1).page.id, 'about');
  assert.equal(preview.tap(0).page.id, 'welcome');
  assert.equal(preview.tap(2).page, null);
  assert.equal(preview.stop(), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSlimFromMim as generateSlim, weightedSample, newMimState, buildPromptData, PromptCategory, PromptSubCategory } from '../src/index.js';

const QN_MIM = {
  mim_id: 'TestQN', mim_type: 'question', rule_name: 'global',
  prompts: [
    { prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 0, condition: '', prompt: 'Plain question?', weight: 1, prompt_id: 'q-plain' },
    { prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 0, condition: 'speaker && speaker.firstName', prompt: '${speaker.firstName}, question?', weight: 1, prompt_id: 'q-named' },
    { prompt_category: 'Errors', prompt_sub_category: 'NM', index: 0, condition: '', prompt: 'Try 0', weight: 1, prompt_id: 'nm0' },
    { prompt_category: 'Errors', prompt_sub_category: 'NM', index: 1, condition: '', prompt: 'Try 1', weight: 1, prompt_id: 'nm1' },
  ],
};

test('weightedSample is deterministic with an injected rng', () => {
  const items = [{ data: 'a', weight: 1 }, { data: 'b', weight: 3 }];
  assert.equal(weightedSample(items, () => 0.0), 'a'); // r=0 -> first
  assert.equal(weightedSample(items, () => 0.5), 'b'); // r=2 -> falls into b
});

test('condition filtering: named prompt excluded when no speaker, included with one', () => {
  const noSpeaker = generateSlim(QN_MIM, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.Q }, buildPromptData({}), { rng: () => 0 });
  assert.equal(noSpeaker.play.esml, 'Plain question?');
  assert.ok(noSpeaker.listen && noSpeaker.listen.rule === 'global', 'question MIM emits a listen');

  const withSpeaker = generateSlim(QN_MIM, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.Q },
    buildPromptData({ loop: { users: [{ id: 'u1', firstName: 'Pat' }] }, perception: { speaker: 'u1' } }), { rng: () => 0.99 });
  // both prompts valid; rng→0.99 picks the last (named); template resolves the name
  assert.equal(withSpeaker.play.esml, 'Pat, question?');
});

test('Errors index selects the matching NoMatch prompt', () => {
  const nm0 = generateSlim(QN_MIM, { category: PromptCategory.ERROR, subCategory: PromptSubCategory.NM, index: 0 }, buildPromptData({}), { rng: () => 0 });
  assert.equal(nm0.play.esml, 'Try 0');
  const nm1 = generateSlim(QN_MIM, { category: PromptCategory.ERROR, subCategory: PromptSubCategory.NM, index: 1 }, buildPromptData({}), { rng: () => 0 });
  assert.equal(nm1.play.esml, 'Try 1');
});

test('exhausted NoMatch index returns null and sets noMatchMax', () => {
  const mimState = newMimState();
  const r = generateSlim(QN_MIM, { category: PromptCategory.ERROR, subCategory: PromptSubCategory.NM, index: 5 }, buildPromptData({}), { mimState });
  assert.equal(r, null);
  assert.equal(mimState.noMatchMax, true);
});

test('play.meta carries prompt_id + mim_id', () => {
  const r = generateSlim(QN_MIM, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.Q }, buildPromptData({}), { rng: () => 0 });
  assert.equal(r.play.meta.mim_id, 'TestQN');
  assert.equal(r.play.meta.prompt_id, 'q-plain');
});

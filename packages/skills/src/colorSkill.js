// color-skill — a minimal two-turn GraphSkill, now MIM-driven via the Slimmer.
// AskColor: Slimmer picks an Entry-Core/Q prompt from color/qn.mim (named variant when a speaker
// is known) and emits a SLIM with a listen → final:false. ReplyColor: Slimmer renders the
// Entry-Core/AN prompt from color/an.mim with the answered color in PromptData → final:true.
// session.data {color, _mim} round-trips between turns.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGraphSkill } from './graph/graphSkill.js';
import { FnNode } from './graph/node.js';
import { buildJcpFromSlim } from './jcp.js';
import { generateSlimFromMim, newMimState, PromptCategory, PromptSubCategory } from './graph/mims/slimmer.js';
import { buildPromptData, loadMimFile } from './graph/mims/promptData.js';

const MIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'mims', 'color');
const qnMim = loadMimFile(join(MIM_DIR, 'qn.mim'));
const anMim = loadMimFile(join(MIM_DIR, 'an.mim'));

export const colorSkill = createGraphSkill({
  name: 'color-skill',
  build: (gm) => {
    const ask = gm.addNode(new FnNode('AskColor', {
      transitions: ['answered'],
      enter: (data) => {
        data.skill.session.data._mim = data.skill.session.data._mim || newMimState();
        const slim = generateSlimFromMim(qnMim, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.Q }, buildPromptData(data.runtime), { mimState: data.skill.session.data._mim, log: data.log });
        return { action: buildJcpFromSlim(slim), final: false };
      },
      exit: (data) => {
        const color = (((data.result && data.result.asr && data.result.asr.text) || '').trim()) || 'that';
        data.skill.session.data.color = color;
        return { transition: 'answered', result: { color } };
      },
    }));
    const reply = gm.addNode(new FnNode('ReplyColor', {
      enter: (data) => {
        const slim = generateSlimFromMim(anMim, { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.AN }, buildPromptData(data.runtime, { color: data.skill.session.data.color }), { log: data.log });
        return { action: buildJcpFromSlim(slim), final: true };
      },
    }));
    ask.addTransition('answered', reply);
    return ask;
  },
});

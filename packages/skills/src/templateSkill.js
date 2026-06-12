// template-skill — port of packages/template-skill: the minimal skeleton skill that validates
// its launch memo ({entry:'SomeThing'}), plays one announcement MIM via ANFactory, and exits.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGraphSkill } from './graph/graphSkill.js';
import { Graph } from './graph/graph.js';
import { NoOpNode, DefaultNode, DefaultTransition } from './graph/nodes.js';
import { ANFactory, ANFactoryTransition } from './graph/mims/factories.js';

const MIM_PATH = join(dirname(fileURLToPath(import.meta.url)), '../resources/mims/template/template-mim.mim');

const MemoSplitTransition = Object.freeze({ Reactive: 'Reactive' });

class MemoSplitNode extends NoOpNode {
  constructor(name) { super(name, Object.values(MemoSplitTransition)); }

  async exit(data) {
    const memo = data.result.memo && data.result.memo.entry;
    if (memo !== 'SomeThing') {
      throw new Error(`Template Skill launched with unknown memo: '${memo}'`);
    }
    return { transition: MemoSplitTransition.Reactive, result: data.result };
  }
}

const SkillTransition = Object.freeze({ Done: 'Done' });

function buildTemplateSkill(gm) {
  const g = new Graph(gm, 'TemplateSkill', Object.values(SkillTransition));

  const intentSplitNode = new MemoSplitNode('Intent Split');
  const completeNode = new DefaultNode('Complete');
  const doMIM = new ANFactory('Do MIM', { mimDataProvider: MIM_PATH }).createGraph(gm);

  g.addNode(intentSplitNode, [[MemoSplitTransition.Reactive, doMIM.initial]]);
  g.addSubGraph(doMIM, [[ANFactoryTransition.Success, completeNode]]);
  g.addNode(completeNode, [[DefaultTransition.Done, SkillTransition.Done]]);

  g.finalize();
  return g;
}

export const templateSkill = createGraphSkill({ name: 'template-skill', build: buildTemplateSkill });

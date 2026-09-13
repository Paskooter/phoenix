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

// MemoSplitNode's first source access is `data.result.memo`; the log line then reads
// `data.result.nlu.intent`. Node 8 reported a null/undefined intermediate receiver as
// "Cannot read property ... of ..." while current Node reports "Cannot read properties ...",
// and the original emitted the Node 8 wording on the cloud wire (the BaseSkill error
// envelope carries the raw message). Localize only these two precondition accesses; errors
// thrown by skill logic stay native.
function sourceResultMemo(data) {
  const result = data.result;
  if (result === null) throw new TypeError("Cannot read property 'memo' of null");
  if (result === undefined) throw new TypeError("Cannot read property 'memo' of undefined");
  return result.memo;
}

function sourceNluIntent(nlu) {
  if (nlu === null) throw new TypeError("Cannot read property 'intent' of null");
  if (nlu === undefined) throw new TypeError("Cannot read property 'intent' of undefined");
  return nlu.intent;
}

// The Phoenix service logger has no createChild (source nodes call data.log.createChild).
// Use the source child logger when the logger offers one, otherwise the logger itself.
function childLog(log, name) {
  return log && typeof log.createChild === 'function' ? log.createChild(name) : log;
}

class MemoSplitNode extends NoOpNode {
  constructor(name) { super(name, Object.values(MemoSplitTransition)); }

  async exit(data) {
    const log = childLog(data.log, 'MemoSplitNode');
    // This node expects to be the first one called so we expect there to be nlu in the data
    const memoField = sourceResultMemo(data);
    const memo = memoField && memoField.entry;
    const intent = sourceNluIntent(data.result.nlu);

    if (log && typeof log.info === 'function') {
      log.info(`Launching Template Skill with memo '${memo}' and intent '${intent}'`);
    }

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

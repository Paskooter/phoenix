// example-skill — port of packages/example-skill: the graph-traversal exerciser used by the
// reference behavior suite. Every ExampleNode speaks "SLIM: '<name>'" (+ MEMO when present) and
// listens, so each LISTEN_UPDATE walks one transition; IntentSplit honors memo before intent
// (proactive launches can't rely on NLU).

import { createGraphSkill } from './graph/graphSkill.js';
import { Graph } from './graph/graph.js';
import { Node } from './graph/node.js';
import { NoOpNode } from './graph/nodes.js';

// @jibo/utils test.TestIntents
const TestIntents = Object.freeze({
  DOES_LIKE: 'doesJiboLikeThing',
  DISLIKES: 'jiboDislikesThing',
  LIVE_AND_PROSPER: 'referenceLiveLongProsper',
});

const ExampleTransition = Object.freeze({ A: 'A', B: 'B' });

function createSlimAction(text) {
  return {
    type: 'JCP',
    config: {
      version: '2.0',
      jcp: {
        type: 'SLIM', id: 'FAKE_SLIM_ID',
        config: {
          play: { type: 'PLAY', id: 'FAKE_PLAY_ID', esml: text },
          listen: { type: 'LISTEN', id: 'FAKE_LISTEN_ID', contexts: [] },
        },
      },
    },
  };
}

class ExampleNode extends Node {
  constructor(name, transitioner) {
    super(name, Object.values(ExampleTransition));
    this.transitioner = transitioner;
  }

  async enter(data) {
    if (data.result && data.result.memo) {
      return { action: createSlimAction(`SLIM: '${this.name}' MEMO: '${data.result.memo}'`) };
    }
    return { action: createSlimAction(`SLIM: '${this.name}'`) };
  }

  async exit(data) {
    return { transition: this.transitioner(data) };
  }
}

const IntentSplitTransition = Object.freeze({
  DOES_LIKE: TestIntents.DOES_LIKE,
  DISLIKES: TestIntents.DISLIKES,
  LIVE_AND_PROSPER: TestIntents.LIVE_AND_PROSPER,
  intent2: 'intent2',
  PROACTIVE: 'PROACTIVE',
});

class IntentSplitNode extends NoOpNode {
  constructor(name) { super(name, Object.values(IntentSplitTransition)); }

  async exit(data) {
    let transition;
    // Proactive launches carry no NLU; memo decides the entry first.
    const memo = data.result && data.result.memo;
    if (memo) {
      switch (memo) {
        case 'Proactive entry 1': transition = IntentSplitTransition.PROACTIVE; break;
        case TestIntents.LIVE_AND_PROSPER: transition = IntentSplitTransition.LIVE_AND_PROSPER; break;
        case TestIntents.DOES_LIKE: transition = IntentSplitTransition.DOES_LIKE; break;
        default: break; // unknown memo: fall back on intent
      }
    }

    if (!transition) {
      const nlu = data.result.nlu;
      switch (nlu.intent) {
        case TestIntents.DOES_LIKE: transition = IntentSplitTransition.DOES_LIKE; break;
        case TestIntents.DISLIKES: transition = IntentSplitTransition.DISLIKES; break;
        case TestIntents.LIVE_AND_PROSPER: transition = IntentSplitTransition.LIVE_AND_PROSPER; break;
        case 'intent2': transition = IntentSplitTransition.intent2; break;
        default: throw new Error(`Unknown intent: '${nlu.intent}'`);
      }
    }

    return { transition, result: data.result };
  }
}

const SkillTransition = Object.freeze({ Done: 'Done' });

function buildExampleSkill(gm) {
  const g = new Graph(gm, 'ExampleSkill', Object.values(SkillTransition));

  const intentSplitNode = new IntentSplitNode('Intent Split');
  const node1 = new ExampleNode('Node1', () => ExampleTransition.A);
  const node2 = new ExampleNode('Node2', () => ExampleTransition.B);
  const node3 = new ExampleNode('Node3', () => ExampleTransition.A);
  const proactiveNode = new ExampleNode('ProactiveNode', () => ExampleTransition.A);

  g.addNode(intentSplitNode, [
    [IntentSplitTransition.DOES_LIKE, node1],
    [IntentSplitTransition.DISLIKES, node1],
    [IntentSplitTransition.LIVE_AND_PROSPER, node1],
    [IntentSplitTransition.intent2, node2],
    [IntentSplitTransition.PROACTIVE, proactiveNode],
  ]);
  g.addNode(node1, [
    [ExampleTransition.A, node2],
    [ExampleTransition.B, node3],
  ]);
  g.addNode(node2, [
    [ExampleTransition.A, SkillTransition.Done],
    [ExampleTransition.B, node3],
  ]);
  g.addNode(node3, [
    [ExampleTransition.A, SkillTransition.Done],
    [ExampleTransition.B, SkillTransition.Done],
  ]);
  g.addNode(proactiveNode, [
    [ExampleTransition.A, SkillTransition.Done],
    [ExampleTransition.B, SkillTransition.Done],
  ]);

  g.finalize();
  return g;
}

export const exampleSkill = createGraphSkill({ name: 'example-skill', build: buildExampleSkill });

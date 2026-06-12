// MIM graph nodes + factories — ports of baseskill/graph/mims/nodes/{MultiTurnNode,QNNode,ANNode,
// MANNode,NMNode,NINode,RouterNode}.ts and factories/{MIMFactory,QNFactory,ANFactory,MANFactory}.ts.
//
// A MIM sub-graph speaks a prompt (Slimmer), listens (question MIMs), and runs the canonical
// NoMatch/NoInput re-prompt escalation until success or the prompt set is exhausted
// (FinalNoMatch/FinalNoInput). Factories assemble these nodes into reusable sub-graphs whose
// exit transitions a parent graph wires onward.

import { Node } from '../node.js';
import { Graph } from '../graph.js';
import { NoOpNode, JCPNode, generateJCPAction } from '../nodes.js';
import { loadMims, prepareMim } from './utils.js';
import { generateSlim, generateSlimSequence, MimTypes, PromptCategory, PromptSubCategory } from './slimmer.js';

// ---------------------------------------------------------------------------
// Nodes

/**
 * Base for nodes whose exit() inspects the turn result: NLU intent → success; bare ASR text →
 * NoMatch; nothing → NoInput. (MultiTurnNode.ts)
 */
export class MultiTurnNode extends JCPNode {
  constructor(name, transitions, successTransition, noMatchTransition, noInputTransition) {
    super(name, transitions);
    this.successTransition = successTransition;
    this.noMatchTransition = noMatchTransition;
    this.noInputTransition = noInputTransition;
  }

  async exit(data) {
    const nlu = data.result && data.result.nlu;
    const asr = data.result && data.result.asr;
    if (nlu && nlu.intent) return { transition: this.successTransition, result: { asr, nlu } };
    if (asr && asr.text) return { transition: this.noMatchTransition };
    return { transition: this.noInputTransition };
  }
}

export const QNTransition = Object.freeze({ Success: 'Success', NoMatch: 'NoMatch', NoInput: 'NoInput' });

export class QNNode extends MultiTurnNode {
  constructor(name, options) {
    super(name, Object.values(QNTransition), QNTransition.Success, QNTransition.NoMatch, QNTransition.NoInput);
    this.options = options;
  }

  async enter(data) {
    prepareMim(data, true);
    const config = { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.QUESTION, noMatch: 0, noInput: 0 };
    const behavior = await generateSlim(config, this.options, data, this.options);
    return { action: behavior && generateJCPAction(behavior) };
  }
}

export const ANTransition = Object.freeze({ Success: 'Success' });

export class ANNode extends JCPNode {
  constructor(name, options) {
    super(name, Object.values(ANTransition));
    this.options = options;
  }

  async enter(data) {
    prepareMim(data, true);
    const config = { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.ANNOUNCEMENT, noMatch: 0, noInput: 0 };
    const behavior = await generateSlim(config, this.options, data, this.options);
    const final = (typeof this.options.final === 'function') ? this.options.final(data) : this.options.final;
    return { action: behavior && generateJCPAction(behavior), final };
  }

  async exit() { return { transition: ANTransition.Success }; }
}

export const MANTransition = Object.freeze({ Success: 'Success' });

export class MANNode extends JCPNode {
  constructor(name, options) {
    super(name, Object.values(MANTransition));
    this.options = options;
  }

  async enter(data) {
    prepareMim(data, true);
    const config = { category: PromptCategory.ENTRY, subCategory: PromptSubCategory.ANNOUNCEMENT, noMatch: 0, noInput: 0 };
    const behavior = await generateSlimSequence(config, this.options, data, this.options);
    const final = (typeof this.options.final === 'function') ? this.options.final(data) : this.options.final;
    return { action: behavior && generateJCPAction(behavior), final };
  }

  async exit() { return { transition: MANTransition.Success }; }
}

export const NMTransition = Object.freeze({ Success: 'Success', NoMatch: 'NoMatch', NoInput: 'NoInput', FinalNoMatch: 'FinalNoMatch' });

export class NMNode extends MultiTurnNode {
  constructor(name, options) {
    super(name, Object.values(NMTransition), NMTransition.Success, NMTransition.NoMatch, NMTransition.NoInput);
    this.options = options;
  }

  async enter(data) {
    prepareMim(data);
    const index = ++data.skill.session.data._mim.noMatch;
    const config = {
      category: PromptCategory.ERROR, subCategory: PromptSubCategory.NO_MATCH,
      index, noMatch: index, noInput: data.skill.session.data._mim.noInput,
    };
    const behavior = await generateSlim(config, this.options, data, this.options);
    return { action: behavior && generateJCPAction(behavior) };
  }

  async exit(data) {
    if (!data.result && data.skill.session.data._mim.noMatchMax) {
      return { transition: NMTransition.FinalNoMatch, result: { noMatch: true } };
    }
    return super.exit(data);
  }
}

export const NITransition = Object.freeze({ Success: 'Success', NoMatch: 'NoMatch', NoInput: 'NoInput', FinalNoInput: 'FinalNoInput' });

export class NINode extends MultiTurnNode {
  constructor(name, options) {
    super(name, Object.values(NITransition), NITransition.Success, NITransition.NoMatch, NITransition.NoInput);
    this.options = options;
  }

  async enter(data) {
    prepareMim(data);
    const index = ++data.skill.session.data._mim.noInput;
    const config = {
      category: PromptCategory.ERROR, subCategory: PromptSubCategory.NO_INPUT,
      index, noMatch: data.skill.session.data._mim.noMatch, noInput: index,
    };
    const behavior = await generateSlim(config, this.options, data, this.options);
    return { action: behavior && generateJCPAction(behavior) };
  }

  async exit(data) {
    if (!data.result && data.skill.session.data._mim.noInputMax) {
      return { transition: NITransition.FinalNoInput, result: { noInput: true } };
    }
    return super.exit(data);
  }
}

export const RouterTransition = Object.freeze({ Question: 'Question', Announcement: 'Announcement' });

/** Routes a generic MIM to its question or announcement arm by mim_type. (RouterNode.ts) */
export class RouterNode extends NoOpNode {
  constructor(name, mimDataProvider) {
    super(name, Object.values(RouterTransition));
    this.mimDataProvider = mimDataProvider;
  }

  async exit(data) {
    const mims = await loadMims(this.mimDataProvider, data);
    if (!mims.length) throw new Error('Provided MIM path func yielded no MIMs');
    if (mims.length > 1) throw new Error('Provided MIM path func yielded more than 1 MIM');

    switch (mims[0].mim_type) {
      case MimTypes.QUESTION:
      case MimTypes.OPTIONAL_RESPONSE:
        return { transition: RouterTransition.Question };
      case MimTypes.ANNOUNCEMENT:
        return { transition: RouterTransition.Announcement };
      default:
        throw new Error('Requested MIM is of unknown type.');
    }
  }
}

// ---------------------------------------------------------------------------
// Factories — each builds a fresh sub-graph (new node instances every call).

export const MIMFactoryTransition = Object.freeze({ Success: 'Success', NoMatch: 'NoMatch', NoInput: 'NoInput' });

/** Generic MIM: router → QN or AN arm, with the NM/NI escalation loop. (MIMFactory.ts) */
export class MIMFactory {
  constructor(name, options) { this.name = name; this.options = options; }

  createGraph(gm) {
    const graph = new Graph(gm, `MIM: ${this.name}`, Object.values(MIMFactoryTransition));

    const routerNode = new RouterNode(`${this.name}: Router Node`, this.options.mimDataProvider);
    const questionNode = new QNNode(`QN:SL:${this.name}`, this.options);
    const announceNode = new ANNode(`AN:SL:${this.name}`, this.options);
    const noMatchNode = new NMNode(`NM:SL:${this.name}`, this.options);
    const noInputNode = new NINode(`NI:SL:${this.name}`, this.options);

    graph.addNode(routerNode, [
      [RouterTransition.Question, questionNode],
      [RouterTransition.Announcement, announceNode],
    ]);
    graph.addNode(questionNode, [
      [QNTransition.Success, MIMFactoryTransition.Success],
      [QNTransition.NoMatch, noMatchNode],
      [QNTransition.NoInput, noInputNode],
    ]);
    graph.addNode(announceNode, [
      [ANTransition.Success, MIMFactoryTransition.Success],
    ]);
    graph.addNode(noMatchNode, [
      [NMTransition.Success, MIMFactoryTransition.Success],
      [NMTransition.NoMatch, noMatchNode],
      [NMTransition.NoInput, noInputNode],
      [NMTransition.FinalNoMatch, MIMFactoryTransition.NoMatch],
    ]);
    graph.addNode(noInputNode, [
      [NITransition.Success, MIMFactoryTransition.Success],
      [NITransition.NoMatch, noMatchNode],
      [NITransition.NoInput, noInputNode],
      [NITransition.FinalNoInput, MIMFactoryTransition.NoInput],
    ]);

    graph.finalize();
    return graph;
  }
}

export const QNFactoryTransition = MIMFactoryTransition;

/** Question MIM: QN + NM/NI escalation loop. (QNFactory.ts) */
export class QNFactory {
  constructor(name, options) { this.name = name; this.options = options; }

  createGraph(gm) {
    const graph = new Graph(gm, `QN MIM: ${this.name}`, Object.values(QNFactoryTransition));

    const questionNode = new QNNode(`QN:SL:${this.name}`, this.options);
    const noMatchNode = new NMNode(`NM:SL:${this.name}`, this.options);
    const noInputNode = new NINode(`NI:SL:${this.name}`, this.options);

    graph.addNode(questionNode, [
      [QNTransition.Success, QNFactoryTransition.Success],
      [QNTransition.NoMatch, noMatchNode],
      [QNTransition.NoInput, noInputNode],
    ]);
    graph.addNode(noMatchNode, [
      [NMTransition.Success, QNFactoryTransition.Success],
      [NMTransition.NoMatch, noMatchNode],
      [NMTransition.NoInput, noInputNode],
      [NMTransition.FinalNoMatch, QNFactoryTransition.NoMatch],
    ]);
    graph.addNode(noInputNode, [
      [NITransition.Success, QNFactoryTransition.Success],
      [NITransition.NoMatch, noMatchNode],
      [NITransition.NoInput, noInputNode],
      [NITransition.FinalNoInput, QNFactoryTransition.NoInput],
    ]);

    graph.finalize();
    return graph;
  }
}

export const ANFactoryTransition = Object.freeze({ Success: 'Success' });

/** Announcement MIM. (ANFactory.ts) */
export class ANFactory {
  constructor(name, options) { this.name = name; this.options = options; }

  createGraph(gm) {
    const graph = new Graph(gm, `AN MIM: ${this.name}`, Object.values(ANFactoryTransition));
    const announceNode = new ANNode(`AN:SL:${this.name}`, this.options);
    graph.addNode(announceNode, [[ANTransition.Success, ANFactoryTransition.Success]]);
    graph.finalize();
    return graph;
  }
}

export const MANFactoryTransition = Object.freeze({ Success: 'Success' });

/** Multi-announcement MIM (a SEQUENCE of SLIMs from several announcement MIMs). (MANFactory.ts) */
export class MANFactory {
  constructor(name, options) { this.name = name; this.options = options; }

  createGraph(gm) {
    const graph = new Graph(gm, `M:AN MIM: ${this.name}`, Object.values(MANFactoryTransition));
    const multiAnnounceNode = new MANNode(`M:AN:SL:${this.name}`, this.options);
    graph.addNode(multiAnnounceNode, [[MANTransition.Success, MANFactoryTransition.Success]]);
    graph.finalize();
    return graph;
  }
}

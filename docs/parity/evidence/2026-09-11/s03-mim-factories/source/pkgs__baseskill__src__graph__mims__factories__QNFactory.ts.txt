# jiboV2/pegasus:packages/baseskill/src/graph/mims/factories/QNFactory.ts@5c0a7390539663ba749d360de348a428c088505c

import { GraphFactory } from '../../GraphFactory';
import { Graph } from '../../Graph';
import { generateTransitions } from '../../Utils';
import { MimFactoryOptions } from '../common/Types';
import * as qn from '../nodes/QNNode';
import * as nm from '../nodes/NMNode';
import * as ni from '../nodes/NINode';


export enum Transition {
    Success = 'Success',
    NoMatch = 'NoMatch',
    NoInput = 'NoInput'
}

export class QNFactory implements GraphFactory {

    constructor(public name: string, private options: MimFactoryOptions) {
        // noop
    }

    /**
     * Builds a new instance of a Question MIM graph with all new instances of nodes
     */
    createGraph(): Graph<Transition> {
        const graph = new Graph(`QN MIM: ${this.name}`, generateTransitions<Transition>(Transition));

        const questionNode = new qn.QNNode(`QN:SL:${this.name}`, this.options);
        const noMatchNode = new nm.NMNode(`NM:SL:${this.name}`, this.options);
        const noInputNode = new ni.NINode(`NI:SL:${this.name}`, this.options);

        graph.addNode(questionNode, [
            [qn.Transition.Success, Transition.Success],
            [qn.Transition.NoMatch, noMatchNode],
            [qn.Transition.NoInput, noInputNode],
        ]);

        graph.addNode(noMatchNode, [
            [nm.Transition.Success, Transition.Success],
            [nm.Transition.NoMatch, noMatchNode],
            [nm.Transition.NoInput, noInputNode],
            [nm.Transition.FinalNoMatch, Transition.NoMatch]
        ]);

        graph.addNode(noInputNode, [
            [ni.Transition.Success, Transition.Success],
            [ni.Transition.NoMatch, noMatchNode],
            [ni.Transition.NoInput, noInputNode],
            [ni.Transition.FinalNoInput, Transition.NoInput]
        ]);

        graph.finalize();
        return graph;
    }
}
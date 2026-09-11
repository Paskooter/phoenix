# jiboV2/pegasus:packages/baseskill/src/graph/mims/factories/MIMFactory.ts@5c0a7390539663ba749d360de348a428c088505c

import { GraphFactory } from '../../GraphFactory';
import { Graph } from '../../Graph';
import { generateTransitions } from '../../Utils';
import { MimFactoryOptions } from '../common/Types';
import * as router from '../nodes/RouterNode';
import * as qn from '../nodes/QNNode';
import * as an from '../nodes/ANNode';
import * as nm from '../nodes/NMNode';
import * as ni from '../nodes/NINode';


export enum Transition {
    Success = 'Success',
    NoMatch = 'NoMatch',
    NoInput = 'NoInput'
}

export class MIMFactory implements GraphFactory {

    constructor(public name: string, private options: MimFactoryOptions) {
        // noop
    }

    /**
     * Builds a new instance of a generic MIM graph with all new instances of nodes
     */
    createGraph(): Graph<Transition> {
        const graph = new Graph(`MIM: ${this.name}`, generateTransitions<Transition>(Transition));

        const routerNode = new router.RouterNode(`${this.name}: Router Node`, this.options.mimDataProvider);
        const questionNode = new qn.QNNode(`QN:SL:${this.name}`, this.options);
        const announceNode = new an.ANNode(`AN:SL:${this.name}`, this.options);
        const noMatchNode = new nm.NMNode(`NM:SL:${this.name}`, this.options);
        const noInputNode = new ni.NINode(`NI:SL:${this.name}`, this.options);
        // const holdReturnNode = new hr.HRNode('Hold/Return Node');

        graph.addNode(routerNode, [
            [router.Transition.Question, questionNode],
            [router.Transition.Announcement, announceNode]
        ]);

        graph.addNode(questionNode, [
            [qn.Transition.Success, Transition.Success],
            [qn.Transition.NoMatch, noMatchNode],
            [qn.Transition.NoInput, noInputNode],
        ]);

        graph.addNode(announceNode, [
            [an.Transition.Success, Transition.Success]
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

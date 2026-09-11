# jiboV2/pegasus:packages/baseskill/src/graph/mims/factories/ANFactory.ts@5c0a7390539663ba749d360de348a428c088505c

import { GraphFactory } from '../../GraphFactory';
import { Graph } from '../../Graph';
import { generateTransitions } from '../../Utils';
import { MimFactoryOptions } from '../common/Types';
import * as an from '../nodes/ANNode';


export enum Transition {
    Success = 'Success'
}

export class ANFactory implements GraphFactory {

    constructor(public name: string, private options: MimFactoryOptions) {
        // noop
    }

    /**
     * Builds a new instance of an Announcement MIM graph with all new instances of nodes
     */
    createGraph(): Graph<Transition> {
        const graph = new Graph(`AN MIM: ${this.name}`, generateTransitions<Transition>(Transition));

        const announceNode = new an.ANNode(`AN:SL:${this.name}`, this.options);

        graph.addNode(announceNode, [
            [an.Transition.Success, Transition.Success]
        ]);

        graph.finalize();
        return graph;
    }
}

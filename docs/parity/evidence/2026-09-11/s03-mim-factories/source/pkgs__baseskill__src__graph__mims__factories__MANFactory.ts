# jiboV2/pegasus:packages/baseskill/src/graph/mims/factories/MANFactory.ts@5c0a7390539663ba749d360de348a428c088505c

import { GraphFactory } from '../../GraphFactory';
import { Graph } from '../../Graph';
import { generateTransitions } from '../../Utils';
import { MimFactoryOptions } from '../common/Types';
import * as man from '../nodes/MANNode';


export enum Transition {
    Success = 'Success'
}

export class MANFactory implements GraphFactory {

    constructor(public name: string, private options: MimFactoryOptions) {
        // noop
    }

    /**
     * Builds a new instance of a multiple-Announcement MIM graph with all new instances of nodes
     */
    createGraph(): Graph<Transition> {
        const graph = new Graph(`M:AN MIM: ${this.name}`, generateTransitions<Transition>(Transition));

        const multiAnnounceNode = new man.MANNode(`M:AN:SL:${this.name}`, this.options);

        graph.addNode(multiAnnounceNode, [
            [man.Transition.Success, Transition.Success]
        ]);

        graph.finalize();
        return graph;
    }
}

# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/RouterNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { Data, ExitResponse } from '../../nodes/Node';
import { NoOpNode } from '../../nodes/NoOpNode';
import { MimTypes, MimDataProvider} from '../common/Types';
import { generateTransitions } from '../../Utils';
import { loadMims } from '../utils/Utils';


export enum Transition {
    Question = 'Question',
    Announcement = 'Announcement'
}


export class RouterNode extends NoOpNode<Transition> {

    constructor(name: string, private mimDataProvider: MimDataProvider) {
        super(name, generateTransitions<Transition>(Transition));
    }

    /**
     * A method that performs the work of this node. It can either return:
     *  - The next cloud node to transition to (name or instance)
     *  - nothing if the skill is over
     */
    async exit(data: Data): Promise<ExitResponse<Transition>> {
        const mims = await loadMims(this.mimDataProvider, data);

        if (!mims.length) {
            throw new Error('Provided MIM path func yielded no MIMs');
        } else if (mims.length > 1) {
            throw new Error('Provided MIM path func yielded more than 1 MIM');
        }

        switch (mims[0].mim_type) {
            case MimTypes.QUESTION:
            case MimTypes.OPTIONAL_RESPONSE:
                return { transition: Transition.Question };
            case MimTypes.ANNOUNCEMENT:
                return { transition: Transition.Announcement};
            default:
                throw new Error('Requested MIM is of unknown type.');
        }
    }
}

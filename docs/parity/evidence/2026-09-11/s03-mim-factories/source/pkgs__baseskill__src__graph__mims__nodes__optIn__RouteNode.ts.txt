# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/optIn/RouteNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { OptInFactoryOptions, OptInType } from '../../common/Types';
import { NoOpNode, ExitResponse, Data } from '../../../nodes';
import { generateTransitions } from '../../../Utils';
import { isFunc } from '../../utils/Utils';


export enum Transition {
    VerifyID = 'VerifyID',
    NoID = 'NoID'
}


export class RouteNode extends NoOpNode<Transition> {

    constructor(name: string, private options: OptInFactoryOptions) {
        super(name, generateTransitions<Transition>(Transition));
    }

    /**
     * @param data
     * @returns
     */
    async exit(data: Data): Promise<ExitResponse<Transition>> {
        const log = data.log.createChild('RouteNode');

        const optInType = isFunc(this.options.optInType) ?
            this.options.optInType(data) : this.options.optInType;

        let transition: Transition;
        switch (optInType) {
            case OptInType.NO_ID:
                transition = Transition.NoID;
                break;
            case OptInType.VERIFY_ID:
                transition = Transition.VerifyID;
                break;
            default:
                throw new Error(`Unknown Opt-In Type: '${optInType}'`);
        }

        data.skill.session.data._optIn = {};
        if (data.runtime.perception.speaker) {
            data.skill.session.data._optIn.speaker = data.runtime.perception.speaker;
        }

        log.info(`Opt-In Type: ${optInType}`);

        return { transition };
    }
}



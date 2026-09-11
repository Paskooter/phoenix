# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/QNNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { skill } from '@jibo/interfaces';
import { MultiTurnNode } from './MultiTurnNode';
import { Data, EnterResponse, ExitResponse } from '../../nodes/Node';
import { generateTransitions, generateJCPAction } from '../../Utils';
import { prepareMim } from '../utils/Utils';
import { generateSlim } from '../utils/slimmer/Slimmer';
import {
    PromptCategory,
    PromptSubCategory,
    MimFactoryOptions,
    SlimmerConfig
} from '../common/Types';

export enum Transition {
    Success = 'Success',
    NoMatch = 'NoMatch',
    NoInput = 'NoInput'
}

export class QNNode extends MultiTurnNode<Transition> {

    constructor(name: string, private options: MimFactoryOptions) {
        super(name, generateTransitions<Transition>(Transition), Transition.Success, Transition.NoMatch, Transition.NoInput);
    }

    async enter(data: Data): Promise<EnterResponse<skill.action.JCPAction>> {
        prepareMim(data, true);
        const config: SlimmerConfig = {
            category: PromptCategory.ENTRY,
            subCategory: PromptSubCategory.QUESTION,
            noMatch: 0,
            noInput: 0
        };
        const behavior = await generateSlim(config, this.options, data);
        const action = behavior && generateJCPAction(behavior);
        return {
            action
        };
    }

    async exit(data: Data): Promise<ExitResponse<Transition>> {
        return super.exit(data);
    }
}

# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/MANNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { skill } from '@jibo/interfaces';
import { JCPNode } from '../../nodes/JCPNode';
import { Data, EnterResponse, ExitResponse } from '../../nodes/Node';
import { PromptCategory, PromptSubCategory, MimFactoryOptions, SlimmerConfig } from '../common/Types';
import { generateTransitions, generateJCPAction } from '../../Utils';
import { prepareMim } from '../utils/Utils';
import { generateSlimSequence } from '../utils/slimmer/Slimmer';

export enum Transition {
     Success = 'Success'
}

export class MANNode extends JCPNode<Transition> {

    constructor(name: string, private options: MimFactoryOptions) {
        super(name, generateTransitions<Transition>(Transition));
    }

    async enter(data: Data): Promise<EnterResponse<skill.action.JCPAction>> {
        prepareMim(data, true);
        const config: SlimmerConfig = {
            category: PromptCategory.ENTRY,
            subCategory: PromptSubCategory.ANNOUNCEMENT,
            noMatch: 0,
            noInput: 0
        };
        const behavior = await generateSlimSequence(config, this.options, data);
        const action = behavior && generateJCPAction(behavior);
        const final = (typeof this.options.final === 'function') ? this.options.final(data) : this.options.final;
        return {
            action,
            final
         };
    }

    async exit(data: Data): Promise<ExitResponse<Transition>> {
        return { transition: Transition.Success };
    }
}

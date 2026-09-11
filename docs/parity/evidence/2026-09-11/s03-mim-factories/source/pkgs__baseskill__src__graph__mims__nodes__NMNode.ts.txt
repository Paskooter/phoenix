# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/NMNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { skill } from '@jibo/interfaces';
import { MultiTurnNode } from './MultiTurnNode';
import { Data, EnterResponse, ExitResponse } from '../../nodes/Node';
import { PromptCategory, PromptSubCategory, MimFactoryOptions, SlimmerConfig } from '../common/Types';
import { generateTransitions, generateJCPAction } from '../../Utils';
import { prepareMim } from '../utils/Utils';
import { generateSlim } from '../utils/slimmer/Slimmer';


export enum Transition {
    Success = 'Success',
    NoMatch = 'NoMatch',
    NoInput = 'NoInput',
    FinalNoMatch = 'FinalNoMatch'
}

export class NMNode extends MultiTurnNode<Transition> {

    constructor(name: string, private options: MimFactoryOptions) {
        super(name, generateTransitions<Transition>(Transition), Transition.Success, Transition.NoMatch, Transition.NoInput);
    }

    async enter(data: Data): Promise<EnterResponse<skill.action.JCPAction>> {
        prepareMim(data);
        const index = ++data.skill.session.data._mim.noMatch;
        const config: SlimmerConfig = {
            category: PromptCategory.ERROR,
            subCategory: PromptSubCategory.NO_MATCH,
            index: index,
            noMatch: index,
            noInput: data.skill.session.data._mim.noInput
        };
        const behavior = await generateSlim(config, this.options, data);
        const action = behavior && generateJCPAction(behavior);
        return {
            action
        };
    }

    async exit(data: Data): Promise<ExitResponse<Transition>> {
        if (!data.result && data.skill.session.data._mim.noMatchMax) {
            return {
                transition: Transition.FinalNoMatch,
                result: {
                    noMatch: true
                }
            };
        }
        return super.exit(data);
    }
}

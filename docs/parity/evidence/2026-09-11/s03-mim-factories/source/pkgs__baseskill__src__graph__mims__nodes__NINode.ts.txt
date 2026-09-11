# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/NINode.ts@5c0a7390539663ba749d360de348a428c088505c

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
    FinalNoInput = 'FinalNoInput',
}

export class NINode extends MultiTurnNode<Transition> {

    constructor(name: string, private options: MimFactoryOptions) {
        super(name, generateTransitions<Transition>(Transition), Transition.Success, Transition.NoMatch, Transition.NoInput);
    }

    async enter(data: Data): Promise<EnterResponse<skill.action.JCPAction>> {
        prepareMim(data);
        const index = ++data.skill.session.data._mim.noInput;
        const config: SlimmerConfig = {
            category: PromptCategory.ERROR,
            subCategory: PromptSubCategory.NO_INPUT,
            index: index,
            noMatch: data.skill.session.data._mim.noMatch,
            noInput: index,
        };
        const behavior = await generateSlim(config, this.options, data);
        const action = behavior && generateJCPAction(behavior);
        return {
            action
        };
    }

    async exit(data: Data): Promise<ExitResponse<Transition>> {
        if (!data.result && data.skill.session.data._mim.noInputMax) {
            return {
                transition: Transition.FinalNoInput,
                result: {
                    noInput: true
                }
            };
        }
        return super.exit(data);
    }
}

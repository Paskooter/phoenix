# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/MultiTurnNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { skill, nlu, asr } from '@jibo/interfaces';
import { JCPNode } from '../../nodes/JCPNode';
import {Data, EnterResponse, ExitResponse} from '../../nodes/Node';


export abstract class MultiTurnNode<T extends string> extends JCPNode<T> {

    constructor(name: string, transitions: T[], private successTransition: T, private noMatchTransition: T, private noInputTransition: T) {
        super(name, transitions);
    }

    abstract enter(data: Data): Promise<EnterResponse<skill.action.JCPAction>>;

    async exit(data: Data): Promise<ExitResponse<T>> {
        const nlu: nlu.NLUResult = data.result.nlu;
        const asr: asr.ASRResult = data.result.asr;

        const haveNLU = (nlu && nlu.intent);
        const haveASR = (asr && asr.text);

        if (haveNLU) {
            return {
                transition: this.successTransition,
                result: {
                    asr,
                    nlu
                }
            };
        } else {
            if (haveASR) {
                return { transition: this.noMatchTransition };
            } else {
                return { transition: this.noInputTransition };
            }
        }
    }
}

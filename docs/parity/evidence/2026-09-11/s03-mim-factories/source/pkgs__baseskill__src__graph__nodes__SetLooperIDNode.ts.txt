# jiboV2/pegasus:packages/baseskill/src/graph/nodes/SetLooperIDNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { v2 as requester } from 'jibo-command-requester';
import { NoOpNode, ExitResponse, Data } from './';
import { generateTransitions } from '../Utils';
import { GraphSkill } from '../../GraphSkill';


export enum Transition {
    Cancel = 'Cancel',
    Success = 'Success',
    NotInLoop = 'NotInLoop'
}

export class SetLooperIDNode extends NoOpNode<Transition> {

    constructor(name: string, private skill: GraphSkill) {
        super(name, generateTransitions<Transition>(Transition));
    }

    /**
     * @param {Data} data
     * @returns {(Promise<dn.Transition.Done>)}
     * @memberof Node
     */
    async exit(data: Data): Promise<ExitResponse<Transition>> {
        const log = data.log.createChild('SetLooperIDNode');

        if (!data.result) {
            data.result = {};
        }

        if (!data.result.nlu) {
            data.result.nlu = { entities: { loopMemberReferent: null } };
        }

        const intent = data.result.nlu.intent;
        const looper = data.result.nlu.entities.loopMemberReferent;

        switch (intent) {
            case 'cancel':
                return { transition: Transition.Cancel };
            case 'loopmember':
                if (looper) {
                    this.skill.overrideSpeaker(data, looper);
                    log.info('Appending a SetPersonPresent behavior to supplemental behaviors');
                    const setPerson = requester.perception.SetPresentPerson.generateProtocol(
                        data.result.nlu.entities.loopMemberReferent,
                        "USER_OVERRIDE",
                        100
                    );
                    this.skill.addSequenceBehavior(data, setPerson);
                    return { transition: Transition.Success };
                } else {
                    log.warn(`Detected intent ${intent}, but recieved incomplete looper information.`);
                }
            case 'notInLoop':
            default:
                this.skill.overrideSpeaker(data, null);
                return { transition: Transition.NotInLoop };
        }




    }
}

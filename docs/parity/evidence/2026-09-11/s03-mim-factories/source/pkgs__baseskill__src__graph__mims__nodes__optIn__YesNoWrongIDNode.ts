# jiboV2/pegasus:packages/baseskill/src/graph/mims/nodes/optIn/YesNoWrongIDNode.ts@5c0a7390539663ba749d360de348a428c088505c

import { skill } from '@jibo/interfaces';
import { NoOpNode, ExitResponse, Data } from '../../../nodes';
import { generateTransitions } from '../../../Utils';
import { GraphSkill } from '../../../../GraphSkill';


export enum Transition {
    Yes = 'Yes',
    No = 'No',
    WrongID = 'WrongID',
    NoMatch = 'NoMatch',
    NoInput = 'NoInput'
}

export class YesNoWrongIDNode extends NoOpNode<Transition> {

    constructor(name: string, private currentSkill: GraphSkill) {
        super(name, generateTransitions<Transition>(Transition));
    }

    /**
     * @param {Data} data
     * @returns {(Promise<Transition>)}
     * @memberof Node
     */
    async exit(data: Data): Promise<ExitResponse<Transition>> {
        const log = data.log.createChild('YesNoWrongID');

        let transition: Transition;
        const nlu = data.result.nlu;
        const asr = data.result.asr;
        const failure = (nlu && nlu.intent) ? null :
                        data.result.noInput ? 'no-input' :
                        data.result.noMatch ? 'no-match' :
                        null;

        if (!failure) {
            switch (nlu.intent) {
                case 'yes':
                    transition = Transition.Yes;
                    if (data.skill.session.data._optIn.speaker && !data.runtime.perception.speaker) {
                        log.info('Utilizing cached optIn speaker for ID.');
                        data.runtime.perception.speaker = data.skill.session.data._optIn.speaker;
                    }
                    break;
                case 'no':
                    transition = Transition.No;
                    break;
                case 'wrongID':
                    transition = Transition.WrongID;
                    break;
                default:
                    throw new Error(`Unknown intent: '${nlu.intent}'`);
            }
        } else {
            if (data.result.noMatch) {
                transition = Transition.NoMatch;
            } else if (data.result.noInput) {
                transition = Transition.NoInput;
            }
        }

        // Add Opt-In Offer Analytics event for the current skill
        try {
            const offerAnalytics: skill.analytics.SkillOfferAnalyticsData = {
                user_response: (nlu && nlu.intent) || failure,
                modality: failure ? 'n/a' :
                          (nlu.intent && !asr.text) ? 'touch' : 'speech'
            };
            this.currentSkill.track(data, skill.analytics.EVENTS.SKILL_OFFER, offerAnalytics);
        } catch (err) {
            log.error('Unable to track Offer analytics:', err);
        }

        log.info(`Transition: ${transition}`);

        return {
            transition,
            result: data.result,
        };
    }
}

# jiboV2/pegasus:packages/baseskill/tests/OptInSkill.test.ts@5c0a7390539663ba749d360de348a428c088505c

import { expect } from 'chai';
import { jibo, skill, proactive } from '@jibo/interfaces';
import { ExampleOptInSkill } from './skills/ExampleOptInSkill';
import { skill_test, LOOP_OWNER_ID } from '@jibo/test-utils';
import * as main from './main';


function asrNlu(asrText = '', intent, entities?) {
    return {
        nlu: { intent, entities },
        asr: { text: asrText }
    };
}

function createOptInLaunchData() {
    return {
        memo: {
            memo: 'Proactive Test with Opt-In',
            skillID: 'opt-in-test-skill',
        }
    };
}


describe('Opt-In Skill Test', () => {

    let skill;
    let conversation;
    let launchData;

    let optInVerify = false;

    beforeEach(function() {
        launchData = createOptInLaunchData();
        skill = new ExampleOptInSkill(optInVerify);
        conversation = new skill_test.SkillConversation(new main.SkillService(skill));
        return conversation.init();
    });

    afterEach(() => {
        skill = null;
        return conversation.close();
    });

    function expectError(message) {
        return conversation.launch('', {}, launchData)
            .then(({ response }) => {
                expect(response.type).to.equal('ERROR');
                expect(response.data.message).to.equal(message);
            });
    }

    it(`A full Opt-In skill execution`, function () {
        return conversation.launch('', {}, launchData)
            .then(({ response }) => {
                expect(response.type).to.not.equal(`ERROR`);
                expect(response.data.skill.id).to.equal('opt-in-test-skill');
            });
    });

    describe('Opt-In Without Verify Test', () => {
        it(`type OPT_IN offers non-verify-id MIM`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInProposalNoID');
                });
        });
    });

    describe('Opt-In With Verify Test', () => {
        let original = optInVerify;
        before(function () {
            optInVerify = true;
        });
        after(function () {
            optInVerify = original;
        });

        it(`type OPT_IN_VERIFY_ID offers verify-id MIM`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInProposalVerifyID');
                });
        });

        it('fuse OptIn MIM GUI/rules with prompts provided by skill', function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInProposalVerifyID');
                    expect(jcp.config.play.meta.prompt_id).to.include('Verify_Test');
                });
        });

        it(`play skill's MIM if correct user`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('yes', 'yes'));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.prompt_id).to.include('AfterOptIn_AN_02');
                    expect(response.data.final).to.equal(true);
                });
        });

        it(`play WrongID MIM if wrong user`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('not me', 'wrongID'));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInWrongID');
                    expect(jcp.config.play.meta.prompt_id).to.include('WrongID');
                });
        });

        it(`play fused Decline MIM if 'no'`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('no', 'no'));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInDecline');
                    expect(jcp.config.play.meta.prompt_id).to.include('Decline_Test');
                    expect(response.data.final).to.equal(true);
                });
        });

        it(`play fused Decline MIM if no input`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('', undefined));
                }).then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('', undefined));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInDecline');
                    expect(jcp.config.play.meta.prompt_id).to.include('Decline_Test');
                    expect(response.data.final).to.equal(true);
                });
        });

        it(`play fused Decline MIM if no match`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('bananas', undefined));
                }).then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('bananas', undefined));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInDecline');
                    expect(jcp.config.play.meta.prompt_id).to.include('Decline_Test');
                    expect(response.data.final).to.equal(true);
                });
        });

        it(`play skill's MIM if user not in loop`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('not me', 'wrongID'));
                }).then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('i am not in the loop', 'notInLoop'));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.prompt_id).to.include('AfterOptIn_AN_01');
                    expect(response.data.final).to.equal(true);
                });
        });

        it(`play Decline MIM if user cancels out of fixing ID`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('not me', 'wrongID'));
                }).then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('cancel', 'cancel'));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SLIM');
                    expect(jcp.config.play.meta.mim_id).to.include('OptInDecline');
                    expect(jcp.config.play.meta.prompt_id).to.include('Decline_Test');
                    expect(response.data.final).to.equal(true);
                });
        });

        it(`play skill's MIM (with updated ID) and add present person behavior if user fixes ID`, function () {
            return conversation.launch('', {}, launchData)
                .then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('not me', 'wrongID'));
                }).then(({ response }) => {
                    return conversation.actionResult(response.data.skill, asrNlu('George Jetson', 'loopmember', {
                        "given-name": "George",
                        "last-name": "Jetson",
                        loopMemberReferent: LOOP_OWNER_ID
                    }));
                }).then(({ response }) => {
                    const jcp = response.data.action.config.jcp;
                    expect(jcp.type).to.equal('SEQUENCE');
                    const behaviors = jcp.children;
                    expect(behaviors.length).to.equal(2);
                    expect(behaviors[0].type).to.equal('SET_PRESENT_PERSON');
                    expect(behaviors[0].looperId).to.equal(LOOP_OWNER_ID);
                    expect(behaviors[1].type).to.equal('SLIM');
                    expect(behaviors[1].config.play.meta.prompt_id).to.include('AfterOptIn_AN_02');
                    expect(behaviors[1].config.play.esml).to.include('ghoti');
                    expect(response.data.final).to.equal(true);
                });
        });
    });
});
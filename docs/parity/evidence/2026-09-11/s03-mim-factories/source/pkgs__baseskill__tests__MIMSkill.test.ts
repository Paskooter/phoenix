# jiboV2/pegasus:packages/baseskill/tests/MIMSkill.test.ts@5c0a7390539663ba749d360de348a428c088505c

import { expect } from 'chai';
import { jibo, skill } from '@jibo/interfaces';
import { ExampleMIMSkill } from './skills/ExampleMIMSkill';
import { skill_test } from '@jibo/test-utils';
import * as main from './main';


describe('MIM Graph Skill', () => {

    let conversation: skill_test.SkillConversation;

    beforeEach(async () => {
        conversation = await new skill_test.SkillConversation(new main.SkillService(new ExampleMIMSkill())).init();
    });

    afterEach(() => {
        return conversation.close();
    });

    function checkGraphState(response, action, transaction, skill, node, trace) {
        expect(response.type).to.equal(action);
        expect(response.data.skill.id).to.equal(skill);
        expect(response.data.skill.session.nodeID).to.equal(node);
        if (trace) {
            expect(response.data.skill.session.trace).to.deep.equal(trace);
        }
    }

    function listenData(nlu, asrText = ''): skill.request.ListenData {
        return {
            nlu,
            asr: {
                text: asrText,
                confidence: 1
            }
        };
    }

    it(`Successful run`, function () {
        const skillData: jibo.data.SkillData = {
            id: 'ExampleMIMSkill'
        };

        return conversation.launch('someIntent', skillData)
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 0, null);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 8, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: null }
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 1, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 9, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 2, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: 'someIntent',
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 10, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'Success' },
                    { nodeID: 10, transition: null },
                ]);
            });
    });

    it(`NoMatch run`, function () {
        const skillData: jibo.data.SkillData = {
            id: 'ExampleMIMSkill'
        };

        return conversation.launch('someIntent', skillData)
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 0, null);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 8, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: null }
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 1, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 9, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 2, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 3, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoMatch' },
                    { nodeID: 3, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: 'someIntent',
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 10, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'Success' },
                    { nodeID: 10, transition: null },
                ]);
            });
    });

    it(`NoInput run`, function () {
        const skillData: jibo.data.SkillData = {
            id: 'ExampleMIMSkill'
        };

        return conversation.launch('someIntent', skillData)
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 0, null);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 8, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: null }
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 1, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 9, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 2, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 4, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: 'someIntent',
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 10, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'Success' },
                    { nodeID: 10, transition: null },
                ]);
            });
    });

    it(`Degenerate run`, function () {
        const skillData: jibo.data.SkillData = {
            id: 'ExampleMIMSkill'
        };

        return conversation.launch('someIntent', skillData)
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 0, null);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 8, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: null }
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 1, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 9, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 2, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 4, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 3, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'NoMatch' },
                    { nodeID: 3, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 3, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 3, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 11, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'FinalNoMatch' },
                    { nodeID: 11, transition: null },
                ]);
                return conversation.actionResult(skillData);
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 5, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'FinalNoMatch' },
                    { nodeID: 11, transition: 'a' },
                    { nodeID: 5, transition: null },
                ]);
                const nlu = {
                    rules: [],
                    intent: null,
                    entities: {},
                };
                return conversation.actionResult(skillData, listenData(nlu, 'some asr text' ));
            })
            .then(({ response }) => {
                checkGraphState(response, `SKILL_ACTION`, skill_test.transactionID, `ExampleMIMSkill`, 14, [
                    { nodeID: 0, transition: 'Success' },
                    { nodeID: 8, transition: 'a' },
                    { nodeID: 1, transition: 'Success' },
                    { nodeID: 9, transition: 'a' },
                    { nodeID: 2, transition: 'NoInput' },
                    { nodeID: 4, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'NoMatch' },
                    { nodeID: 3, transition: 'FinalNoMatch' },
                    { nodeID: 11, transition: 'a' },
                    { nodeID: 5, transition: 'NoMatch' },
                    { nodeID: 6, transition: 'FinalNoMatch' },
                    { nodeID: 14, transition: null },
                ]);
            });
    });

});

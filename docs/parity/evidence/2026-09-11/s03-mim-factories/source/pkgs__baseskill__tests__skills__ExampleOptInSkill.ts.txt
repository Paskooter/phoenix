# jiboV2/pegasus:packages/baseskill/tests/skills/ExampleOptInSkill.ts@5c0a7390539663ba749d360de348a428c088505c

import * as main from '../main';
import * as path from 'path';
import dn = main.graph.nodes.dn;
import NoOpNode = main.graph.nodes.NoOpNode;

const ROOT = require('find-root')(__dirname);

export enum Transition {
    Done = 'Done'
}

let verify = false;

export class ExampleOptInSkill extends main.GraphSkill<Transition> {

    constructor(_verify) {
        verify = _verify;
        super('opt-in-test-skill');
    }

    createGraph(): main.graph.Graph<Transition> {
        let g = new main.graph.Graph('Main Skill Graph', main.graph.utils.generateTransitions<Transition>(Transition));

        const start = new dn.DefaultNode('Start');
        const declined = new dn.DefaultNode('Declined');
        const accepted = new dn.DefaultNode('Accepted');
        const notInLoop = new dn.DefaultNode('Not In Loop');
        const complete = new dn.DefaultNode('Complete');

        const mimPath = (mimName) => path.join(ROOT, 'res_test', 'mims', `${mimName}.mim`);
        const optInOptions: main.graph.mims.OptInFactoryOptions = {
            proposalMimProvider: mimPath('OptInVerify'),
            declineMimProvider: mimPath('OptInDecline'),
            optInType: verify ? main.graph.mims.OptInType.VERIFY_ID : main.graph.mims.OptInType.NO_ID
        };
        const optInMIM = new main.graph.mims.optIn.OptInFactory('Opt-In', this, optInOptions).createGraph();

        const realThingOptions: main.graph.mims.MimFactoryOptions = {
            mimDataProvider: mimPath('AfterOptIn'),
            final: true
        };
        const realThingMIM = new main.graph.mims.an.ANFactory('Real Thing', realThingOptions).createGraph();

        g.addNode(start, [
            [dn.Transition.Done, optInMIM.initial],
        ]);
        g.addSubGraph(optInMIM, [
            [main.graph.mims.optIn.Transition.Declined, declined],
            [main.graph.mims.optIn.Transition.Accepted, accepted],
            [main.graph.mims.optIn.Transition.NotInLoop, notInLoop]
        ]);
        g.addNode(declined, [[main.graph.nodes.dn.Transition.Done, Transition.Done]]);
        g.addNode(notInLoop, [[main.graph.nodes.dn.Transition.Done, realThingMIM.initial]]);
        g.addNode(accepted, [[main.graph.nodes.dn.Transition.Done, realThingMIM.initial]]);
        g.addSubGraph(realThingMIM, [
            [main.graph.mims.an.Transition.Success, complete]
        ]);
        g.addNode(complete, [[main.graph.nodes.dn.Transition.Done, Transition.Done]]);

        g.finalize();
        return g;
    }
}
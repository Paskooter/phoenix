# jiboV2/pegasus:packages/baseskill/tests/skills/ExampleMIMSkill.ts@5c0a7390539663ba749d360de348a428c088505c

import * as main from '../main';
import * as en from '../graph/ExampleNode';
import { testMims } from '../Utils';


enum Transition {
    Done = 'Done'
}

export class ExampleMIMSkill extends main.GraphSkill<Transition> {

    constructor() {
        super('ExampleMIMSkill');
    }

    // Create very simple graph
    createGraph(): main.graph.Graph<Transition> {
        const g = new main.graph.Graph<Transition>('Main Skill Graph', main.graph.utils.generateTransitions(Transition));

        const anPath = testMims.uber4;
        const anFactory = new main.graph.mims.an.ANFactory('AN MIM', {mimDataProvider: anPath});
        const anGraph = anFactory.createGraph();

        const manPaths = [
            testMims.uber2,
            testMims.uber3
        ];
        const manFactory = new main.graph.mims.man.MANFactory('Multiple AN MIMs', {mimDataProvider: manPaths});
        const manGraph = manFactory.createGraph();

        const qnPath = (data) => testMims.uber;
        const qnFactory = new main.graph.mims.qn.QNFactory('QN MIM', {mimDataProvider: qnPath});
        const qnGraph = qnFactory.createGraph();

        const qn2Path = (data) => testMims.noNMNI;
        const qn2Factory = new main.graph.mims.qn.QNFactory('QN2 MIM', {mimDataProvider: qn2Path});
        const qn2Graph = qn2Factory.createGraph();

        const anSuccessNode = new en.ExampleNode('Success', (data) => {
            return en.Transition.A;
        });
        const manSuccessNode = new en.ExampleNode('Success', (data) => {
            return en.Transition.A;
        });
        const qnSuccessNode = new en.ExampleNode('Success', (data) => {
            return en.Transition.A;
        });
        const qnNoMatchNode = new en.ExampleNode('NoMatch', (data) => {
            return en.Transition.A;
        });
        const qnNoInputNode = new en.ExampleNode('NoInput', (data) => {
            return en.Transition.A;
        });
        const qn2SuccessNode = new en.ExampleNode('QN2 Success', (data) => {
            return en.Transition.A;
        });
        const qn2NoMatchNode = new en.ExampleNode('QN2 NoMatch', (data) => {
            return en.Transition.A;
        });
        const qn2NoInputNode = new en.ExampleNode('QN2 NoInput', (data) => {
            return en.Transition.A;
        });

        g.addSubGraph(anGraph, [
            [main.graph.mims.an.Transition.Success, anSuccessNode]
        ]);
        g.addSubGraph(manGraph, [
            [main.graph.mims.man.Transition.Success, manSuccessNode]
        ]);
        g.addSubGraph(qnGraph, [
            [main.graph.mims.qn.Transition.Success, qnSuccessNode],
            [main.graph.mims.qn.Transition.NoMatch, qnNoMatchNode],
            [main.graph.mims.qn.Transition.NoInput, qnNoInputNode]
        ]);
        g.addSubGraph(qn2Graph, [
            [main.graph.mims.qn.Transition.Success, qn2SuccessNode],
            [main.graph.mims.qn.Transition.NoMatch, qn2NoMatchNode],
            [main.graph.mims.qn.Transition.NoInput, qn2NoInputNode]
        ]);

        g.addNode(anSuccessNode, [[en.Transition.A, manGraph.initial], [en.Transition.B, manGraph.initial]]);
        g.addNode(manSuccessNode, [[en.Transition.A, qnGraph.initial], [en.Transition.B, qnGraph.initial]]);
        g.addNode(qnSuccessNode, [[en.Transition.A, qn2Graph.initial], [en.Transition.B, qn2Graph.initial]]);
        g.addNode(qnNoMatchNode, [[en.Transition.A, qn2Graph.initial], [en.Transition.B, qn2Graph.initial]]);
        g.addNode(qnNoInputNode, [[en.Transition.A, qn2Graph.initial], [en.Transition.B, qn2Graph.initial]]);
        g.addNode(qn2SuccessNode, [[en.Transition.A, Transition.Done], [en.Transition.B, Transition.Done]]);
        g.addNode(qn2NoMatchNode, [[en.Transition.A, Transition.Done], [en.Transition.B, Transition.Done]]);
        g.addNode(qn2NoInputNode, [[en.Transition.A, Transition.Done], [en.Transition.B, Transition.Done]]);

        g.finalize();
        return g;
    }
}

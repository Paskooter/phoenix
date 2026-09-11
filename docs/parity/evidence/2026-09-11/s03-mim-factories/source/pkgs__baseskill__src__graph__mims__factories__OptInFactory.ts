# jiboV2/pegasus:packages/baseskill/src/graph/mims/factories/OptInFactory.ts@5c0a7390539663ba749d360de348a428c088505c

import * as path from 'path';
import { GraphFactory } from '../../GraphFactory';
import { Graph } from '../../Graph';
import { GraphSkill } from '../../../GraphSkill';
import { isFunc } from '../utils/Utils';
import { generateTransitions } from '../../Utils';
import { MimFactoryOptions, OptInFactoryOptions, OptInType, MimDataFunc } from '../common/Types';
import { unifyMims } from '../utils/unify/Unify';
import { Data } from '../../nodes/Node';
import * as qn from './QNFactory';
import * as an from './ANFactory';
import * as yesno from '../nodes/optIn/YesNoWrongIDNode';
import * as route from '../nodes/optIn/RouteNode';
import * as dn from '../../nodes/DefaultNode';
import * as looper from '../../nodes/SetLooperIDNode';

const ROOT = require('find-root')(__dirname);

export enum Transition {
    Accepted = 'Accepted',
    NotInLoop = 'NotInLoop',
    Declined = 'Declined'
}

export enum MimPath {
    ProposalVerifyID = 'ProposalVerifyID',
    ProposalNoID = 'ProposalNoID',
    WrongID = 'WrongID',
    Decline = 'Decline',
}

export class OptInFactory implements GraphFactory {

    constructor(public name: string, private skill: GraphSkill, private options: OptInFactoryOptions) {
        // noop
    }

    /**
     * Builds a new instance of a Opt-In graph with all new instances of nodes
     */
    createGraph(): Graph<Transition> {
        const g = new Graph(this.name, generateTransitions<Transition>(Transition));

        const routeNode = new route.RouteNode('Router', this.options);
        const yesNoWrongIDNode = new yesno.YesNoWrongIDNode('Yes/No/Wrong ID', this.skill);
        const setLooperIDNode = new looper.SetLooperIDNode('Set Looper ID', this.skill);
        const acceptedNode = new dn.DefaultNode('Accepted');
        const notInLoopNode = new dn.DefaultNode('Not In Loop');
        const declinedNode = new dn.DefaultNode('Declined');

        /**
         * Function that will yield the path to the base MIM to be unified
         * with the skill's provided Opt-In MIM.
         */
        const baseProvider = (data: Data) => {
            const optInType = isFunc(this.options.optInType) ?
                this.options.optInType(data) : this.options.optInType;
            let mim: string;
            switch (optInType) {
                case OptInType.NO_ID:
                    mim = MimPath.ProposalNoID;
                    break;
                case OptInType.VERIFY_ID:
                    mim = MimPath.ProposalVerifyID;
                    break;
                default:
                    throw new Error(`Unknown Opt-In Type: '${optInType}'`);
            }
            return path.join(ROOT, 'mims', 'en-us', `${mim}.mim`);
        };
        const mimPath = (mimName: string) => path.join(ROOT, 'mims', 'en-us', `${mimName}.mim`);

        /**
         * Function that will yield the unified Opt-In Verify/No-Verify MIM from the base MIM
         * and the skill provided MIM and optional transform func.
         */
        const verifyMimProvider: MimDataFunc = async (data: Data) => {
            const optInData = {
                mimProvider: this.options && this.options.proposalMimProvider,
                transform: this.options && this.options.proposalTransform,
                baseProvider
            };
            return unifyMims(optInData, data);
        };
        const verifyOptions: MimFactoryOptions = {
            mimDataProvider: verifyMimProvider,
            promptDataProvider: this.options && this.options.promptDataProvider,
            viewDataProvider: this.options && this.options.viewDataProvider
        };

        const wrongOptions: MimFactoryOptions = {
            mimDataProvider: mimPath(MimPath.WrongID),
            promptDataProvider: this.options && this.options.promptDataProvider,
            viewDataProvider: this.options && this.options.viewDataProvider
        };

        /**
         * Function that will yield the unified Opt-In Decline MIM from the base MIM
         * and the skill provided MIM and optional transform func.
         */
        const declineMimProvider: MimDataFunc = async (data: Data) => {
            const declineData = {
                mimProvider: this.options && this.options.declineMimProvider,
                transform: this.options && this.options.declineTransform,
                baseProvider: mimPath(MimPath.Decline)
            };
            return unifyMims(declineData, data);
        };
        const declineOptions: MimFactoryOptions = {
            mimDataProvider: declineMimProvider,
            promptDataProvider: this.options && this.options.promptDataProvider,
            viewDataProvider: this.options && this.options.viewDataProvider,
            final: true
        };

        const verifyMIM = new qn.QNFactory('Verify MIM', verifyOptions).createGraph();
        const noVerifyMIM = new qn.QNFactory('No Verify MIM', verifyOptions).createGraph();
        const wrongIDMIM = new qn.QNFactory('Wrong ID MIM', wrongOptions).createGraph();
        const declineMIM = new an.ANFactory('Decline MIM', declineOptions).createGraph();

        g.addNode(routeNode, [
            [route.Transition.VerifyID, verifyMIM.initial],
            [route.Transition.NoID, noVerifyMIM.initial]
        ]);
        g.addSubGraph(verifyMIM, [
            [qn.Transition.Success, yesNoWrongIDNode],
            [qn.Transition.NoInput, yesNoWrongIDNode],
            [qn.Transition.NoMatch, yesNoWrongIDNode],
        ]);
        g.addSubGraph(noVerifyMIM, [
            [qn.Transition.Success, yesNoWrongIDNode],
            [qn.Transition.NoInput, yesNoWrongIDNode],
            [qn.Transition.NoMatch, yesNoWrongIDNode],
        ]);
        g.addNode(yesNoWrongIDNode, [
            [yesno.Transition.Yes, acceptedNode],
            [yesno.Transition.No, declineMIM.initial],
            [yesno.Transition.WrongID, wrongIDMIM.initial],
            [yesno.Transition.NoInput, declineMIM.initial],
            [yesno.Transition.NoMatch, declineMIM.initial],
        ]);
        g.addSubGraph(wrongIDMIM, [
            [qn.Transition.Success, setLooperIDNode],
            [qn.Transition.NoInput, declineMIM.initial],
            [qn.Transition.NoMatch, declineMIM.initial],
        ]);
        g.addNode(setLooperIDNode, [
            [looper.Transition.Cancel, declineMIM.initial],
            [looper.Transition.Success, acceptedNode],
            [looper.Transition.NotInLoop, notInLoopNode],
        ]);
        g.addSubGraph(declineMIM, [[an.Transition.Success, declinedNode]]);
        g.addNode(acceptedNode, [[dn.Transition.Done, Transition.Accepted]]);
        g.addNode(notInLoopNode, [[dn.Transition.Done, Transition.NotInLoop]]);
        g.addNode(declinedNode, [[dn.Transition.Done, Transition.Declined]]);

        g.finalize();
        return g;
    }
}
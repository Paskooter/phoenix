// Opt-In FSM — port of baseskill/graph/mims/factories/OptInFactory.ts and
// nodes/optIn/{RouteNode,YesNoWrongIDNode}.ts. The proactive opt-in flow: propose (with or
// without verifying the looper's identity), read yes/no/wrongID, recover identity via the
// WrongID MIM + SetLooperIDNode, and exit Accepted / NotInLoop / Declined. Base MIMs are the
// reference baseskill/mims/en-us/*.mim, vendored under resources/mims/base/en-us/.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Graph } from '../graph.js';
import { NoOpNode, DefaultNode, DefaultTransition, SetLooperIDNode, SetLooperIDTransition } from '../nodes.js';
import { isFunc } from './utils.js';
import { unifyMims } from './unify.js';
import { QNFactory, QNFactoryTransition, ANFactory, ANFactoryTransition } from './factories.js';

const BASE_MIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../resources/mims/base/en-us');

export const OptInType = Object.freeze({ NO_ID: 'NO_ID', VERIFY_ID: 'VERIFY_ID' });

export const OptInTransition = Object.freeze({ Accepted: 'Accepted', NotInLoop: 'NotInLoop', Declined: 'Declined' });

export const OptInMimPath = Object.freeze({
  ProposalVerifyID: 'ProposalVerifyID',
  ProposalNoID: 'ProposalNoID',
  WrongID: 'WrongID',
  Decline: 'Decline',
});

export const RouteTransition = Object.freeze({ VerifyID: 'VerifyID', NoID: 'NoID' });

/** Routes by opt-in type and snapshots the current speaker into session._optIn. (RouteNode.ts) */
export class RouteNode extends NoOpNode {
  constructor(name, options) {
    super(name, Object.values(RouteTransition));
    this.options = options;
  }

  async exit(data) {
    const optInType = isFunc(this.options.optInType) ? this.options.optInType(data) : this.options.optInType;

    let transition;
    switch (optInType) {
      case OptInType.NO_ID: transition = RouteTransition.NoID; break;
      case OptInType.VERIFY_ID: transition = RouteTransition.VerifyID; break;
      default: throw new Error(`Unknown Opt-In Type: '${optInType}'`);
    }

    data.skill.session.data._optIn = {};
    if (data.runtime && data.runtime.perception && data.runtime.perception.speaker) {
      data.skill.session.data._optIn.speaker = data.runtime.perception.speaker;
    }

    return { transition };
  }
}

export const YesNoWrongIDTransition = Object.freeze({ Yes: 'Yes', No: 'No', WrongID: 'WrongID', NoMatch: 'NoMatch', NoInput: 'NoInput' });

/** Reads the proposal answer; tracks the SKILL_OFFER analytics event. (YesNoWrongIDNode.ts) */
export class YesNoWrongIDNode extends NoOpNode {
  constructor(name, currentSkill) {
    super(name, Object.values(YesNoWrongIDTransition));
    this.currentSkill = currentSkill;
  }

  async exit(data) {
    const log = data.log;
    let transition;
    const nlu = data.result && data.result.nlu;
    const asr = data.result && data.result.asr;
    const failure = (nlu && nlu.intent) ? null
      : (data.result && data.result.noInput) ? 'no-input'
        : (data.result && data.result.noMatch) ? 'no-match'
          : null;

    if (!failure) {
      switch (nlu.intent) {
        case 'yes':
          transition = YesNoWrongIDTransition.Yes;
          if (data.skill.session.data._optIn.speaker && !(data.runtime.perception && data.runtime.perception.speaker)) {
            log?.info?.('Utilizing cached optIn speaker for ID.');
            if (!data.runtime.perception) data.runtime.perception = {};
            data.runtime.perception.speaker = data.skill.session.data._optIn.speaker;
          }
          break;
        case 'no': transition = YesNoWrongIDTransition.No; break;
        case 'wrongID': transition = YesNoWrongIDTransition.WrongID; break;
        default: throw new Error(`Unknown intent: '${nlu.intent}'`);
      }
    } else if (data.result.noMatch) {
      transition = YesNoWrongIDTransition.NoMatch;
    } else if (data.result.noInput) {
      transition = YesNoWrongIDTransition.NoInput;
    }

    // SKILL_OFFER analytics for the current skill (modality: touch vs speech vs n/a)
    try {
      this.currentSkill.track(data, 'SKILL_OFFER', {
        user_response: (nlu && nlu.intent) || failure,
        modality: failure ? 'n/a' : (nlu.intent && !(asr && asr.text)) ? 'touch' : 'speech',
      });
    } catch (err) {
      log?.error?.('Unable to track Offer analytics:', { error: err.message });
    }

    return { transition, result: data.result };
  }
}

/**
 * Opt-In graph factory. (OptInFactory.ts)
 * @param {string} name graph name
 * @param {object} skill the owning GraphSkill facade ({track, overrideSpeaker, addSequenceBehavior})
 * @param {object} options OptInFactoryOptions: optInType (+Func), proposalMimProvider,
 *   declineMimProvider, proposalTransform, declineTransform, promptDataProvider, viewDataProvider
 */
export class OptInFactory {
  constructor(name, skill, options) {
    this.name = name;
    this.skill = skill;
    this.options = options;
  }

  createGraph(gm) {
    const g = new Graph(gm, this.name, Object.values(OptInTransition));

    const routeNode = new RouteNode('Router', this.options);
    const yesNoWrongIDNode = new YesNoWrongIDNode('Yes/No/Wrong ID', this.skill);
    const setLooperIDNode = new SetLooperIDNode('Set Looper ID', this.skill);
    const acceptedNode = new DefaultNode('Accepted');
    const notInLoopNode = new DefaultNode('Not In Loop');
    const declinedNode = new DefaultNode('Declined');

    // Path to the base proposal MIM by opt-in type.
    const baseProvider = (data) => {
      const optInType = isFunc(this.options.optInType) ? this.options.optInType(data) : this.options.optInType;
      let mim;
      switch (optInType) {
        case OptInType.NO_ID: mim = OptInMimPath.ProposalNoID; break;
        case OptInType.VERIFY_ID: mim = OptInMimPath.ProposalVerifyID; break;
        default: throw new Error(`Unknown Opt-In Type: '${optInType}'`);
      }
      return join(BASE_MIM_DIR, `${mim}.mim`);
    };
    const mimPath = (mimName) => join(BASE_MIM_DIR, `${mimName}.mim`);

    // Unified proposal MIM (base + skill prompts/transform).
    const verifyMimProvider = async (data) => unifyMims({
      mimProvider: this.options && this.options.proposalMimProvider,
      transform: this.options && this.options.proposalTransform,
      baseProvider,
    }, data);
    const verifyOptions = {
      mimDataProvider: verifyMimProvider,
      promptDataProvider: this.options && this.options.promptDataProvider,
      viewDataProvider: this.options && this.options.viewDataProvider,
    };

    const wrongOptions = {
      mimDataProvider: mimPath(OptInMimPath.WrongID),
      promptDataProvider: this.options && this.options.promptDataProvider,
      viewDataProvider: this.options && this.options.viewDataProvider,
    };

    // Unified decline MIM.
    const declineMimProvider = async (data) => unifyMims({
      mimProvider: this.options && this.options.declineMimProvider,
      transform: this.options && this.options.declineTransform,
      baseProvider: mimPath(OptInMimPath.Decline),
    }, data);
    const declineOptions = {
      mimDataProvider: declineMimProvider,
      promptDataProvider: this.options && this.options.promptDataProvider,
      viewDataProvider: this.options && this.options.viewDataProvider,
      final: true,
    };

    const verifyMIM = new QNFactory('Verify MIM', verifyOptions).createGraph(gm);
    const noVerifyMIM = new QNFactory('No Verify MIM', verifyOptions).createGraph(gm);
    const wrongIDMIM = new QNFactory('Wrong ID MIM', wrongOptions).createGraph(gm);
    const declineMIM = new ANFactory('Decline MIM', declineOptions).createGraph(gm);

    g.addNode(routeNode, [
      [RouteTransition.VerifyID, verifyMIM.initial],
      [RouteTransition.NoID, noVerifyMIM.initial],
    ]);
    g.addSubGraph(verifyMIM, [
      [QNFactoryTransition.Success, yesNoWrongIDNode],
      [QNFactoryTransition.NoInput, yesNoWrongIDNode],
      [QNFactoryTransition.NoMatch, yesNoWrongIDNode],
    ]);
    g.addSubGraph(noVerifyMIM, [
      [QNFactoryTransition.Success, yesNoWrongIDNode],
      [QNFactoryTransition.NoInput, yesNoWrongIDNode],
      [QNFactoryTransition.NoMatch, yesNoWrongIDNode],
    ]);
    g.addNode(yesNoWrongIDNode, [
      [YesNoWrongIDTransition.Yes, acceptedNode],
      [YesNoWrongIDTransition.No, declineMIM.initial],
      [YesNoWrongIDTransition.WrongID, wrongIDMIM.initial],
      [YesNoWrongIDTransition.NoInput, declineMIM.initial],
      [YesNoWrongIDTransition.NoMatch, declineMIM.initial],
    ]);
    g.addSubGraph(wrongIDMIM, [
      [QNFactoryTransition.Success, setLooperIDNode],
      [QNFactoryTransition.NoInput, declineMIM.initial],
      [QNFactoryTransition.NoMatch, declineMIM.initial],
    ]);
    g.addNode(setLooperIDNode, [
      [SetLooperIDTransition.Cancel, declineMIM.initial],
      [SetLooperIDTransition.Success, acceptedNode],
      [SetLooperIDTransition.NotInLoop, notInLoopNode],
    ]);
    g.addSubGraph(declineMIM, [[ANFactoryTransition.Success, declinedNode]]);
    g.addNode(acceptedNode, [[DefaultTransition.Done, OptInTransition.Accepted]]);
    g.addNode(notInLoopNode, [[DefaultTransition.Done, OptInTransition.NotInLoop]]);
    g.addNode(declinedNode, [[DefaultTransition.Done, OptInTransition.Declined]]);

    g.finalize();
    return g;
  }
}

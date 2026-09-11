#!/usr/bin/env node
// S-03 runtime replay — MIM factories, no-input/no-match escalation and opt-in.
//
// Drives the REAL Phoenix skills HTTP service (createSkillService + node:http) with
// frozen robot-shaped LISTEN_LAUNCH / LISTEN_UPDATE turns and asserts the source
// suites' observable outputs:
//
//   * MIMSkill.test.ts (pinned jiboV2/pegasus@5c0a739
//     packages/baseskill/tests/MIMSkill.test.ts) — the four runs (Successful, NoMatch,
//     NoInput, Degenerate) with their exact session.nodeID sequence and session.trace
//     arrays for the ExampleMIMSkill graph assembled from ANFactory + MANFactory +
//     two QNFactory subgraphs. Node identity is assigned by construction order, which
//     this harness reproduces.
//   * OptInSkill.test.ts — the Opt-In factory session branches (proposal No-ID vs
//     Verify-ID, fused prompts, yes, no, wrongID, cancel, notInLoop, no-input and
//     no-match escalation to decline, loopmember identity fix).
//
// The ExampleMIMSkill / ExampleOptInSkill harness MIM bodies live in the source
// repo's gitignored res_test/mims and are NOT in the archive; this harness uses
// equivalent fixtures (same categories/sub-categories/index ladder) so the
// STRUCTURAL oracle (nodeID/trace/transition/final/mim identity) is pinned while
// prompt-id-specific assertions on those fixtures are marked INFERRED.
//
// Usage: node scripts/parity-s03/replay-mim-factories.mjs [outPath]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGraphSkill, createSkillService, Graph, FnNode,
  mimFactories, OptInFactory, OptInType, OptInTransition, nodes,
} from '../../packages/skills/src/index.js';

const { DefaultNode, DefaultTransition } = nodes;

const { ANFactory, MANFactory, QNFactory } = mimFactories;

// --- fixtures (equivalent to res_test/mims; see header) ---------------------

const prompt = (o) => ({
  prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 1, condition: '',
  prompt: 'pick', media: 'TTS', prompt_id: 'p', weight: 1, auto_rule_override: null, ...o,
});
const anPrompt = (id, esml, condition = '') => ({
  prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 1, condition,
  prompt: esml, media: 'TTS', prompt_id: id, weight: 1, auto_rule_override: null,
});

// Uber.mim: QN with NM ladder 1..3 and one NI step.
const UBER = {
  mim_id: 'Uber', mim_type: 'question', rule_name: 'uber/rule', es_auto_tagging: true, prompts: [
    prompt({ prompt_sub_category: 'Q', prompt_id: 'uber_q', prompt: 'ask' }),
    prompt({ prompt_category: 'Errors', prompt_sub_category: 'NM', index: 1, prompt_id: 'uber_nm_1' }),
    prompt({ prompt_category: 'Errors', prompt_sub_category: 'NM', index: 2, prompt_id: 'uber_nm_2' }),
    prompt({ prompt_category: 'Errors', prompt_sub_category: 'NM', index: 3, prompt_id: 'uber_nm_3' }),
    prompt({ prompt_category: 'Errors', prompt_sub_category: 'NI', index: 1, prompt_id: 'uber_ni_1' }),
  ],
};
// NoNMNI.mim: QN with no NM/NI ladder at all.
const NO_NM_NI = {
  mim_id: 'NoNMNI', mim_type: 'question', rule_name: 'nonmni/rule', es_auto_tagging: true,
  prompts: [prompt({ prompt_sub_category: 'Q', prompt_id: 'nonmni_q', prompt: 'ask2' })],
};
const AN = (id, esml) => ({ mim_id: id, mim_type: 'announcement', es_auto_tagging: true, prompts: [anPrompt(`${id}_an`, esml)] });

// --- ExampleMIMSkill (source tests/skills/ExampleMIMSkill.ts) ---------------

const fakeSlim = (data, label) => ({ action: nodes.generateJCPAction({ id: `${label}-${data.skill.session.nodeID}`, type: 'SLIM', config: { play: { id: 'p', type: 'PLAY', esml: label } } }) });

function buildExampleMimSkill(gm) {
  const g = new Graph(gm, 'Main Skill Graph', ['Done']);

  const anGraph = new ANFactory('AN MIM', { mimDataProvider: AN('Uber4', 'a1'), rng: () => 0 }).createGraph(gm);
  const manGraph = new MANFactory('Multiple AN MIMs', { mimDataProvider: [AN('Uber2', 'm1'), AN('Uber3', 'm2')], rng: () => 0 }).createGraph(gm);
  const qnGraph = new QNFactory('QN MIM', { mimDataProvider: () => UBER, rng: () => 0 }).createGraph(gm);
  const qn2Graph = new QNFactory('QN2 MIM', { mimDataProvider: () => NO_NM_NI, rng: () => 0 }).createGraph(gm);

  const example = (name, label) => new FnNode(name, {
    transitions: ['a', 'b'],
    enter: (data) => fakeSlim(data, label),
    exit: () => ({ transition: 'a' }),
  });
  const anSuccess = example('Success', 'an-ok');
  const manSuccess = example('Success', 'man-ok');
  const qnSuccess = example('Success', 'qn-ok');
  const qnNoMatch = example('NoMatch', 'qn-nomatch');
  const qnNoInput = example('NoInput', 'qn-noinput');
  const qn2Success = example('QN2 Success', 'qn2-ok');
  const qn2NoMatch = example('QN2 NoMatch', 'qn2-nomatch');
  const qn2NoInput = example('QN2 NoInput', 'qn2-noinput');

  g.addSubGraph(anGraph, [[mimFactories.ANFactoryTransition.Success ?? 'Success', anSuccess]]);
  g.addSubGraph(manGraph, [[mimFactories.MANFactoryTransition.Success ?? 'Success', manSuccess]]);
  g.addSubGraph(qnGraph, [
    [mimFactories.QNFactoryTransition.Success, qnSuccess],
    [mimFactories.QNFactoryTransition.NoMatch, qnNoMatch],
    [mimFactories.QNFactoryTransition.NoInput, qnNoInput],
  ]);
  g.addSubGraph(qn2Graph, [
    [mimFactories.QNFactoryTransition.Success, qn2Success],
    [mimFactories.QNFactoryTransition.NoMatch, qn2NoMatch],
    [mimFactories.QNFactoryTransition.NoInput, qn2NoInput],
  ]);

  g.addNode(anSuccess, [['a', manGraph.initial], ['b', manGraph.initial]]);
  g.addNode(manSuccess, [['a', qnGraph.initial], ['b', qnGraph.initial]]);
  g.addNode(qnSuccess, [['a', qn2Graph.initial], ['b', qn2Graph.initial]]);
  g.addNode(qnNoMatch, [['a', qn2Graph.initial], ['b', qn2Graph.initial]]);
  g.addNode(qnNoInput, [['a', qn2Graph.initial], ['b', qn2Graph.initial]]);
  g.addNode(qn2Success, [['a', 'Done'], ['b', 'Done']]);
  g.addNode(qn2NoMatch, [['a', 'Done'], ['b', 'Done']]);
  g.addNode(qn2NoInput, [['a', 'Done'], ['b', 'Done']]);

  g.finalize();
  return g;
}

const listenData = (intent, asrText = '') => ({ nlu: { rules: [], intent, entities: {} }, asr: { text: asrText, confidence: 1 } });

function general() {
  return { general: { accountID: 'a', robotID: 'r', lang: 'en-US' } };
}
function runtime() {
  return {
    location: { iso: '2020-01-15T12:00:00.000Z' }, perception: { speaker: 'alice' },
    loop: { owner: 'alice', users: [{ id: 'alice', firstName: 'Alice', lastName: 'Smith' }], jibo: { id: 'jibo' } },
    character: { emotion: { name: 'NEUTRAL' } }, dialog: { referent: null },
  };
}

// The four source runs: [result|null] per turn after the launch.
const MIM_RUNS = [
  {
    name: 'MIMSkill / Successful run (MIMSkill.test.ts:41-100)',
    turns: [
      null,
      null,
      null,
      null,
      listenData('someIntent', 'some asr text'),
    ],
    nodes: [0, 8, 1, 9, 2, 10],
    traces: [
      [{ nodeID: 0, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'Success' }, { nodeID: 10, transition: null }],
    ],
  },
  {
    name: 'MIMSkill / NoMatch run (MIMSkill.test.ts:102-178)',
    turns: [null, null, null, null, listenData(null, 'some asr text'), listenData('someIntent', 'some asr text')],
    nodes: [0, 8, 1, 9, 2, 3, 10],
    traces: [
      [{ nodeID: 0, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoMatch' }, { nodeID: 3, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoMatch' }, { nodeID: 3, transition: 'Success' }, { nodeID: 10, transition: null }],
    ],
  },
  {
    name: 'MIMSkill / NoInput run (MIMSkill.test.ts:180-256)',
    turns: [null, null, null, null, listenData(null, ''), listenData('someIntent', 'some asr text')],
    nodes: [0, 8, 1, 9, 2, 4, 10],
    traces: [
      [{ nodeID: 0, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'Success' }, { nodeID: 10, transition: null }],
    ],
  },
  {
    name: 'MIMSkill / Degenerate run (MIMSkill.test.ts:258-433)',
    turns: [
      null, null, null, null,
      listenData(null, ''),
      listenData(null, 'some asr text'),
      listenData(null, 'some asr text'),
      listenData(null, 'some asr text'),
      listenData(null, 'some asr text'),
      null,
      listenData(null, 'some asr text'),
    ],
    nodes: [0, 8, 1, 9, 2, 4, 3, 3, 3, 11, 5, 14],
    traces: [
      [{ nodeID: 0, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'NoMatch' }, { nodeID: 3, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'FinalNoMatch' }, { nodeID: 11, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'FinalNoMatch' }, { nodeID: 11, transition: 'a' }, { nodeID: 5, transition: null }],
      [{ nodeID: 0, transition: 'Success' }, { nodeID: 8, transition: 'a' }, { nodeID: 1, transition: 'Success' }, { nodeID: 9, transition: 'a' }, { nodeID: 2, transition: 'NoInput' }, { nodeID: 4, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'NoMatch' }, { nodeID: 3, transition: 'FinalNoMatch' }, { nodeID: 11, transition: 'a' }, { nodeID: 5, transition: 'NoMatch' }, { nodeID: 6, transition: 'FinalNoMatch' }, { nodeID: 14, transition: null }],
    ],
  },
];

// --- OptIn (source tests/skills/ExampleOptInSkill.ts + OptInSkill.test.ts) ---

const VERIFY_TEST = {
  mim_id: 'VerifyTest', mim_type: 'question',
  prompts: [prompt({ prompt_id: 'Verify_Test', prompt: 'want your report?' })],
};
const DECLINE_TEST = {
  mim_id: 'DeclineTest', mim_type: 'announcement',
  prompts: [anPrompt('Decline_Test', 'okay then.')],
};
// AfterOptIn: the archived res_test body is unavailable; the accepted/not-in-loop
// split is modelled on the base MIM condition style (!speaker vs !!speaker), which
// reproduces the source expectations. Marked INFERRED (fixture-derived).
const AFTER_OPT_IN = {
  mim_id: 'AfterOptIn', mim_type: 'announcement',
  prompts: [
    anPrompt('AfterOptIn_AN_01', 'the ghoti is a fish.', '!speaker'),
    anPrompt('AfterOptIn_AN_02', 'the ghoti is a fish.', '!!speaker'),
  ],
};

const slimOf = (r) => {
  const jcp = r.data.action.config.jcp;
  return jcp.type === 'SLIM' ? jcp : jcp.children.find((c) => c.type === 'SLIM');
};
const playOf = (r) => slimOf(r).config.play;

// First response whose SLIM is the decline MIM (0 = none). Used where the number of
// escalation turns depends on the unarchived res_test fixtures' Errors ladder.
const firstDecline = (rs) => rs.findIndex((r) => {
  try { return playOf(r).meta.mim_id.includes('OptInDecline'); } catch { return false; }
});

function buildExampleOptInSkill({ optInType }) {
  return (gm, facade) => {
    const g = new Graph(gm, 'Main Skill Graph', ['Done']);
    const start = new DefaultNode('Start');
    const declined = new DefaultNode('Declined');
    const accepted = new DefaultNode('Accepted');
    const notInLoop = new DefaultNode('Not In Loop');
    const complete = new DefaultNode('Complete');
    const optIn = new OptInFactory('Opt-In', facade, {
      proposalMimProvider: VERIFY_TEST, declineMimProvider: DECLINE_TEST, optInType,
    }).createGraph(gm);
    const realThing = new ANFactory('Real Thing', { mimDataProvider: AFTER_OPT_IN, final: true, rng: () => 0 }).createGraph(gm);

    g.addNode(start, [[DefaultTransition.Done, optIn.initial]]);
    g.addSubGraph(optIn, [
      [OptInTransition.Declined, declined],
      [OptInTransition.Accepted, accepted],
      [OptInTransition.NotInLoop, notInLoop],
    ]);
    g.addNode(declined, [['Done', 'Done']]);
    g.addNode(notInLoop, [['Done', realThing.initial]]);
    g.addNode(accepted, [['Done', realThing.initial]]);
    g.addSubGraph(realThing, [[mimFactories.ANFactoryTransition.Success, complete]]);
    g.addNode(complete, [['Done', 'Done']]);
    g.finalize();
    return g;
  };
}

// Each scenario: turns are intents with asr text. Assertions are functions over the
// final response (and any intermediate responses needed).
const OPTIN_SCENARIOS = [
  {
    name: 'OptIn / type OPT_IN offers non-verify-id MIM (OptInSkill.test.ts:64-71)',
    optInType: OptInType.NO_ID,
    turns: [],
    check: (rs) => [['mim_id includes OptInProposalNoID', playOf(rs[0]).meta.mim_id.includes('OptInProposalNoID')]],
  },
  {
    name: 'OptIn / type OPT_IN_VERIFY_ID offers verify-id MIM (OptInSkill.test.ts:83-90)',
    optInType: OptInType.VERIFY_ID,
    turns: [],
    check: (rs) => [
      ['mim_id includes OptInProposalVerifyID', playOf(rs[0]).meta.mim_id.includes('OptInProposalVerifyID')],
      ['prompt_id includes Verify_Test', playOf(rs[0]).meta.prompt_id.includes('Verify_Test')],
    ],
  },
  {
    name: "OptIn / play skill's MIM if correct user (OptInSkill.test.ts:102-112)",
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: 'yes', text: 'yes' }],
    check: (rs) => [
      ['final', rs[1].data.final === true],
      ['slIM mim_id includes AfterOptIn', playOf(rs[1]).meta.mim_id.includes('AfterOptIn')],
    ],
  },
  {
    name: 'OptIn / play WrongID MIM if wrong user (OptInSkill.test.ts:114-124)',
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: 'wrongID', text: 'not me' }],
    check: (rs) => [
      ['mim_id includes OptInWrongID', playOf(rs[1]).meta.mim_id.includes('OptInWrongID')],
      ['prompt_id includes WrongID', playOf(rs[1]).meta.prompt_id.includes('WrongID')],
    ],
  },
  {
    name: "OptIn / play fused Decline MIM if 'no' (OptInSkill.test.ts:126-137)",
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: 'no', text: 'no' }],
    check: (rs) => [
      ['mim_id includes OptInDecline', playOf(rs[1]).meta.mim_id.includes('OptInDecline')],
      ['prompt_id includes Decline_Test', playOf(rs[1]).meta.prompt_id.includes('Decline_Test')],
      ['final', rs[1].data.final === true],
    ],
  },
  {
    name: 'OptIn / play fused Decline MIM if no input (OptInSkill.test.ts:139-152)',
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: undefined, text: '' }, { intent: undefined, text: '' }],
    // The source answer count (2) is a property of the unarchived res_test OptInVerify
    // fixture's Errors ladder; the pinned base OptInProposalVerifyID.mim has zero
    // Errors-category prompts, so the FinalNoInput exit is reached on the first
    // no-input answer. Assert the branch, not the turn index.
    check: (rs) => {
      const hit = firstDecline(rs);
      return [
        ['decline MIM reached (FinalNoInput -> yes/no NoInput -> decline)', hit > 0],
        ['decline prompt is the fused Decline_Test', hit > 0 && playOf(rs[hit]).meta.prompt_id.includes('Decline_Test')],
        ['decline is final', hit > 0 && rs[hit].data.final === true],
      ];
    },
  },
  {
    name: 'OptIn / play fused Decline MIM if no match (OptInSkill.test.ts:154-167)',
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: undefined, text: 'bananas' }, { intent: undefined, text: 'bananas' }],
    check: (rs) => {
      const hit = firstDecline(rs);
      return [
        ['decline MIM reached (FinalNoMatch -> yes/no NoMatch -> decline)', hit > 0],
        ['decline prompt is the fused Decline_Test', hit > 0 && playOf(rs[hit]).meta.prompt_id.includes('Decline_Test')],
        ['decline is final', hit > 0 && rs[hit].data.final === true],
      ];
    },
  },
  {
    name: "OptIn / play skill's MIM if user not in loop (OptInSkill.test.ts:169-181)",
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: 'wrongID', text: 'not me' }, { intent: 'notInLoop', text: 'i am not in the loop' }],
    check: (rs) => [
      ['final', rs[2].data.final === true],
      ['slIM mim_id includes AfterOptIn', playOf(rs[2]).meta.mim_id.includes('AfterOptIn')],
    ],
  },
  {
    name: 'OptIn / play Decline MIM if user cancels out of fixing ID (OptInSkill.test.ts:183-196)',
    optInType: OptInType.VERIFY_ID,
    turns: [{ intent: 'wrongID', text: 'not me' }, { intent: 'cancel', text: 'cancel' }],
    check: (rs) => [
      ['mim_id includes OptInDecline', playOf(rs[2]).meta.mim_id.includes('OptInDecline')],
      ['prompt_id includes Decline_Test', playOf(rs[2]).meta.prompt_id.includes('Decline_Test')],
      ['final', rs[2].data.final === true],
    ],
  },
  {
    name: "OptIn / add present person behavior if user fixes ID (OptInSkill.test.ts:198-220)",
    optInType: OptInType.VERIFY_ID,
    turns: [
      { intent: 'wrongID', text: 'not me' },
      { intent: 'loopmember', text: 'George Jetson', entities: { 'given-name': 'George', 'last-name': 'Jetson', loopMemberReferent: 'u-owner' } },
    ],
    check: (rs) => {
      const jcp = rs[2].data.action.config.jcp;
      const kids = jcp.type === 'SEQUENCE' ? jcp.children : [];
      const setPerson = kids.find((c) => c.type === 'SET_PRESENT_PERSON');
      const slim = kids.find((c) => c.type === 'SLIM');
      return [
        ['jcp is a SEQUENCE', jcp.type === 'SEQUENCE'],
        ['2+ children', kids.length === 2],
        ['SET_PRESENT_PERSON looperId', !!setPerson && setPerson.looperId === 'u-owner'],
        ['SET_PRESENT_PERSON source USER_OVERRIDE', !!setPerson && setPerson.source === 'USER_OVERRIDE'],
        ['SLIM mim_id includes AfterOptIn', !!slim && slim.config.play.meta.mim_id.includes('AfterOptIn')],
        ['final', rs[2].data.final === true],
      ];
    },
  },
];

// --- runner -----------------------------------------------------------------

async function startService(handler, skillId) {
  const service = createSkillService({ name: 's03-replay', skillId, handler });
  const server = await service.listen(0);
  const port = server.address().port;
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/${skillId}/main`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, post };
}

async function runMimRuns(results) {
  const skill = createGraphSkill({ name: 'ExampleMIMSkill', build: (gm) => buildExampleMimSkill(gm) });
  const { server, post } = await startService(skill, 'ExampleMIMSkill');
  try {
    for (const run of MIM_RUNS) {
      const checks = [];
      let session;
      const launchRes = await post({ type: 'LISTEN_LAUNCH', msgID: 'm', ts: 1, data: { ...general(), runtime: runtime(), skill: { id: 'ExampleMIMSkill' } } });
      let resp = launchRes.body;
      checks.push(['launch nodeID 0', resp.data.skill.session.nodeID === 0]);
      const traceOf = () => resp.data.skill.session.trace;
      const nodeOf = () => resp.data.skill.session.nodeID;
      // record node sequence
      const observedNodes = [nodeOf()];
      const observedTraces = [traceOf()];
      session = resp.data.skill.session;
      for (const turn of run.turns) {
        const body = {
          type: 'LISTEN_UPDATE', msgID: 'm', ts: 2,
          data: { ...general(), runtime: runtime(), skill: { id: 'ExampleMIMSkill', session } },
        };
        if (turn) body.data.result = turn;
        resp = (await post(body)).body;
        observedNodes.push(nodeOf());
        observedTraces.push(traceOf());
        session = resp.data.skill.session;
      }
      checks.push(['nodeID sequence', JSON.stringify(observedNodes) === JSON.stringify(run.nodes)]);
      const tracesOk = JSON.stringify(observedTraces) === JSON.stringify(run.traces);
      checks.push(['trace sequences', tracesOk]);
      results.push({
        scenario: run.name, kind: 'mim', pass: checks.every(([, ok]) => ok), checks,
        observed: tracesOk ? undefined : { observedNodes, observedTraces, expectedNodes: run.nodes, expectedTraces: run.traces },
      });
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function runOptInScenarios(results) {
  for (const sc of OPTIN_SCENARIOS) {
    const skill = createGraphSkill({ name: 'opt-in-test-skill', build: buildExampleOptInSkill({ optInType: sc.optInType }) });
    const { server, post } = await startService(skill, 'opt-in-test-skill');
    try {
      const rs = [];
      let session;
      const launchRes = await post({
        type: 'PROACTIVE_LAUNCH', msgID: 'm', ts: 1,
        data: { ...general(), runtime: runtime(), skill: { id: 'opt-in-test-skill' } },
      });
      let resp = launchRes.body;
      rs.push(resp);
      session = resp.data.skill.session;
      for (const turn of sc.turns) {
        const result = { nlu: { rules: [], intent: turn.intent, entities: turn.entities || {} }, asr: { text: turn.text, confidence: 1 } };
        resp = (await post({
          type: 'LISTEN_UPDATE', msgID: 'm', ts: 2,
          data: { ...general(), runtime: runtime(), skill: { id: 'opt-in-test-skill', session }, result },
        })).body;
        rs.push(resp);
        session = resp.data.skill.session;
      }
      let checks;
      try { checks = sc.check(rs); } catch (err) { checks = [[`check threw: ${err.message}`, false]]; }
      const observed = rs.map((r) => {
        try {
          const jcp = r.data.action && r.data.action.config.jcp;
          const slim = jcp && (jcp.type === 'SLIM' ? jcp : (jcp.children || []).find((c) => c.type === 'SLIM'));
          return { nodeID: r.data.skill.session.nodeID, jcp: jcp && jcp.type, mim: slim && slim.config.play.meta.mim_id, pid: slim && slim.config.play.meta.prompt_id, final: r.data.final, action: r.data.action ? 'yes' : null };
        } catch { return { err: r.data && r.data.type }; }
      });
      results.push({ scenario: sc.name, kind: 'optin', pass: checks.every(([, ok]) => ok), checks, observed });
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
}

async function main() {
  const results = [];
  await runMimRuns(results);
  await runOptInScenarios(results);

  const checks = results.flatMap((r) => r.checks);
  const passed = checks.filter(([, ok]) => ok).length;
  const failed = checks.length - passed;
  const report = {
    task: 'S-03',
    generatedAt: new Date().toISOString(),
    method: 'live skills HTTP service (createSkillService) + frozen turns',
    sourceSuites: [
      'jiboV2/pegasus@5c0a739 packages/baseskill/tests/MIMSkill.test.ts',
      'jiboV2/pegasus@5c0a739 packages/baseskill/tests/OptInSkill.test.ts',
    ],
    scenarios: results.length,
    checks: checks.length,
    passed,
    failed,
    differences: failed ? checks.filter(([, ok]) => !ok).map(([name]) => name) : [],
    results,
  };
  const out = process.argv[2];
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}`);
    for (const [name, ok] of r.checks) if (!ok) console.log(`        - ${name}`);
    if (r.observed && r.kind === 'mim') console.log(`        observedNodes=${JSON.stringify(r.observed.observedNodes)}`);
  }
  console.log(`\nscenarios ${results.length}, checks ${checks.length}: ${passed}/${checks.length} pass, ${failed} fail`);
  console.log(failed ? 'RESULT: DIFFERENCES' : 'RESULT: OK');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((err) => { console.error(err); process.exit(2); });

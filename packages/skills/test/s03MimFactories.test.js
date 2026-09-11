// S-03 — MIM factories, no-input/no-match escalation and opt-in behavior.
//
// Focused branch coverage for the ported baseskill MIM library:
//   * factories.js — MIMFactory/QNFactory/ANFactory/MANFactory assembled graphs, the
//     NM/NI escalation loop (Success / NoMatch / NoInput / FinalNoMatch / FinalNoInput,
//     including the cross-escalation NI->NM and NM->NI), RouterNode routing and its
//     error branches, and the frozen session `_mim` state machine.
//   * optIn.js — routing, yes/no/wrongID/cancel/notInLoop, unknown intents, proposal
//     MIM selection (No-ID vs Verify-ID), the cached-speaker restore, and the loop-member
//     -> SetPresentPerson / dialog-referent handoff.
//
// Oracle: pinned jiboV2/pegasus@5c0a739 packages/baseskill/src/graph/mims/{factories,nodes}
// and the source suites tests/{MIMSkill,OptInSkill}.test.ts. Tests import the package under
// test relatively (`.parity` worktree node_modules is a symlink to the main checkout).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRequestType } from '@phoenix/contracts';
import {
  createGraphSkill, createSkillService, Graph, FnNode,
  mimFactories, nodes, OptInFactory, OptInType, OptInTransition,
} from '../src/index.js';
import { RouteTransition, YesNoWrongIDTransition, OptInMimPath } from '../src/graph/mims/optIn.js';
import { SetLooperIDTransition } from '../src/graph/nodes.js';

const {
  MIMFactory, MIMFactoryTransition,
  QNFactory, QNFactoryTransition,
  ANFactory, ANFactoryTransition,
  MANFactory, MANFactoryTransition,
  NMTransition, NITransition, RouterTransition,
} = mimFactories;

// --- fixtures ---------------------------------------------------------------

// Question MIM with a two-step NM ladder and a one-step NI ladder so the escalation
// terminal branches are reachable (source Uber.mim shape).
const QN_MIM = {
  mim_id: 'TestQN', mim_type: 'question', rule_name: 'test/rule', es_auto_tagging: true,
  prompts: [
    { prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 1, condition: '', prompt: 'what color?', media: 'TTS', prompt_id: 'q1', weight: 1, auto_rule_override: null },
    { prompt_category: 'Errors', prompt_sub_category: 'NM', index: 1, condition: '', prompt: 'nm one', media: 'TTS', prompt_id: 'nm1', weight: 1, auto_rule_override: null },
    { prompt_category: 'Errors', prompt_sub_category: 'NM', index: 2, condition: '', prompt: 'nm two', media: 'TTS', prompt_id: 'nm2', weight: 1, auto_rule_override: null },
    { prompt_category: 'Errors', prompt_sub_category: 'NI', index: 1, condition: '', prompt: 'ni one', media: 'TTS', prompt_id: 'ni1', weight: 1, auto_rule_override: null },
  ],
};

const AN_MIM = (id, text, extra = {}) => ({
  mim_id: id, mim_type: 'announcement', es_auto_tagging: true,
  prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 1, condition: '', prompt: text, media: 'TTS', prompt_id: `${id}-an`, weight: 1, auto_rule_override: null }],
  ...extra,
});

function makeRuntime({ speaker = 'alice' } = {}) {
  return {
    location: { iso: '2020-01-15T12:00:00.000Z' },
    perception: speaker ? { speaker } : {},
    loop: {
      owner: 'alice',
      jibo: { id: 'jibo', birthdate: Date.parse('2017-05-19T15:27:05.000Z'), color: 'WHITE' },
      users: [{
        id: 'alice', firstName: 'Alice', lastName: 'Smith', gender: 'female', phoneticName: 'Alice',
        birthdate: Date.parse('1990-01-01T00:00:00.000Z'),
      }],
    },
    character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } },
    dialog: { referent: null },
  };
}

const ctx = (skillID, runtime = makeRuntime()) => ({ general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime, skill: { id: skillID } });
const launch = (skillID, extra = {}, runtime = makeRuntime()) => ({ type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1, data: { ...ctx(skillID, runtime), ...extra } });
const update = (skillID, session, result, runtime = makeRuntime()) => ({
  type: SkillRequestType.LISTEN_UPDATE, msgID: 'm', ts: 2,
  data: { ...ctx(skillID, runtime), skill: { id: skillID, session }, result },
});

const slimOf = (resp) => {
  const jcp = resp.data.action.config.jcp;
  return jcp.type === 'SLIM' ? jcp : jcp.children.find((c) => c.type === 'SLIM');
};
const playOf = (resp) => slimOf(resp).config.play;
const esmlOf = (resp) => playOf(resp).esml;
const mimOf = (resp) => playOf(resp).meta.mim_id;
const pidOf = (resp) => playOf(resp).meta.prompt_id;

const noMatch = { nlu: { intent: null, entities: {} }, asr: { text: 'mumble' } };
const noInput = { nlu: { intent: null, entities: {} }, asr: { text: '' } };

// --- transition tables (source enums) --------------------------------------

test('S-03 factories: exit transition tables match the source enums', () => {
  assert.deepEqual(Object.values(MIMFactoryTransition), ['Success', 'NoMatch', 'NoInput']);
  assert.deepEqual(Object.values(QNFactoryTransition), ['Success', 'NoMatch', 'NoInput']);
  assert.deepEqual(Object.values(ANFactoryTransition), ['Success']);
  assert.deepEqual(Object.values(MANFactoryTransition), ['Success']);
  assert.deepEqual(Object.values(NMTransition), ['Success', 'NoMatch', 'NoInput', 'FinalNoMatch']);
  assert.deepEqual(Object.values(NITransition), ['Success', 'NoMatch', 'NoInput', 'FinalNoInput']);
  assert.deepEqual(Object.values(RouterTransition), ['Question', 'Announcement']);
  assert.deepEqual(Object.values(OptInTransition), ['Accepted', 'NotInLoop', 'Declined']);
  assert.deepEqual(Object.values(RouteTransition), ['VerifyID', 'NoID']);
  assert.deepEqual(Object.values(YesNoWrongIDTransition), ['Yes', 'No', 'WrongID', 'NoMatch', 'NoInput']);
  assert.deepEqual(Object.values(SetLooperIDTransition), ['Cancel', 'Success', 'NotInLoop']);
  assert.deepEqual(Object.values(OptInMimPath), ['ProposalVerifyID', 'ProposalNoID', 'WrongID', 'Decline']);
});

// --- MIMFactory -------------------------------------------------------------

const mimSkill = (options) => createGraphSkill({
  name: 'mim-skill',
  build: (gm) => new MIMFactory('test', options).createGraph(gm),
});

test('S-03 MIMFactory: question MIM takes the QN arm and Success exits the MIM', async () => {
  const skill = mimSkill({ mimDataProvider: QN_MIM, rng: () => 0 });
  const r1 = await skill(launch('mim-skill'));
  assert.equal(r1.data.final, false);
  assert.equal(esmlOf(r1), 'what color?');
  const r2 = await skill(update('mim-skill', r1.data.skill.session, { nlu: { intent: 'color', entities: { color: 'blue' } }, asr: { text: 'blue' } }));
  assert.equal(r2.data.action, null);
  assert.equal(r2.data.final, true, 'MIM Success exit is terminal');
});

test('S-03 MIMFactory: NoMatch ladder then FinalNoMatch exits the MIM as NoMatch', async () => {
  const skill = mimSkill({ mimDataProvider: QN_MIM, rng: () => 0 });
  const r1 = await skill(launch('mim-skill'));
  const r2 = await skill(update('mim-skill', r1.data.skill.session, noMatch));
  assert.equal(esmlOf(r2), 'nm one');
  const r3 = await skill(update('mim-skill', r2.data.skill.session, noMatch));
  assert.equal(esmlOf(r3), 'nm two');
  const r4 = await skill(update('mim-skill', r3.data.skill.session, noMatch));
  assert.equal(r4.data.action, null, 'NM ladder exhausted -> FinalNoMatch -> MIM NoMatch exit');
  assert.equal(r4.data.final, true);
});

test('S-03 MIMFactory: NoInput ladder then FinalNoInput exits the MIM as NoInput', async () => {
  const noNm = { ...QN_MIM, prompts: QN_MIM.prompts.filter((p) => p.prompt_sub_category !== 'NM') };
  const skill = mimSkill({ mimDataProvider: noNm, rng: () => 0 });
  const r1 = await skill(launch('mim-skill'));
  const r2 = await skill(update('mim-skill', r1.data.skill.session, noInput));
  assert.equal(esmlOf(r2), 'ni one');
  const r3 = await skill(update('mim-skill', r2.data.skill.session, noInput));
  assert.equal(r3.data.action, null, 'NI ladder exhausted -> FinalNoInput -> MIM NoInput exit');
  assert.equal(r3.data.final, true);
});

// --- QNFactory cross-escalation --------------------------------------------

const qnSkill = (mim = QN_MIM) => createGraphSkill({
  name: 'qn-skill',
  build: (gm) => new QNFactory('test', { mimDataProvider: mim, rng: () => 0 }).createGraph(gm),
});

test('S-03 QNFactory cross-escalation: no-match then no-input walks NM -> NI', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  const r2 = await skill(update('qn-skill', r1.data.skill.session, noMatch)); // QN -> NM(1)
  assert.equal(esmlOf(r2), 'nm one');
  const r3 = await skill(update('qn-skill', r2.data.skill.session, noInput)); // NM -> NI(1)
  assert.equal(esmlOf(r3), 'ni one');
  const r4 = await skill(update('qn-skill', r3.data.skill.session, noMatch)); // NI -> NM(2)
  assert.equal(esmlOf(r4), 'nm two');
  const r5 = await skill(update('qn-skill', r4.data.skill.session, noInput)); // NM -> NI, none left
  assert.equal(r5.data.action, null);
  assert.equal(r5.data.final, true);
});

test('S-03 QNFactory cross-escalation: no-input then no-match walks NI -> NM', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  const r2 = await skill(update('qn-skill', r1.data.skill.session, noInput)); // QN -> NI(1)
  assert.equal(esmlOf(r2), 'ni one');
  const r3 = await skill(update('qn-skill', r2.data.skill.session, noMatch)); // NI -> NM(1)
  assert.equal(esmlOf(r3), 'nm one');
  const r4 = await skill(update('qn-skill', r3.data.skill.session, noMatch)); // NM(2)
  assert.equal(esmlOf(r4), 'nm two');
  const r5 = await skill(update('qn-skill', r4.data.skill.session, noMatch)); // exhausted
  assert.equal(r5.data.action, null);
  assert.equal(r5.data.final, true);
});

test('S-03 QNFactory success carries the NLU result and terminates', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  const r2 = await skill(update('qn-skill', r1.data.skill.session, { nlu: { intent: 'color', entities: { color: 'red' } }, asr: { text: 'red' } }));
  assert.equal(r2.data.final, true);
  assert.equal(r2.data.fireAndForget, true);
  assert.deepEqual(slimOf(r1).config.listen.contexts, ['test/rule']);
});

// Host the factory as a subgraph so the PARENT can distinguish which exit transition
// fired (Success / NoMatch / NoInput) — the top-level handler collapses all of them to a
// terminal response, so this is the only place the exit value is observable.
function hostedQnSkill(mim = QN_MIM) {
  return createGraphSkill({
    name: 'host-skill',
    build: (gm) => {
      const g = new Graph(gm, 'host', ['Done']);
      const qn = new QNFactory('inner', { mimDataProvider: mim, rng: () => 0 }).createGraph(gm);
      const ender = (name, esml) => new FnNode(name, {
        transitions: ['Done'],
        enter: async () => ({ action: nodes.generateJCPAction({ id: name, type: 'SLIM', config: { play: { id: 'p', type: 'PLAY', esml } } }) }),
        exit: async () => ({ transition: 'Done' }),
      });
      const onSuccess = ender('OnSuccess', 'exit-success');
      const onNoMatch = ender('OnNoMatch', 'exit-nomatch');
      const onNoInput = ender('OnNoInput', 'exit-noinput');
      g.addSubGraph(qn, [
        [QNFactoryTransition.Success, onSuccess],
        [QNFactoryTransition.NoMatch, onNoMatch],
        [QNFactoryTransition.NoInput, onNoInput],
      ]);
      g.addNode(onSuccess, [['Done', 'Done']]);
      g.addNode(onNoMatch, [['Done', 'Done']]);
      g.addNode(onNoInput, [['Done', 'Done']]);
      g.finalize();
      return g;
    },
  });
}

test('S-03 QNFactory exits the parent on NoMatch only after the NM ladder is exhausted', async () => {
  const skill = hostedQnSkill();
  const r1 = await skill(launch('host-skill'));
  const r2 = await skill(update('host-skill', r1.data.skill.session, noMatch)); // NM(1)
  assert.equal(esmlOf(r2), 'nm one', 'ladder still inside the MIM');
  const r3 = await skill(update('host-skill', r2.data.skill.session, noMatch)); // NM(2)
  assert.equal(esmlOf(r3), 'nm two');
  const r4 = await skill(update('host-skill', r3.data.skill.session, noMatch)); // FinalNoMatch -> parent NoMatch
  assert.equal(esmlOf(r4), 'exit-nomatch', 'FinalNoMatch took the parent NoMatch exit, not NoInput');
});

test('S-03 QNFactory exits the parent on NoInput only after the NI ladder is exhausted', async () => {
  const skill = hostedQnSkill();
  const r1 = await skill(launch('host-skill'));
  const r2 = await skill(update('host-skill', r1.data.skill.session, noInput)); // NI(1)
  assert.equal(esmlOf(r2), 'ni one', 'ladder still inside the MIM');
  const r3 = await skill(update('host-skill', r2.data.skill.session, noInput)); // FinalNoInput -> parent NoInput
  assert.equal(esmlOf(r3), 'exit-noinput', 'FinalNoInput took the parent NoInput exit, not NoMatch');
});

// --- frozen session state ---------------------------------------------------

test('S-03 session state: QN entry resets _mim, NM/NI entries only increment their ladder', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  assert.deepEqual(r1.data.skill.session.data._mim, { noMatch: 0, noInput: 0, noMatchMax: false, noInputMax: false }, 'QN entry resets the MIM counters');
  const r2 = await skill(update('qn-skill', r1.data.skill.session, noMatch));
  assert.equal(r2.data.skill.session.data._mim.noMatch, 1, 'NM entry increments noMatch');
  assert.equal(r2.data.skill.session.data._mim.noInput, 0);
  const r3 = await skill(update('qn-skill', r2.data.skill.session, noInput));
  assert.equal(r3.data.skill.session.data._mim.noMatch, 1, 'NM counter no longer reset');
  assert.equal(r3.data.skill.session.data._mim.noInput, 1, 'NI entry increments noInput');
});

test('S-03 session state: an exhausted ladder latches its max flag', async () => {
  const noNm = { ...QN_MIM, prompts: QN_MIM.prompts.filter((p) => p.prompt_sub_category !== 'NM') };
  const skill = qnSkill(noNm);
  const r1 = await skill(launch('qn-skill'));
  const r2 = await skill(update('qn-skill', r1.data.skill.session, noMatch));
  assert.equal(r2.data.skill.session.data._mim.noMatchMax, true, 'no NM prompts -> noMatchMax latched');
});

// --- ANFactory / MANFactory terminals --------------------------------------

test('S-03 ANFactory: a single announcement plays and Success leaves final per options', async () => {
  const skill = createGraphSkill({
    name: 'an-skill',
    build: (gm) => new ANFactory('test', { mimDataProvider: AN_MIM('solo', 'hello there.'), rng: () => 0 }).createGraph(gm),
  });
  const r = await skill(launch('an-skill'));
  assert.equal(esmlOf(r), 'hello there.');
  assert.equal(r.data.final, false, 'ANNode enter does not force final unless options.final');
});

test('S-03 MANFactory: several announcements become one SEQUENCE, final per options', async () => {
  const skill = createGraphSkill({
    name: 'man-skill',
    build: (gm) => new MANFactory('test', {
      mimDataProvider: [AN_MIM('a', 'first.'), AN_MIM('b', 'second.')], final: true, rng: () => 0,
    }).createGraph(gm),
  });
  const r = await skill(launch('man-skill'));
  const seq = r.data.action.config.jcp;
  assert.equal(seq.type, 'SEQUENCE');
  assert.deepEqual(seq.children.map((c) => c.config.play.esml), ['first.', 'second.']);
  assert.equal(r.data.final, true);
});

// --- RouterNode error branches ---------------------------------------------

test('S-03 RouterNode: zero MIMs throws the source message', async () => {
  const skill = mimSkill({ mimDataProvider: [], rng: () => 0 });
  await assert.rejects(() => skill(launch('mim-skill')), /Provided MIM path func yielded no MIMs/);
});

test('S-03 RouterNode: more than one MIM throws the source message', async () => {
  const skill = mimSkill({ mimDataProvider: [AN_MIM('a', 'x'), AN_MIM('b', 'y')], rng: () => 0 });
  await assert.rejects(() => skill(launch('mim-skill')), /Provided MIM path func yielded more than 1 MIM/);
});

test('S-03 RouterNode: an unknown mim_type throws the source message', async () => {
  const skill = mimSkill({ mimDataProvider: { mim_id: 'x', mim_type: 'mystery', prompts: [] }, rng: () => 0 });
  await assert.rejects(() => skill(launch('mim-skill')), /Requested MIM is of unknown type\./);
});

test('S-03 RouterNode: optional-response routes to the Question arm', async () => {
  const skill = mimSkill({ mimDataProvider: { ...QN_MIM, mim_id: 'opt', mim_type: 'optional-response' }, rng: () => 0 });
  const r = await skill(launch('mim-skill'));
  assert.equal(esmlOf(r), 'what color?', 'optional-response took the QN arm');
});

// --- OptInFactory -----------------------------------------------------------

// Skill-provided MIMs mirroring the source suite's res_test fixtures (fused prompt
// ids Verify_Test / Decline_Test / AfterOptIn_AN_0x).
const VERIFY_TEST_MIM = {
  mim_id: 'VerifyTest', mim_type: 'question',
  prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 1, condition: '', prompt: 'want your report?', media: 'TTS', prompt_id: 'Verify_Test', weight: 1, auto_rule_override: null }],
};
const DECLINE_TEST_MIM = {
  mim_id: 'DeclineTest', mim_type: 'announcement',
  prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 1, condition: '', prompt: 'okay then.', media: 'TTS', prompt_id: 'Decline_Test', weight: 1, auto_rule_override: null }],
};

function optInHarness({ optInType = OptInType.VERIFY_ID, proposalMimProvider = VERIFY_TEST_MIM, declineMimProvider = DECLINE_TEST_MIM } = {}) {
  const captured = {};
  const skill = createGraphSkill({
    name: 'optin-skill',
    build: (gm, facade) => {
      const g = new Graph(gm, 'main', ['Done']);
      const optIn = new OptInFactory('OptIn', facade, { optInType, proposalMimProvider, declineMimProvider }).createGraph(gm);
      // Content node records the live runtime.perception.speaker so the cached-speaker
      // restore is observable on the wire (the response carries only skill/action/analytics).
      const content = new FnNode('Content', {
        transitions: ['Done'],
        enter: async (data) => {
          captured.speakerOnAccept = data.runtime.perception.speaker ?? null;
          return {
            final: true,
            action: nodes.generateJCPAction({
              id: 'x', type: 'SLIM',
              config: { play: { id: 'p', type: 'PLAY', esml: 'the ghoti is a fish.', meta: { prompt_id: 'AfterOptIn_AN_02', speaker: captured.speakerOnAccept } } },
            }),
          };
        },
        exit: async () => ({ transition: 'Done' }),
      });
      const ender = (name) => new FnNode(name, { transitions: ['Done'], exit: async () => ({ transition: 'Done' }) });
      const declined = ender('Declined');
      const notInLoop = ender('NotInLoop');

      g.addSubGraph(optIn, [
        [OptInTransition.Accepted, content],
        [OptInTransition.Declined, declined],
        [OptInTransition.NotInLoop, notInLoop],
      ]);
      g.addNode(content, [['Done', 'Done']]);
      g.addNode(declined, [['Done', 'Done']]);
      g.addNode(notInLoop, [['Done', 'Done']]);
      g.finalize();
      return g;
    },
  });
  return { skill, captured };
}

const offerOf = (resp) => (resp.data.analytics['optin-skill'] || []).find((e) => e.event === 'Skill Offer');

test('S-03 OptIn: VERIFY_ID proposal uses the unified base ProposalVerifyID MIM + base rule', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  assert.equal(mimOf(r1), 'OptInProposalVerifyID');
  assert.equal(pidOf(r1), 'Verify_Test', 'skill prompt fused over the base MIM');
  assert.deepEqual(slimOf(r1).config.listen.contexts, ['shared/verify_id']);
  assert.equal(r1.data.skill.session.data._optIn.speaker, 'alice', 'RouteNode snapshots the speaker');
});

test('S-03 OptIn: NO_ID proposal uses the base ProposalNoID MIM + shared/no_id rule', async () => {
  const { skill } = optInHarness({ optInType: OptInType.NO_ID });
  const r1 = await skill(launch('optin-skill'));
  assert.equal(mimOf(r1), 'OptInProposalNoID');
  assert.deepEqual(slimOf(r1).config.listen.contexts, ['shared/no_id']);
});

test('S-03 OptIn: an unknown opt-in type throws the source message at the router', async () => {
  const { skill } = optInHarness({ optInType: 'BOGUS' });
  await assert.rejects(() => skill(launch('optin-skill')), /Unknown Opt-In Type: 'BOGUS'/);
});

test('S-03 OptIn: yes -> Accepted, Skill Offer analytics, runtime speaker retained', async () => {
  const { skill, captured } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'yes', entities: {} }, asr: { text: 'yes' } }));
  assert.equal(r2.data.final, true);
  assert.equal(captured.speakerOnAccept, 'alice', 'runtime speaker retained');
  const offer = offerOf(r2);
  assert.ok(offer, "source event name is 'Skill Offer' (interfaces/skill/analytics.ts EVENTS.SKILL_OFFER)");
  assert.equal(offer.properties.user_response, 'yes');
  assert.equal(offer.properties.modality, 'speech');
});

test('S-03 OptIn: yes restores the cached opt-in speaker when the update drops perception.speaker', async () => {
  const { skill, captured } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill')); // launch carries perception.speaker = alice -> cached
  assert.equal(r1.data.skill.session.data._optIn.speaker, 'alice');
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'yes', entities: {} }, asr: { text: 'yes' } }, makeRuntime({ speaker: null })));
  assert.equal(captured.speakerOnAccept, 'alice', 'cached optIn speaker restored onto runtime.perception');
  assert.equal(r2.data.final, true);
});

test('S-03 OptIn: unknown speaker (no perception.speaker) leaves the cache empty and restores nothing', async () => {
  const { skill, captured } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill', {}, makeRuntime({ speaker: null })));
  assert.deepEqual(r1.data.skill.session.data._optIn, {}, 'no speaker snapshot when perception.speaker is absent');
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'yes', entities: {} }, asr: { text: 'yes' } }, makeRuntime({ speaker: null })));
  assert.equal(captured.speakerOnAccept, null, 'no cached speaker to restore');
  assert.equal(r2.data.final, true);
});

test('S-03 OptIn: no -> Decline MIM (final), offer analytics user_response no', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'no', entities: {} }, asr: { text: 'no' } }));
  assert.equal(mimOf(r2), 'OptInDecline');
  assert.equal(pidOf(r2), 'Decline_Test');
  assert.equal(r2.data.final, true);
  assert.equal(offerOf(r2).properties.user_response, 'no');
});

test('S-03 OptIn: one no-input reaches FinalNoInput and declines (modality n/a)', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, noInput));
  assert.equal(mimOf(r2), 'OptInDecline', 'base proposal has no NI ladder -> FinalNoInput -> decline');
  assert.equal(r2.data.final, true);
  const offer = offerOf(r2);
  assert.equal(offer.properties.user_response, 'no-input');
  assert.equal(offer.properties.modality, 'n/a');
});

test('S-03 OptIn: one no-match reaches FinalNoMatch and declines', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, noMatch));
  assert.equal(mimOf(r2), 'OptInDecline');
  assert.equal(r2.data.final, true);
  assert.equal(offerOf(r2).properties.user_response, 'no-match');
});

test('S-03 OptIn: wrongID -> WrongID MIM then cancel -> decline', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: 'not me' } }));
  assert.equal(mimOf(r2), 'OptInWrongID');
  assert.deepEqual(slimOf(r2).config.listen.contexts, ['shared/wrong_id']);
  const r3 = await skill(update('optin-skill', r2.data.skill.session, { nlu: { intent: 'cancel', entities: {} }, asr: { text: 'cancel' } }));
  assert.equal(mimOf(r3), 'OptInDecline', "SetLooperIDNode 'cancel' -> Cancel -> decline");
  assert.equal(r3.data.final, true);
});

test('S-03 OptIn: wrongID -> notInLoop exits NotInLoop and never reaches content', async () => {
  const { skill, captured } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: 'not me' } }));
  const r3 = await skill(update('optin-skill', r2.data.skill.session, { nlu: { intent: 'notInLoop', entities: {} }, asr: { text: 'i am not in the loop' } }));
  assert.equal(r3.data.final, true, 'NotInLoop terminal');
  assert.equal(r3.data.action, null);
  assert.equal(captured.speakerOnAccept, undefined, 'NotInLoop path never reaches the content node');
  assert.equal(offerOf(r2).properties.user_response, 'wrongID', 'offer tracked on the proposal answer (yes/no node), not the identity turn');
});

test('S-03 OptIn: unknown intents at the identity prompt fall through to NotInLoop', async () => {
  for (const intent of ['repeat', 'thanks', 'somethingElse']) {
    const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
    const r1 = await skill(launch('optin-skill'));
    const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: 'not me' } }));
    const r3 = await skill(update('optin-skill', r2.data.skill.session, { nlu: { intent, entities: {} }, asr: { text: intent } }));
    assert.equal(r3.data.final, true, `intent '${intent}' reaches a terminal`);
    assert.equal(r3.data.action, null, `intent '${intent}' produced no decline MIM (NotInLoop)`);
  }
});

test('S-03 OptIn: an unknown intent at the yes/no prompt throws (source default branch)', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  await assert.rejects(
    () => skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'bananas', entities: {} }, asr: { text: 'bananas' } })),
    /Unknown intent: 'bananas'/,
  );
});

test('S-03 OptIn: loopmember with a referent -> Success, SetPresentPerson + speaker override', async () => {
  const { skill, captured } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: 'not me' } }));
  const r3 = await skill(update('optin-skill', r2.data.skill.session, {
    nlu: { intent: 'loopmember', entities: { 'given-name': 'Bob', 'last-name': 'Jones', loopMemberReferent: 'u-bob' } },
    asr: { text: 'i am bob jones' },
  }));
  const jcp = r3.data.action.config.jcp;
  assert.equal(jcp.type, 'SEQUENCE');
  assert.equal(jcp.children[0].type, 'SET_PRESENT_PERSON');
  assert.equal(jcp.children[0].looperId, 'u-bob');
  assert.equal(jcp.children[0].source, 'USER_OVERRIDE');
  assert.equal(jcp.children[0].confidence, 100);
  assert.equal(captured.speakerOnAccept, 'u-bob', 'overrideSpeaker wrote the referent onto runtime.perception');
  assert.equal(r3.data.final, true);
});

test('S-03 OptIn: loopmember without a referent falls through to NotInLoop', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: 'not me' } }));
  const r3 = await skill(update('optin-skill', r2.data.skill.session, { nlu: { intent: 'loopmember', entities: {} }, asr: { text: 'i am someone' } }));
  assert.equal(r3.data.final, true);
  assert.equal(r3.data.action, null);
});

test('S-03 OptIn: a touch answer (no asr text) is tracked with modality touch', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'yes', entities: {} }, asr: { text: '' } }));
  assert.equal(offerOf(r2).properties.modality, 'touch');
});

// --- live entrypoint: the real skills HTTP service --------------------------

test('S-03 live: an opt-in session replays over the real skills HTTP service', async () => {
  const { skill } = optInHarness({ optInType: OptInType.VERIFY_ID });
  const service = createSkillService({ name: 's03', skillId: 'optin-skill', handler: skill });
  const server = await service.listen(0);
  const port = server.address().port;
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/optin-skill/main`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const r1 = await post(launch('optin-skill'));
    assert.equal(r1.status, 200);
    assert.equal(mimOf(r1.body), 'OptInProposalVerifyID');
    const r2 = await post(update('optin-skill', r1.body.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: 'not me' } }));
    assert.equal(mimOf(r2.body), 'OptInWrongID');
    const r3 = await post(update('optin-skill', r2.body.data.skill.session, {
      nlu: { intent: 'loopmember', entities: { loopMemberReferent: 'u-bob' } }, asr: { text: 'i am bob' },
    }));
    assert.equal(r3.body.data.action.config.jcp.children[0].looperId, 'u-bob');
    assert.equal(r3.body.data.final, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

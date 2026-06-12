// MIM factories + OptIn FSM — exercises the ported baseskill node library: QNFactory's
// NoMatch/NoInput escalation-to-exhaustion loop, MANFactory SLIM sequences, RouterNode MIM-type
// routing, unifyMims prompt injection, and the full OptInFactory yes/wrongID/decline flows
// (including the SetPresentPerson supplemental behavior riding the next JCP action).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRequestType } from '@phoenix/contracts';
import {
  createGraphSkill, Graph, FnNode, unifyMims,
  mimFactories, nodes, OptInFactory, OptInType, OptInTransition,
} from '../src/index.js';

const { QNFactory, QNFactoryTransition, MANFactory, MANFactoryTransition, MIMFactory, MIMFactoryTransition } = mimFactories;

// --- fixtures ---------------------------------------------------------------

const QN_MIM = {
  mim_id: 'TestQN', mim_type: 'question', rule_name: 'test/rule', es_auto_tagging: true,
  prompts: [
    { prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 1, condition: '', prompt: 'what color?', media: 'TTS', prompt_id: 'q1', weight: 1, auto_rule_override: null },
    { prompt_category: 'Errors', prompt_sub_category: 'NM', index: 1, condition: '', prompt: 'sorry, which color?', media: 'TTS', prompt_id: 'nm1', weight: 1, auto_rule_override: null },
    { prompt_category: 'Errors', prompt_sub_category: 'NM', index: 2, condition: '', prompt: 'last try: a color?', media: 'TTS', prompt_id: 'nm2', weight: 1, auto_rule_override: null },
    { prompt_category: 'Errors', prompt_sub_category: 'NI', index: 1, condition: '', prompt: 'still there?', media: 'TTS', prompt_id: 'ni1', weight: 1, auto_rule_override: null },
  ],
};

const AN_MIM = (id, text) => ({
  mim_id: id, mim_type: 'announcement', es_auto_tagging: true,
  prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'AN', index: 1, condition: '', prompt: text, media: 'TTS', prompt_id: `${id}-an`, weight: 1, auto_rule_override: null }],
});

const ctx = (skillID) => ({ general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, runtime: { dialog: {}, perception: { speaker: 'alice' } }, skill: { id: skillID } });
const launch = (skillID, extra = {}) => ({ type: SkillRequestType.LISTEN_LAUNCH, msgID: 'm', ts: 1, data: { ...ctx(skillID), ...extra } });
const update = (skillID, session, result) => ({ type: SkillRequestType.LISTEN_UPDATE, msgID: 'm', ts: 2, data: { ...ctx(skillID), skill: { id: skillID, session }, result } });

const playOf = (resp) => {
  const jcp = resp.data.action.config.jcp;
  const slim = jcp.type === 'SLIM' ? jcp : jcp.children.find((c) => c.type === 'SLIM');
  return slim.config.play;
};

// --- QNFactory --------------------------------------------------------------

function qnSkill() {
  return createGraphSkill({
    name: 'qn-skill',
    build: (gm) => new QNFactory('test', { mimDataProvider: QN_MIM, rng: () => 0 }).createGraph(gm),
  });
}

test('QNFactory: question -> success carries the NLU result', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  assert.equal(r1.data.final, false);
  assert.equal(playOf(r1).esml, 'what color?');
  const slim = r1.data.action.config.jcp;
  assert.equal(slim.config.listen.rule, 'test/rule', 'question MIM emits a LISTEN from rule_name');

  const r2 = await skill(update('qn-skill', r1.data.skill.session, { nlu: { intent: 'color', entities: { color: 'blue' } }, asr: { text: 'blue' } }));
  assert.equal(r2.data.final, true, 'Success exit is terminal at the top level');
  assert.equal(r2.data.fireAndForget, true);
});

test('QNFactory: NoMatch escalates by index then exits FinalNoMatch when exhausted', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  const noMatch = { nlu: { intent: null, entities: {} }, asr: { text: 'mumble' } };

  const r2 = await skill(update('qn-skill', r1.data.skill.session, noMatch));
  assert.equal(playOf(r2).esml, 'sorry, which color?', 'NM index 1');
  assert.equal(r2.data.final, false);

  const r3 = await skill(update('qn-skill', r2.data.skill.session, noMatch));
  assert.equal(playOf(r3).esml, 'last try: a color?', 'NM index 2');

  const r4 = await skill(update('qn-skill', r3.data.skill.session, noMatch));
  assert.equal(r4.data.action, null, 'NM prompts exhausted -> FinalNoMatch -> terminal');
  assert.equal(r4.data.final, true);
});

test('QNFactory: NoInput plays the NI prompt', async () => {
  const skill = qnSkill();
  const r1 = await skill(launch('qn-skill'));
  const r2 = await skill(update('qn-skill', r1.data.skill.session, { nlu: { intent: null, entities: {} }, asr: { text: '' } }));
  assert.equal(playOf(r2).esml, 'still there?');
});

// --- MANFactory + RouterNode ------------------------------------------------

test('MANFactory: multiple announcement MIMs become one SEQUENCE of SLIMs (final)', async () => {
  const skill = createGraphSkill({
    name: 'man-skill',
    build: (gm) => new MANFactory('test', {
      mimDataProvider: [AN_MIM('a', 'first.'), AN_MIM('b', 'second.'), AN_MIM('c', 'third.')],
      final: true, rng: () => 0,
    }).createGraph(gm),
  });
  const r = await skill(launch('man-skill'));
  assert.equal(r.data.final, true);
  const seq = r.data.action.config.jcp;
  assert.equal(seq.type, 'SEQUENCE');
  assert.deepEqual(seq.children.map((c) => c.config.play.esml), ['first.', 'second.', 'third.']);
});

test('MIMFactory router: announcement MIM takes the AN arm', async () => {
  const skill = createGraphSkill({
    name: 'mim-skill',
    build: (gm) => new MIMFactory('test', { mimDataProvider: AN_MIM('solo', 'hello there.'), rng: () => 0 }).createGraph(gm),
  });
  const r = await skill(launch('mim-skill'));
  assert.equal(playOf(r).esml, 'hello there.');
});

// --- unifyMims ----------------------------------------------------------------

test('unifyMims: skill prompts replace base prompts; transform wins when provided', async () => {
  const data = { log: null, skill: { session: { data: {} } } };
  const base = () => ({ mim_id: 'base', mim_type: 'question', rule_name: 'base/rule', prompts: [{ prompt_id: 'base-p' }] });

  const merged = await unifyMims({ baseProvider: () => base(), mimProvider: { prompts: [{ prompt_id: 'skill-p' }] } }, data);
  assert.equal(merged.mim_id, 'base', 'base identity kept');
  assert.equal(merged.prompts[0].prompt_id, 'skill-p', 'skill prompts injected');

  const transformed = await unifyMims({
    baseProvider: () => base(),
    mimProvider: { prompts: [{ prompt_id: 'skill-p' }] },
    transform: (d, skillMim, baseMim) => ({ ...baseMim, mim_id: 'custom' }),
  }, data);
  assert.equal(transformed.mim_id, 'custom');
});

// --- OptInFactory -------------------------------------------------------------

function optInSkill() {
  return createGraphSkill({
    name: 'optin-skill',
    build: (gm, facade) => {
      const g = new Graph(gm, 'main', ['Done']);
      const optIn = new OptInFactory('OptIn', facade, {
        optInType: OptInType.VERIFY_ID,
        proposalMimProvider: { prompts: [{ prompt_category: 'Entry-Core', prompt_sub_category: 'Q', index: 1, condition: '', prompt: 'want your report, ${speaker.name}?', media: 'TTS', prompt_id: 'prop1', weight: 1, auto_rule_override: null }] },
        promptDataProvider: { speaker: { name: 'Alice' } },
      }).createGraph(gm);
      const content = new FnNode('Content', {
        transitions: ['Done'],
        enter: async () => ({ action: nodes.generateJCPAction({ id: 'x', type: 'SLIM', config: { play: { id: 'p', type: 'PLAY', esml: 'here is your report.' } } }), final: true }),
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
}

test('OptIn: VERIFY_ID proposal uses unified skill prompt + base listen rule', async () => {
  const skill = optInSkill();
  const r1 = await skill(launch('optin-skill', { type: undefined }));
  assert.equal(playOf(r1).esml, 'want your report, Alice?', 'skill prompt over base MIM, template resolved');
  const slim = r1.data.action.config.jcp;
  assert.equal(slim.config.listen.rule, 'shared/verify_id', 'base ProposalVerifyID rule kept');
});

test('OptIn: yes -> Accepted -> content action; SKILL_OFFER analytics tracked', async () => {
  const skill = optInSkill();
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'yes', entities: {} }, asr: { text: 'yes' } }));
  assert.equal(playOf(r2).esml, 'here is your report.');
  assert.equal(r2.data.final, true);
  const events = r2.data.analytics['optin-skill'] || [];
  assert.ok(events.some((e) => e.event === 'SKILL_OFFER' && e.properties.user_response === 'yes' && e.properties.modality === 'speech'));
});

test('OptIn: no -> decline announcement (final) from the base Decline MIM', async () => {
  const skill = optInSkill();
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'no', entities: {} }, asr: { text: 'no' } }));
  assert.equal(r2.data.final, true, 'decline MIM is final');
  assert.ok(playOf(r2).esml.length > 0, 'base Decline.mim provided the prompt');
});

test('OptIn: wrongID -> WrongID MIM -> loopmember recovers identity; SetPresentPerson rides the next JCP', async () => {
  const skill = optInSkill();
  const r1 = await skill(launch('optin-skill'));
  const r2 = await skill(update('optin-skill', r1.data.skill.session, { nlu: { intent: 'wrongID', entities: {} }, asr: { text: "that's not me" } }));
  const slim2 = r2.data.action.config.jcp;
  assert.equal(slim2.config.listen.rule, 'shared/wrong_id', 'WrongID MIM listens for identity');

  const r3 = await skill(update('optin-skill', r2.data.skill.session, { nlu: { intent: 'loopmember', entities: { loopMemberReferent: 'bob' } }, asr: { text: 'i am bob' } }));
  const jcp = r3.data.action.config.jcp;
  assert.equal(jcp.type, 'SEQUENCE', 'supplemental behavior wraps the content JCP in a SEQUENCE');
  assert.equal(jcp.children[0].type, 'SET_PRESENT_PERSON');
  assert.equal(jcp.children[0].looperId, 'bob');
  assert.equal(jcp.children[0].source, 'USER_OVERRIDE');
});

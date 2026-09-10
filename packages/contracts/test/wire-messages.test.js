import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validate,
  message,
  response,
  errorResponse,
  schemas,
  messages,
  triggerRequest,
  clientAsr,
  clientNlu,
  skillRedirect,
  proactiveResponse,
  listenResultState,
  RequestType,
  ResponseType,
  ListenResultState,
  ListenMessageMode,
  TriggerSource,
  ActionType,
  ASRAnnotation,
} from '../src/index.js';

// Wire fixtures are lifted verbatim from the pinned Pegasus reference emitters and
// consumers (files cited in each test). The rule under test: every captured valid
// reference request/response must be ACCEPTED, and the reference's behaviour on
// INVALID input must be reproduced — never "improved" (tightened).

const ok = (schema, value, label) => {
  const r = validate(schema, value);
  assert.ok(r.valid, `${label}: ${r.errors.join('; ')}`);
};
const bad = (schema, value, label) => {
  const r = validate(schema, value);
  assert.equal(r.valid, false, `${label}: expected rejection, got ${JSON.stringify(value)}`);
};

// --- robot -> hub requests --------------------------------------------------

test('LISTEN request accepts the reference client shape (ListenClientSession.start, listen-helpers audioTest)', () => {
  const listen = {
    type: 'LISTEN',
    msgID: 'uuid-1',
    ts: 1770000000000,
    data: {
      lang: 'en-US',
      hotphrase: false,
      rules: ['launch'],
      asr: { hints: ['live', '$YESNO'], earlyEOS: ['live'] },
    },
  };
  ok(schemas.listenRequest, listen, 'plain listen');

  const fakeAsr = { type: 'LISTEN', msgID: 'u2', ts: 1, data: { lang: 'en-US', rules: [], asr: 'FAKE' } };
  ok(schemas.listenRequest, fakeAsr, "asr may be the literal 'FAKE'");

  const withAgents = {
    type: 'LISTEN',
    msgID: 'u3',
    ts: 1,
    data: { lang: 'en-US', rules: ['launch'], agents: { myAgent: { accessToken: 't', rules: ['r1'] } } },
  };
  ok(schemas.listenRequest, withAgents, 'external agents ride on data.agents');
});

test('LISTEN mode accepts only CLIENT_ASR / CLIENT_NLU (hub throws on any other value)', () => {
  const m1 = { type: 'LISTEN', msgID: 'u', ts: 1, data: { lang: 'en-US', rules: [], mode: 'CLIENT_ASR' } };
  ok(schemas.listenRequest, m1, 'CLIENT_ASR mode');
  const m2 = { type: 'LISTEN', msgID: 'u', ts: 1, data: { lang: 'en-US', rules: [], mode: 'CLIENT_NLU' } };
  ok(schemas.listenRequest, m2, 'CLIENT_NLU mode');
  // ListenTransactionHandler.handleListenMessage: `Invalid value for mode '...'`
  const badMode = { type: 'LISTEN', msgID: 'u', ts: 1, data: { lang: 'en-US', rules: [], mode: 'STEAM_ASR' } };
  bad(schemas.listenRequest, badMode, 'invalid mode');
});

test('CLIENT_ASR / CLIENT_NLU messages validate (hub-client writeClientASR/writeClientNLU)', () => {
  ok(schemas.clientAsrRequest, { type: 'CLIENT_ASR', msgID: 'u', ts: 1, data: { text: 'hello jibo' } });
  ok(schemas.clientNluRequest, { type: 'CLIENT_NLU', msgID: 'u', ts: 1, data: { intent: 'menuSelect', rules: ['launch'], entities: {} } });
  // data.text is what the hub reads into asrData — absence is rejected (hub would
  // emit asrData.text undefined and the NLU stage would feed garbage to the parser).
  bad(schemas.clientAsrRequest, { type: 'CLIENT_ASR', msgID: 'u', ts: 1, data: {} }, 'CLIENT_ASR without text');
});

test('CONTEXT accepts the hub-client shape; missing lang/release are legal (MessagePreProcessor injects defaults)', () => {
  const ctx = {
    type: 'CONTEXT',
    msgID: 'u',
    ts: 1,
    data: {
      general: { accountID: 'acct-1', robotID: 'jibo-1', lang: 'en-US', release: '1.8.0' },
      runtime: { character: {}, location: {}, loop: { users: [], jibo: {}, owner: '', loopId: 'l1' }, perception: {}, dialog: {} },
      skill: { id: null },
    },
  };
  ok(schemas.context, ctx, 'full CONTEXT');

  // MessageValidator.validateContextMessage only requires accountID + robotID; the
  // pre-processor assigns lang:'en', release:'1.8.0' defaults for the rest.
  const minimal = { type: 'CONTEXT', msgID: 'u', ts: 1, data: { general: { accountID: 'a', robotID: 'r' } } };
  ok(schemas.context, minimal, 'CONTEXT without lang/release (reference defaults them)');

  bad(schemas.context, { type: 'CONTEXT', msgID: 'u', ts: 1, data: { general: { accountID: 'a' } } }, 'CONTEXT missing robotID');
  bad(schemas.context, { type: 'CONTEXT', msgID: 'u', ts: 1, data: {} }, 'CONTEXT missing general');
});

test('TRIGGER proactive request validates; unknown triggerSource accepted (reference never enum-checks it)', () => {
  const newArrival = {
    type: 'TRIGGER',
    msgID: 'u',
    ts: 1,
    data: { triggerSource: 'NEW_ARRIVAL', triggerData: { looperID: 'loop-42' } },
  };
  ok(schemas.trigger, newArrival, 'NEW_ARRIVAL');
  ok(schemas.trigger, { type: 'TRIGGER', msgID: 'u', ts: 1, data: { triggerSource: 'SURPRISE', triggerData: {} } }, 'SURPRISE');
  // ProactiveTransactionHandler only compares triggerSource to SURPRISE — an
  // unknown source is accepted at runtime (and schema must match the runtime).
  ok(schemas.trigger, { type: 'TRIGGER', msgID: 'u', ts: 1, data: { triggerSource: 'MOON_PHASE', triggerData: {} } }, 'unknown triggerSource passes (runtime behaviour)');
  // triggerData is dereferenced eagerly (request.data.triggerData.looperID) — a
  // request without it rejects the transaction in the reference.
  bad(schemas.trigger, { type: 'TRIGGER', msgID: 'u', ts: 1, data: { triggerSource: 'NEW_ARRIVAL' } }, 'TRIGGER without triggerData');
});

// --- hub <-> parser ---------------------------------------------------------

test('NLU request accepts text/rules plus loop users and external agents (ListenTransactionHandler.performNLU)', () => {
  const req = {
    type: 'NLU',
    msgID: 'u',
    ts: 1,
    data: {
      text: 'what time is it',
      rules: ['launch'],
      loop: { users: [{ id: 'l1', firstName: 'Ada', lastName: 'Lovelace' }] },
      external: { agent2: { accessToken: 'tok', rules: ['r9'] } },
    },
  };
  ok(schemas.nluRequest, req, 'full NLU request');
  bad(schemas.nluRequest, { type: 'NLU', msgID: 'u', ts: 1, data: { rules: ['launch'], text: 42 } }, 'NLU request text must be a string (parser 400s)');
});

test('NLU response accepts the parser EMPTY_NLU with entities:null (ParseRequestHandler)', () => {
  ok(schemas.nluResponse, { type: 'NLU', msgID: 'u', ts: 1, data: { intent: null, entities: null, rules: [] } }, 'EMPTY_NLU entities:null');
  ok(schemas.nluResponse, { type: 'NLU', msgID: 'u', ts: 1, data: { intent: 'launch', entities: {}, rules: ['launch'] } }, 'normal NLU');
  // intent may be null on garbage ASR (gotcha #7)
  ok(schemas.nluResponse, { type: 'NLU', msgID: 'u', ts: 1, data: { intent: null, rules: [], entities: {} } }, 'null intent');
});

test('NLU response accepts external agent results with error field (nlu.ts ExternalAgentResult)', () => {
  const resp = {
    type: 'NLU',
    msgID: 'u',
    ts: 1,
    data: {
      intent: 'launch',
      rules: ['launch'],
      entities: {},
      external: {
        agent2: { intent: 'other', rules: [], entities: {}, error: 'agent unreachable' },
      },
    },
  };
  ok(schemas.nluResponse, resp, 'external agent result');
});

// --- hub -> robot responses -------------------------------------------------

test('LISTEN response accepts the emitListenResult shape; match may be null', () => {
  const resp = {
    type: 'LISTEN',
    msgID: 'u',
    ts: 1,
    final: false,
    timings: { total: 1234, asr: 800, nlu: 420 },
    data: {
      asr: { text: 'live long and prosper', confidence: 0.9 },
      nlu: { intent: 'liveAndProsper', rules: ['launch'], entities: {} },
      match: { skillID: 'example', launch: true, onRobot: false },
    },
  };
  ok(schemas.listenResponse, resp, 'full listen response');

  // emitListenResult(null, true) — the no-match path writes match: null
  const noMatch = {
    type: 'LISTEN',
    msgID: 'u',
    ts: 1,
    final: true,
    data: { asr: { text: 'nothing matched', confidence: 0.4 }, nlu: { intent: null, rules: [], entities: {} }, match: null },
  };
  ok(schemas.listenResponse, noMatch, 'match:null');

  // GARBAGE path: nluData is the fixed garbage object, asr carries annotation
  const garbage = {
    type: 'LISTEN',
    msgID: 'u',
    ts: 1,
    final: true,
    data: {
      asr: { text: 'blah', confidence: 0.1, annotation: ASRAnnotation.GARBAGE },
      nlu: { intent: null, rules: [], entities: {} },
      match: null,
    },
  };
  ok(schemas.listenResponse, garbage, 'GARBAGE annotation');
});

test('match requires skillID but allows null (GlobalMatchResponseData + isProactive/skipSurprises)', () => {
  ok(schemas.match, null, 'match: null');
  ok(schemas.match, { skillID: 's', onRobot: true, launch: false }, 'minimal match');
  ok(schemas.match, { skillID: 's', onRobot: false, isProactive: true, launch: true, skipSurprises: true }, 'proactive match fields');
  bad(schemas.match, {}, 'match without skillID');
});

test('SKILL_REDIRECT hub->robot validates (TransactionHandler.emitSkillRedirectNotification)', () => {
  const redirect = {
    type: 'SKILL_REDIRECT',
    msgID: 'u',
    ts: 1,
    final: false,
    data: {
      match: { skillID: 'other-skill', launch: true, onRobot: false },
      nlu: { intent: 'x', rules: ['launch'], entities: {} },
      asr: { text: 'hi', confidence: 0.9 },
      memo: { entry: 'from-launch' },
    },
  };
  ok(schemas.skillRedirect, redirect, 'redirect with memo/asr/nlu');
  ok(schemas.skillRedirect, { type: 'SKILL_REDIRECT', msgID: 'u', ts: 1, final: true, data: { match: { skillID: 'r', launch: true, onRobot: true } } }, 'onRobot redirect (final)');
  bad(schemas.skillRedirect, { type: 'SKILL_REDIRECT', msgID: 'u', ts: 1, data: {} }, 'redirect without match (hub always wraps one)');
});

test('PROACTIVE response accepts both the match and the empty {} shapes (emitMatchResponse / emitNoActionResponse)', () => {
  const withMatch = {
    type: 'PROACTIVE',
    msgID: 'u',
    ts: 1,
    final: false,
    data: {
      match: { skillID: 'report-skill', onRobot: false, isProactive: true, launch: true, skipSurprises: false },
    },
  };
  ok(schemas.proactive, withMatch, 'match response');
  const noAction = { type: 'PROACTIVE', msgID: 'u', ts: 1, final: true, data: {} };
  ok(schemas.proactive, noAction, 'no-action response (data:{})');
});

// --- hub <-> skill ----------------------------------------------------------

test('Skill session trace accepts the reference null-transition launch shape (GraphManager.ts:84)', () => {
  // The reference GraphManager pushes {nodeID, transition: null} on enterNode and
  // returns an action before the transition is resolved, so a LAUNCH response
  // legitimately carries trace [{nodeID, transition: null}]. A schema that requires
  // a string transition here would reject valid reference output.
  const launchResp = {
    type: 'SKILL_ACTION',
    msgID: 'u',
    ts: 1,
    data: {
      skill: { id: 'color-skill', session: { id: 's1', nodeID: 0, data: {}, trace: [{ nodeID: 0, transition: null }] } },
      action: { type: ActionType.JCP, config: { version: '2.0', jcp: { type: 'SLIM', id: 'x', config: {} } } },
      final: false,
    },
  };
  ok(schemas.skillResponse, launchResp, 'launch trace with transition:null');
  // after the answer, the same trace entry resolves to a string
  const updated = { ...launchResp, data: { ...launchResp.data, skill: { id: 'color-skill', session: { id: 's1', nodeID: 1, data: {}, trace: [{ nodeID: 0, transition: 'answered' }] } } } };
  ok(schemas.skillResponse, updated, 'resolved trace transition');
});

test('Skill request LISTEN_LAUNCH validates with result nlu/asr/memo (SkillRequestHelper.buildListenLaunchRequest)', () => {
  const launch = {
    type: 'LISTEN_LAUNCH',
    msgID: 'u',
    ts: 1,
    data: {
      general: { accountID: 'a', robotID: 'r', lang: 'en-US', release: '1.8.0' },
      runtime: { character: {}, location: {}, loop: {}, perception: {}, dialog: {} },
      skill: { id: 'example' },
      result: {
        nlu: { intent: 'launch', rules: ['launch'], entities: {} },
        asr: { text: 'hello', confidence: 1 },
        memo: { entry: 'x' },
      },
    },
  };
  ok(schemas.skillRequest, launch, 'LISTEN_LAUNCH full');
  // redirect-driven launches may carry only memo (redirect.data.memo, no nlu/asr)
  ok(schemas.skillRequest, { type: 'LISTEN_LAUNCH', msgID: 'u', ts: 1, data: { general: { accountID: 'a', robotID: 'r' }, skill: { id: 'example' }, result: { memo: { entry: 'x' } } } }, 'LISTEN_LAUNCH memo only');

  ok(schemas.skillRequest, { type: 'LISTEN_UPDATE', msgID: 'u', ts: 1, data: { general: { accountID: 'a', robotID: 'r' }, skill: { id: 'example', session: { id: 's1', nodeID: 3, data: {}, trace: [] } }, result: { nlu: { intent: null, rules: [], entities: {} }, asr: { text: '', confidence: 1 } } } }, 'LISTEN_UPDATE with session');
  ok(schemas.skillRequest, { type: 'PROACTIVE_LAUNCH', msgID: 'u', ts: 1, data: { general: { accountID: 'a', robotID: 'r' }, runtime: {}, skill: { id: 'example' }, result: { nlu: null, memo: 'pr-memo' } } }, 'PROACTIVE_LAUNCH (no asr)');

  // GraphSkill throws for requests without general.accountID / general.robotID
  bad(schemas.skillRequest, { type: 'LISTEN_LAUNCH', msgID: 'u', ts: 1, data: { skill: { id: 'x' }, result: {} } }, 'skill request missing general');
  bad(schemas.skillRequest, { type: 'LISTEN_LAUNCH', msgID: 'u', ts: 1, data: { general: { accountID: 'a' }, skill: { id: 'x' } } }, 'skill request missing general.robotID');
  bad(schemas.skillRequest, { type: 'LISTEN_LAUNCH', msgID: 'u', ts: 1, data: { general: { accountID: 'a', robotID: 'r' } } }, 'skill request missing skill');
});

test('SKILL_ACTION skill->hub validates, including action:null terminal responses (GraphSkill)', () => {
  const actionResp = {
    type: 'SKILL_ACTION',
    msgID: 'u',
    ts: 1,
    data: {
      skill: { id: 'example', session: { id: 'sess-1', nodeID: 1, data: {}, trace: [] } },
      action: {
        type: ActionType.JCP,
        config: { version: '2.0', jcp: { type: 'SLIM', id: 'slim-1', config: { play: { type: 'PLAY', id: 'p1', esml: "SLIM: 'Node1'" }, listen: { type: 'LISTEN', id: 'l1', contexts: [] } } } },
      },
      analytics: { example: [{ event: 'Skill Entry', properties: { initial_intent: 'n/a', domain: '', was_hey_jibo_launch: true, user_initiated: true, last_skill: 'n/a' } }] },
      final: false,
      fireAndForget: false,
    },
  };
  ok(schemas.skillResponse, actionResp, 'SKILL_ACTION with JCP SLIM');

  // terminal node: action:null, final:true, fireAndForget:true
  const finalResp = {
    type: 'SKILL_ACTION',
    msgID: 'u',
    ts: 1,
    data: { skill: { id: 'example' }, action: null, analytics: { example: [] }, final: true, fireAndForget: true },
  };
  ok(schemas.skillResponse, finalResp, 'SKILL_ACTION terminal (action:null)');
  bad(schemas.skillResponse, { type: 'SKILL_ACTION', msgID: 'u', ts: 1, data: { action: 'not-an-object' } }, 'action must be object|null');
});

test('SKILL_REDIRECT skill->hub validates (GraphSkill redirect: skillID + skill context)', () => {
  const redirect = {
    type: 'SKILL_REDIRECT',
    msgID: 'u',
    ts: 1,
    data: {
      skillID: 'other-skill',
      memo: { entry: 'pick-again' },
      skill: { id: 'example' },
    },
  };
  ok(schemas.skillResponse, redirect, 'skill redirect response');
});

test('Skill ERROR validates (BaseSkill.buildErrorResponse: message + skill.id, no code)', () => {
  const err = { type: 'ERROR', msgID: 'u', ts: 1, data: { message: 'boom', skill: { id: 'example' } } };
  ok(schemas.skillResponse, err, 'skill error response');
});

// --- JCP / display / analytics / manifests ----------------------------------

test('JCP action validates (generateJCPAction / createSlimAction) including DISPLAY behavior payloads', () => {
  const slim = messages.jcpActionSchema;
  ok(slim, { type: 'JCP', config: { version: '2.0', jcp: { type: 'SLIM', id: 'FAKE_SLIM_ID', config: {} } } }, 'JCP SLIM');
  bad(slim, { type: 'JCP', config: {} }, 'JCP without version/jcp');
  bad(slim, { type: 'PLAY', config: { version: '2.0', jcp: {} } }, 'unknown action type rejected');

  // A menu DISPLAY wrapped in a SLIM (v2 behaviors + DisplayView), as skills emit
  // through the JCP requester (jibo-command-protocol v2 Display/MenuDisplay).
  const displaySlim = {
    type: 'JCP',
    config: {
      version: '2.0',
      jcp: {
        type: 'SLIM',
        id: 'slim-menu',
        options: { displayMode: 'START_ON_PLAY' },
        config: {
          play: { type: 'PLAY', id: 'p', esml: 'Pick an option' },
          display: {
            type: 'DISPLAY',
            id: 'd1',
            keepDisplay: true,
            visible: true,
            name: 'menu1',
            layer: 0,
            overlay: 'dim',
            onCancel: [],
            view: {
              type: 'MENU',
              name: 'm',
              title: 'Choose',
              startIndex: 0,
              contents: [{ name: 'a', text: 'Alpha', data: {} }],
            },
          },
        },
      },
    },
  };
  ok(slim, displaySlim, 'JCP with MENU display');
  ok(slim, { type: 'JCP', config: { version: '2.0', jcp: { type: 'SEQUENCE', id: 'seq', children: [] } } }, 'JCP with SEQUENCE (supplemental injection)');
});

// MIM is NOT a distinct wire schema. In the pinned reference `mimID` lives on
// jibo/dialog.ts DialogTurn, which no hub or skill wire message imports, and the
// chitchat skill reads it out of skill memo (ProcessQueryNode.ts:36,
// `let mimID = memo.mim`). So the C-02 requirement to "cover MIMs without
// rejecting valid optional fields" means memo must stay open and carry MIM
// state through untouched.
test('MIM state rides in skill memo and is never rejected', () => {
  // The hub wraps a redirect as data.match = { skillID, launch, onRobot } with
  // memo alongside (messages.js:427-442), so the fixtures below use that shape.
  const match = { skillID: 'chitchat', launch: true, onRobot: false };

  ok(schemas.skillRedirect, {
    type: 'SKILL_REDIRECT',
    data: { match, memo: { mim: 'scripted/greeting-01', type: 'SemiSpecificResponse' } },
  }, 'redirect carrying chitchat MIM memo');

  // resolveSemiSpecificMim swaps the id mid-turn; the new value must also pass.
  ok(schemas.skillRedirect, {
    type: 'SKILL_REDIRECT',
    data: { match, memo: { mim: 'emotion/happy-03' } },
  }, 'redirect after semi-specific MIM resolution');

  // memo is deliberately unconstrained: unknown MIM-adjacent keys must not fail.
  ok(schemas.skillRedirect, {
    type: 'SKILL_REDIRECT',
    data: { match, memo: { mim: 'x', scriptedResponseMiMSet: ['a'], unknownFutureKey: 1 } },
  }, 'memo tolerates unknown MIM-adjacent keys');
});

test('Analytics payload validates (GraphSkill.track Skill Entry + opt-in MIM Skill Offer)', () => {
  const analytics = {
    example: [
      { event: 'Skill Entry', properties: { initial_intent: 'launchPersonalReport', domain: 'report', was_hey_jibo_launch: false, user_initiated: true, last_skill: 'n/a' } },
      { event: 'Skill Offer', properties: { user_response: 'yes', modality: 'speech' } },
    ],
  };
  ok(schemas.analytics, analytics, 'analytics with both events');
  ok(schemas.analytics, {}, 'empty analytics object');
  bad(schemas.analytics, { example: [{ properties: {} }] }, 'analytics entry without event');
});

test('Real manifests from the reference tree validate (example / report / create)', () => {
  const example = {
    id: 'example-skill',
    intents: [{ name: 'doesJiboLikeThing', entities: [], memo: 'SomeThing' }],
    proactives: [{ memo: 'Proactive entry 1', topics: ['fake topic 1'], contextRules: [] }],
  };
  ok(schemas.manifest, example, 'example_skill_manifest.json');

  const report = {
    id: 'report-skill',
    intents: [{ name: 'launchPersonalReport', entities: [], memo: 'Reactive' }],
    proactives: [
      {
        memo: 'Proactive',
        topics: [],
        contextRules: [
          { field: 'PART_OF_DAY', matchRule: 'CONTAINED_IN', value: [{ basic: 'MORNING', detail: 'EARLY' }] },
          { field: 'DAY_OF_WEEK', matchRule: 'CONTAINED_IN', value: [0, 1, 2, 3, 4, 5, 6] },
        ],
        IHRules: [{ query: 'PersonalReportLaunchCount7LastHours', matchRule: 'LESS_THAN', value: 1 }],
        settingsRules: [{ skill: 'report-skill', key: 'offerProactively', matchRule: 'EXACT', value: { value: true } }],
      },
    ],
    IHQueries: {
      PersonalReportLaunchCount7LastHours: {
        type: 'Count',
        queryRules: [{ field: 'skillID', match: 'EXACT', value: 'report-skill' }],
        startTimeOffset: [-7, 'hours'],
        endTimeOffset: [0, 'hours'],
      },
    },
    settings: {
      view: {
        type: 'skill',
        index: 0,
        title: 'Personal report',
        childViews: [
          { type: 'switch', index: 0, title: 'Offer report proactively', valueDefinition: { target: 'person', key: 'offerProactively', default: true } },
          { type: 'choice', index: 1, valueDefinition: { target: 'person', key: 'weather' }, choices: [{ id: 0, value: 'Fahrenheit' }, { id: 1, value: 'Celsius' }] },
        ],
      },
    },
  };
  ok(schemas.manifest, report, 'report_skill_manifest.json');

  const create = {
    id: '@be/create',
    intents: [
      { name: 'createOnePhoto', entities: [{ name: 'skill', value: '@be/create', matchRule: 'EXACT' }], memo: 'Launch intent' },
    ],
    onRobot: true,
  };
  ok(schemas.manifest, create, 'create_manifest.json (onRobot)');

  bad(schemas.manifest, { intents: [] }, 'manifest without id');
  bad(schemas.manifest, { id: 'x', proactives: [{ topics: ['ok'], contextRules: [{ field: 'P', matchRule: 'MAYBE_SO', value: 0 }] }] }, 'unknown contextRule matchRule');
});

test('IHRule value rejects strings exactly like SkillConfigValidator.validateIHRule (runtime, not interface)', () => {
  // The interfaces type says `value: TimePeriod | number | string | null`, but the hub's
  // manifest validator (SkillConfigValidator.ts:153-163) only accepts number | boolean |
  // array | null and rejects strings. Our schema must reproduce the RUNTIME behaviour —
  // this is the highest-risk strictness assertion in the matrix.
  const ihValue = (value) => ({
    id: 'x',
    proactives: [{ topics: ['t'], contextRules: [], IHRules: [{ query: 'Q', matchRule: 'LESS_THAN', value }] }],
    IHQueries: { Q: { type: 'Count', queryRules: [], startTimeOffset: [-7, 'hours'], endTimeOffset: [0, 'hours'] } },
  });

  // accepted by the runtime validator
  ok(schemas.manifest, ihValue(1), 'IHRule value number');
  ok(schemas.manifest, ihValue([1, 2]), 'IHRule value array');
  ok(schemas.manifest, ihValue(true), 'IHRule value boolean');
  ok(schemas.manifest, ihValue(null), 'IHRule value null');
  // rejected by the runtime validator
  bad(schemas.manifest, ihValue('1'), 'IHRule value string rejected (SkillConfigValidator)');
  bad(schemas.manifest, ihValue({ basic: 'MORNING' }), 'IHRule value non-null object rejected (SkillConfigValidator)');
});

// --- ListenResult precedence ------------------------------------------------

test('ListenResult precedence exactly matches interfaces/src/hub/response.ts ListenResult.state', () => {
  const noInput = ListenResultState.noInput;
  const noMatch = ListenResultState.noMatch;
  const match = ListenResultState.match;

  // 1. nlu with intent OR non-empty entities -> match (even with empty asr)
  assert.equal(listenResultState({ text: 'hi' }, { intent: 'go', rules: [], entities: {} }), match);
  assert.equal(listenResultState({ text: '' }, { intent: null, rules: [], entities: { person: 'ada' } }), match);
  assert.equal(listenResultState(null, { intent: 'go', rules: [], entities: {} }), match, 'intent wins even without asr');

  // 2. no asr / no asr text -> noInput
  assert.equal(listenResultState(null, null), noInput);
  assert.equal(listenResultState(undefined, { intent: null, rules: [], entities: {} }), noInput);
  assert.equal(listenResultState({ text: '' }, { intent: null, rules: [], entities: {} }), noInput);
  // entities:null is treated as empty (ListenResult.entities getter null-safety)
  assert.equal(listenResultState({ text: '' }, { intent: null, rules: [], entities: null }), noInput);

  // 3. asr text present but nothing matched -> noMatch
  assert.equal(listenResultState({ text: 'hi' }, { intent: null, rules: [], entities: {} }), noMatch);
  assert.equal(listenResultState({ text: 'hi', confidence: 0.3 }, { intent: null, rules: [], entities: null }), noMatch);
  assert.equal(listenResultState({ text: 'hi' }, null), noMatch);
});

// --- builders ---------------------------------------------------------------

test('New builders produce schema-valid messages', () => {
  const tr = triggerRequest(TriggerSource.SURPRISE, { looperID: 'l7' });
  ok(schemas.trigger, tr, 'triggerRequest builder');
  assert.equal(tr.type, RequestType.TRIGGER);

  const ca = clientAsr('hi');
  ok(schemas.clientAsrRequest, ca, 'clientAsr builder');
  const cn = clientNlu({ intent: 'launch', rules: ['launch'], entities: {} });
  ok(schemas.clientNluRequest, cn, 'clientNlu builder');

  const sr = skillRedirect({ skillID: 'other', onRobot: false }, { memo: { entry: 'x' }, final: false });
  ok(schemas.skillRedirect, sr, 'skillRedirect builder');
  assert.deepEqual(sr.data.match, { skillID: 'other', launch: true, onRobot: false });

  const prMatch = proactiveResponse({ skillID: 'report-skill', onRobot: false, isProactive: true, launch: true, skipSurprises: false }, { final: false });
  ok(schemas.proactive, prMatch, 'proactiveResponse(match) builder');
  const prNone = proactiveResponse(null, { final: true });
  ok(schemas.proactive, prNone, 'proactiveResponse(no match) builder');
  assert.deepEqual(prNone.data, {}, 'no-action body is the literal {}');
});

test('Existing envelope builders still validate against the completed error schema', () => {
  const err = errorResponse('boom', 'TIMEOUT_PARSER');
  ok(schemas.error, err, 'errorResponse builder');
  const base = message(RequestType.LISTEN, { lang: 'en-US', rules: [] });
  ok(schemas.listenRequest, base, 'message() builder');
  const r = response(ResponseType.LISTEN, { asr: null, nlu: null, match: null }, { final: false, timings: { total: 1 } });
  ok(schemas.listenResponse, r, 'response() builder');
});
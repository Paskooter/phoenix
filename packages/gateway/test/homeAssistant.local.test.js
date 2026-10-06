// Synthetic identities/preferences only. No native wake or HA execution claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTransaction, GLOBAL_TURN_RULES } from '../src/listenTransaction.js';
import { LOCAL_HOME_SKILL_ID } from '../src/homeAssistantLocal.js';
import { IntentRouter } from '../src/intentRouter.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { loadRegistry } from '../src/registry.js';
import { parseRequest } from '../../nlu/src/requestParser.js';
import { buildSkillAction } from '../../skills/src/jcp.js';

const ROBOT = { id: 'local-fixture-account', friendlyId: 'local-fixture-robot', accessKeyId: 'local-fixture-key' };
const SHORTCUT = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const ABSENT = Symbol('absent');
const caps = ['robot_roster', 'robot_action', 'room_context', 'state_queries', 'follow_up', 'routine_shortcuts'];
const declaration = (extra = {}) => ({ v: 1, capabilities: [...caps], shortcuts: [{ id: SHORTCUT, phrase: 'movie time' }], ...extra });
const registry = await loadRegistry({ indexFile: 'skills-phoenix.json', skillsBase: 'http://127.0.0.1:1' });
const router = new IntentRouter(registry);
const manager = new SkillConfigManager(registry);
const listen = (out) => out.frames.find((frame) => frame.type === 'LISTEN');
const hint = (out) => listen(out)?.data.nlu?.entities?.phoenix_local_home;

function context(preference = declaration(), general = {}, skill = {}) {
  return { type: 'CONTEXT', data: {
    general: { accountID: ROBOT.id, robotID: ROBOT.friendlyId, release: '13.2.0', ...general },
    runtime: { loop: { users: [] } }, skill,
    ...(preference === ABSENT ? {} : { phoenix_local_home: preference }),
  } };
}

async function turn(text, { preference = declaration(), verified = ROBOT, general = {}, skill = {},
  hotphrase = false, listenPreference = ABSENT, beforeAsr, started, parser, cloudSelection, cloudEnabled = true, onFrame,
} = {}) {
  const frames = [], cloud = [], native = [], parsed = [], history = [], events = [];
  const tx = new ListenTransaction({ _auth: ROBOT, _verifiedRobotIdentity: verified,
    _jiboHeaders: { 'x-jibo-robotid': 'untrusted-trace-robot', 'x-jibo-transid': 'untrusted-trace-turn' },
  }, {
    config: { recordLaunchHistory: true, recordSpeechHistory: false },
    homeAssistant: cloudEnabled ? {
      async selection(identity) { cloud.push({ type: 'selection', identity });
        return cloudSelection ? cloudSelection() : { enabled: true, capabilities: caps, shortcuts: [] }; },
      async command(identity, commandText, route) { cloud.push({ type: 'command', identity, text: commandText, route });
        return { outcome: 'success', response_type: 'action_done', speech: 'Synthetic cloud result.' }; },
    } : null,
    parser: { async handleNLU(input) { parsed.push(input); return parser ? parser(input, tx) : parseRequest(input); } },
    intentRouter: router, skillConfigManager: manager,
    skillClient: { async launchOrUpdate(skillID, input, trace, isUpdate) {
      native.push({ skillID, input, isUpdate });
      return { skillID, response: buildSkillAction({ skillId: skillID, sessionId: 'local-fixture-session', esmlText: 'Synthetic native reply.' }) };
    } },
    historyClient: { async writeSkillLaunch(row) { history.push(row); return {}; } },
  }, { write(frame) { frames.push(frame); onFrame?.(frame, tx); return true; } }, {
    info(message, fields) { events.push({ message, fields }); }, debug() {}, warn() {}, error() {},
  });
  tx.handleMessage({ json: { type: 'LISTEN', data: { mode: 'CLIENT_ASR', lang: 'en-US', hotphrase, rules: [...GLOBAL_TURN_RULES],
    ...(listenPreference === ABSENT ? {} : { phoenix_local_home: listenPreference }),
  } } });
  tx.handleMessage({ json: context(preference, general, skill) });
  await beforeAsr?.(tx);
  tx.handleMessage({ json: { type: 'CLIENT_ASR', data: { text } } });
  await started?.(tx);
  await tx.done;
  return { frames, cloud, native, parsed, history, events, tx };
}

test('local handoff retains recognized wording in the SDK carrier and finishes only the voice transaction', async () => {
  const text = 'ask Home Assistant to start my custom routine';
  const out = await turn(text);
  assert.deepEqual(out.frames.map((frame) => frame.type), ['SOS', 'EOS', 'LISTEN']);
  assert.deepEqual(listen(out).data.match, { skillID: LOCAL_HOME_SKILL_ID, launch: true, onRobot: true });
  assert.equal(listen(out).final, true);
  assert.equal(listen(out).data.asr.text, text);
  assert.deepEqual(hint(out), { v: 1, text, route: { kind: 'command' } });
  assert.deepEqual(out.cloud, []);
  assert.deepEqual(out.native, []);
  assert.equal(out.tx.state, 'DONE');
  assert.equal(out.history.length, 1);
  assert.equal(out.history[0].skillID, LOCAL_HOME_SKILL_ID);
  const completed = out.events.filter((event) => event.message === 'voice_turn_complete');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].fields.outcome, 'listen');
  assert.ok(out.frames.every((frame) => !frame.data?.action));
});

test('local query, room, cached follow-up and exact routine routing use the existing actual classifier', async () => {
  for (const [text, kind] of [['turn on the study light', 'command'], ['turn the lights off in this room', 'command'],
    ['is the study light on', 'query'], ['what is the temperature in here', 'query'],
    ['turn it off', 'follow_up'], ['make it dimmer', 'follow_up'], ['make them brighter', 'follow_up'], ['Movie   time!', 'routine']]) {
    const out = await turn(text, { preference: declaration({ follow_up: { available: true, expires_at_ms: Date.now() + 30_000 } }) });
    assert.equal(listen(out).data.match.skillID, LOCAL_HOME_SKILL_ID, text);
    assert.deepEqual(hint(out).route, kind === 'routine' ? { kind, shortcut_id: SHORTCUT } : { kind }, text);
    assert.equal(hint(out).text, text);
    assert.deepEqual(out.cloud, [], text);
    if (kind !== 'command') assert.equal(out.parsed.length, 1, text);
  }
  for (const text of ['make it dimmer', 'make it brighter', 'yes', 'blue', 'start something', 'movie time please',
    'turn it off and start a script', 'is the study light on and turn it off', 'tell me about lights']) {
    const out = await turn(text);
    assert.notEqual(listen(out)?.data.match?.skillID, LOCAL_HOME_SKILL_ID, text);
    assert.deepEqual(out.cloud, [], text);
  }
  const noCapabilities = await turn('is the study light on', { preference: declaration({ capabilities: [] }) });
  assert.equal(hint(noCapabilities), undefined);
  const unpaired = await turn('turn on the study light', { preference: declaration({ capabilities: [], shortcuts: [] }), cloudEnabled: false });
  assert.equal(listen(unpaired).data.match.skillID, LOCAL_HOME_SKILL_ID);
  assert.deepEqual(unpaired.cloud, []);
});

test('native ordinary commands and active skill replies retain priority over local shortcuts', async () => {
  for (const text of ['dance', 'do a dance', 'sing me a song', 'take a selfie', 'what time is it',
    'tell me a joke', 'turn up the volume', 'go to sleep', 'stop', 'help me set up Hue']) {
    const out = await turn(text, { preference: declaration({ shortcuts: [{ id: SHORTCUT, phrase: text }] }) });
    const nlu = parseRequest({ text, rules: [...GLOBAL_TURN_RULES] });
    const decision = router.getSkillIDFromNLU(nlu);
    assert.equal(listen(out)?.data.match?.skillID, decision?.skillID, text);
    assert.notEqual(listen(out)?.data.match?.skillID, LOCAL_HOME_SKILL_ID, text);
    assert.deepEqual(out.cloud, [], text);
  }
  const active = await turn('movie time', { skill: { id: 'fixture-active-skill', session: { id: 'fixture-session' } } });
  assert.equal(active.native[0].skillID, 'fixture-active-skill');
  assert.equal(active.native[0].isUpdate, true);
  assert.deepEqual(active.cloud, []);
  const interrupted = await turn('turn on the study light', { skill: { id: 'fixture-active-skill' }, hotphrase: true });
  assert.equal(listen(interrupted).data.match.skillID, LOCAL_HOME_SKILL_ID);
  const conflict = await turn('make it dimmer', {
    preference: declaration({ follow_up: { available: true, expires_at_ms: Date.now() + 30_000 } }),
    parser: () => ({ intent: 'requestDance', rules: ['launch'], entities: {} }),
  });
  assert.equal(listen(conflict).data.match.skillID, 'chitchat-skill');
});

test('malformed declarations and unverified/context/header identities cannot use local routing or fall back to cloud HA', async () => {
  const malformed = [null, false, [], {}, declaration({ v: 2 }), declaration({ endpoint: 'https://invalid.local' }),
    declaration({ capabilities: ['unknown'] }), declaration({ capabilities: ['follow_up', 'follow_up'] }),
    declaration({ capabilities: ['robot_roster', 'robot_action', 'telemetry'] }),
    declaration({ shortcuts: [{ id: [SHORTCUT], phrase: 'movie time' }] }),
    declaration({ shortcuts: [{ id: SHORTCUT.toUpperCase(), phrase: 'movie time' }] }),
    declaration({ shortcuts: [{ id: SHORTCUT, phrase: 'x'.repeat(81) }] }),
    declaration({ shortcuts: [{ id: SHORTCUT, phrase: 'movie\ntime' }] }),
    declaration({ shortcuts: Array.from({ length: 17 }, () => ({ id: SHORTCUT, phrase: 'movie time' })) }),
    declaration({ follow_up: { available: true, expires_at_ms: Date.now() + 60_000 } }),
    declaration({ follow_up: { available: true, expires_at_ms: Date.now() + 10_000, robot_id: 'untrusted' } }),
  ];
  for (const preference of malformed) {
    const out = await turn('ask Home Assistant to start custom fixture', { preference,
      parser: () => ({ intent: null, rules: [], entities: {} }) });
    assert.equal(hint(out), undefined);
    assert.deepEqual(out.cloud, []);
  }
  for (const options of [{ verified: null }, { verified: { ...ROBOT, friendlyId: 'other-robot' } },
    { preference: ABSENT, general: { phoenix_local_home: declaration(), householdID: 'untrusted-household' } },
    { preference: ABSENT, listenPreference: null }, { preference: declaration(), listenPreference: declaration() }]) {
    const out = await turn('ask Home Assistant to start custom fixture', {
      ...options, parser: () => ({ intent: null, rules: [], entities: {} }),
    });
    assert.equal(hint(out), undefined);
    assert.deepEqual(out.cloud, []);
  }
});

test('local preferences are copied once and follow-up expiry cannot be extended by another context', async () => {
  const preference = declaration();
  const copied = await turn('movie time', { preference, beforeAsr() { preference.shortcuts[0].phrase = 'other words'; } });
  assert.equal(hint(copied).route.shortcut_id, SHORTCUT);
  const expired = await turn('make it dimmer', { preference: declaration({ follow_up: { available: true, expires_at_ms: Date.now() + 20 } }),
    parser: async (input) => { await new Promise((resolve) => setTimeout(resolve, 30)); return parseRequest(input); },
  });
  assert.equal(hint(expired), undefined);
  const duplicate = await turn('turn it off', { beforeAsr(tx) {
    tx.handleMessage({ json: context(declaration({ follow_up: { available: true, expires_at_ms: Date.now() + 30_000 } })) });
  } });
  assert.equal(hint(duplicate), undefined);
  const notInherited = await turn('turn it off');
  assert.equal(hint(notInherited), undefined);
  assert.deepEqual(notInherited.cloud, []);
});

test('disconnect/cancel or a late local declaration prevents cloud dispatch and local handoff', async () => {
  const cancelled = await turn('is the study light on', { started(tx) { tx.abandon(); } });
  assert.equal(hint(cancelled), undefined);
  assert.deepEqual(cancelled.cloud, []);
  let releaseSelection, selectionStarted;
  const selecting = new Promise((resolve) => { selectionStarted = resolve; });
  const late = await turn('turn on the study light', { preference: ABSENT,
    cloudSelection: () => { selectionStarted(); return new Promise((resolve) => { releaseSelection = resolve; }); },
    async started(tx) {
      await selecting;
      tx.handleMessage({ json: context(declaration()) });
      releaseSelection({ enabled: true });
    },
  });
  assert.deepEqual(late.cloud.map((call) => call.type), ['selection']);
  assert.equal(hint(late), undefined);
  const beforeDispatch = await turn('turn on the study light', { preference: ABSENT, onFrame(frame, tx) {
    if (frame.type === 'LISTEN' && !frame.final) tx.handleMessage({ json: context(null) });
  } });
  assert.deepEqual(beforeDispatch.cloud.map((call) => call.type), ['selection']);
  assert.equal(beforeDispatch.frames.at(-1).final, true);
  assert.equal(beforeDispatch.frames.at(-1).data.match, null);
});

test('absence of a local declaration preserves cloud beta, and unlinked robots keep native Hue', async () => {
  const cloud = await turn('turn on the study light', { preference: ABSENT });
  assert.deepEqual(cloud.cloud.map((call) => call.type), ['selection', 'command']);
  assert.equal(listen(cloud).data.match.skillID, 'phoenix-home-assistant');
  assert.equal(cloud.frames.at(-1).type, 'SKILL_ACTION');
  const hue = await turn('turn on the lights', { preference: ABSENT, cloudSelection: () => ({ enabled: false }) });
  // One selection per turn: the pre-parse check, the parser hint and routing share it.
  assert.deepEqual(hue.cloud.map((call) => call.type), ['selection']);
  assert.equal(hue.parsed[0].home, undefined);
  assert.equal(listen(hue).data.match.skillID, '@be/hue-control');
});

test('a smart-home decision from the parser reaches Home Assistant with the spoken words, only when it is linked', async () => {
  // The parser stands in for the decision layer: it answers HOME_COMMAND_INTENT
  // only when the gateway marked the turn as one Home Assistant could take.
  const decided = (input) => (input.home === true
    ? { intent: 'phoenixHomeCommand', entities: {}, rules: ['launch'] }
    : parseRequest(input));
  for (const [text, kind] of [['start the vacuum', 'command'], ['lock the front door', 'command'],
    ['is the garage door open', 'query'], ['set the living room to 68 degrees', 'command']]) {
    const local = await turn(text, { parser: decided });
    assert.equal(local.parsed[0].home, true, text);
    assert.equal(listen(local).data.match.skillID, LOCAL_HOME_SKILL_ID, text);
    assert.deepEqual(hint(local), { v: 1, text, route: { kind } }, text);
    assert.deepEqual(local.cloud, [], text);

    const cloud = await turn(text, { preference: ABSENT, parser: decided });
    assert.equal(cloud.parsed[0].home, true, text);
    assert.deepEqual(cloud.cloud.map((call) => call.type), ['selection', 'command'], text);
    assert.deepEqual(cloud.cloud[1].route, { kind }, text);
    assert.equal(cloud.cloud[1].text, text, text);

    const unlinked = await turn(text, { preference: ABSENT, parser: decided, cloudSelection: () => ({ enabled: false }) });
    assert.equal(unlinked.parsed[0].home, undefined, text);
    assert.deepEqual(unlinked.cloud.map((call) => call.type), ['selection'], text);
    assert.notEqual(listen(unlinked).data.match?.skillID, 'phoenix-home-assistant', text);

    const none = await turn(text, { preference: ABSENT, parser: decided, cloudEnabled: false });
    assert.equal(none.parsed[0].home, undefined, text);
  }
});

test('the home hint is withheld from turns Home Assistant may never take', async () => {
  const marked = (input) => ({ ...parseRequest(input), marked: input.home });
  for (const text of ['what time is it', 'turn up the volume', 'go to sleep', 'tell me a joke', 'stop']) {
    const out = await turn(text, { parser: marked });
    assert.equal(out.parsed[0].home, undefined, text);
  }
  const active = await turn('lock the front door', { parser: marked, skill: { id: 'fixture-active-skill', session: { id: 'fixture-session' } } });
  assert.equal(active.parsed[0].home, undefined);
  assert.equal(active.native[0].skillID, 'fixture-active-skill');
  const unpaired = await turn('lock the front door', { parser: marked, preference: null, cloudEnabled: false });
  assert.equal(unpaired.parsed[0].home, undefined);
});

test('common household devices and the grammar thermostat rule reach Home Assistant without a decision', async () => {
  for (const text of ['turn off the basement AC', 'turn the bedroom fan off', 'switch on the A/C', 'turn off the TV',
    'turn the space heater on', 'turn on the outlet']) {
    const out = await turn(text, { preference: ABSENT });
    assert.deepEqual(out.parsed, [], text); // the direct-command fast path skips the parser
    assert.deepEqual(out.cloud.map((call) => call.type), ['selection', 'command'], text);
  }
  for (const text of ['set the thermostat to 72', 'turn up the heat', 'turn down the AC']) {
    const out = await turn(text, { preference: ABSENT });
    assert.deepEqual(out.cloud.map((call) => call.type), ['selection', 'command'], text);
    assert.equal(out.cloud[1].text, text, text);
  }
  for (const text of ['switch on dance mode', 'turn yourself off', 'turn off your fan']) {
    const out = await turn(text, { preference: ABSENT });
    assert.ok(!out.cloud.some((call) => call.type === 'command'), text);
  }
  // Without a linked connector the thermostat rule keeps its native answer.
  const unlinked = await turn('set the thermostat to 72', { preference: ABSENT, cloudSelection: () => ({ enabled: false }) });
  assert.equal(listen(unlinked).data.match.skillID, router.getSkillIDFromNLU(parseRequest({ text: 'set the thermostat to 72', rules: [...GLOBAL_TURN_RULES] })).skillID);
});

test('Hue never takes a turn from a linked Home Assistant; unlinked robots keep it', async () => {
  const hueOf = (text) => router.getSkillIDFromNLU(parseRequest({ text, rules: [...GLOBAL_TURN_RULES] }))?.skillID;
  // Several devices in one sentence reach Home Assistant whole.
  const both = 'turn on the kitchen and living room lights';
  assert.equal(hueOf(both), '@be/hue-control');
  const local = await turn(both);
  assert.equal(listen(local).data.match.skillID, LOCAL_HOME_SKILL_ID);
  assert.deepEqual(hint(local), { v: 1, text: both, route: { kind: 'command' } });
  const cloud = await turn(both, { preference: ABSENT });
  assert.deepEqual(cloud.cloud.map((call) => call.type), ['selection', 'command']);
  assert.equal(cloud.cloud[1].text, both);
  // Setup phrases, delays, sequences and an unassigned room are neither sent nor given to Hue.
  const noRooms = () => ({ enabled: true, capabilities: [], shortcuts: [] });
  for (const [text, preference, cloudSelection] of [
    ['help me set up my lights', declaration(), undefined], ['forget my lights', declaration(), undefined],
    ['turn off the lights in 10 minutes', declaration(), undefined], ['turn off the lights in five minutes', ABSENT, undefined],
    ['turn on the lights and then dim them', ABSENT, undefined], ['turn on the lights in here', ABSENT, noRooms],
    ['help me set up my lights', ABSENT, undefined]]) {
    assert.equal(hueOf(text), '@be/hue-control', text);
    const out = await turn(text, { preference, cloudSelection });
    assert.equal(listen(out).data.match, null, text);
    assert.ok(!out.cloud.some((call) => call.type === 'command'), text);
  }
  for (const text of ['help me set up my lights', 'turn off the lights in 10 minutes', both]) {
    const unlinked = await turn(text, { preference: ABSENT, cloudSelection: () => ({ enabled: false }) });
    assert.equal(listen(unlinked).data.match.skillID, '@be/hue-control', text);
    const none = await turn(text, { preference: ABSENT, cloudEnabled: false });
    assert.equal(listen(none).data.match.skillID, '@be/hue-control', text);
  }
});

test('a connector without state queries is not sent implicit questions from the decision layer', async () => {
  const decided = (input) => (input.home === true
    ? { intent: 'phoenixHomeCommand', entities: {}, rules: ['launch'] } : parseRequest(input));
  const legacy = () => ({ enabled: true, capabilities: [], shortcuts: [] });
  const question = await turn('is the garage door open', { preference: ABSENT, parser: decided, cloudSelection: legacy });
  assert.deepEqual(question.cloud.map((call) => call.type), ['selection']);
  const command = await turn('close the garage door', { preference: ABSENT, parser: decided, cloudSelection: legacy });
  assert.deepEqual(command.cloud.map((call) => call.type), ['selection', 'command']);
  assert.deepEqual(command.cloud[1].route, { kind: 'command' });
});

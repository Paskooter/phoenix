// All identities, rooms, preferences and peer results are invented fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantClient } from '../src/homeAssistantClient.js';
import { homeCommandCandidate } from '../src/homeAssistantRoute.js';
import { ListenTransaction, GLOBAL_TURN_RULES } from '../src/listenTransaction.js';
import { IntentRouter } from '../src/intentRouter.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { loadRegistry } from '../src/registry.js';
import { parseRequest } from '../../nlu/src/requestParser.js';
import { buildSkillAction } from '../../skills/src/jcp.js';
import { homeAssistantSpeech } from '../../skills/src/homeAssistantSkill.js';

const ROBOT = { id: 'synthetic-account-a', friendlyId: 'synthetic-robot-a', accessKeyId: 'synthetic-key-a' };
const OTHER_ROBOT = { id: 'synthetic-account-b', friendlyId: 'synthetic-robot-b', accessKeyId: 'synthetic-key-b' };
const SHORTCUT = '11111111-2222-4333-8444-555555555555';
const capabilities = ['room_context', 'state_queries', 'follow_up', 'routine_shortcuts'];
const linked = (extra = {}) => ({ enabled: true, capabilities, shortcuts: [{ id: SHORTCUT, phrase: 'movie time' }], ...extra });
const log = { info() {}, debug() {}, warn() {}, error() {} };
const registry = await loadRegistry({ indexFile: 'skills-phoenix.json', skillsBase: 'http://127.0.0.1:1' });
const router = new IntentRouter(registry);
const manager = new SkillConfigManager(registry);
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const esml = (reply) => reply.data.action.config.jcp.children[0].config.play.esml;

function peerClient({ selection = linked(), result = { outcome: 'success', response_type: 'action_done', speech: 'Synthetic result.' } } = {}) {
  const requests = [];
  const client = new HomeAssistantClient({ url: 'http://synthetic-account.invalid', token: 'synthetic-peer-token',
    fetchImpl: async (url, options) => {
      const request = { url, body: JSON.parse(options.body), headers: options.headers };
      requests.push(request);
      const value = url.endsWith('/selection')
        ? (typeof selection === 'function' ? await selection(request.body.identity) : selection)
        : (typeof result === 'function' ? await result(request.body) : result);
      return jsonResponse(value);
    } });
  return { client, requests };
}

async function voiceTurn(client, text, { identity = ROBOT, skill = {}, hotphrase = false, nlu = null, started = null, onFrame = null } = {}) {
  const frames = [];
  const native = [];
  const parsed = [];
  const tx = new ListenTransaction({ _auth: identity,
    _jiboHeaders: { 'x-jibo-robotid': 'synthetic-spoofed-trace-robot', 'x-jibo-loopid': 'synthetic-spoofed-loop' },
    _remoteAddress: '127.0.0.1' }, {
    config: { recordLaunchHistory: false, recordSpeechHistory: false }, homeAssistant: client,
    parser: { async handleNLU(input) { parsed.push(input); return nlu || parseRequest({ text: input.text, rules: input.rules }); } },
    intentRouter: router, skillConfigManager: manager,
    skillClient: { async launchOrUpdate(skillID, input, trace, isUpdate) {
      native.push({ skillID, isUpdate });
      return { skillID, response: buildSkillAction({ skillId: skillID, sessionId: 'synthetic-native-session', esmlText: 'Synthetic native reply.' }) };
    } },
  }, { write(frame) { frames.push(frame); onFrame?.(frame, tx); return true; } }, log);
  if (identity) {
    tx.handleMessage({ json: { type: 'LISTEN', data: { mode: 'CLIENT_ASR', lang: 'en-US', hotphrase, rules: [...GLOBAL_TURN_RULES] } } });
    tx.handleMessage({ json: { type: 'CONTEXT', data: {
    general: { robotID: identity?.friendlyId || 'synthetic-unauthenticated-robot', accountID: identity?.id || 'synthetic-unauthenticated-account', lang: 'en', release: '1.9.0',
      householdID: 'synthetic-spoofed-household', room: 'synthetic-spoofed-room' },
    runtime: { dialog: { homeAssistant: linked({ follow_up: { available: true, expires_at_ms: Date.now() + 30_000 } }) },
      perception: { peoplePresent: [] }, loop: { users: [] } }, skill,
    } } });
  }
  tx.handleMessage({ json: { type: 'CLIENT_ASR', data: { text } } });
  if (started) await started(tx);
  await tx.done;
  return { frames, native, parsed, tx };
}

test('state questions and room controls require explicitly negotiated capabilities', () => {
  const selection = linked();
  for (const text of ['is the study light on', 'are the sitting room lights off', 'is the kitchen switch on', 'is the entry door locked',
    'is the office window closed', 'what is the state of the study light', "what's the kitchen humidity",
    'what is the temperature in the kitchen', 'what is the temperature in here']) {
    assert.equal(homeCommandCandidate(text, { selection }).route.kind, 'query', text);
    assert.equal(homeCommandCandidate(text, { selection: { enabled: true } }), null, text);
  }
  for (const text of ['turn on the lights in here', 'turn the lights off in this room', 'set the lights in here to blue']) {
    assert.equal(homeCommandCandidate(text, { selection }).route.kind, 'command', text);
    assert.equal(homeCommandCandidate(text, { selection: { enabled: true } }), null, text);
  }
  for (const text of ['is the kitchen light on and turn it off', 'what is the temperature outside',
    'is the run script light on', 'tell me about the door', 'what is Home Assistant', 'what about my family']) {
    assert.equal(homeCommandCandidate(text, { selection }), null, text);
  }
});

test('short pronoun and room follow-ups need fresh per-robot context and do not admit arbitrary answers', () => {
  const now = 1_000_000;
  const selection = linked({ follow_up: { available: true, expires_at_ms: now + 30_000 } });
  for (const text of ['turn it off', 'switch on those', 'set them to 50 percent', 'set it brightness to 100%',
    'set them to warm white', 'are they still on', 'is it closed', 'and in the kitchen', 'what about the study lights']) {
    assert.equal(homeCommandCandidate(text, { selection, now }).route.kind, 'follow_up', text);
    for (const expires_at_ms of [now, now - 1, now + 30_001]) {
      assert.equal(homeCommandCandidate(text, { selection: linked({ follow_up: { available: true, expires_at_ms } }), now }), null, text);
    }
    assert.equal(homeCommandCandidate(text, { selection: linked(), now }), null, text);
  }
  for (const text of ['yes', 'blue', 'change it', 'do it again', 'turn it off and start a script',
    'set it to 101 percent', 'what about turn off the lights', 'and in the kitchen then run a script']) {
    assert.equal(homeCommandCandidate(text, { selection, now }), null, text);
  }
});

test('relative brightness follows only six exact forms with current context and no native conflict', () => {
  const now = 1_000_000;
  const selection = linked({ follow_up: { available: true, expires_at_ms: now + 30_000 } });
  for (const text of ['make it dimmer', 'make them dimmer', 'make those dimmer',
    'make it brighter', 'make them brighter', 'make those brighter']) {
    assert.deepEqual(homeCommandCandidate(text, { selection, now, nativeDecision: null }).route, { kind: 'follow_up' }, text);
    for (const unavailable of [linked(), linked({ follow_up: { available: false, expires_at_ms: now + 30_000 } }),
      linked({ follow_up: { available: true, expires_at_ms: now } }),
      linked({ follow_up: { available: true, expires_at_ms: now + 30_001 } }),
      linked({ capabilities: [], follow_up: selection.follow_up })]) {
      assert.equal(homeCommandCandidate(text, { selection: unavailable, now, nativeDecision: null }), null, text);
    }
    assert.equal(homeCommandCandidate(text, { selection, now, activeSkill: 'synthetic-active-skill' }), null, text);
    assert.equal(homeCommandCandidate(text, { selection, now, nlu: { intent: 'requestDance', entities: {} },
      nativeDecision: { skillID: 'chitchat-skill' } }), null, text);
    assert.equal(homeCommandCandidate(text, { selection, now, nlu: { intent: 'battery', entities: { domain: 'settings', skill: '@be/settings' } },
      nativeDecision: null }), null, text);
    assert.equal(homeCommandCandidate(text, { selection: linked({ shortcuts: [{ id: SHORTCUT, phrase: text }] }), now,
      nativeDecision: null }), null, `no-context routine collision: ${text}`);
  }
  for (const text of ['make it dimmer and turn it off', 'make those brighter then run a script',
    'please make it dimmer', 'make it slightly dimmer', 'make it darker', 'dim it', 'brighten them', 'make it louder']) {
    assert.equal(homeCommandCandidate(text, { selection, now, nativeDecision: null }), null, text);
  }
});

test('relative brightness voice dispatch uses the live verified robot and never probes without context', async () => {
  const liveContext = () => linked({ follow_up: { available: true, expires_at_ms: Date.now() + 30_000 } });
  for (const text of ['make it dimmer', 'make it brighter', 'make them brighter']) {
    const peer = peerClient({ selection: liveContext });
    await voiceTurn(peer.client, text);
    assert.deepEqual(peer.requests.at(-1).body, { identity: ROBOT, text, language: 'en', route: { kind: 'follow_up' } });
  }
  for (const selection of [linked(), linked({ follow_up: { available: true, expires_at_ms: Date.now() - 1 } })]) {
    const peer = peerClient({ selection });
    await voiceTurn(peer.client, 'make it dimmer');
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 0);
  }
  const cancelled = peerClient({ selection: liveContext });
  await voiceTurn(cancelled.client, 'make it dimmer', { onFrame: (frame, tx) => {
    if (frame.type === 'LISTEN') tx.abandon();
  } });
  assert.equal(cancelled.requests.filter((request) => request.url.endsWith('/command')).length, 0);
  const boundPeer = peerClient({ selection: (identity) => identity.id === ROBOT.id ? liveContext() : linked() });
  await voiceTurn(boundPeer.client, 'make it dimmer', { identity: OTHER_ROBOT });
  await voiceTurn(boundPeer.client, 'make it dimmer', { skill: { id: 'synthetic-active-skill', session: { id: 'synthetic-active-session' } } });
  const native = await voiceTurn(boundPeer.client, 'make it dimmer', {
    nlu: { intent: 'requestDance', entities: {}, rules: ['launch'] },
  });
  assert.equal(native.frames.find((frame) => frame.type === 'LISTEN').data.match.skillID, 'chitchat-skill');
  for (const [text, intent] of [['make it louder', 'volumeUp'], ['make it quieter', 'volumeDown']]) {
    const nlu = parseRequest({ text, rules: [...GLOBAL_TURN_RULES] });
    assert.equal(nlu.intent, intent);
    await voiceTurn(boundPeer.client, text);
  }
  assert.equal(boundPeer.requests.filter((request) => request.url.endsWith('/command')).length, 0);
});

test('routine phrases match exactly, cannot steal reserved commands and require UUID shortcut identities', () => {
  assert.deepEqual(homeCommandCandidate('  MOVIE   TIME?! ', { selection: linked() }).route, { kind: 'routine', shortcut_id: SHORTCUT });
  for (const text of ['please movie time', 'movie time now', 'start movie time']) {
    assert.equal(homeCommandCandidate(text, { selection: linked() }), null, text);
  }
  for (const text of ['tell me a joke', 'turn up the volume',
    'go to sleep', 'what time is it', 'what is the weather', 'cancel', 'connect Hue', 'yes', 'blue', 'black',
    'wake up', 'be quiet', 'take a photo', 'play music', 'connect to wifi', 'help']) {
    const selection = linked({ shortcuts: [{ id: SHORTCUT, phrase: text }] });
    assert.equal(homeCommandCandidate(text, { selection }), null, text);
  }
  assert.equal(homeCommandCandidate('movie time', { selection: { enabled: true, capabilities: [] } }), null);
  assert.equal(homeCommandCandidate('movie time', { selection: linked({ shortcuts: [{ id: 'not-a-uuid', phrase: 'movie time' }] }) }), null);
});

test('follow-up and query failure speech describes the result without claiming action completion', () => {
  assert.match(homeAssistantSpeech({ outcome: 'error', code: 'no_context', speech: '' }), /full command again/);
  assert.match(homeAssistantSpeech({ outcome: 'error', code: 'invalid_shortcut', speech: '' }), /routine is no longer available/);
  assert.equal(homeAssistantSpeech({ outcome: 'error', code: 'unsupported_feature', speech: '' }), 'That Home Assistant device does not support that change.');
  assert.match(homeAssistantSpeech({ outcome: 'success', response_type: 'query_answer', speech: '' }, { kind: 'query' }), /didn't provide a state answer/);
});

test('client projects verified identity and route fields, keeps legacy selection and does not retry execution', async () => {
  const peer = peerClient({ selection: { enabled: true }, result: { outcome: 'uncertain', response_type: 'error', speech: '' } });
  const identity = { ...ROBOT, householdID: 'synthetic-extra-household', context: { area: 'synthetic-extra-room' } };
  assert.deepEqual(await peer.client.selection(identity), { enabled: true, capabilities: [], shortcuts: [], follow_up: { available: false } });
  await peer.client.command(identity, 'movie time', { kind: 'routine', shortcut_id: SHORTCUT, householdID: 'synthetic-extra-household', conversation_id: 'synthetic-extra-context' });
  assert.deepEqual(peer.requests[0].body, { identity: ROBOT });
  assert.deepEqual(peer.requests[1].body, { identity: ROBOT, text: 'movie time', language: 'en', route: { kind: 'routine', shortcut_id: SHORTCUT } });
  assert.equal(peer.requests[1].headers['x-jibo-robotid'], undefined);
  const before = peer.requests.length;
  assert.equal((await peer.client.command(ROBOT, 'movie time', { kind: 'routine', shortcut_id: 'not-a-uuid' })).code, 'invalid_command');
  assert.equal(await peer.client.selection({ id: ROBOT.id, friendlyId: ROBOT.friendlyId }), false);
  assert.equal(peer.requests.length, before);
  let attempts = 0;
  const broken = new HomeAssistantClient({ url: 'http://synthetic-account.invalid', token: 'synthetic-peer-token',
    fetchImpl: async () => { attempts++; throw new Error('synthetic lost response after delivery'); } });
  assert.equal((await broken.command(ROBOT, 'turn on the study light')).outcome, 'uncertain');
  assert.equal(attempts, 1);
});

test('real listen transactions select query/routine metadata and reuse the escaped Jibo response envelope', async () => {
  for (const [text, route] of [['is the study light on', { kind: 'query' }],
    ['movie time', { kind: 'routine', shortcut_id: SHORTCUT }], ['turn on the lights in here', { kind: 'command' }]]) {
    const peer = peerClient({ result: { outcome: 'success', response_type: 'query_answer', speech: '<anim/> Study & lamp {break}', conversation_id: 'synthetic-private-conversation' } });
    const result = await voiceTurn(peer.client, text);
    const command = peer.requests.find((request) => request.url.endsWith('/command'));
    assert.deepEqual(command.body, { identity: ROBOT, text, language: 'en', route });
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 1);
    assert.equal(result.native.length, 0);
    const listen = result.frames.find((frame) => frame.type === 'LISTEN');
    assert.equal(listen.data.match.skillID, 'phoenix-home-assistant');
    const reply = result.frames.at(-1);
    assert.equal(reply.type, 'SKILL_ACTION'); assert.equal(reply.final, true); assert.equal(reply.data.final, true);
    assert.match(esml(reply), /&lt;anim\/&gt;/); assert.match(esml(reply), /&amp;/); assert.ok(!esml(reply).includes('{'));
    assert.ok(!JSON.stringify(reply).includes('synthetic-private-conversation'));
    assert.ok(result.parsed.length > 0);
  }
});

test('native commands, active skill answers and arbitrary speech never execute the Home Assistant API', async () => {
  for (const text of ['turn up the volume', 'go to sleep', 'what time is it', 'tell me a joke', 'what is the weather',
    'stop', 'cancel', 'help me connect Hue', 'make me laugh', 'wake up', 'be quiet', 'take a photo', 'play music', 'connect to wifi', 'help']) {
    const peer = peerClient({ selection: linked({ shortcuts: [{ id: SHORTCUT, phrase: text }] }) });
    const result = await voiceTurn(peer.client, text);
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 0, text);
    if (text === 'what time is it') assert.equal(result.frames.find((frame) => frame.type === 'LISTEN').data.match.skillID, '@be/clock');
  }
  for (const text of ['tell me about lights', 'hello there', 'turn on dance mode', 'switch on dance mode', 'switch on those']) {
    const peer = peerClient();
    await voiceTurn(peer.client, text);
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 0, text);
  }
  const peer = peerClient();
  const active = await voiceTurn(peer.client, 'movie time', { skill: { id: 'synthetic-active-skill', session: { id: 'synthetic-active-session' } } });
  assert.equal(peer.requests.length, 0);
  assert.deepEqual(active.native, [{ skillID: 'synthetic-active-skill', isUpdate: true }]);
  const interrupted = await voiceTurn(peer.client, 'movie time', { skill: { id: 'synthetic-active-skill' }, hotphrase: true });
  assert.equal(interrupted.frames.at(-1).data.skill.id, 'phoenix-home-assistant');
});

test('classifier-native skills and domains beat conflicting owner shortcuts without alias enumeration', async () => {
  for (const [text, intent, skillID] of [['dance', 'requestDance', 'chitchat-skill'],
    ['do a dance', 'requestDance', 'chitchat-skill'], ['sing me a song', 'requestSingSong', 'chitchat-skill'],
    ['take a selfie', 'createOnePhoto', '@be/create'], ['show me my pictures', 'galleryOpen', '@be/gallery'],
    ['how much battery do you have', 'battery', '@be/settings'], ['show me the settings', 'menu', '@be/settings']]) {
    const nlu = parseRequest({ text, rules: [...GLOBAL_TURN_RULES] });
    const nativeDecision = router.getSkillIDFromNLU(nlu);
    assert.equal(nlu.intent, intent, text);
    assert.equal(nativeDecision.skillID, skillID, text);
    const selection = linked({ shortcuts: [{ id: SHORTCUT, phrase: text }] });
    assert.equal(homeCommandCandidate(text, { nlu, nativeDecision, selection }), null, text);
    assert.equal(homeCommandCandidate(text, { nlu, selection }), null, `missing decision: ${text}`);
    const peer = peerClient({ selection });
    const result = await voiceTurn(peer.client, text);
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 0, text);
    assert.equal(result.frames.find((frame) => frame.type === 'LISTEN').data.match.skillID, skillID, text);
  }
  // A known native domain stays protected even when its skill is not enabled.
  assert.equal(homeCommandCandidate('take a selfie', { selection: linked({ shortcuts: [{ id: SHORTCUT, phrase: 'take a selfie' }] }),
    nlu: { intent: 'createOnePhoto', entities: { domain: 'create', skill: '@be/create' } }, nativeDecision: null }), null);
});

test('native shortcut guard preserves supported home routes, explicit invocation and unknown owner phrases', async () => {
  const lights = 'turn up the lights';
  const nlu = parseRequest({ text: lights, rules: [...GLOBAL_TURN_RULES] });
  const nativeDecision = router.getSkillIDFromNLU(nlu);
  assert.equal(nativeDecision.skillID, '@be/hue-control');
  const linkedPeer = peerClient({ selection: linked({ shortcuts: [{ id: SHORTCUT, phrase: lights }] }) });
  await voiceTurn(linkedPeer.client, lights);
  assert.deepEqual(linkedPeer.requests.at(-1).body.route, { kind: 'command' });
  const unlinkedPeer = peerClient({ selection: { enabled: false } });
  const hue = await voiceTurn(unlinkedPeer.client, lights);
  assert.equal(unlinkedPeer.requests.filter((request) => request.url.endsWith('/command')).length, 0);
  assert.equal(hue.frames.find((frame) => frame.type === 'LISTEN').data.match.skillID, '@be/hue-control');
  const explicit = homeCommandCandidate('ask Home Assistant to dance', {
    nlu: { intent: 'requestDance', entities: {} }, nativeDecision: { skillID: 'chitchat-skill' }, selection: linked(),
  });
  assert.deepEqual(explicit.route, { kind: 'command' });
  assert.equal(explicit.text, 'dance');
  const unknown = parseRequest({ text: 'movie time', rules: [...GLOBAL_TURN_RULES] });
  assert.equal(unknown.intent, null);
  assert.deepEqual(homeCommandCandidate('movie time', { nlu: unknown, nativeDecision: null, selection: linked() }).route,
    { kind: 'routine', shortcut_id: SHORTCUT });
  const ownerPeer = peerClient();
  await voiceTurn(ownerPeer.client, 'movie time', { nlu: { intent: 'synthetic-unregistered-intent', entities: {}, rules: ['launch'] } });
  assert.deepEqual(ownerPeer.requests.at(-1).body.route, { kind: 'routine', shortcut_id: SHORTCUT });
});

test('unlinked and legacy Hue behavior survive; explicit invocation still gives setup speech', async () => {
  for (const selection of [{ enabled: false }, { enabled: true }]) {
    const peer = peerClient({ selection });
    const query = await voiceTurn(peer.client, 'is the study light on');
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 0);
    assert.ok(query.parsed.length);
  }
  const unlinked = peerClient({ selection: { enabled: false }, result: { outcome: 'error', response_type: 'error', code: 'not_linked', speech: '' } });
  const hue = await voiceTurn(unlinked.client, 'turn on the lights');
  assert.equal(unlinked.requests.filter((request) => request.url.endsWith('/command')).length, 0);
  assert.equal(hue.frames.find((frame) => frame.type === 'LISTEN').data.match.skillID, '@be/hue-control');
  const explicit = await voiceTurn(unlinked.client, 'ask Home Assistant to start my custom routine');
  assert.match(esml(explicit.frames.at(-1)), /Link Home Assistant/);
  assert.deepEqual(unlinked.requests.at(-1).body.route, { kind: 'command' });
});

test('per-robot fresh selection prevents context/header spoofing and clears follow-ups without replay', async () => {
  let online = true;
  const peer = peerClient({ selection: (identity) => online && identity.id === ROBOT.id
    ? linked({ follow_up: { available: true, expires_at_ms: Date.now() + 30_000 } }) : { enabled: false } });
  await voiceTurn(peer.client, 'turn it off');
  assert.deepEqual(peer.requests.at(-1).body.route, { kind: 'follow_up' });
  const before = peer.requests.filter((request) => request.url.endsWith('/command')).length;
  await voiceTurn(peer.client, 'turn it off', { identity: OTHER_ROBOT });
  online = false; // Account connector disconnected/revoked or agent changed.
  await voiceTurn(peer.client, 'turn it off');
  await voiceTurn(peer.client, 'movie time');
  await voiceTurn(peer.client, 'movie time', { identity: null });
  assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, before);
  assert.ok(peer.requests.filter((request) => request.url.endsWith('/selection')).every((request) =>
    Object.keys(request.body).join(',') === 'identity' && Object.keys(request.body.identity).sort().join(',') === 'accessKeyId,friendlyId,id'));
});

test('selection abandonment prevents dispatch; dispatch uncertainty/busy emits one honest response', async () => {
  let releaseSelection;
  const selecting = peerClient({ selection: () => new Promise((resolve) => { releaseSelection = resolve; }) });
  await voiceTurn(selecting.client, 'turn on the study light', { started: async (tx) => {
    await new Promise((resolve) => setImmediate(resolve)); tx.abandon(); releaseSelection(linked());
  } });
  assert.equal(selecting.requests.filter((request) => request.url.endsWith('/command')).length, 0);
  const cancelledRoute = peerClient();
  await voiceTurn(cancelledRoute.client, 'turn on the study light', { onFrame: (frame, tx) => {
    if (frame.type === 'LISTEN') tx.abandon();
  } });
  assert.equal(cancelledRoute.requests.filter((request) => request.url.endsWith('/command')).length, 0);
  for (const result of [{ outcome: 'uncertain', response_type: 'error', speech: 'Turned on' },
    { outcome: 'error', response_type: 'error', code: 'busy', speech: '' }]) {
    const peer = peerClient({ result });
    const turn = await voiceTurn(peer.client, 'turn on the study light');
    assert.equal(peer.requests.filter((request) => request.url.endsWith('/command')).length, 1);
    assert.match(esml(turn.frames.at(-1)), result.code === 'busy' ? /still working/ : /couldn't confirm/);
  }
  let releaseResult;
  const executing = peerClient({ result: () => new Promise((resolve) => { releaseResult = resolve; }) });
  const turn = await voiceTurn(executing.client, 'turn on the study light', { started: async (tx) => {
    await new Promise((resolve) => setImmediate(resolve)); tx.abandon(); releaseResult({ outcome: 'success', response_type: 'action_done', speech: 'Synthetic done.' });
  } });
  assert.equal(executing.requests.filter((request) => request.url.endsWith('/command')).length, 1);
  assert.equal(turn.frames.filter((frame) => frame.type === 'SKILL_ACTION').length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCommandCandidate, homeCommandEligible } from '../src/homeAssistantRoute.js';
import { buildHomeAssistantReply, homeAssistantSpeech } from '../../skills/src/homeAssistantSkill.js';
import { parseRequest } from '../../nlu/src/requestParser.js';
import { GLOBAL_TURN_RULES } from '../src/listenTransaction.js';
import { IntentRouter } from '../src/intentRouter.js';
import { loadRegistry } from '../src/registry.js';

test('first-release direct phrases and explicit custom commands are selected before execution', () => {
  for (const text of ['turn on the kitchen lights', 'turn off bedroom lamp', 'switch garden switch on',
    'set the bedroom light brightness to fifty percent', 'set kitchen lights to red', 'activate the dinner scene',
    'run relax script', 'ask Home Assistant to start my custom routine']) assert.ok(homeCommandCandidate(text), text);
  assert.equal(homeCommandCandidate('ask Home Assistant to turn on kitchen light').text, 'turn on kitchen light');
});

test('ordinary Jibo commands, active skill answers and compound requests never probe Assist', () => {
  for (const text of ['turn up the volume', 'set the volume to fifty percent', 'go to sleep', 'what time is it',
    'tell me a joke', "what's the weather", 'stop', 'cancel', 'blue', 'yes', 'turn on dance mode',
    'turn on kitchen lights and change the thermostat', 'tell me about lights']) {
    assert.equal(homeCommandCandidate(text), null, text);
  }
  assert.equal(homeCommandCandidate('turn on kitchen lights', { activeSkill: 'active-skill' }), null);
  assert.ok(homeCommandCandidate('turn on kitchen lights', { activeSkill: 'active-skill', hotphrase: true }));
});

test('classified home commands: polite requests stay commands, questions are read-only, delays are never sent', () => {
  const selection = { enabled: true, capabilities: ['room_context', 'state_queries', 'follow_up', 'routine_shortcuts'], shortcuts: [] };
  const home = { intent: 'phoenixHomeCommand', entities: {}, rules: ['launch'] };
  const lights = (intent) => ({ intent, entities: { domain: 'hue-control', skill: '@be/hue-control' }, rules: ['launch'] });
  for (const [text, nlu, kind] of [
    ['do you mind turning off the lights', lights('lightsOff'), 'command'], ['do you mind turning on the fan', home, 'command'],
    ['how about some light in the den', home, 'command'], ['set the office lights at 50 percent', lights('lightsUp'), 'command'],
    ['turn on the kitchen and dining room lights', lights('lightsGroupOn'), 'command'], ['close the garage door', home, 'command'],
    ['set the thermostat to 72', { intent: 'requestManageThermostat', entities: {}, rules: ['launch'] }, 'command'],
    ['is the dryer done', home, 'query'], ['how warm is it in the nursery', home, 'query'], ['did i leave the stove on', home, 'query'],
  ]) assert.deepEqual(homeCommandCandidate(text, { selection, nlu })?.route, { kind }, text);
  for (const [text, nlu] of [['turn the porch light on at 7 pm', home], ['turn off the lights at 10:30', lights('lightsOff')],
    ['turn the fan on for 20 minutes', home], ['turn off the lights in five minutes', lights('lightsOff')],
    ['turn on the lights and then dim them', lights('lightsOn')], ['what time is it', home], ['turn up the volume', home]]) {
    assert.equal(homeCommandCandidate(text, { selection, nlu }), null, text);
  }
  // Common devices take the direct path before any parse; Jibo's own parts never do.
  for (const text of ['turn off the basement AC', 'turn on the A/C', 'switch the bedroom fan off', 'turn off the TV']) {
    assert.deepEqual(homeCommandCandidate(text, { selection })?.route, { kind: 'command' }, text);
  }
  for (const text of ['turn off your fan', 'turn yourself off', 'turn off the lights in five minutes']) {
    assert.equal(homeCommandCandidate(text, { selection }), null, text);
  }
});

test('fallback classification and explicit invocation retain self, media and delay limits', () => {
  const selection = { enabled: true, capabilities: ['state_queries'] };
  const nlu = { intent: 'phoenixHomeCommand', entities: {}, rules: ['launch'] };
  for (const text of ['turn off your fan', 'turn your light off', 'turn yourself off', 'set your light to red',
    'play the tv show friends', 'turn off the AC in eleven minutes', 'turn on the AC in twenty-five minutes',
    'turn off the AC at seven pm', 'turn off the AC tomorrow',
    'ask home assistant to turn off the AC in five minutes', 'tell home assistant to turn on the fan tomorrow']) {
    assert.equal(homeCommandEligible(text), false, text);
    assert.equal(homeCommandCandidate(text, { selection, nlu }), null, text);
  }
  for (const text of ['ask home assistant to is the invented dryer done', 'tell home assistant to what is the bedroom temperature']) {
    assert.equal(homeCommandCandidate(text, { selection, nlu }).route.kind, 'query', text);
    assert.equal(homeCommandCandidate(text, { selection: { enabled: true, capabilities: [] }, nlu }), null, text);
  }
});

test('existing Hue routing remains intact and setup/delete intents cannot be redirected', async () => {
  const skills = await loadRegistry({ indexFile: 'skills-phoenix.json', skillsBase: 'http://127.0.0.1:1' });
  const router = new IntentRouter(skills);
  const nlu = parseRequest({ text: 'turn on the lights', rules: [...GLOBAL_TURN_RULES] });
  assert.equal(router.getSkillIDFromNLU(nlu).skillID, '@be/hue-control');
  for (const intent of ['lightsSetup', 'lightsDeleteData', 'lightsHowTo', 'lightsSetupDefaultGroup']) {
    assert.equal(homeCommandCandidate('help me connect Hue', { nlu: { intent, rules: ['launch'] } }), null);
  }
});

test('returned text uses the existing escaped ESML envelope and uncertainty cannot claim success', () => {
  const reply = buildHomeAssistantReply({ outcome: 'success', speech: '<anim/> Kitchen & bedroom {break}' });
  assert.equal(reply.type, 'SKILL_ACTION'); assert.equal(reply.data.final, true);
  const esml = reply.data.action.config.jcp.children[0].config.play.esml;
  assert.ok(esml.includes('&lt;anim/&gt;')); assert.ok(esml.includes('&amp;')); assert.ok(!esml.includes('{'));
  assert.match(homeAssistantSpeech({ outcome: 'uncertain', speech: 'Turned on' }), /couldn't confirm/);
  assert.match(homeAssistantSpeech({ outcome: 'partial', speech: 'One device worked' }), /Only part/);
});

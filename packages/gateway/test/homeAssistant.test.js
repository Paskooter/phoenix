import test from 'node:test';
import assert from 'node:assert/strict';
import { homeCommandCandidate } from '../src/homeAssistantRoute.js';
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

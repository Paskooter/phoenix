import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { start } from '../src/index.js';
import { loadRegistry } from '../../gateway/src/registry.js';
import { IntentRouter } from '../../gateway/src/intentRouter.js';
import { SkillConfigManager } from '../../gateway/src/skillClient.js';
import { setDecisionClientForTest } from '../src/decisionLayer.js';
import { mediaPlayRequest } from '../src/mediaPlay.js';
import { ListenTransaction } from '../../gateway/src/listenTransaction.js';
import { ParserClient } from '../../gateway/src/parserClient.js';

const RULES = ['launch', 'globals/global_commands_launch', 'globals/gui_nav', 'globals/mim_repeat', 'globals/mim_thanks'];

async function hubTurn(parser, marker, inputNlu, text = 'play Despacito') {
  const skills = await loadRegistry({ indexFile: 'skills-native.json', env: {} });
  const frames = [];
  const tx = new ListenTransaction({ _auth: { id: 'synthetic-account', friendlyId: 'synthetic-robot' } }, {
    config: { recordLaunchHistory: false, recordSpeechHistory: false }, parser,
    intentRouter: new IntentRouter(skills), skillConfigManager: new SkillConfigManager(skills),
    skillClient: { launchOrUpdate() { throw Error('a media launch must not call a cloud skill'); } },
  }, { write(frame) { frames.push(frame); } }, { info() {}, debug() {}, warn() {}, error() {} });
  tx.handleMessage({ json: { type: 'LISTEN', data: { mode: inputNlu ? 'CLIENT_NLU' : 'CLIENT_ASR', hotphrase: true, rules: RULES } } });
  tx.handleMessage({ json: { type: 'CONTEXT', data: { general: { accountID: 'synthetic-account', robotID: 'synthetic-robot', release: '13.7.1' }, runtime: { loop: { users: [] } }, skill: {}, ...(marker === undefined ? {} : { phoenix_jibotube: marker }) } } });
  tx.handleMessage({ json: inputNlu ? { type: 'CLIENT_NLU', data: inputNlu } : { type: 'CLIENT_ASR', data: { text } } });
  await tx.done;
  return frames.find(frame => frame.type === 'LISTEN');
}

test('the Hub only offers media routing for a robot that declares the installed app', async () => {
  assert.equal(mediaPlayRequest({ text: 'play Despacito', rules: RULES }), null);
  const server = await start(0);
  try {
    const frame = await hubTurn(new ParserClient(`http://127.0.0.1:${server.address().port}`), 1);
    assert.deepEqual(frame.data.match, { skillID: '@phoenix/jibotube', launch: true, onRobot: true });
    assert.equal(frame.final, true);
    assert.equal(frame.data.nlu.entities.query, 'Despacito');
    assert.equal(frame.data.asr.text, 'play Despacito');
    // Optional cross-repository replay into the private app's archived SDK.
    if (process.env.JIBOTUBE_VOICE_LISTEN_OUT) writeFileSync(process.env.JIBOTUBE_VOICE_LISTEN_OUT, JSON.stringify(frame));
    for (const marker of [undefined, true, 0, 2, '1', {}, []]) {
      const frame = await hubTurn(null, marker, { intent: 'phoenixPlayVideo', entities: { query: 'Despacito' }, rules: ['launch'] });
      assert.equal(frame?.data.match, null, `unsupported marker ${JSON.stringify(marker)} must never launch a missing skill`);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('robots without the media capability retain the legacy parser and game route', async () => {
  let decisions = 0;
  setDecisionClientForTest({ enabled: true, config: { minProbability: 0.5, overrideProbability: 0.9 },
    choose: async () => { decisions++; return { choice: 'game', probability: 1 }; } });
  const server = await start(0);
  try {
    const parser = new ParserClient(`http://127.0.0.1:${server.address().port}`);
    for (const marker of [undefined, true, 0, 2, '1', {}, []]) {
      const frame = await hubTurn(parser, marker);
      assert.equal(frame.data.nlu.intent, 'launchGame');
      assert.equal(frame.data.match.skillID, '@be/circuit-saver');
    }
    assert.equal(decisions, 7, 'the old decision route still runs without the exact capability');
    const frame = await hubTurn(parser, 1);
    assert.equal(frame.data.match.skillID, '@phoenix/jibotube');
    assert.equal(decisions, 7, 'the installed player bypasses generic decision review');
  } finally {
    setDecisionClientForTest(null);
    await new Promise(resolve => server.close(resolve));
  }
});

test('installed media routing preserves recognized game actions and the game-list answer', async () => {
  let decisions = 0;
  setDecisionClientForTest({ enabled: true, config: { minProbability: 0.5, overrideProbability: 0.9 },
    choose: async () => { decisions++; return { choice: 'game', probability: 1 }; } });
  const server = await start(0);
  try {
    const router = new IntentRouter(await loadRegistry({ indexFile: 'skills-native.json', env: {} }));
    for (const [text, intent, mim] of [
      ['play pong', 'requestPlayPong', 'RA_JBO_PlayPong'],
      ['play ping pong', 'requestPlayPingPong', 'RA_JBO_PlayPingPong'],
      ['roll the dice', 'requestRollTwoDice', 'RA_JBO_RollTwoDice'],
      ['roll a die', 'requestRollOneDie', 'RA_JBO_RollOneDie'],
      ['flip a coin', 'requestFlipCoin', 'RA_JBO_FlipCoin'],
      ['what games can you play', 'whatThingDoesJiboHave', 'RI_JBO_WhatGames'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/parse`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'NLU', data: { text, rules: RULES, media: true } }),
      });
      assert.equal(response.status, 200);
      const nlu = (await response.json()).data;
      assert.equal(nlu.intent, intent, text);
      const route = router.getSkillIDFromNLU(nlu);
      assert.equal(route.skillID, 'chitchat-skill', text);
      assert.equal(route.memo.mim, mim, text);
    }
    assert.equal(decisions, 0);
  } finally {
    setDecisionClientForTest(null);
    await new Promise(resolve => server.close(resolve));
  }
});

test('media titles preserve names, Unicode, qualifiers and explicit video requests without stealing games', () => {
  const positive = [
    ['play Despacito', 'Despacito'], ['Hey Jibo, play Despacito!', 'Despacito'],
    ['Could you please play the song Despacito on JiboTube?', 'Despacito'],
    ['play Daft Punk - One More Time please', 'Daft Punk - One More Time'],
    ['play Bésame Mucho by Andrea Bocelli', 'Bésame Mucho by Andrea Bocelli'],
    ['watch a cat learning to jump', 'a cat learning to jump'],
    ['play a video called NASA launch on YouTube', 'NASA launch'],
    ['play Game of Thrones theme', 'Game of Thrones theme'],
    ['play the video Chess', 'Chess'], ['play "Take On Me"', 'Take On Me'],
  ];
  for (const [text, query] of positive) {
    assert.equal(mediaPlayRequest({ text, rules: RULES, media: true })?.entities.query, query, text);
  }
  const negative = ['play', 'play a game', 'play games with me', 'play tic tac toe', 'play tic-tac-toe', 'play chess',
    'play circuit saver', 'play with me', 'play again', 'play the radio', 'play the news', 'play music',
    'play a story', 'pause', 'resume', 'stop', 'turn up the volume', 'sing Despacito', 'tell me about Despacito',
    'do you know who sings Despacito', 'can you teach me to play chess', 'play a guessing game', 'play a quiz',
    'play trivia', 'play twenty questions', 'play ' + 'x'.repeat(161)];
  for (const text of negative) assert.equal(mediaPlayRequest({ text, rules: RULES, media: true }), null, text);
  for (const rules of [[], ['globals/gui_nav'], ['launch', 'clock/yes_no'], ['launch', 'unknown']]) {
    assert.equal(mediaPlayRequest({ text: 'play Despacito', rules, media: true }), null, rules.join(','));
  }
  assert.equal(mediaPlayRequest({ text: 'play Despacito', rules: RULES, media: true, external: {} }), null);
});

// Real parser HTTP and deployment registry; no ASR engine or media provider.
test('a global play request carries its title to the on-robot JiboTube launch without a model call', async () => {
  let decisions = 0;
  setDecisionClientForTest({ enabled: true, config: { minProbability: 0.5, overrideProbability: 0.9 },
    choose: async () => { decisions++; return { choice: 'game', probability: 1 }; } });
  const server = await start(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/parse`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'NLU', data: { text: 'Hey Jibo, play Despacito', rules: RULES, media: true } }),
    });
    assert.equal(response.status, 200);
    const nlu = (await response.json()).data;
    assert.deepEqual(nlu, { intent: 'phoenixPlayVideo', entities: { query: 'Despacito' }, rules: ['launch'] });
    assert.equal(decisions, 0, 'a deterministic media command is not reclassified as a game');
    for (const indexFile of ['skills-native.json', 'skills-phoenix.json']) {
      const skills = await loadRegistry({ indexFile, env: {} });
      assert.equal(new IntentRouter(skills).getSkillIDFromNLU(nlu)?.skillID, '@phoenix/jibotube', indexFile);
      assert.equal(new SkillConfigManager(skills).isOnRobotSkill('@phoenix/jibotube'), true);
    }
  } finally {
    setDecisionClientForTest(null);
    await new Promise(resolve => server.close(resolve));
  }
});

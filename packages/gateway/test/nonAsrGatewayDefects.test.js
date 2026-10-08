// Synthetic fixtures; staged September gateway hardening re-port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { preprocessContext } from '../src/preprocessor.js';
import { ProactiveTransaction } from '../src/proactive/proactiveTransaction.js';
import { SettingsClient } from '../src/settingsClient.js';
import { HistoryClient } from '../src/historyClient.js';
import { loadConfig } from '../src/config.js';
import { loadRegistry } from '../src/registry.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { ListenTransaction } from '../src/listenTransaction.js';
import * as listenModule from '../src/listenTransaction.js';
const MAX_PRESESSION_AUDIO_BYTES = listenModule.MAX_PRESESSION_AUDIO_BYTES ?? 1024 * 1024;
import { createGateway } from '../src/index.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const AUTH = { id: 'acct-non-asr', friendlyId: 'robot-non-asr' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function contextFrame() {
  return {
    type: 'CONTEXT',
    data: {
      runtime: { loop: {} },
      skill: { id: null },
    },
  };
}

function proactiveContext() {
  return {
    type: 'CONTEXT',
    data: {
      general: { accountID: AUTH.id, robotID: AUTH.friendlyId, release: '2.0.1' },
      runtime: { loop: { loopId: 'loop-non-asr', users: [] }, perception: {} },
      skill: { id: null },
    },
  };
}

function proactiveHarness(t, { skillClient, historyClient } = {}) {
  const frames = [];
  const writes = [];
  const manager = { isOnRobotSkill: () => false };
  const tx = new ProactiveTransaction(
    { _jiboHeaders: {}, _auth: AUTH, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: true },
      skills: [{ id: 'cloud-skill', URL: 'http://skill.invalid/v1/main', intents: [], proactives: [{ topics: [], contextRules: [] }] }],
      skillConfigManager: manager,
      skillClient: skillClient || { proactiveLaunch: async () => ({ response: { type: 'SKILL_ACTION', data: {} } }) },
      settingsClient: { getSettings: async () => new Map() },
      historyClient: historyClient || { writeSkillLaunch: (...args) => writes.push(args) },
    },
    { write: (frame) => frames.push(frame) },
    log,
  );
  t.after(() => clearTimeout(tx._txTimer));
  return { tx, frames, writes };
}

test('NET peer values retain an explicitly supplied HTTP or HTTPS scheme', async () => {
  const config = await loadConfig({
    NET_parser: 'https://parser.example.test:9443',
    NET_history: 'http://history.example.test:9006',
    NET_settings: 'https://settings.example.test:9443',
  });
  assert.equal(config.parserURL, 'https://parser.example.test:9443');
  assert.equal(config.historyURL, 'http://history.example.test:9006');
  assert.equal(config.settingsURL, 'https://settings.example.test:9443');
});

test('registry rejects a malformed skill baseURL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-invalid-base-url-'));
  try {
    mkdirSync(join(root, 'resources/skills'), { recursive: true });
    writeFileSync(join(root, 'resources/skills', 'index.json'), JSON.stringify({ skills: [{ baseURL: 'ftp://not-http', configPath: 'manifest.json' }] }));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ id: 'bad-url', intents: [] }));
    await assert.rejects(loadRegistry({ rootPath: root, indexFile: 'index.json' }), /baseURL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('settings rules require an own value while retaining false and null values', () => {
  const base = {
    id: 'settings-rule-skill', URL: 'http://skill.invalid/v1/main', intents: [],
    proactives: [{ topics: [], contextRules: [], settingsRules: [{ skill: 'settings-rule-skill', key: 'enabled', matchRule: 'EXACT' }] }],
  };
  assert.throws(() => new SkillConfigManager([base]), /settingsRule.*value|value.*settingsRule/i);
  for (const value of [false, null, 0]) {
    assert.doesNotThrow(() => new SkillConfigManager([{
      ...base,
      proactives: [{ ...base.proactives[0], settingsRules: [{ ...base.proactives[0].settingsRules[0], value }] }],
    }]));
  }
});


test('disabled-auth preprocessing uses a stable anonymous identity', () => {
  const message = contextFrame();
  preprocessContext(message, null, '127.0.0.1');
  assert.deepEqual(message.data.general, {
    accountID: 'anonymous-account',
    robotID: 'anonymous-robot',
    lang: 'en',
    release: '1.8.0',
    remoteAddress: '127.0.0.1',
  });
});

test('disabled-auth CONTEXT can complete a client-NLU listen turn', async (t) => {
  const gateway = await createGateway({
    hubTokenSecret: '', disableAuth: true, accountUrl: '', skills: [],
    parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', settingsURL: 'http://127.0.0.1:9',
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  t.after(async () => {
    for (const socket of gateway.wss.clients) socket.terminate();
    await new Promise((resolve) => gateway.wss.close(resolve));
    await new Promise((resolve) => gateway.service.server.close(resolve));
  });

  let admittedAuth;
  gateway.wss.on('connection', (socket) => { admittedAuth = socket._auth; });
  const messages = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/listen`);
    const received = [];
    const timer = setTimeout(() => reject(new Error('disabled-auth listen did not finish')), 1500);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'LISTEN', data: { mode: 'CLIENT_NLU', hotphrase: false, rules: [] } }));
      ws.send(JSON.stringify(contextFrame()));
      ws.send(JSON.stringify({ type: 'CLIENT_NLU', data: { intent: null, rules: [], entities: {} } }));
    });
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.final) {
        clearTimeout(timer);
        ws.close();
        resolve(received);
      }
    });
    ws.on('error', reject);
  });
  assert.deepEqual(admittedAuth, { id: 'anonymous-account', friendlyId: 'anonymous-robot' });
  assert.deepEqual(messages.map((message) => message.type), ['SOS', 'EOS', 'LISTEN']);
  assert.equal(messages.at(-1).data.match, null);
});

test('pre-session audio keeps ordinary early chunks but caps excess buffered bytes', () => {
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: AUTH, _remoteAddress: '127.0.0.1' },
    { config: { recordLaunchHistory: false } },
    { write() {} },
    log,
  );
  clearTimeout(tx._txTimer);
  const early = Buffer.from('early audio');
  tx.handleMessage({ audio: early });
  assert.equal(tx.audioChunks[0], early);
  assert.equal(tx.audioBufferedBytes, early.byteLength);

  const remaining = MAX_PRESESSION_AUDIO_BYTES - tx.audioBufferedBytes;
  tx.handleMessage({ audio: Buffer.alloc(remaining) });
  tx.handleMessage({ audio: Buffer.alloc(1) });
  assert.equal(tx.audioBufferedBytes, MAX_PRESESSION_AUDIO_BYTES);
  assert.equal(tx.audioChunks.reduce((total, chunk) => total + chunk.byteLength, 0), MAX_PRESESSION_AUDIO_BYTES);
});

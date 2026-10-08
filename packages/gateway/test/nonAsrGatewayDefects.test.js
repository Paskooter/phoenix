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


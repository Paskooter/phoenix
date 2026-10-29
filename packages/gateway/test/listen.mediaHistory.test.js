import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListenTransaction } from '../src/listenTransaction.js';
import { HistoryClient } from '../src/historyClient.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { IntentRouter } from '../src/intentRouter.js';
import { mediaPlayRequest } from '../../nlu/src/mediaPlay.js';
import { createHistoryService, HistoryStore } from '../../history/src/index.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const manifest = { ...JSON.parse(readFileSync(new URL('../resources/skills/phoenix-skills/jibotube_manifest.json', import.meta.url))), URL: 'on-robot' };
const close = server => new Promise(resolve => server.close(resolve));

// @phoenix/jibotube is a native routing identity, not a Pegasus History ID:
// event.ts permits only @be/ or an unscoped name. Keep that validator intact.
test('media launch persists a History-compatible identity without changing native skill or NLU', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'media-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.json');
  let server = await createHistoryService(new HistoryStore(file)).listen(0);
  t.after(() => close(server));
  const history = new HistoryClient(`http://127.0.0.1:${server.address().port}`);
  const pending = [];
  const frames = [];
  const nlu = mediaPlayRequest({ text: 'play a video called fixture melody', media: true, rules: ['launch'] });
  const originalNlu = structuredClone(nlu);
  const tx = new ListenTransaction({ _jiboHeaders: { 'x-jibo-transid': 'media-history' } }, {
    config: { recordLaunchHistory: true },
    intentRouter: new IntentRouter([manifest]),
    skillConfigManager: new SkillConfigManager([manifest]),
    historyClient: {
      writeSkillLaunch(...args) {
        const result = history.writeSkillLaunch(...args);
        pending.push(result);
        return result;
      },
    },
  }, { write: frame => frames.push(frame) }, log);
  t.after(() => tx.resolve());
  tx.listenMessage = { data: { hotphrase: true } };
  tx.nluData = nlu;
  tx.asrData = { text: 'play a video called fixture melody', confidence: 1 };
  tx.contextPr.resolve({ data: {
    general: { robotID: 'media-fixture-robot', release: '1.8.0' },
    runtime: { perception: { speaker: 'media-fixture-person' } },
    phoenix_jibotube: 1,
  } });

  await tx._performRouting();
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data.match, { skillID: '@phoenix/jibotube', launch: true, onRobot: true });
  assert.deepEqual(frames[0].data.nlu, originalNlu, 'the skill receives the original NLU');
  assert.deepEqual(tx.nluData, originalNlu);
  const results = await Promise.all(pending);
  assert.equal(results.length, 1);
  assert.notEqual(results[0], null, 'media History write must not silently swallow HTTP 500');
  assert.equal(results[0].skillID, 'phoenix-jibotube');

  // Reload the durable file into a new real HTTP service before querying it.
  await close(server);
  server = await createHistoryService(new HistoryStore(file)).listen(0);
  const reader = new HistoryClient(`http://127.0.0.1:${server.address().port}`);
  const query = { robotID: 'media-fixture-robot', skillID: 'phoenix-jibotube' };
  assert.equal(await reader.getSkillLaunchCount(query), 1);
  const saved = await reader.getLatestSkillLaunch(query);
  assert.equal(saved.skillID, 'phoenix-jibotube');
  assert.equal(saved.intent, originalNlu.intent);
  assert.deepEqual(saved.personIDs, ['media-fixture-person']);
  assert.equal(Object.hasOwn(saved, 'payload'), false);
});

test('History still rejects the unsupported native namespace rather than broadening the source schema', async (t) => {
  const server = await createHistoryService().listen(0);
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/skill/launch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ robotID: 'fixture', sessionID: 'fixture-session', skillID: '@phoenix/jibotube', intent: 'phoenixPlayVideo' }),
  });
  assert.equal(response.status, 500);
  const error = await response.json();
  assert.match(JSON.stringify(error), /skillID/);
  assert.doesNotMatch(JSON.stringify(error), /intent.*must be a string/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTransaction } from '../src/listenTransaction.js';
import { HistoryClient } from '../src/historyClient.js';
import { SkillConfigManager } from '../src/skillClient.js';
import { createHistoryService, HistoryStore } from '../../history/src/index.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

// An unrecognized follow-up still updates the active skill. The parser's null
// intent is not a History intent: the archived event schema permits omission,
// but rejects null (and returns HTTP 500, not 400, through BaseService).
test('a no-intent active-skill follow-up persists launch history without a null intent', async (t) => {
  const store = new HistoryStore();
  const service = createHistoryService(store);
  const server = await service.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const history = new HistoryClient(base);
  const pending = [];
  const frames = [];
  const tx = new ListenTransaction({ _jiboHeaders: { 'x-jibo-transid': 'history-null-intent' } }, {
    config: { recordLaunchHistory: true },
    intentRouter: { getSkillIDFromNLU: () => null },
    skillConfigManager: new SkillConfigManager([{ id: 'active-skill', onRobot: true, URL: 'on-robot', intents: [] }]),
    historyClient: {
      writeSkillLaunch(...args) {
        const result = history.writeSkillLaunch(...args);
        pending.push(result);
        return result;
      },
    },
  }, { write: (frame) => frames.push(frame) }, log);
  t.after(() => tx.resolve());
  tx.listenMessage = { data: { hotphrase: false } };
  tx.nluData = { intent: null, rules: [], entities: {} };
  tx.asrData = { text: 'an unrecognized follow-up', confidence: 1 };
  tx.contextPr.resolve({ data: {
    general: { robotID: 'history-robot', release: '1.8.0' },
    runtime: { perception: { speaker: 'history-person' } },
    skill: { id: 'active-skill' },
  } });

  await tx._performRouting();
  assert.equal(frames.at(-1).data.match.skillID, 'active-skill');
  assert.equal(frames.at(-1).data.match.launch, false);
  const results = await Promise.all(pending);
  assert.equal(results.length, 1);
  assert.notEqual(results[0], null, 'the History write must succeed instead of silently swallowing HTTP 500');
  assert.equal(tx.nluData.intent, null, 'only the History record is normalized, not the skill input');
  const response = await fetch(`${base}/v1/skill/launch/latest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ robotID: 'history-robot' }),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.skillID, 'active-skill');
  assert.deepEqual(saved.personIDs, ['history-person']);
  assert.equal(Object.hasOwn(saved, 'intent'), false);
  assert.equal(Object.hasOwn(saved, 'payload'), false, 'a launch does not require payload');
});

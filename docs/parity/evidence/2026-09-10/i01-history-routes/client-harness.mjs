// I-01 client-level parity harness.
//
// Drives the PHOENIX history service with the UNMODIFIED pinned `@jibo/history-client`
// (compiled lib from the 5c0a739 reference tree, its own axios fork), reproducing the
// scenarios the pinned history tests assert. Nothing here is a hand-rolled request shape.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHistoryService } from '@phoenix/history/src/index.js';
import { HistoryStore } from '@phoenix/history/src/store.js';

const REF = '/home/shell/work/phoenix/.parity/reference/5c0a7390539663ba749d360de348a428c088505c';
const require = createRequire(REF + '/');
const { SkillLaunchHistoryClient, SpeechHistoryClient } = require(REF + '/packages/history-client/lib/history-client.js');

const store = new HistoryStore();
const svc = createHistoryService(store);
await svc.listen(0);
const base = `http://127.0.0.1:${svc.server.address().port}`;
const launchClient = new SkillLaunchHistoryClient(base);
const speechClient = new SpeechHistoryClient(base);

const results = [];
const record = (name, value) => results.push({ name, value });

async function run(name, fn) {
  try { record(name, { ok: true, value: await fn() }); }
  catch (e) { record(name, { ok: false, error: e.message, data: e.response && e.response.data }); }
}

const TS = Date.now();

await run('writeSkillLaunch returns id', async () => {
  const id = await launchClient.writeSkillLaunch({
    timestamp: TS, sessionID: 'sess-client', robotID: 'Robot-Jibo-Number-One', skillID: 'SKILL-1',
    intent: 'intent-1', personIDs: ['person-2', 'person-1'],
  });
  return { id, isString: typeof id === 'string' };
});

await run('writeSkillPayload same triple returns same id (pinned SkillPayloadEvent)', async () => {
  const id = launchClient.writeSkillPayload({
    timestamp: TS, sessionID: 'sess-client', robotID: 'Robot-Jibo-Number-One', skillID: 'SKILL-1',
    payload: { key1: 'value1', key2: 'value2' },
  });
  return id;
});

await run('getLatestSkillLaunch by robotID (pinned SkillLaunchEvent)', async () =>
  launchClient.getLatestSkillLaunch({ robotID: 'Robot-Jibo-Number-One', rules: [] }));

await run('getLatestSkillLaunch notSessionID own session -> null', async () =>
  launchClient.getLatestSkillLaunch({ robotID: 'Robot-Jibo-Number-One', notSessionID: 'sess-client', rules: [] }));

await run('getLatestSkillLaunch notSessionID other -> record', async () => {
  const r = await launchClient.getLatestSkillLaunch({ robotID: 'Robot-Jibo-Number-One', notSessionID: 'other-session', rules: [] });
  return r && r.id;
});

await run('getSkillLaunchCount -> number', async () =>
  launchClient.getSkillLaunchCount({ robotID: 'Robot-Jibo-Number-One', rules: [] }));

await run('getLatestSkillLaunch no match -> null (pinned ComplexQueries)', async () =>
  launchClient.getLatestSkillLaunch({ robotID: 'Robot-Jibo-Number-One', rules: [{ field: 'intent', value: 'nope' }] }));

await run('getSkillLaunchCount unknown robot -> 0', async () =>
  launchClient.getSkillLaunchCount({ robotID: 'nobody', rules: [] }));

await run('writeSkillPayload no matching record -> null', async () =>
  launchClient.writeSkillPayload({ timestamp: TS, sessionID: 'zz', robotID: 'nobody', skillID: 'SK', payload: { a: 1 } }));

await run('getLatestSkillLaunch missing robotID -> error envelope', async () =>
  launchClient.getLatestSkillLaunch({ rules: [] }));

// Speech — pinned SpeechHistoryRequestsHandler.test.ts flow
let createdId = null;
await run('SpeechHistoryClient.createRecord -> id string', async () => {
  createdId = await speechClient.createRecord({
    robotID: 'some-robot-id', accountID: 'some-acc-id', transID: 'some-trans-id',
    audioFileURL: 'http://aws.test.com', timestamp: TS,
  });
  return { createdId, isString: typeof createdId === 'string' };
});

await run('SpeechHistoryClient.updateRecord -> same id (whitelist/null-strip)', async () => {
  const id = await speechClient.updateRecord(createdId, {
    audioFileURL: 'http://aws2.test.com',
    asr: { text: 'Some text here', confidence: 0.7 },
    nlu: { intent: 'someIntent', entities: { entity1: 'entityValue1' } },
  });
  return { id, same: id === createdId, stored: store.speech.get(createdId) };
});

await run('SpeechHistoryClient.updateRecord null/undefined never erases', async () => {
  await speechClient.updateRecord(createdId, { asr: null, nlu: undefined, personIDs: ['person1', 'person2'], match: { skillID: 'testSkill', launch: true, onRobot: false }, error: { message: 'Some Error' } });
  return store.speech.get(createdId);
});

await run('SpeechHistoryClient.updateRecord unknown id -> 500', async () =>
  speechClient.updateRecord('does-not-exist', { audioFileURL: 'x' }));

await run('SpeechHistoryClient.save() create-then-update path', async () => {
  const { SpeechHistoryRecord } = require(REF + '/packages/history-client/lib/speech/SpeechHistoryRecord.js');
  const rec = new SpeechHistoryRecord({ robotID: 'r2', accountID: 'a2', transID: 't2', timestamp: TS });
  const saved = await speechClient.save(rec);
  return { id: saved.id, hasId: !!saved.id };
});

svc.server.close();
const out = { client: '@jibo/history-client/lib (pinned 5c0a739)', results };
console.log(JSON.stringify(out, null, 2));
writeFileSync(process.argv[2] || 'client-harness.json', JSON.stringify(out, null, 2));

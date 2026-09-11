// H-08 — speech-history side effects and the launch-history flags, at the transaction level.
//
// Reference: pegasus 5c0a7390539663ba749d360de348a428c088505c
//   packages/hub/src/listen/ListenTransactionHandler.ts:73-108, 261, 283, 323, 465, 598, 619, 632, 676
//   packages/hub/src/utils/TransactionHandler.ts (recordSkillLaunch)
// A differential receipt against the pinned original (Node 8.9.4) lives in
// docs/parity/evidence/2026-09-11/h08-speech-history/; these are the always-run pins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ListenTransaction, HubError } from '../src/listenTransaction.js';

const silentLog = () => ({ debug() {}, info() {}, warn() {}, error() {} });

/** Mirror the wire serialization: the HTTP client JSON.stringify's the record. */
const wire = (v) => JSON.parse(JSON.stringify(v));

function context(skill = {}, { speaker = 'person-1' } = {}) {
  return {
    data: {
      general: { accountID: 'account-u', robotID: 'robot-u', lang: 'en', release: '1.8.0' },
      runtime: { perception: { speaker, peoplePresent: [] }, dialog: {}, loop: { users: [] } },
      skill,
    },
  };
}

const action = (skillID, session) => ({ type: 'SKILL_ACTION', msgID: `peer-${session}`, ts: 1, data: { skill: { id: skillID, session: { id: session } } } });
const redirectResponse = (from, session, target) => ({ type: 'SKILL_REDIRECT', msgID: 'peer-redirect', ts: 1,
  data: { skill: { id: from, session: { id: session } }, skillID: target, nlu: { intent: 'redirect' }, asr: { text: 'r' }, memo: { from } } });

function makeTx({
  config = { recordLaunchHistory: true, recordSpeechHistory: true },
  onRobot = [],
  launchOrUpdate = async (id) => ({ skillID: id, response: action(id, `sess-${id}`) }),
  launch = async (id) => ({ skillID: id, response: action(id, `sess-${id}`) }),
  saveSpeechRecord,
  asrProvider,
  intentRouter = { getSkillIDFromNLU: () => null },
  parser = { handleNLU: async () => ({ intent: null, rules: [], entities: {} }) },
} = {}) {
  const sink = { saves: [], launches: [] };
  const log = silentLog();
  const tx = new ListenTransaction(
    { _jiboHeaders: { 'x-jibo-transid': 'tid:h08-unit' }, _auth: { id: 'account-u', friendlyId: 'robot-u' }, _remoteAddress: '127.0.0.1' },
    {
      config,
      skillConfigManager: { isOnRobotSkill: (id) => onRobot.includes(id) },
      skillClient: { launchOrUpdate, launch },
      historyClient: {
        writeSkillLaunch(data) { sink.launches.push(wire(data)); return Promise.resolve(); },
        saveSpeechRecord: saveSpeechRecord || ((record) => {
          sink.saves.push({ id: record.id, data: wire(record.data) });
          return Promise.resolve(record);
        }),
      },
      asrProvider,
      intentRouter,
      parser,
    },
    { write() {} },
    log,
  );
  // Capture the exact SpeechHistoryRecord.update() sequence for the turn.
  const updates = [];
  if (tx.speechRecord) {
    const orig = tx.speechRecord.update.bind(tx.speechRecord);
    tx.speechRecord.update = (data) => { updates.push(wire(data)); return orig(data); };
  }
  return { tx, sink, updates, log };
}

test('CLIENT_NLU: client asr+nlu, a null match, and one speech save in order', async () => {
  const { tx, sink, updates } = makeTx();
  tx.listenMessage = { data: { rules: ['launch'] } };
  tx.state = 'WAIT_CLIENT_NLU';
  tx.contextPr.resolve(context());
  tx._handleClientNLU({ data: { intent: 'no-such-intent', rules: ['launch'], entities: {}, external: {} } });
  await tx.done;

  assert.deepEqual(updates, [
    { asr: { text: '', confidence: 1 }, nlu: { intent: 'no-such-intent', rules: ['launch'], entities: {}, external: {} } },
    { match: null }, // ListenTransactionHandler.ts:676 — recorded even when the match is null
  ]);
  assert.equal(sink.saves.length, 1);
  assert.equal(sink.saves[0].id, undefined, 'the create path leaves the record id unset');
  assert.deepEqual(sink.saves[0].data, {
    robotID: 'robot-u', accountID: 'account-u', transID: 'tid:h08-unit',
    timestamp: sink.saves[0].data.timestamp, audioFileURL: null,
    asr: { text: '', confidence: 1 }, nlu: { intent: 'no-such-intent', rules: ['launch'], entities: {}, external: {} },
    match: null,
  });
  assert.equal(typeof sink.saves[0].data.timestamp, 'number');
  assert.deepEqual(sink.launches, []);
});

test('cloud match: match then skill output are recorded, and the launch row is written', async () => {
  const { tx, sink, updates } = makeTx();
  tx.nluData = { intent: 'launch-intent' };
  tx.asrData = { text: 'hi', confidence: 1 };
  await tx._onSkillMatch('source', context({}, { speaker: 'speaker-9' }));
  tx.resolve();

  assert.deepEqual(updates, [
    { match: { skillID: 'source', launch: true, onRobot: false } },
    { skill: { skillID: 'source', response: action('source', 'sess-source') } },
  ]);
  assert.equal(sink.saves.length, 1);
  assert.deepEqual(sink.saves[0].data.skill, { skillID: 'source', response: action('source', 'sess-source') });
  assert.deepEqual(sink.launches, [{
    robotID: 'robot-u', sessionID: 'sess-source', skillID: 'source', intent: 'launch-intent', personIDs: ['speaker-9'],
  }]);
});

test('continued session records launch:false and preserves the returned session', async () => {
  const { tx, sink, updates } = makeTx();
  tx.nluData = { intent: 'followup-intent' };
  tx.asrData = { text: 'more', confidence: 1 };
  await tx._onSkillMatch('source', context({ id: 'source', session: { id: 'existing', opaque: true } }), null, true);
  tx.resolve();
  assert.deepEqual(updates[0], { match: { skillID: 'source', launch: false, onRobot: false } });
  assert.equal(sink.launches[0].sessionID, 'sess-source');
});

test('redirect: the redirect payload is recorded before the destination skill output', async () => {
  const { tx, sink, updates } = makeTx({
    launchOrUpdate: async () => ({ skillID: 'source', response: redirectResponse('source', 'sess-source', 'destination') }),
    launch: async () => ({ skillID: 'destination', response: action('destination', 'sess-dest') }),
  });
  tx.nluData = { intent: 'launch-intent' };
  tx.asrData = { text: '', confidence: 1 };
  await tx._onSkillMatch('source', context());
  tx.resolve();

  assert.deepEqual(updates.map((u) => Object.keys(u)[0]), ['match', 'skill', 'redirect', 'skill']);
  assert.equal(updates[2].redirect.skillID, 'destination');
  assert.deepEqual(sink.launches.map((l) => l.skillID), ['source', 'destination']);
  assert.equal(sink.saves.length, 1);
});

test('a rejected turn records the HubError and saves the speech record twice', async () => {
  const { tx, sink, updates } = makeTx();
  const settled = tx.done.catch((error) => error);
  tx.reject(new HubError('TIMEOUT_SKILL', 'boom'));
  assert.equal((await settled).code, 'TIMEOUT_SKILL');
  // TransactionHandler.reject: onTransactionError saves once, then stop() -> done() ->
  // resolve() -> onTransactionSuccess saves the same record again.
  assert.equal(sink.saves.length, 2);
  assert.deepEqual(updates, [{ error: { code: 'TIMEOUT_SKILL' } }]); // Error.message is non-enumerable
  for (const save of sink.saves) {
    assert.equal(save.id, undefined, 'both saves are creates while the id is still unset');
    assert.deepEqual(save.data.error, { code: 'TIMEOUT_SKILL' });
    assert.equal(save.data.robotID, 'robot-u');
  }
});

test('recordSpeechHistory off: no speech record, no saves', async () => {
  const { tx, sink, updates } = makeTx({ config: { recordLaunchHistory: true, recordSpeechHistory: false } });
  assert.equal(tx.speechRecord, null);
  tx.nluData = { intent: 'launch-intent' };
  tx.asrData = { text: '', confidence: 1 };
  await tx._onSkillMatch('source', context());
  tx.resolve();
  assert.deepEqual(updates, []);
  assert.deepEqual(sink.saves, []);
  assert.equal(sink.launches.length, 1, 'launch history is independent of the speech flag');
});

test('recordLaunchHistory off: no skill-launch row (speech still saved)', async () => {
  const { tx, sink } = makeTx({ config: { recordLaunchHistory: false, recordSpeechHistory: true } });
  tx.nluData = { intent: 'launch-intent' };
  tx.asrData = { text: '', confidence: 1 };
  await tx._onSkillMatch('source', context());
  tx.resolve();
  assert.deepEqual(sink.launches, []);
  assert.equal(sink.saves.length, 1);
});

test('missing speaker writes the UNKNOWN personID sentinel', async () => {
  const { tx, sink } = makeTx();
  tx.nluData = { intent: 'launch-intent' };
  tx.asrData = { text: '', confidence: 1 };
  await tx._onSkillMatch('source', context({}, { speaker: null }));
  tx.resolve();
  assert.deepEqual(sink.launches[0].personIDs, ['UNKNOWN']);
});

test('an on-robot match records the row and the speech match without any skill call', async () => {
  let calls = 0;
  const { tx, sink, updates } = makeTx({ onRobot: ['robot-skill'], launchOrUpdate: async () => { calls += 1; } });
  tx.nluData = { intent: 'robot-intent' };
  tx.asrData = { text: '', confidence: 1 };
  await tx._onSkillMatch('robot-skill', context());
  tx.resolve();
  assert.equal(calls, 0);
  assert.deepEqual(updates[0], { match: { skillID: 'robot-skill', launch: true, onRobot: true } });
  assert.equal(sink.launches.length, 1);
});

test('server ASR records the RAW transcript before normalization', async () => {
  const asr = () => ({ onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {}, getLastIncremental() { return null; },
    start: () => Promise.resolve({ text: '  Hello   World ', confidence: 0.9 }) });
  const { tx, updates } = makeTx({ asrProvider: asr });
  tx.listenMessage = { data: { lang: 'en-US', rules: ['launch'] } };
  tx.contextPr.resolve(context());
  tx._handleListen(tx.listenMessage);
  await tx.done;
  // ListenTransactionHandler.ts:465 clones asrData before normalizeString mutates the live one.
  assert.deepEqual(updates[0], { asr: { text: '  Hello   World ', confidence: 0.9 } });
});

test('a failing history sink never breaks the transaction and is logged', async () => {
  const errors = [];
  const log = { debug() {}, info() {}, warn() {}, error(msg) { errors.push(msg); } };
  const { tx } = makeTx({
    saveSpeechRecord: (record) => Promise.reject(Object.assign(new Error('history /v1/speech 500'), { stack: 'x' })),
  });
  tx.log = log;
  tx.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ['history /v1/speech 500']);
});

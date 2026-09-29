import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  forgetIfttt, forgetJot, forgetKeys, forgetMedia, forgetNotifications, forgetPerson, forgetPushDevices, forgetVoiceTraining,
} from '../src/accountForget.js';
import { DeviceRegistry, IftttStore, JotStore, KeyStore, NotificationStore, PersonStore, VoiceTrainingStore } from '../src/index.js';

// Synthetic ids, invented for this test: the person deleting their account, two
// people who stay, their robot, and two loops.
const GONE = 'a1a1a1a1a1a1a1a1a1a1a1a1';
const STAYS = 'b2b2b2b2b2b2b2b2b2b2b2b2';
const ALSO = 'c3c3c3c3c3c3c3c3c3c3c3c3';
const ROBOT = 'd4d4d4d4d4d4d4d4d4d4d4d4';
const LOOP = 'e5e5e5e5e5e5e5e5e5e5e5e5';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-forget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('messages: theirs and those only for them go; everyone else’s only lose them as a recipient or reader', (t) => {
  const jot = new JotStore({ file: join(tempDir(t), 'jot.json') });
  const theirs = jot.create({ sender: GONE, loopId: LOOP, content: 'sent by them', tags: [STAYS], read: [GONE, STAYS] });
  const forThem = jot.create({ sender: STAYS, loopId: LOOP, content: 'only for them', tags: [GONE], read: [STAYS, GONE] });
  const shared = jot.create({ sender: STAYS, loopId: LOOP, content: 'for two', tags: [GONE, ALSO], read: [STAYS, GONE] });
  const everyone = jot.create({ sender: ALSO, loopId: LOOP, content: 'for the loop', tags: [], read: [ALSO, GONE] });
  const untouched = jot.create({ sender: STAYS, loopId: LOOP, content: 'unrelated', tags: [ALSO], read: [STAYS] });
  jot.recordEvent({ payload: { messageId: theirs.id, senderId: GONE, tags: [STAYS], loopId: LOOP } });
  jot.recordEvent({ payload: { messageId: untouched.id, senderId: STAYS, tags: [ALSO], loopId: LOOP } });

  const preview = forgetJot(jot, [GONE], { dryRun: true });
  assert.deepEqual(preview, { messages: 2, messagesForOthers: 2, events: 1 });
  assert.equal(jot.messages.length, 5, 'a dry run changes nothing');

  assert.deepEqual(forgetJot(jot, [GONE], { dryRun: false }), preview);
  const byId = new Map(jot.messages.map((message) => [message.id, message]));
  assert.equal(byId.has(theirs.id), false);
  assert.equal(byId.has(forThem.id), false);
  assert.deepEqual(byId.get(shared.id).tags, [ALSO]);
  assert.deepEqual(byId.get(shared.id).read, [STAYS]);
  // Still a message for the whole loop, just without them as a reader.
  assert.deepEqual(byId.get(everyone.id).tags, []);
  assert.deepEqual(byId.get(everyone.id).read, [ALSO]);
  assert.deepEqual(byId.get(untouched.id).read, [STAYS]);
  assert.equal(jot.events.length, 1);
  assert.deepEqual(forgetJot(jot, [GONE], { dryRun: false }), {}, 'forgetting again finds nothing');
});

test('keys: their copies and requests go; the loop’s key backup stays, even when they made it', (t) => {
  const keys = new KeyStore(join(tempDir(t), 'keys.json'));
  keys.create({ accountId: GONE, loopId: LOOP, publicKey: 'their-public-key' });
  keys.create({ accountId: STAYS, loopId: LOOP, publicKey: 'other-public-key' });
  // They owned the loop when the backup was made, and have since handed it on.
  keys.backup({ loopId: LOOP, accountId: GONE, encryptedKey: Buffer.alloc(48, 1).toString('base64'), passwordHash: 'a'.repeat(40) });
  keys.createBinary({ accountId: GONE, loopId: LOOP, encryptedUrl: 'https://classic.fixture.test/binary/1' });

  assert.deepEqual(forgetKeys(keys, [GONE], { dryRun: false }), { keys: 1, binaries: 1 });
  assert.deepEqual([...keys.keys.values()].map((key) => key.accountId), [STAYS]);
  assert.ok(keys.backups.has(LOOP));
});

test('person: their answers, properties and holidays go; the loop’s properties stay', (t) => {
  const person = new PersonStore({ file: join(tempDir(t), 'person.json') });
  person.createAnswer({ accountId: GONE, key: 'favoriteColor', answer: 'green' });
  person.createAnswer({ accountId: STAYS, key: 'favoriteColor', answer: 'blue' });
  person.saveAccountProperty({ accountId: GONE, key: 'nickname', value: 'fixture' });
  person.saveLoopProperty({ loopId: LOOP, key: 'customHolidays', value: { holidays: [] }, updatedAccountId: GONE });
  person.createHoliday({ name: 'Birthday', memberId: GONE, loopId: LOOP, isEnabled: true });
  person.createHoliday({ name: 'Birthday', memberId: STAYS, loopId: LOOP, isEnabled: true });

  assert.deepEqual(forgetPerson(person, [GONE], { dryRun: false }), { answers: 1, accountProperties: 1, holidays: 1 });
  assert.equal(person.findAnswers(STAYS).length, 1);
  assert.ok(person.findLoopProperty(LOOP, 'customHolidays'), 'last changed by them, but the loop’s');
  assert.deepEqual([...person.holidays.values()].map((holiday) => holiday.memberId), [STAYS]);
});

test('notifications, phones, IFTTT, voice samples and uploads that are theirs go', (t) => {
  const dir = tempDir(t);
  const notifications = new NotificationStore(join(dir, 'notifications.json'));
  notifications.enqueue({ accountId: GONE, payload: { kind: 'for them' } });
  notifications.enqueue({ accountId: ROBOT, payload: { kind: 'loop updated', members: [GONE, STAYS] } });
  assert.deepEqual(forgetNotifications(notifications, [GONE], { dryRun: false }), { notifications: 1, tokens: 1 });
  // The robot's queue stays whole, whoever its notifications mention.
  assert.equal(notifications.findNotificationsByTokenIds([notifications.findTokenByAccountId(ROBOT)._id]).length, 1);

  const push = new DeviceRegistry(join(dir, 'push.json'));
  push.createDevice(GONE, { name: 'phone', pushToken: 'their-token', type: 'ios' });
  push.createDevice(STAYS, { name: 'phone', pushToken: 'other-token', type: 'ios' });
  assert.deepEqual(forgetPushDevices(push, [GONE], { dryRun: false }), { accounts: 1 });
  assert.deepEqual([...push.accounts.keys()], [STAYS]);

  const ifttt = new IftttStore({ file: join(dir, 'ifttt.json') });
  ifttt.findOrCreateIdentity({ identity: GONE, filter: 'user', loopIds: [LOOP] });
  ifttt.findOrCreateIdentity({ identity: STAYS, filter: 'user', loopIds: [LOOP] });
  ifttt.createTrigger({ identity: GONE, text: 'turn on the lights' });
  ifttt.createMedia({ identity: GONE, encryptedUrl: 'https://classic.fixture.test/ifttt/1' });
  ifttt.createAction({ loopId: LOOP, fields: { text: 'loop action' } });
  assert.deepEqual(forgetIfttt(ifttt, [GONE], { dryRun: false }), { identities: 1, triggers: 1, media: 1 });
  assert.deepEqual([...ifttt.identities.keys()], [STAYS]);
  assert.equal(ifttt.actions.length, 1, 'a loop’s actions are the loop’s');

  const voice = new VoiceTrainingStore({ file: join(dir, 'voice.json') });
  voice.create({ accountId: ROBOT, path: `voice/${GONE}/sample-1`, body: 'c2FtcGxl' });
  voice.create({ accountId: ROBOT, path: `voice/${STAYS}/sample-1`, body: 'c2FtcGxl' });
  assert.deepEqual(forgetVoiceTraining(voice, [GONE], { dryRun: false }), { records: 1 });
  assert.deepEqual(voice.records.map((record) => record.path), [`voice/${STAYS}/sample-1`]);

  const media = { records: new Map([
    ['upload-1', { path: 'upload-1', type: 'image', accountId: GONE, loopId: LOOP }],
    ['photo-1', { path: 'photo-1', type: 'image', accountId: ROBOT, loopId: LOOP }],
  ]) };
  assert.deepEqual(forgetMedia(media, [GONE], { dryRun: false }), { records: 1 });
  assert.deepEqual([...media.records.keys()], ['photo-1']);
});

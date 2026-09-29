import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { adminPurgeRoutes, deletionBackupDays, pruneDeletionBackups, purgeBackupDir } from '../src/recordPurge.js';

// Synthetic ids, invented for this test.
const PERSON = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const LOOP = 'cccccccccccccccccccccccc';
const TOKEN = 'purge-fixture-peer-token';

function fakeRes() {
  return {
    code: 200,
    body: undefined,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function withPeerToken(fn) {
  const prior = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = TOKEN;
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env.ETCO_account_internalPeerToken;
    else process.env.ETCO_account_internalPeerToken = prior;
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phx-purge-'));
  const file = join(root, 'messages.json');
  writeFileSync(file, '{}');
  // A store with its own forget rule: a message is the person's when they sent it.
  const messages = [
    { id: 'm1', sender: PERSON, loopId: LOOP, read: [PERSON] },
    { id: 'm2', sender: OTHER, loopId: LOOP, read: [OTHER, PERSON] },
  ];
  // A store without one: it holds nothing personal, so forgetting leaves it alone.
  const events = [{ robot: 'x', seenBy: PERSON }];
  let saves = 0;
  const stores = [
    {
      name: 'messages',
      file,
      collections: () => ({ messages }),
      save: () => { saves += 1; },
      forget: (ids, { dryRun }) => {
        let removed = 0;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (!ids.includes(messages[index].sender)) continue;
          removed += 1;
          if (!dryRun) messages.splice(index, 1);
        }
        return { messages: removed };
      },
    },
    { name: 'events', file: null, collections: () => ({ events }), save: () => { saves += 1; } },
  ];
  const uploads = join(root, 'uploads');
  mkdirSync(join(uploads, PERSON), { recursive: true });
  writeFileSync(join(uploads, PERSON, 'photo'), 'bytes');
  const route = adminPurgeRoutes({
    service: 'fixture', stores, idDirectories: [['uploads', uploads]], backupRoot: join(root, 'removal-backups'),
  })['POST /internal/admin/purge'];
  const call = (body) => {
    const res = fakeRes();
    const result = route({ req: { headers: { 'x-phoenix-internal-token': TOKEN } }, res, body });
    // A refusal is sent on the response; an answer is returned for the service to send.
    return res.body !== undefined ? { code: res.code, body: res.body } : { code: 200, body: result };
  };
  return { root, messages, events, uploads, call, saves: () => saves };
}

test('forgetting a person removes only what each store says is theirs', () => withPeerToken(() => {
  const f = fixture();
  try {
    const preview = f.call({ forget: [PERSON] });
    assert.equal(preview.code, 200);
    assert.deepEqual(preview.body.stores, [{ name: 'messages', removed: {}, forgotten: { messages: 1 } }]);
    assert.deepEqual(preview.body.directories, [`uploads-${PERSON}`]);
    assert.equal(f.messages.length, 2, 'a dry run changes nothing');

    const done = f.call({ forget: [PERSON], dryRun: false, label: 'deletion' });
    assert.equal(done.code, 200);
    assert.deepEqual(f.messages.map((message) => message.id), ['m2'], 'another sender’s message stays, even though they read it');
    assert.equal(f.events.length, 1, 'a store without a forget rule is untouched');
    assert.equal(f.saves(), 1);
    assert.equal(existsSync(join(f.uploads, PERSON)), false, 'their own folder goes');
    assert.match(done.body.backupDir, /removal-backups\/deletion-\d{8}T\d{6}Z-fixture$/);
    assert.ok(existsSync(join(done.body.backupDir, 'messages.json')));
    assert.ok(existsSync(join(done.body.backupDir, `uploads-${PERSON}`, 'photo')));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}));

test('ids and forget can be combined, and each request is checked', () => withPeerToken(() => {
  const f = fixture();
  try {
    assert.equal(f.call({}).code, 400);
    assert.equal(f.call({ ids: [], forget: [] }).code, 400);
    assert.equal(f.call({ forget: ['robot-name-not-an-account'] }).code, 400);
    assert.equal(f.call({ forget: [PERSON], label: 'elsewhere' }).code, 400);

    // A loop id removes every record that mentions it, in every store; the two passes report apart.
    const both = f.call({ ids: [LOOP], forget: [PERSON] });
    assert.deepEqual(both.body.stores, [{ name: 'messages', removed: { messages: 2 }, forgotten: { messages: 1 } }]);
    const removal = f.call({ ids: [LOOP], dryRun: false });
    assert.match(removal.body.backupDir, /\/removal-\d{8}T\d{6}Z-fixture$/);
    assert.equal(f.messages.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}));

test('deletion backups are pruned after the retention window; removal backups are kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'phx-prune-'));
  try {
    const now = Date.UTC(2026, 8, 29, 12);
    const day = 24 * 60 * 60 * 1000;
    const make = (name) => { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'store.json'), '{}'); };
    make(purgeBackupDir(root, 'deletion', 'account', new Date(now - 31 * day)).split('/').pop());
    make(purgeBackupDir(root, 'deletion', 'classic', new Date(now - 29 * day)).split('/').pop());
    make(purgeBackupDir(root, 'removal', 'account', new Date(now - 400 * day)).split('/').pop());
    make('deletion-by-hand');
    utimesSync(join(root, 'deletion-by-hand'), new Date(now - 60 * day), new Date(now - 60 * day));

    const pruned = pruneDeletionBackups(root, { days: 30, now }).map((dir) => dir.split('/').pop()).sort();
    assert.deepEqual(pruned, ['deletion-20260829T120000Z-account', 'deletion-by-hand']);
    assert.deepEqual(readdirSync(root).sort(), ['deletion-20260831T120000Z-classic', 'removal-20250825T120000Z-account']);
    assert.deepEqual(pruneDeletionBackups(join(root, 'missing')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the retention window comes from PHOENIX_DELETION_BACKUP_DAYS', () => {
  assert.equal(deletionBackupDays({}), 30);
  assert.equal(deletionBackupDays({ PHOENIX_DELETION_BACKUP_DAYS: '7' }), 7);
  assert.equal(deletionBackupDays({ PHOENIX_DELETION_BACKUP_DAYS: '0' }), 0);
  assert.equal(deletionBackupDays({ PHOENIX_DELETION_BACKUP_DAYS: '' }), 30);
  assert.equal(deletionBackupDays({ PHOENIX_DELETION_BACKUP_DAYS: 'soon' }), 30);
  assert.equal(deletionBackupDays({ PHOENIX_DELETION_BACKUP_DAYS: '-1' }), 30);
});

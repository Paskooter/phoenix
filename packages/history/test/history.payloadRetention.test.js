// saveSkillPayload against the 14-day TTL. The reference collection's Mongo TTL
// index removes an expired skill launch, so findOneAndUpdate cannot match it.
// Synthetic records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore, SKILL_LAUNCH_RETENTION_MS } from '../src/store.js';

test('payload update prunes expired launches before matching', () => {
  const store = new HistoryStore();
  const now = Date.now();
  store.addSkillLaunch({ robotID: 'synthetic-robot', sessionID: 'fresh', skillID: 'skill', timestamp: now });
  store.addSkillLaunch({
    robotID: 'synthetic-robot', sessionID: 'expired', skillID: 'skill',
    timestamp: now - SKILL_LAUNCH_RETENTION_MS - 1,
  });
  assert.equal(store.saveSkillPayload({
    robotID: 'synthetic-robot', sessionID: 'expired', skillID: 'skill', payload: { stale: true },
  }), null);
  assert.deepEqual(store.skillLaunches.map((record) => record.sessionID), ['fresh']);
});

test('a malformed payload is rejected before retention changes are flushed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-history-retention-'));
  try {
    const file = join(dir, 'history.json');
    const store = new HistoryStore(file);
    const now = Date.now();
    store.addSkillLaunch({ robotID: 'synthetic-robot', sessionID: 'fresh', skillID: 'skill', timestamp: now });
    store.addSkillLaunch({
      robotID: 'synthetic-robot', sessionID: 'expired', skillID: 'skill',
      timestamp: now - SKILL_LAUNCH_RETENTION_MS - 1,
    });
    const before = readFileSync(file, 'utf8');
    assert.throws(
      () => store.saveSkillPayload({ robotID: 'synthetic-robot', sessionID: 'expired', skillID: 'skill', payload: null }),
      /Cannot convert undefined or null to object/,
    );
    assert.deepEqual(store.skillLaunches.map((record) => record.sessionID), ['fresh', 'expired']);
    assert.equal(readFileSync(file, 'utf8'), before, 'a rejected payload must not flush retention changes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForQuiescence, QUIET_MS } from './deployment-quiescence.mjs';

function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; } };
}
const report = () => {};

test('waits for voice and OTA completion plus a fresh full minute after any new turn', async () => {
  const timer = clock();
  let id = null;
  let claimedAt;
  await waitForQuiescence({ ...timer, report,
    read: () => ({ active: timer.now() < 8000 || (timer.now() >= 65000 && timer.now() < 68000) ? 1 : 0,
      lastActivityAt: timer.now() >= 68000 ? 68000 : timer.now() >= 8000 ? 8000 : 0,
      acknowledged: [id, id], detail: 'fixture' }),
    claim: () => { claimedAt = timer.now(); id = 'lease'; return id; },
    release: () => { id = null; },
  });
  assert.equal(QUIET_MS, 60000);
  assert.equal(claimedAt, 128000);
});

test('work starting in the quiet-check/lease race abandons the lease and waits another minute', async () => {
  const timer = clock();
  let id = null; let claims = 0; let releases = 0;
  await waitForQuiescence({ ...timer, report,
    read: () => ({ active: 0, lastActivityAt: claims ? 60000 : 0, acknowledged: [id, id], detail: 'fixture' }),
    claim: () => { claims++; id = 'lease-' + claims; return id; },
    release: () => { releases++; id = null; },
  });
  assert.equal(claims, 2);
  assert.equal(releases, 1);
  assert.ok(timer.now() >= 120000);
});

test('requires both admission acknowledgements and never activates on unknown/busy activity', async () => {
  for (const mode of ['busy', 'missing-ack', 'stale']) {
    const timer = clock(); let claims = 0; let releases = 0;
    await assert.rejects(waitForQuiescence({ ...timer, report, timeoutMs: 80000,
      read: () => {
        if (mode === 'stale') throw new Error('stale activity');
        return { active: mode === 'busy' ? 1 : 0, lastActivityAt: 0, acknowledged: ['lease', null], detail: 'fixture' };
      },
      claim: () => { claims++; return 'lease'; }, release: () => { releases++; },
    }), /Timed out|stale/);
    assert.equal(claims, releases);
    if (mode !== 'missing-ack') assert.equal(claims, 0);
  }
});

test('read failure while holding the barrier releases it without activating', async () => {
  const timer = clock(); let held = false;
  await assert.rejects(waitForQuiescence({ ...timer, report,
    read: () => { if (held) throw new Error('unreadable'); return { active: 0, lastActivityAt: 0, detail: '' }; },
    claim: () => { held = true; return 'lease'; }, release: () => { held = false; },
  }), /unreadable/);
  assert.equal(held, false);
});

// Run by check-test-tmp-leaks.test.mjs through the checker (not matched by `node --test`).
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

test('signals it started, then waits to be interrupted', async () => {
  writeFileSync(join(tmpdir(), 'started'), 'x');
  await sleep(30_000);
});

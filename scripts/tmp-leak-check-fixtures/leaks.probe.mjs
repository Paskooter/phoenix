// Run by check-test-tmp-leaks.test.mjs through the checker (not matched by `node --test`).
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('leaves one file in TMPDIR', () => {
  writeFileSync(join(tmpdir(), 'left-behind.txt'), 'x');
});

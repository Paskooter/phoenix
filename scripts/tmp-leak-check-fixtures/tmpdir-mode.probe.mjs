// Run by check-test-tmp-leaks.test.mjs through the checker (not matched by `node --test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('the checker gives tests a private (0700) TMPDIR', () => {
  assert.equal(tmpdir(), process.env.TMPDIR);
  assert.equal((statSync(tmpdir()).mode & 0o777).toString(8), '700');
});

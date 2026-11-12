#!/usr/bin/env node
// Run the unit tests (or the given test files) with TMPDIR pointed at a fresh, empty
// directory and fail if anything is left in it afterwards. Tests must clean up their
// temporary files; leftovers otherwise pile up in the shared /tmp or /dev/shm.
//
//   node scripts/check-test-tmp-leaks.mjs                 # the whole `node --test` suite
//   node scripts/check-test-tmp-leaks.mjs path/a.test.js  # only these files
//
// Exit 0: tests passed and nothing was left. Exit 1: leftovers (listed). Any other
// non-zero exit is the test run's own status.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'phoenix-tmp-leak-check-'));
const testTmp = join(root, 'tmp');
// Private to this user, like mkdtemp: code that refuses group- or world-writable
// storage (for example secure stores that walk their parent directories) must see
// the same permissions here as in a real per-user temp directory. umask can only
// remove bits, so chmod after mkdir to get exactly 0700 whatever the umask is.
mkdirSync(testTmp, { mode: 0o700 });
chmodSync(testTmp, 0o700);
let status;
try {
  const run = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
    env: { ...process.env, TMPDIR: testTmp },
    stdio: 'inherit',
  });
  const left = readdirSync(testTmp).sort();
  if (left.length > 0) {
    console.error(`\n${left.length} temporary entr${left.length === 1 ? 'y was' : 'ies were'} left behind:`);
    for (const name of left) console.error(`  ${name}`);
  } else {
    console.log('\nNo temporary files were left behind.');
  }
  if (run.status !== 0) status = run.status ?? 1;
  else status = left.length > 0 ? 1 : 0;
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(status);

// Temporary directories for Classic tests that are guaranteed not to outlive the test file.
//
// A test's own `finally { rmSync(dir) }` is not always the last write: a NotificationHub
// flushes its store (mkdir -p + atomic replace) when the server notices a socket close or a
// poll fires, and that can land after the test body has already removed the directory,
// recreating it in the shared $TMPDIR. Each directory made here is therefore removed again
// when the test process exits, after its event loop has drained. Keep removing early in
// the test as well; this is the backstop, not a replacement.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = new Set();

function removeAll() {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
}

export function makeTempDir(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  if (created.size === 0) process.once('exit', removeAll);
  created.add(directory);
  return directory;
}

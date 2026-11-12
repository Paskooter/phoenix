// Launch Playwright's Chromium with its own temporary directory.
//
// With --disable-dev-shm-usage Chromium keeps its shared-memory files in TMPDIR
// (.org.chromium.Chromium.*). It unlinks each one right after creating it, but the
// process-group kill at browser.close() can land in between and leave one behind
// (seen about once in a dozen runs). Each browser gets a private TMPDIR that is
// removed once the browser has closed or disconnected. The name stays short:
// Chromium also puts sockets under TMPDIR and socket paths are limited to 107 bytes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launchChromium(chromium, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chr-'));
  const removeDir = () => rmSync(dir, { recursive: true, force: true });
  let browser;
  try {
    browser = await chromium.launch({ ...options, env: { ...process.env, ...options.env, TMPDIR: dir } });
  } catch (error) {
    removeDir();
    throw error;
  }
  browser.once('disconnected', removeDir);
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    try { return await close(...args); } finally { removeDir(); }
  };
  return browser;
}

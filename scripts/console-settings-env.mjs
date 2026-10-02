#!/usr/bin/env node
// Print the settings saved from the admin console, for the native launcher.
//
//   node scripts/console-settings-env.mjs <file>             NUL-separated KEY=value pairs
//   node scripts/console-settings-env.mjs --revision <file>  the file's revision, or 0
//
// The launcher exports each pair as it is (`export "$pair"`, never eval), so a
// value cannot run as shell code. Only settings the catalogue marks editable, with
// a value that passes its validation, are printed: the file is written by the
// account service, and nothing in it may set NODE_OPTIONS, PATH, a secret the
// services share, or anything else the console does not own. The pairs end with
// PHOENIX_CONSOLE_SETTINGS_REVISION, so each service knows which revision it runs.
//
// It never fails the launcher. A missing file means nothing is set here; an
// unreadable one is reported on stderr and ignored, and the server's own
// settings apply.

import { BY_KEY, isEditable, validate } from '../packages/account/src/admin/configCatalog.js';
import { readConsoleSettings } from '../packages/account/src/admin/consoleSettings.js';

const args = process.argv.slice(2);
const revisionOnly = args[0] === '--revision';
const file = revisionOnly ? args[1] : args[0];

try {
  const { state, error } = readConsoleSettings(file);
  if (error) process.stderr.write(`phoenix: console settings ignored: ${error}\n`);
  if (revisionOnly) {
    process.stdout.write(`${error ? 0 : state.revision}\n`);
  } else {
    const pairs = [];
    if (!error) {
      for (const [key, entry] of Object.entries(state.settings)) {
        if (entry.value === null) continue;
        if (!BY_KEY.has(key) || !isEditable(key)) {
          process.stderr.write(`phoenix: console settings: ${key} cannot be set from the console; ignored\n`);
          continue;
        }
        const problem = validate(key, entry.value);
        if (problem) {
          process.stderr.write(`phoenix: console settings: ${key} ${problem}; ignored\n`);
          continue;
        }
        pairs.push(`${key}=${entry.value}`);
      }
    }
    pairs.push(`PHOENIX_CONSOLE_SETTINGS_REVISION=${error ? 0 : state.revision}`);
    process.stdout.write(pairs.map((pair) => `${pair}\0`).join(''));
  }
} catch (error) {
  process.stderr.write(`phoenix: console settings ignored: ${error.message}\n`);
  process.stdout.write(revisionOnly ? '0\n' : 'PHOENIX_CONSOLE_SETTINGS_REVISION=0\0');
}

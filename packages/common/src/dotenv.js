// Zero-dep .env loader. Loaded (side-effect) by @phoenix/common's index so every service and
// script picks up the repo-root .env without per-entrypoint wiring. Real environment variables
// always win — .env only fills in what's unset — so tests and launchers that set env explicitly
// are unaffected. Lines: KEY=VALUE, # comments, optional surrounding quotes. Override the file
// path with PHOENIX_ENV_FILE.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which keys in process.env got there from the file. A real environment
// variable always wins, so this is precisely the set whose live value came from
// .env rather than from the process environment — which is what the admin
// console needs to know before it offers to edit one. Recorded here rather than
// inferred by comparison, because a file value and an environment value that
// happen to be equal are indistinguishable after the fact.
//
// It accumulates across calls on purpose. A second loadDotEnv() fills nothing,
// because the first one already set those keys; replacing the record there
// would erase the answer and make every file-sourced setting look like it was
// pinned by the environment.
let loadedFromFile = {};

/** Keys whose current process.env value came from the .env file. */
export function dotEnvLoaded() {
  return { ...loadedFromFile };
}

export function loadDotEnv(env = process.env) {
  const candidates = [
    env.PHOENIX_ENV_FILE,
    join(process.cwd(), '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '../../..', '.env'), // repo root from packages/common/src
  ].filter(Boolean);

  const file = candidates.find((f) => existsSync(f));
  if (!file) return {};

  const loaded = {};
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Fill keys that are unset OR empty-string. Launchers/compose commonly pass a variable
    // through as `FOO="${FOO:-}"`, which exports an empty string when the shell didn't set it —
    // that must NOT shadow a real value in .env. A non-empty real env value still wins.
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      loaded[key] = value;
    }
  }
  loadedFromFile = { ...loadedFromFile, ...loaded };
  return loaded;
}

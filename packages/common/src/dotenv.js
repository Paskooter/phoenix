// Zero-dep .env loader. Loaded (side-effect) by @phoenix/common's index so every service and
// script picks up the repo-root .env without per-entrypoint wiring. Real environment variables
// always win — .env only fills in what's unset — so tests and launchers that set env explicitly
// are unaffected. Lines: KEY=VALUE, # comments, optional surrounding quotes. Override the file
// path with PHOENIX_ENV_FILE.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    if (env[key] === undefined) {
      env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

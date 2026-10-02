// Reading the server's environment file: the .env (or PHOENIX_ENV_FILE) every
// Phoenix service already loads.
//
// The console reads it to show where each setting's value comes from. It never
// writes it: that file belongs to whoever installed the server, and on a hardened
// install the services cannot write it at all. Settings changed from the console
// are kept separately (consoleSettings.js) and layered over it by the launcher.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the .env path the same way dotenv.js does, so the console reads the
 * file the services actually read. When none exists, the repo-root path is
 * returned.
 */
export function envFilePath(env = process.env) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const candidates = [env.PHOENIX_ENV_FILE, join(process.cwd(), '.env'), join(repoRoot, '.env')]
    .filter(Boolean);
  return candidates.find((f) => existsSync(f)) || candidates[candidates.length - 1];
}

/** Split a line into {key, value} when it assigns one, else null. */
function parseAssignment(line, { allowCommented = false } = {}) {
  let body = line;
  let commented = false;
  if (/^\s*#/.test(line)) {
    if (!allowCommented) return null;
    // Only a directly-commented assignment (`#KEY=value`), not prose that
    // happens to contain an equals sign.
    body = line.replace(/^\s*#\s?/, '');
    commented = true;
  }
  const eq = body.indexOf('=');
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = body.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value, commented };
}

/**
 * Every assignment currently in force in the file (commented-out lines are not
 * in force and are reported separately).
 * @returns {{values: Record<string,string>, commented: Record<string,string>, exists: boolean, path: string}}
 */
export function readEnvFile(path = envFilePath()) {
  const out = { values: {}, commented: {}, exists: existsSync(path), path };
  if (!out.exists) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const live = parseAssignment(line);
    if (live) { out.values[live.key] = live.value; continue; }
    const dead = parseAssignment(line, { allowCommented: true });
    if (dead && !(dead.key in out.commented)) out.commented[dead.key] = dead.value;
  }
  return out;
}

// Reading and rewriting the .env file that every Phoenix service already loads.
//
// The console edits configuration by editing this file, because dotenv.js
// (packages/common/src/dotenv.js) is what services read at startup — so a change
// here reaches all of them with no extra wiring.
//
// The file is hand-written and full of explanatory comments, and those comments
// are worth more than anything the console writes into it. So:
//
//   * every line we do not own is preserved byte for byte, in place;
//   * setting a key that exists rewrites that one line, keeping its position;
//   * setting a key that exists but is commented out uncomments it in place,
//     which is how .env.example already presents optional settings;
//   * clearing a key comments its line out rather than leaving `KEY=`, so the
//     file keeps reading like the documentation it is;
//   * a key that appears nowhere is appended under a clearly marked section.
//
// Writes are atomic (temp file in the same directory, then rename) so a crash
// or a full disk cannot leave a half-written .env that stops the stack booting.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_HEADER = '# ── Set from the admin console ──────────────────────────────────────────────';

/**
 * Resolve the .env path the same way dotenv.js does, so the console edits the
 * file the services actually read. When none exists yet, the repo-root path is
 * returned so it can be created on first write.
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

/** Quote a value only when it needs it — the loader strips surrounding quotes. */
function formatValue(value) {
  const v = String(value);
  if (v === '') return '';
  // Leading/trailing whitespace would be trimmed away by the loader, and a '#'
  // would be read as part of the value, so quote when either is in play.
  return /^\s|\s$|#/.test(v) ? `"${v}"` : v;
}

/**
 * Apply a set of changes to the .env file.
 *
 * @param {Record<string,string>} changes key -> value; '' clears the setting
 * @param {{path?: string, backup?: boolean}} [opts]
 * @returns {{path: string, applied: string[], cleared: string[], added: string[], backup: string|null}}
 */
export function writeEnvFile(changes, opts = {}) {
  const path = opts.path || envFilePath();
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = original === '' ? [] : original.split('\n');

  const pending = new Map(Object.entries(changes));
  const applied = [];
  const cleared = [];
  const added = [];

  // Pass one: rewrite assignments that are already present, in place.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const live = parseAssignment(line);
    const dead = live ? null : parseAssignment(line, { allowCommented: true });
    const hit = live || dead;
    if (!hit || !pending.has(hit.key)) continue;

    const value = String(pending.get(hit.key) ?? '');
    pending.delete(hit.key);

    if (value === '') {
      // Clearing: comment the line out, preserving the value so it is still
      // visible as the thing that used to be set.
      lines[i] = live ? `#${hit.key}=${formatValue(hit.value)}` : line;
      if (live) cleared.push(hit.key);
    } else {
      lines[i] = `${hit.key}=${formatValue(value)}`;
      applied.push(hit.key);
    }
  }

  // Pass two: anything still pending has no line anywhere. Append it under a
  // managed section so it is obvious where it came from.
  const toAppend = [...pending.entries()].filter(([, v]) => String(v ?? '') !== '');
  for (const [key] of pending) if (String(changes[key] ?? '') === '') cleared.push(key);

  if (toAppend.length) {
    const hasHeader = lines.some((l) => l.trim() === MANAGED_HEADER.trim());
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    if (!hasHeader) { lines.push(MANAGED_HEADER, ''); }
    for (const [key, value] of toAppend) {
      lines.push(`${key}=${formatValue(value)}`);
      added.push(key);
      applied.push(key);
    }
  }

  let text = lines.join('\n');
  if (text !== '' && !text.endsWith('\n')) text += '\n';

  // Nothing changed? Do not touch the file at all.
  if (text === original) return { path, applied: [], cleared: [], added: [], backup: null };

  // Keep one backup of the previous contents. An operator who mis-sets
  // something and locks themselves out has a file to copy back.
  let backup = null;
  if (original !== '' && opts.backup !== false) {
    backup = `${path}.bak`;
    try { copyFileSync(path, backup); } catch { backup = null; }
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  let mode;
  try { mode = statSync(path).mode; } catch { mode = 0o600; }
  // .env holds secrets; a fresh file must not be world-readable.
  writeFileSync(tmp, text, { mode: mode & 0o777 });
  renameSync(tmp, path);

  return { path, applied, cleared, added, backup };
}

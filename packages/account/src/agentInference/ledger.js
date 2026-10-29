// Dedicated, content-free counters. Never recreate a missing ledger at service boot.
import { openSync, closeSync, writeFileSync, fsyncSync, renameSync, mkdirSync,
  readFileSync, unlinkSync, rmdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const emptyCounters = () => ({ day: '', dayRequests: 0, dayMicroUsd: 0, minute: 0, minuteRequests: 0 });
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const counters = (v) => object(v) && (v.day === '' || /^\d{4}-\d{2}-\d{2}$/.test(v.day))
  && ['dayRequests', 'dayMicroUsd', 'minute', 'minuteRequests'].every((key) => integer(v[key]));
function validState(v) {
  return counters(v) && v.version === 1 && integer(v.lifetimeMicroUsd) && object(v.accounts)
    && v.dayMicroUsd <= v.lifetimeMicroUsd && Object.keys(v.accounts).length <= 10000
    && Object.entries(v.accounts).every(([key, row]) => /^[a-f0-9]{64}$/.test(key) && counters(row)
      && (row.policy === null || row.policy === 'agent-inference-v1')
      && (row.tokenHash === null || /^[a-f0-9]{64}$/.test(row.tokenHash))
      && integer(row.tokenExpires) && integer(row.authVersion));
}

export function atomicInferenceWrite(file, state) {
  const temp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    const dir = openSync(dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

// Explicit one-time operator action, not a constructor fallback. Refuse overwrite.
export function initializeInferenceLedger(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...emptyCounters(), version: 1, accounts: {}, lifetimeMicroUsd: 0 })); fsyncSync(fd);
  } finally { closeSync(fd); }
  const dir = openSync(dirname(file), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class InferenceLedger {
  constructor(file) {
    if (typeof file !== 'string' || !file) throw new Error('inference_ledger_required');
    this.file = join(realpathSync(dirname(file)), basename(file));
    this.lock = `${this.file}.lock`;
    // One process owns this ledger for its lifetime. Crash leaves a fail-closed
    // lock; the operator must confirm the old writer is gone before removal.
    mkdirSync(this.lock, { mode: 0o700 });
    try {
      if (!lstatSync(this.file).isFile()) throw new Error('inference_ledger_invalid');
      this.state = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validState(this.state)) {
        throw new Error('inference_ledger_invalid');
      }
    } catch (e) { this.close(); throw e; }
  }
  save() {
    if (this.failed || this.closed) throw new Error('inference_ledger_unavailable');
    try { atomicInferenceWrite(this.file, this.state); }
    catch { this.failed = true; throw new Error('inference_ledger_unavailable'); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; rmdirSync(this.lock);
  }
}

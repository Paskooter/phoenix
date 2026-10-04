import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRequestId, robotIdentity, sameRobotIdentity } from './robotActionProtocol.js';

/** Private uncertainty reservations, never action payloads or a delivery queue. */
export class RobotActionReservations {
  constructor({ runtimeDir = process.env.PHOENIX_RUNTIME_DIR, fsImpl = fs, maxEntries = 1000,
    maxBytes = 1024 * 1024 } = {}) {
    this.fs = fsImpl;
    this.configured = typeof runtimeDir === 'string' && !!runtimeDir;
    this.entries = new Map();
    this.loadFault = false;
    this.writeFault = false;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.unknown = false;
    this.failedTemps = new Set();
    this.instanceId = randomUUID();
    if (!this.configured) return;
    this.directory = join(runtimeDir, 'robot-actions');
    this.file = join(this.directory, 'outstanding.json');
    try {
      if (!this.fs.lstatSync(runtimeDir).isDirectory()) throw new Error('Existing runtime required');
      this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = this.fs.lstatSync(this.directory);
      if (!directory.isDirectory() || (directory.mode & 0o077)) throw new Error('Private directory required');
      const parent = this.fs.openSync(runtimeDir, 'r');
      try { this.fs.fsyncSync(parent); } finally { this.fs.closeSync(parent); }
      if (this.fs.readdirSync(this.directory).some(name => /^outstanding\..+\.tmp$/.test(name))) throw new Error('Uncommitted reservation');
      let bytes;
      try {
        const stat = this.fs.lstatSync(this.file);
        if (!stat.isFile() || (stat.mode & 0o077) || stat.size > maxBytes) throw new Error('Invalid reservation file');
        bytes = this.fs.readFileSync(this.file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (bytes !== undefined) {
        const state = JSON.parse(bytes);
        if (!state || state.version !== 1 || Object.keys(state).some(key => !['version', 'reservations', 'unknown'].includes(key))
          || (state.unknown !== undefined && state.unknown !== true)
          || (state.unknown !== true && Buffer.byteLength(bytes) > maxBytes - 64)
          || !Array.isArray(state.reservations) || state.reservations.length > maxEntries) throw new Error('Invalid reservations');
        for (const entry of state.reservations) {
          const identity = robotIdentity(entry?.identity);
          if (!identity || Object.keys(entry).some(key => !['identity', 'requestId'].includes(key))
            || Object.keys(entry.identity).some(key => !['id', 'accessKeyId', 'friendlyId'].includes(key))
            || !isRequestId(entry.requestId) || this.entries.has(identity.id)) throw new Error('Invalid reservation');
          this.entries.set(identity.id, { identity, requestId: entry.requestId.toLowerCase() });
        }
        this.unknown = state.unknown === true;
      } else if (!this.persist()) throw new Error('Reservation initialization failed');
    } catch {
      // Unknown prior speech must block admission and deployment, never become
      // a fresh empty snapshot or an excuse to replay a stored action.
      this.loadFault = true;
    }
  }

  get healthy() { return this.configured && !this.loadFault && !this.writeFault && !this.unknown; }

  serialize(entries = this.entries) {
    return JSON.stringify({ version: 1, reservations: [...entries.values()], ...(this.unknown ? { unknown: true } : {}) });
  }

  persist() {
    // Retry only this instance's bounded pair. Foreign startup leftovers remain
    // uncertainty evidence and are never adopted or deleted by a new process.
    const temp = join(this.directory, `outstanding.${this.instanceId}.state.tmp`);
    const intent = join(this.directory, `outstanding.${this.instanceId}.intent.tmp`);
    let file, directory;
    let localIntent = this.failedTemps.has(intent), localTemp = this.failedTemps.has(temp);
    try {
      directory = this.fs.openSync(this.directory, 'r');
      // A durable intent remains visible if replacement/clear fails after the
      // primary rename. Startup treats it as uncertainty, never an empty store.
      if (localIntent && this.fs.existsSync(intent)) {
        file = this.fs.openSync(intent, this.fs.constants.O_RDONLY | this.fs.constants.O_NOFOLLOW);
      } else {
        file = this.fs.openSync(intent, 'wx', 0o600);
        localIntent = true;
        this.fs.writeFileSync(file, '{"version":1}');
      }
      this.fs.fsyncSync(file);
      this.fs.closeSync(file); file = undefined;
      this.fs.fsyncSync(directory);
      file = localTemp && this.fs.existsSync(temp)
        ? this.fs.openSync(temp, this.fs.constants.O_WRONLY | this.fs.constants.O_TRUNC | this.fs.constants.O_NOFOLLOW)
        : this.fs.openSync(temp, 'wx', 0o600);
      localTemp = true;
      this.fs.writeFileSync(file, this.serialize());
      this.fs.fsyncSync(file);
      this.fs.closeSync(file); file = undefined;
      this.fs.renameSync(temp, this.file);
      this.fs.fsyncSync(directory);
      for (const failed of new Set([...this.failedTemps, intent])) {
        try { this.fs.unlinkSync(failed); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.fs.fsyncSync(directory);
      this.failedTemps.clear();
      this.fs.closeSync(directory); directory = undefined;
      this.writeFault = false;
      return true;
    } catch {
      this.writeFault = true;
      // Keep failed pre-rename writes as startup uncertainty evidence. A later
      // successful live rollback/clear may remove only these known local temps.
      if (localTemp && this.fs.existsSync(temp)) this.failedTemps.add(temp);
      if (localIntent && this.fs.existsSync(intent)) this.failedTemps.add(intent);
      return false;
    } finally {
      if (file !== undefined) try { this.fs.closeSync(file); } catch { /* held as uncertainty */ }
      if (directory !== undefined) try { this.fs.closeSync(directory); } catch { /* held as uncertainty */ }
    }
  }

  reserve(identity, requestId) {
    if (!this.configured || this.loadFault || this.unknown || !robotIdentity(identity) || !isRequestId(requestId)) return false;
    const previous = this.entries.get(identity.id);
    const candidate = new Map(this.entries);
    candidate.set(identity.id, { identity: robotIdentity(identity), requestId: requestId.toLowerCase() });
    if ((previous && !sameRobotIdentity(previous.identity, identity)) || candidate.size > this.maxEntries
      || Buffer.byteLength(this.serialize(candidate)) > this.maxBytes - 64) {
      // Preserve a durable global uncertainty marker rather than a RAM-only
      // overflow execution. It requires investigation and cannot authorize work.
      this.unknown = true;
      this.persist();
      return false;
    }
    // Keep an uncertain write in memory even if rename or directory fsync fails.
    this.entries.set(identity.id, { identity: robotIdentity(identity), requestId: requestId.toLowerCase() });
    return this.persist();
  }

  clear(identity, requestId) {
    if (!this.configured || this.loadFault) return false;
    const previous = this.entries.get(identity.id);
    if (!previous || !sameRobotIdentity(previous.identity, identity) || previous.requestId !== requestId) return false;
    this.entries.delete(identity.id);
    if (this.persist()) return true;
    this.entries.set(identity.id, previous);
    return false;
  }
}

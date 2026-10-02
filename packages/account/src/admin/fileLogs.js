// Read the native launcher's retained logs. Paths come only from server
// configuration; browser filters cannot select files. Cached, bounded reads
// keep polling cheap while including every service and compressed rotations.
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gunzip as unzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(unzip);
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const WEEK = 7 * 86400_000;
const DAY = 86400_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 50_000;
const FILE = /^phx-compose-[a-z-]+\.log(?:\.\d+(?:\.gz)?)?$/;

async function readTail(file, size, compressed, budget = MAX_BYTES) {
  if (compressed && size > budget) throw new Error('compressed log exceeds read budget');
  const fd = await open(file, 'r');
  try {
    const start = Math.max(0, size - budget);
    const buffer = Buffer.alloc(Math.min(size, budget));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, start);
    let text = (compressed ? await gunzip(buffer.subarray(0, bytesRead), { maxOutputLength: budget }) : buffer.subarray(0, bytesRead)).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    // A writer may have emitted only part of its final record.
    return { text: text.slice(0, text.lastIndexOf('\n') + 1), truncated: start > 0 };
  } finally { await fd.close(); }
}

export function createFileLogReader(directory, { now = Date.now } = {}) {
  const epoch = randomBytes(8).toString('hex');
  const files = new Map();
  let records = new Map();
  let sequence = 0;
  let refreshedAt = 0;
  let inFlight;
  let truncated = false;
  let unreadable = 0;

  async function refresh() {
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && FILE.test(entry.name)).map(entry => entry.name).sort();
    unreadable = 0;
    truncated = names.length > 160;
    const current = new Set(names.slice(-160));
    for (const name of files.keys()) if (!current.has(name)) files.delete(name);
    const entries = [];
    for (const name of current) {
      try { entries.push({ name, metadata: await stat(join(directory, name)) }); }
      catch (error) { files.delete(name); if (error.code !== 'ENOENT') unreadable++; }
    }
    entries.sort((a, b) => b.metadata.mtimeMs - a.metadata.mtimeMs || a.name.localeCompare(b.name));
    let bytesLeft = MAX_TOTAL_BYTES;
    let eventsLeft = MAX_EVENTS;
    for (const { name, metadata } of entries) {
      try {
        if (bytesLeft <= 0 || eventsLeft <= 0) { files.delete(name); truncated = true; continue; }
        const path = join(directory, name);
        const signature = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
        const cached = files.get(name);
        if (cached?.signature === signature && cached.bytes <= bytesLeft && cached.events.length <= eventsLeft) {
          bytesLeft -= cached.bytes; eventsLeft -= cached.events.length; continue;
        }
        const { text, truncated: clipped } = await readTail(path, metadata.size, name.endsWith('.gz'), Math.min(MAX_BYTES, bytesLeft));
        const service = name.match(/^phx-compose-(.*?)\.log/)[1];
        const events = [];
        for (const raw of text.split('\n')) {
          if (!raw) continue;
          let line;
          try { line = JSON.parse(raw); } catch {
            // Uncaught Node errors and their stack traces bypass the JSON
            // logger. Keep those visible too, with the file's write time.
            if (!/^\s*(?:at\s|[A-Za-z]*Error\b|\[error\]|Error:|node:|throw\s)/i.test(raw)) continue;
            line = { t: new Date(metadata.mtimeMs).toISOString(), level: 'error', ns: service, msg: raw.slice(0, 8192), unstructured: true };
          }
          if (!line || typeof line !== 'object' || !Object.hasOwn(LEVELS, line.level)
            || !Number.isFinite(Date.parse(line.t))) continue;
          if (typeof line.msg !== 'string') line.msg = JSON.stringify(line.msg ?? '').slice(0, 8192);
          const id = createHash('sha256').update(service).update('\0').update(raw).digest('hex');
          events.push({ id, line: { ...line, service }, time: Date.parse(line.t) });
        }
        const bytes = Buffer.byteLength(text);
        const kept = events.slice(-eventsLeft);
        files.set(name, { signature, events: kept, bytes, clipped: clipped || kept.length < events.length });
        bytesLeft -= bytes; eventsLeft -= kept.length;
      } catch (error) {
        files.delete(name);
        // Rotation can remove a file between the directory listing and open.
        if (error.code !== 'ENOENT') unreadable++;
      }
    }
    const cutoff = now() - WEEK;
    const all = [...files.values()].flatMap(file => file.events)
      .filter(event => event.time >= cutoff
        && (!String(event.line.event || '').startsWith('voice_turn_') || event.time >= now() - DAY))
      .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    truncated ||= all.length > MAX_EVENTS || [...files.values()].some(file => file.clipped);
    const next = new Map();
    for (const event of all.slice(-MAX_EVENTS)) {
      if (next.has(event.id)) continue; // the active file and its rotation can briefly overlap
      next.set(event.id, records.get(event.id) || { ...event.line, seq: ++sequence });
    }
    records = next;
    refreshedAt = now();
  }

  return async function read({ since = 0, limit = 200, level = null, ns = null } = {}) {
    if (!refreshedAt || now() - refreshedAt >= 750) {
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      await inFlight;
    }
    const match = /^([a-f0-9]{16}):(\d+)$/.exec(String(since));
    const sameEpoch = match?.[1] === epoch;
    const after = sameEpoch ? Number(match[2]) : 0;
    const max = Math.max(1, Math.min(1000, Number(limit) || 200));
    const events = [...records.values()].filter(line => line.seq > after
      && (level === null || LEVELS[line.level] <= LEVELS[level])
      && (!ns || String(line.ns || '').startsWith(ns) || line.service.startsWith(ns)))
      .sort((a, b) => a.seq - b.seq);
    return {
      events: events.slice(-max), cursor: `${epoch}:${sequence}`,
      buffered: records.size, dropped: Math.max(0, events.length - max),
      reset: !!match && !sameEpoch, scope: 'server-files', retentionMs: WEEK,
      truncated, unreadableFiles: unreadable,
    };
  };
}

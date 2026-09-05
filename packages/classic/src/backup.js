// `backup` service (Backup_20170222) — robot backup-to-cloud, the "Backing up robot…" step of
// the UI's wipe/factory-reset flow. Audited against the original jiborobot/srv-backup-ws
// (src/controllers/ctrl.js) and the robot-side driver PlatformTeam/system-manager
// scripts/jibo-system-{backup,restore}.js, which is the authoritative client:
//
//   Loop.list {}                  -> [{ id: loopId, … }]   (exactly one; handled by @phoenix/account)
//   Backup.new  { loopId }        -> { uploadUrl }          a PUT URL the robot uploads the blob to
//   <PUT uploadUrl> octet-stream  -> 200 + ETag header      (the robot reads response.headers.etag)
//   Backup.list { loopId, max=1 } -> [{ modified, etag, size, location:{ expires, url } }]
//                                    newest-first; the robot asserts entry.etag === the PUT ETag,
//                                    so backup() succeeds and the wipe is allowed to proceed.
//   <GET location.url>            -> 200 + the blob         (restore: jibo-system-restore.js)
//
// The original handed back S3 presigned URLs. Phoenix has no S3, so — exactly like the OTA
// "self-hosted packages" divergence — the URLs point back at THIS entrypoint (derived from the
// request Host, or ETCO_classic_publicUrl), and the blob is stored locally. The loop-ownership
// check (loop.robot === accountId) the original did is dropped: LAN trust, like the rest of the
// classic services. Storage is process-lifetime (index in memory, blobs on disk under
// ETCO_classic_backupDir / $TMPDIR/phx-backups) — durable enough for backup→wipe→reboot→restore
// within one server run; recorded in DIVERGENCES.

import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';

// Mirrors srv-backup-ws: keys are `MAGICK - now` so a lexical/numeric sort puts newest first.
const MAGICK = 9999999999999;
const URL_EXPIRATION_MS = 24 * 60 * 60 * 1000; // ctrl.js URL_EXPIRATION_SEC (24h)
const SAFE = /^[A-Za-z0-9_-]+$/;               // loopId/key live in URLs + file paths — no traversal

export class BackupStore {
  constructor(dir = process.env.ETCO_classic_backupDir || join(tmpdir(), 'phx-backups')) {
    this.dir = dir;
    this.index = new Map(); // loopId -> [{ key, etag, modified, size, file }]
  }

  _entries(loopId) {
    let a = this.index.get(loopId);
    if (!a) { a = []; this.index.set(loopId, a); }
    return a;
  }

  /** A fresh, unique, newest-sorts-first object key for a Backup.new call. */
  newKey() {
    return `${MAGICK - Date.now()}-${randomBytes(4).toString('hex')}`;
  }

  /** Stream an upload to disk, hashing as it goes; record + return the entry (with S3-style ETag). */
  async put(loopId, key, reqStream) {
    await mkdir(join(this.dir, loopId), { recursive: true });
    const file = join(this.dir, loopId, key);
    const hash = createHash('md5');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); },
    });
    await pipeline(reqStream, tap, createWriteStream(file));
    const entry = { key, etag: `"${hash.digest('hex')}"`, modified: Date.now(), size, file };
    const arr = this._entries(loopId).filter((e) => e.key !== key);
    arr.push(entry);
    this.index.set(loopId, arr);
    return entry;
  }

  /** Newest-first, capped to [1, 1000] like the original (default max=1 — one entry, matching S3). */
  list(loopId, max = 1) {
    const cap = Math.max(1, Math.min(1000, Number(max) || 1));
    return [...this._entries(loopId)].sort((a, b) => b.modified - a.modified).slice(0, cap);
  }

  find(loopId, key) {
    return this._entries(loopId).find((e) => e.key === key) || null;
  }
}

/** AWS-JSON Backup handler (Backup.New / Backup.List). `baseFor(req)` -> the public URL of this server. */
export function makeBackupHandler(store, baseFor) {
  const blobUrl = (req, loopId, key) =>
    `${baseFor(req)}/backup/blob?loopId=${encodeURIComponent(loopId)}&key=${encodeURIComponent(key)}`;

  return function backupHandler({ req, res, body, op }) {
    const b = body || {};
    const loopId = b.loopId;
    switch (op.toLowerCase()) {
      case 'new': {
        if (!loopId || !SAFE.test(loopId)) return void sendAmzError(res, ValidationException, 'loopId is required');
        return void sendAmz(res, 200, { uploadUrl: blobUrl(req, loopId, store.newKey()) });
      }
      case 'list': {
        if (!loopId || !SAFE.test(loopId)) return void sendAmzError(res, ValidationException, 'loopId is required');
        const entries = store.list(loopId, b.max).map((e) => ({
          modified: new Date(e.modified).toISOString(),
          etag: e.etag,
          size: e.size,
          location: { expires: Date.now() + URL_EXPIRATION_MS, url: blobUrl(req, loopId, e.key) },
        }));
        return void sendAmz(res, 200, entries);
      }
      default:
        return void sendAmzError(res, ValidationException, `unknown Backup operation: ${op}`);
    }
  };
}

/**
 * The blob endpoints the Backup.New/List URLs point at — registered on the entrypoint's HTTP
 * server (NOT the AWS-JSON prefix router). PUT stores the upload (raw body — opts out of the
 * common runner's JSON parsing) and answers with the ETag; GET streams it back for restore.
 */
export function backupBlobRoutes(store) {
  const ids = (url) => {
    const loopId = url.searchParams.get('loopId');
    const key = url.searchParams.get('key');
    return (loopId && key && SAFE.test(loopId) && SAFE.test(key)) ? { loopId, key } : null;
  };

  const putBlob = async ({ req, res, url, log }) => {
    const id = ids(url);
    if (!id) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('bad loopId/key'); }
    try {
      const entry = await store.put(id.loopId, id.key, req);
      // The robot's uploader reads response.headers.etag and later asserts it == Backup.list's etag.
      log.info?.('backup blob stored', { loopId: id.loopId, key: id.key, size: entry.size, etag: entry.etag });
      res.writeHead(200, { ETag: entry.etag, 'content-length': 0 });
      res.end();
    } catch (err) {
      log.error?.('backup blob store failed', { error: err.message });
      if (!res.writableEnded) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('store failed'); }
    }
  };
  putBlob.rawBody = true; // do not JSON-parse the binary upload

  const getBlob = async ({ res, url, log }) => {
    const id = ids(url);
    const entry = id && store.find(id.loopId, id.key);
    if (!entry) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return void res.end('no such backup'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.size });
    try {
      await pipeline(createReadStream(entry.file), res);
    } catch (err) {
      log.warn?.('backup blob stream interrupted', { error: err.message });
    }
  };

  return { 'PUT /backup/blob': putBlob, 'GET /backup/blob': getBlob };
}

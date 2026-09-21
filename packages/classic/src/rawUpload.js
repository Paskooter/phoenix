import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A source-compatible 413 for a request that crossed a configured byte cap. */
export class UploadTooLargeError extends Error {
  constructor(limit) {
    super(`Payload content length greater than maximum allowed: ${limit}`);
    this.name = 'UploadTooLargeError';
    this.code = 'PAYLOAD_TOO_LARGE';
    this.status = 413;
    this.statusCode = 413;
    this.limit = limit;
  }
}

/** Read a non-negative integer limit from an environment override. */
export function configuredMaxBytes(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Validate an explicit or default upload limit once at a store boundary. */
export function normalizeMaxBytes(value, fallback) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
  return limit;
}

/** Return a valid declared request length, or null when the request is chunked/unknown. */
export function declaredContentLength(req) {
  const raw = req?.headers?.['content-length'];
  if (raw === undefined || raw === null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Stream an upload into a same-directory temporary file and publish it only after EOF.
 * The transform counts bytes (including chunked requests) and destroys the temporary
 * file on size, source, sink, or rename failure.
 */
export async function writeAtomicUpload(input, file, { maxBytes, onChunk } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  let size = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        if (size + bytes.length > maxBytes) return callback(new UploadTooLargeError(maxBytes));
        size += bytes.length;
        onChunk?.(bytes);
        return callback(null, bytes);
      } catch (error) {
        return callback(error);
      }
    },
  });
  try {
    await pipeline(input, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await rename(temporary, file);
    return { size };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

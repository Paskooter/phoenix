// Shared by every raw-upload boundary in this process, including retained replay files.
export const DEFAULT_UPLOAD_STAGING_MAX_BYTES = 2_000_000_000;
export const DEFAULT_UPLOAD_STAGING_MAX_UPLOADS = 4;

export class UploadStagingThrottleError extends Error {
  constructor() {
    super('Request throttled due to server rules.');
    this.code = 'REQUEST_THROTTLED';
    this.statusCode = 503;
  }
}

function configuredLimit(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Reserve declared bytes up front; charge unknown-length entities before each chunk is stored. */
export function createUploadStagingBudget({
  maxBytes = configuredLimit('ETCO_upload_stagingMaxBytes', DEFAULT_UPLOAD_STAGING_MAX_BYTES),
  maxUploads = configuredLimit('ETCO_upload_stagingMaxUploads', DEFAULT_UPLOAD_STAGING_MAX_UPLOADS),
} = {}) {
  for (const [name, value] of Object.entries({ maxBytes, maxUploads })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  let bytes = 0;
  let uploads = 0;
  return {
    acquire(expectedBytes = 0) {
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new TypeError('Invalid staging reservation');
      if (uploads >= maxUploads || expectedBytes > maxBytes - bytes || (expectedBytes === 0 && bytes >= maxBytes)) {
        throw new UploadStagingThrottleError();
      }
      uploads++;
      bytes += expectedBytes;
      let reserved = expectedBytes;
      let received = 0;
      let released = false;
      return {
        consume(size) {
          if (released || !Number.isSafeInteger(size) || size < 0) throw new TypeError('Invalid staging consumption');
          const extra = Math.max(0, received + size - reserved);
          if (extra > maxBytes - bytes) throw new UploadStagingThrottleError();
          received += size;
          reserved += extra;
          bytes += extra;
        },
        release() {
          if (released) return;
          released = true;
          uploads--;
          bytes -= reserved;
        },
      };
    },
  };
}

// Lazy initialization allows the service's dotenv loader to run before resolving configuration.
let processBudget;
export const uploadStagingBudget = {
  acquire(expectedBytes) {
    processBudget ||= createUploadStagingBudget();
    return processBudget.acquire(expectedBytes);
  },
};

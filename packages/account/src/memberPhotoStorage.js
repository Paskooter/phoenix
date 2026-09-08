// Local public-object adapter for the @jibo/binary createPublic/remove contract.
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export class MemberPhotoStorage {
  constructor({ directory, publicBaseUrl }) {
    if (!directory || !publicBaseUrl) throw new Error('Photo storage requires a directory and public URL');
    this.directory = directory;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
  }

  file(key) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid photo object key');
    return join(this.directory, key);
  }

  async createPublic({ dataStream, path }) {
    const target = this.file(path);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await pipeline(dataStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { path, url: `${this.publicBaseUrl}/${path}` };
  }

  async remove(path) { await rm(this.file(path), { force: true }); return {}; }
  open(path) { return createReadStream(this.file(path)); }
}

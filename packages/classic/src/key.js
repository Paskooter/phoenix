// `key` service (Key_20160201) — the UGC (user-generated-content) encryption-key exchange. When
// a robot/app wants to share encrypted content within a loop, it creates a key request (its
// public key), another member encrypts the shared symmetric key to it (Share), and the requester
// fetches it back. Backup/Restore stash a password-encrypted key blob per loop.
//
// Phoenix keeps this in-memory in the entrypoint (UGC encryption isn't needed for basic robot
// revival; nothing persists encrypted content here either — noted in DIVERGENCES). The account
// identity comes from the SigV4 Credential accessKeyId (LAN-trust, like the rest).

import { randomBytes } from 'node:crypto';
import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';

export class KeyStore {
  constructor() {
    this.requests = new Map(); // id -> { id, accountId, loopId, publicKey, encryptedKey }
    this.backups = new Map();  // `${loopId}:${passwordHash}` -> { loopId, accountId, encryptedKey }
  }

  create({ accountId, loopId, publicKey }) {
    const req = { id: randomBytes(12).toString('hex'), accountId, loopId, publicKey, encryptedKey: null };
    this.requests.set(req.id, req);
    return req;
  }

  get(id) { return this.requests.get(id) || null; }

  share(id, encryptedKey) {
    const req = this.requests.get(id);
    if (!req) return null;
    req.encryptedKey = encryptedKey;
    return req;
  }

  /** A loop should create a fresh key only when no satisfied (encryptedKey-bearing) request exists. */
  shouldCreate(loopId) {
    for (const req of this.requests.values()) {
      if (req.loopId === loopId && req.encryptedKey) return false;
    }
    return true;
  }

  incomingRequests(loopId) {
    return [...this.requests.values()].filter((r) => r.loopId === loopId && !r.encryptedKey);
  }
}

export function makeKeyHandler(store = new KeyStore()) {
  return function keyHandler({ req, res, body, op }) {
    const accountId = accessKeyIdFromAuth(req) || 'anon';
    const b = body || {};
    switch (op.toLowerCase()) {
      case 'createrequest': {
        const r = store.create({ accountId, loopId: b.loopId, publicKey: b.publicKey });
        return void sendAmz(res, 200, r);
      }
      case 'getrequest': {
        const r = store.get(b.id);
        if (!r) return void sendAmzError(res, { code: 'KEY_REQUEST_NOT_FOUND', statusCode: 404 }, 'Key request not found');
        return void sendAmz(res, 200, r);
      }
      case 'share': {
        const r = store.share(b.id, b.encryptedKey);
        if (!r) return void sendAmzError(res, { code: 'KEY_REQUEST_NOT_FOUND', statusCode: 404 }, 'Key request not found');
        return void sendAmz(res, 200, r);
      }
      case 'shouldcreate':
        return void sendAmz(res, 200, { shouldCreate: store.shouldCreate(b.loopId) });
      case 'listincomingrequests':
        return void sendAmz(res, 200, store.incomingRequests(b.loopId));
      case 'backup': {
        store.backups.set(`${b.loopId}:${b.passwordHash}`, { loopId: b.loopId, accountId, encryptedKey: b.encryptedKey });
        return void sendAmz(res, 200, { loopId: b.loopId, accountId, encryptedKey: b.encryptedKey });
      }
      case 'restore': {
        const rec = store.backups.get(`${b.loopId}:${b.passwordHash}`);
        if (!rec) return void sendAmzError(res, { code: 'KEY_BACKUP_NOT_FOUND', statusCode: 404 }, 'Key backup not found');
        return void sendAmz(res, 200, rec);
      }
      case 'listbinaryrequests':
        return void sendAmz(res, 200, []); // binary UGC variant — not exercised without media; empty
      case 'sharebinary':
        return void sendAmz(res, 200, { id: b.id || '', accountId, loopId: '', encryptedUrl: '', decryptedUrl: '' });
      default:
        return void sendAmzError(res, ValidationException, `unknown Key operation: ${op}`);
    }
  };
}

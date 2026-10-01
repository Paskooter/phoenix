// Browser key-exchange facade. Only public keys and opaque ciphertext cross
// this boundary; the existing Key service/robot remain the blind relay/sharer.
import { createPublicKey } from 'node:crypto';
import { sendJson } from '@phoenix/common';
import { requireUser } from './session.js';
import { classicCall, ClassicCallError } from './classicClient.js';

export function portalLoopKeyRoutes(store, options = {}) {
  const classic = options.classicCall || classicCall;
  const base = options.classicBase;
  const attempts = new Map();
  function allowed(accountId, operation, limit) {
    const now = Date.now();
    for (const [key, row] of attempts) if (now - row.started >= 900_000) attempts.delete(key);
    const key = `${accountId}:${operation}`;
    let row = attempts.get(key);
    if (!row) {
      if (attempts.size >= 10_000) return false;
      attempts.set(key, row = { started: now, count: 0 });
    }
    return ++row.count <= limit;
  }
  function context(req, res, loopId) {
    const account = requireUser(store, req, res);
    if (!account) return null;
    const loop = typeof loopId === 'string' ? store.loops.get(loopId) : null;
    if (!loop || loop.isDeleted || (String(loop.owner) !== String(account._id)
      && !(loop.members || []).some((m) => String(m.accountId) === String(account._id)
        && String(m.status).toLowerCase() === 'accepted'))) {
      sendJson(res, 404, { error: 'Loop not found' });
      return null;
    }
    res.setHeader('cache-control', 'private, no-store');
    return { account, loop };
  }
  function failure(res, error) {
    const known = error instanceof ClassicCallError;
    return sendJson(res, known && error.status < 500 ? error.status : 502, {
      error: known && error.status < 500 ? error.message : 'Secure content service is unavailable',
      code: known ? error.code : 'KEY_SERVICE_UNAVAILABLE',
    });
  }
  const call = (account, target, body) => classic({ base, account, target: `Key_20160201.${target}`, body });
  function requestView(row, account, loop) {
    // Classic also lets siblings read a request. This browser facade deliberately
    // only returns requests created by this signed-in account, in this loop.
    if (!row || String(row.accountId) !== String(account._id) || String(row.loopId) !== String(loop._id)) {
      throw new ClassicCallError({ status: 404, code: 'KEY_NOT_FOUND', message: 'Key request not found' });
    }
    return { id: row.id, loopId: row.loopId, ...(row.encryptedKey ? { encryptedKey: row.encryptedKey } : {}) };
  }
  return {
    'POST /api/loop-key/request': async ({ req, res, body }) => {
      const ctx = context(req, res, body?.loopId);
      if (!ctx) return;
      const { account, loop } = ctx;
      let key;
      try {
        if (Object.keys(body).some((k) => !['loopId', 'publicKey'].includes(k))
          || typeof body.publicKey !== 'string' || body.publicKey.length > 1100
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.publicKey)) throw new Error();
        const der = Buffer.from(body.publicKey, 'base64');
        key = createPublicKey({ key: der, format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048
          || key.asymmetricKeyDetails.modulusLength > 4096
          || !key.export({ format: 'der', type: 'spki' }).equals(der)) throw new Error();
      } catch { return sendJson(res, 400, { error: 'A valid RSA public key is required' }); }
      if (!allowed(account._id, 'request', 24)) return sendJson(res, 429, { error: 'Too many key requests. Try again later.' });
      try {
        const result = await call(account, 'CreateRequest', { loopId: loop._id, publicKey: body.publicKey });
        return requestView(result.body, account, loop);
      } catch (error) { return failure(res, error); }
    },
    'GET /api/loop-key/request': async ({ req, res, url }) => {
      const ctx = context(req, res, url.searchParams.get('loopId'));
      if (!ctx) return;
      const id = url.searchParams.get('id');
      if (!/^[a-f0-9]{24}$/.test(id || '')) return sendJson(res, 400, { error: 'Invalid key request' });
      if (!allowed(ctx.account._id, 'poll', 600)) return sendJson(res, 429, { error: 'Too many key requests. Try again later.' });
      try { return requestView((await call(ctx.account, 'GetRequest', { id })).body, ctx.account, ctx.loop); }
      catch (error) { return failure(res, error); }
    },
    'GET /api/loop-key/status': async ({ req, res, url }) => {
      const ctx = context(req, res, url.searchParams.get('loopId'));
      if (!ctx) return;
      const canManageRecovery = String(ctx.loop.owner) === String(ctx.account._id);
      if (!canManageRecovery) return { canManageRecovery: false, backupExists: null };
      try {
        await call(ctx.account, 'Restore', { loopId: ctx.loop._id });
        return { canManageRecovery: true, backupExists: true };
      } catch (error) {
        if (error instanceof ClassicCallError && error.code === 'BACKUP_NOT_FOUND') {
          return { canManageRecovery: true, backupExists: false };
        }
        return failure(res, error);
      }
    },
    'POST /api/loop-key/backup': async ({ req, res, body }) => {
      const ctx = context(req, res, body?.loopId);
      if (!ctx) return;
      if (String(ctx.loop.owner) !== String(ctx.account._id)) return sendJson(res, 403, { error: 'Only the loop owner can create a recovery backup' });
      if (Object.keys(body).some((k) => !['loopId', 'encryptedKey', 'passwordHash'].includes(k))
        || !/^[a-f0-9]{40}$/.test(body.passwordHash || '')
        || typeof body.encryptedKey !== 'string' || body.encryptedKey.length > 128
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.encryptedKey)
        || ![48, 64].includes(Buffer.from(body.encryptedKey, 'base64').length)) {
        return sendJson(res, 400, { error: 'Invalid encrypted recovery backup' });
      }
      if (!allowed(ctx.account._id, 'backup', 8)) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
      try {
        // Atomic create-only at Classic: never overwrite an existing recovery
        // backup because two browser tabs both observed "no backup".
        await call(ctx.account, 'Backup', { loopId: ctx.loop._id,
          encryptedKey: body.encryptedKey, passwordHash: body.passwordHash, ifAbsent: true });
        return { ok: true };
      } catch (error) { return failure(res, error); }
    },
  };
}

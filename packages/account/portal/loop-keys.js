import { createExchange, encryptBackup, decryptBackup, decryptContent,
  validateLoopKey, passphraseProof, contentType, readMedia } from './loop-crypto.js';

// The optional remembered record contains AES-GCM ciphertext and a nonextractable
// device-wrapping CryptoKey, not plaintext loop keys. Same-origin scripts still
// form the trust boundary; this is NOT an OS hardware-backed keystore.
export function browserKeyStorage(indexedDB = globalThis.indexedDB) {
  let database;
  async function db() {
    if (!indexedDB) throw new Error('This browser cannot remember keys');
    if (!database) database = new Promise((resolve, reject) => {
      const req = indexedDB.open('phoenix-private-keys', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('Could not access this device’s key storage'));
    });
    return database;
  }
  async function transaction(mode, action) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('keys', mode);
      let result;
      action(tx.objectStore('keys'), (value) => { result = value; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('Could not update this device’s key storage'));
    });
  }
  return {
    read: (id) => transaction('readonly', (store, done) => { const req = store.get(id); req.onsuccess = () => done(req.result); }),
    write: (id, value) => transaction('readwrite', (store) => store.put(value, id)),
    remove: (id) => transaction('readwrite', (store) => store.delete(id)),
    deleteAccount: (accountId) => transaction('readwrite', (store) => {
      const cursor = store.openCursor(); cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (String(row.key).startsWith(`${accountId}:`)) row.delete();
        row.continue();
      };
    }),
  };
}

let forgeModule;
async function browserForge() {
  // Pinned local dependency, never a CDN. Imported lazily only for an exchange.
  forgeModule ||= import('/api/crypto/forge.js').then(() => globalThis.forge);
  return forgeModule;
}

export function createLoopKeyClient({ api, crypto = globalThis.crypto,
  getForge = browserForge, storage = browserKeyStorage(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pollMs = 1500, pollLimit = 40,
  fetcher = globalThis.fetch } = {}) {
  let accountId = null; let generation = 0;
  const keys = new Map(); const pending = new Map(); const states = new Map();
  const versions = new Map(); const listeners = new Set(); const remembered = new Set();
  const emit = (loopId, status, error = '') => {
    states.set(loopId, { status, error });
    for (const fn of listeners) fn(loopId);
  };
  const checked = async (method, path, body) => {
    const result = await api(method, path, body);
    if (!result.ok) { const error = new Error(result.data?.error || 'Secure content service is unavailable');
      error.status = result.status; throw error; }
    return result.data;
  };
  const activeCheck = (epoch, owner, loopId, version) => {
    if (epoch !== generation || owner !== accountId || version !== (versions.get(loopId) || 0)) throw new Error('Key request cancelled');
  };
  function save(loopId, key) {
    keys.get(loopId)?.fill(0);
    keys.set(loopId, validateLoopKey(key));
    emit(loopId, 'ready');
    return key;
  }
  async function ensure(loopId, { retry = false } = {}) {
    if (!accountId) throw new Error('Sign in to unlock your photos');
    if (keys.has(loopId)) return keys.get(loopId);
    if (pending.has(loopId)) return pending.get(loopId);
    if (!retry && ['waiting', 'error'].includes(states.get(loopId)?.status)) throw new Error(states.get(loopId).error);
    const epoch = generation; const owner = accountId; const version = versions.get(loopId) || 0;
    const check = () => activeCheck(epoch, owner, loopId, version);
    emit(loopId, 'connecting');
    const task = (async () => {
      if (!crypto?.subtle) throw new Error('Unlocking photos requires a secure HTTPS connection');
      let saved;
      try { saved = await storage.read(`${owner}:${loopId}`); } catch { /* private browsing/no persistence */ }
      check();
      if (saved) {
        try {
          const key = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv,
            additionalData: new TextEncoder().encode(`${owner}:${loopId}`) }, saved.wrapKey, saved.ciphertext));
          check(); remembered.add(loopId); return save(loopId, key);
        } catch { await storage.remove(`${owner}:${loopId}`).catch(() => {}); check(); }
      }
      const exchange = await createExchange(crypto, await getForge());
      check();
      let result = await checked('POST', '/api/loop-key/request', { loopId, publicKey: exchange.publicKey });
      check();
      for (let attempt = 0; attempt < pollLimit && !result.encryptedKey; attempt++) {
        await wait(pollMs); check();
        result = await checked('GET', `/api/loop-key/request?loopId=${encodeURIComponent(loopId)}&id=${encodeURIComponent(result.id)}`);
        check();
      }
      if (!result.encryptedKey) { const error = new Error('Bring Jibo online to unlock these photos, or use your recovery passphrase.'); error.waiting = true; throw error; }
      const key = exchange.unwrap(result.encryptedKey); check(); return save(loopId, key);
    })().catch((error) => {
      if (epoch === generation && version === (versions.get(loopId) || 0)) emit(loopId, error.waiting ? 'waiting' : 'error', error.message);
      throw error;
    }).finally(() => { if (pending.get(loopId) === task) pending.delete(loopId); });
    pending.set(loopId, task);
    return task;
  }
  async function forget(loopId) {
    versions.set(loopId, (versions.get(loopId) || 0) + 1);
    keys.get(loopId)?.fill(0); keys.delete(loopId); pending.delete(loopId); remembered.delete(loopId);
    if (accountId) await storage.remove(`${accountId}:${loopId}`).catch(() => {});
    emit(loopId, 'locked');
  }
  return {
    ensure, forget,
    state: (loopId) => states.get(loopId) || { status: 'locked', error: '' },
    has: (loopId) => keys.has(loopId),
    isRemembered: (loopId) => remembered.has(loopId),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async setAccount(next) {
      if (next === accountId) return;
      const prior = accountId;
      generation++; accountId = next;
      for (const key of keys.values()) key.fill(0);
      keys.clear(); pending.clear(); states.clear(); remembered.clear(); versions.clear();
      if (prior) await storage.deleteAccount(prior).catch(() => {});
    },
    async forgetAll() {
      generation++;
      for (const key of keys.values()) key.fill(0);
      keys.clear(); pending.clear(); states.clear(); remembered.clear();
      if (accountId) await storage.deleteAccount(accountId).catch(() => {});
      for (const fn of listeners) fn(null);
    },
    async remember(loopId, enabled) {
      if (!enabled) { await storage.remove(`${accountId}:${loopId}`); remembered.delete(loopId);
        emit(loopId, keys.has(loopId) ? 'ready' : 'locked'); return; }
      const owner = accountId; const epoch = generation; const version = versions.get(loopId) || 0;
      const key = await ensure(loopId); activeCheck(epoch, owner, loopId, version);
      const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const id = `${owner}:${loopId}`;
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
        additionalData: new TextEncoder().encode(id) }, wrapKey, key);
      activeCheck(epoch, owner, loopId, version);
      await storage.write(id, { wrapKey, iv, ciphertext });
      try { activeCheck(epoch, owner, loopId, version); }
      catch (error) { await storage.remove(id).catch(() => {}); throw error; }
      remembered.add(loopId); emit(loopId, 'ready');
    },
    backupStatus: (loopId) => checked('GET', `/api/loop-key/status?loopId=${encodeURIComponent(loopId)}`),
    async createBackup(loopId, passphrase) {
      if (passphrase.length < 12) throw new Error('Use a recovery passphrase of at least 12 characters');
      const epoch = generation; const owner = accountId; const version = versions.get(loopId) || 0;
      const key = await ensure(loopId);
      const encrypted = await encryptBackup(crypto, key, passphrase);
      const verified = await decryptBackup(crypto, encrypted.encryptedKey, passphrase);
      if (!verified.every((byte, i) => byte === key[i])) throw new Error('Recovery backup verification failed');
      verified.fill(0);
      activeCheck(epoch, owner, loopId, version);
      return checked('POST', '/api/loop-key/backup', { loopId, ...encrypted });
    },
    async changeBackup(loopId, current, next) {
      if (next.length < 12) throw new Error('Use a recovery passphrase of at least 12 characters');
      const epoch = generation; const owner = accountId; const version = versions.get(loopId) || 0;
      const oldPasswordHash = await passphraseProof(crypto, current);
      const result = await checked('POST', '/api/robot/backup-key/current', { loopId, passwordHash: oldPasswordHash });
      const key = await decryptBackup(crypto, result.encryptedKey, current);
      try {
        activeCheck(epoch, owner, loopId, version);
        const existing = keys.get(loopId);
        if (existing && !existing.every((x, i) => x === key[i])) throw new Error('The backup contains a different loop key. Nothing was changed.');
        const replacement = await encryptBackup(crypto, key, next);
        activeCheck(epoch, owner, loopId, version);
        return await checked('POST', '/api/robot/backup-key/change', { loopId, oldPasswordHash,
          newPasswordHash: replacement.passwordHash, encryptedKey: replacement.encryptedKey });
      } finally { key.fill(0); }
    },
    async restore(loopId, passphrase) {
      if (!accountId) throw new Error('Sign in to unlock your photos');
      const epoch = generation; const owner = accountId; const version = versions.get(loopId) || 0;
      const result = await checked('POST', '/api/robot/backup-key/current', {
        loopId, passwordHash: await passphraseProof(crypto, passphrase) });
      const key = await decryptBackup(crypto, result.encryptedKey, passphrase);
      try { activeCheck(epoch, owner, loopId, version); }
      catch (error) { key.fill(0); throw error; }
      // Cancel an outstanding exchange so a late reply cannot replace this key.
      versions.set(loopId, (versions.get(loopId) || 0) + 1); pending.delete(loopId);
      return save(loopId, key);
    },
    async mediaBlob(record) {
      if (!/^[A-Za-z0-9_-]+$/.test(record.path || '')) throw new Error('Invalid capture path');
      const epoch = generation; const owner = accountId;
      if (!owner) throw new Error('Sign in to view photos');
      const key = record.isEncrypted ? await ensure(record.loopId) : null;
      let bytes = await readMedia(await fetcher(`/api/media/blob/${record.path}`, { cache: 'no-store' }));
      if (key) {
        try { bytes = await decryptContent(crypto, bytes, key); }
        catch { throw new Error('Could not decrypt this capture with the loop’s key'); }
      }
      if (epoch !== generation || owner !== accountId || (key && keys.get(record.loopId) !== key)) {
        bytes.fill(0); throw new Error('Sign in to view photos');
      }
      return new Blob([bytes], { type: contentType(bytes) });
    },
  };
}

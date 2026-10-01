import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, publicEncrypt, constants, randomBytes, webcrypto } from 'node:crypto';
import forge from 'node-forge';
import { createExchange, decryptContent, encryptBackup, decryptBackup, passphraseProof,
  CONTENT_IV_POSITIONS, PASSPHRASE_IV, contentType, readMedia } from '../portal/loop-crypto.js';
import { createLoopKeyClient } from '../portal/loop-keys.js';

const key = new Uint8Array(randomBytes(32));
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, ...Buffer.from('JFIF'), 0, 1, 2, 3]);
function wrap(exchange, bytes = key) {
  return publicEncrypt({ key: Buffer.from(exchange.publicKey, 'base64'), format: 'der', type: 'spki',
    padding: constants.RSA_PKCS1_PADDING }, bytes).toString('base64');
}
function storage() {
  const rows = new Map();
  return { rows, async read(id) { return rows.get(id); }, async write(id, row) { rows.set(id, structuredClone(row)); },
    async remove(id) { rows.delete(id); }, async deleteAccount(id) { for (const k of rows.keys()) if (k.startsWith(`${id}:`)) rows.delete(k); } };
}
function client({ api, ...options } = {}) {
  return createLoopKeyClient({ crypto: webcrypto, getForge: async () => forge, storage: storage(),
    wait: async () => {}, pollLimit: 2, api, ...options });
}

test('browser RSA unwrap matches stock Node 6 RSA_PKCS1_PADDING; wrong key/length rejected', async () => {
  const exchange = await createExchange(webcrypto, forge);
  assert.deepEqual(exchange.unwrap(wrap(exchange)), key);
  assert.throws(() => exchange.unwrap(wrap(exchange, randomBytes(16))), /could not unlock/);
  const other = await createExchange(webcrypto, forge);
  assert.throws(() => other.unwrap(wrap(exchange)), /could not unlock/);
});

test('browser photo decryption exactly matches jibo-sts AES-CBC stream and key-derived IV', async () => {
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.from(CONTENT_IV_POSITIONS.map((i) => key[i])));
  const ciphertext = Buffer.concat([cipher.update(jpeg), cipher.final()]);
  assert.deepEqual(Buffer.from(await decryptContent(webcrypto, ciphertext, key)), jpeg);
  assert.equal(contentType(await decryptContent(webcrypto, ciphertext, key)), 'image/jpeg');
  await assert.rejects(decryptContent(webcrypto, ciphertext, new Uint8Array(randomBytes(32))));
  assert.throws(() => contentType(ciphertext), /could not be decoded/);
});

test('recovery format matches Android including newline base64; wrong passphrase/key length rejected', async () => {
  const passphrase = 'test recovery passphrase';
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(passphrase).digest(), PASSPHRASE_IV);
  const ciphertext = Buffer.concat([cipher.update(`${Buffer.from(key).toString('base64')}\n`, 'utf8'), cipher.final()]);
  assert.deepEqual(await decryptBackup(webcrypto, ciphertext.toString('base64'), passphrase), key);
  const backup = await encryptBackup(webcrypto, key, passphrase);
  assert.equal(backup.passwordHash, createHash('sha1').update(passphrase).digest('hex'));
  assert.deepEqual(await decryptBackup(webcrypto, backup.encryptedKey, passphrase), key);
  await assert.rejects(decryptBackup(webcrypto, backup.encryptedKey, 'wrong passphrase'), /Check your passphrase/);
  await assert.rejects(encryptBackup(webcrypto, new Uint8Array(16), passphrase), /Invalid loop/);
});

test('bounded streamed download rejects errors/oversized content', async () => {
  assert.deepEqual(await readMedia(new Response(jpeg)), new Uint8Array(jpeg));
  await assert.rejects(readMedia(new Response('no', { status: 403 })), /download/);
  await assert.rejects(readMedia(new Response(jpeg), 4), /too large/);
});

test('automatic exchange deduplicates, polls, keeps loops isolated and sends only the public key', async () => {
  let requests = 0; let polls = 0; const exchanges = new Map(); const sent = [];
  const c = client({ api: async (method, path, body) => {
    sent.push(body);
    if (method === 'POST') { requests++; exchanges.set(body.loopId, body.publicKey); return { ok: true, data: { id: body.loopId } }; }
    polls++; const loopId = new URL(path, 'http://fixture').searchParams.get('loopId');
    return { ok: true, data: { encryptedKey: wrap({ publicKey: exchanges.get(loopId) }, loopId === 'one' ? key : new Uint8Array(32).fill(9)) } };
  } });
  await c.setAccount('alice');
  const [a, b] = await Promise.all([c.ensure('one'), c.ensure('one')]);
  assert.equal(a, b); assert.equal(requests, 1); assert.equal(polls, 1);
  const other = await c.ensure('two'); assert.notDeepEqual(a, other);
  assert.deepEqual(Object.keys(sent.find(Boolean)).sort(), ['loopId', 'publicKey']);
  await c.setAccount('bob'); assert.equal(c.has('one'), false); assert.deepEqual(a, new Uint8Array(32));
});

test('offline exchange is bounded and retries only by explicit user action', async () => {
  let creates = 0; let polls = 0;
  const c = client({ api: async (method) => { if (method === 'POST') creates++; else polls++; return { ok: true, data: { id: 'pending' } }; } });
  await c.setAccount('alice');
  await assert.rejects(c.ensure('one'), /Bring Jibo online/);
  assert.equal(c.state('one').status, 'waiting'); assert.equal(polls, 2);
  await assert.rejects(c.ensure('one')); assert.equal(creates, 1);
  await assert.rejects(c.ensure('one', { retry: true })); assert.equal(creates, 2);
});

test('remember is opt-in, encrypts stored keys with nonextractable CryptoKey, and sign-out wipes them', async () => {
  const s = storage(); let creates = 0;
  const api = async (_method, _path, body) => { creates++; return { ok: true, data: { encryptedKey: wrap(body) } }; };
  const c = client({ api, storage: s }); await c.setAccount('alice');
  await c.ensure('one'); assert.equal(s.rows.size, 0);
  await c.remember('one', true);
  const record = s.rows.get('alice:one'); assert.equal(record.wrapKey.extractable, false);
  assert.equal(record.ciphertext.byteLength, 48); assert.equal(record.key, undefined);
  const next = client({ api, storage: s }); await next.setAccount('alice');
  assert.deepEqual(await next.ensure('one'), key); assert.equal(creates, 1);
  await next.setAccount(null); assert.equal(s.rows.size, 0); assert.equal(next.has('one'), false);
});

test('late exchange after sign-out never installs a key', async () => {
  let resolve; const gate = new Promise((r) => { resolve = r; }); let requested;
  const c = client({ api: async (_method, _path, body) => { requested = body; await gate; return { ok: true, data: { encryptedKey: wrap(body) } }; } });
  await c.setAccount('alice'); const pending = c.ensure('one');
  while (!requested) await new Promise((r) => setTimeout(r, 5));
  await c.setAccount(null); resolve(); await assert.rejects(pending, /cancelled/);
  assert.equal(c.has('one'), false);
});

test('first backup uploads only ciphertext/proof, offline restore works, and mediaBlob returns plaintext locally', async () => {
  const passphrase = 'a long recovery passphrase'; const sent = [];
  const encrypted = await encryptBackup(webcrypto, key, passphrase);
  const cipher = createCipheriv('aes-256-cbc', key, Buffer.from(CONTENT_IV_POSITIONS.map((i) => key[i])));
  const ciphertext = Buffer.concat([cipher.update(jpeg), cipher.final()]);
  const c = client({ api: async (_method, path, body) => {
    sent.push({ path, body });
    if (path === '/api/robot/backup-key/current') return { ok: true, data: { encryptedKey: encrypted.encryptedKey } };
    if (path === '/api/loop-key/backup') return { ok: true, data: { ok: true } };
    throw new Error('Robot offline');
  }, fetcher: async () => new Response(ciphertext) });
  await c.setAccount('alice'); await c.restore('one', passphrase);
  const blob = await c.mediaBlob({ path: 'photo', loopId: 'one', isEncrypted: true });
  assert.equal(blob.type, 'image/jpeg'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), jpeg);
  await c.createBackup('one', passphrase);
  assert.equal(JSON.stringify(sent).includes(passphrase), false);
  assert.equal(JSON.stringify(sent).includes(Buffer.from(key).toString('base64')), false);
  assert.equal(sent[0].body.passwordHash, await passphraseProof(webcrypto, passphrase));
  assert.deepEqual(Object.keys(sent[1].body).sort(), ['encryptedKey', 'loopId', 'passwordHash']);
});

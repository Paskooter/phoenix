// One-time bootstrap of the UGC ("loop") key from a real Jibo robot into a target device,
// without installing anything on the robot and without the server ever holding plaintext.
//
// WHY THIS EXISTS
// ---------------
// The documented design (Jibo wiki "User Generated Content Key" + "Key Backup and Restore")
// is: the loop key is a 32-byte AES-256 key that the servers must never possess. A client that
// already has it hands it to another client encrypted to that client's RSA public key
// (Key_20160201 CreateRequest/Share); the durable safety net is a passphrase backup
// (Key_20160201 Backup/Restore) whose ciphertext is produced on the device as
// BASE64(AES-CBC-PKCS5(key = SHA-256(passphrase), iv = <app constant>, plaintext = BASE64(rawKey)))
// and stored against ownerId + loopId.
//
// Moth was reflashed with Phoenix-parity software, so the robot-side key-sharing code is gone:
// nothing on the robot can originate a Share any more. The robot's original 2017 key survives as
// data at /var/jibo/keys/symmetric-<loopId>.json and is now the ONLY copy. A single, auditable,
// operator-run import is therefore the only way to bootstrap a device; from then on the ordinary
// passphrase restore works on any device.
//
// WHAT IT DOES (one pass)
//   1. reads the raw 32-byte key from the robot over SSH (no robot-side install, nothing written)
//   2. resolves the TARGET device's RSA public key from that device's own
//      Key_20160201.CreateRequest pending-request record (never from a guess)
//   3. encrypts the key to it with RSA/NONE/PKCS1Padding - the exact padding the app's
//      KeyManager.saveSymmetricKey uses
//   4. delivers it through the server's existing Key_20160201.Share path, so the server only ever
//      sees ciphertext and keeps its documented blindness
//
// The operator necessarily sees the raw key once, over SSH. That is unavoidable (the robot is the
// only holder) and is the accepted cost of bootstrapping the user's own robot.
//
// SAFETY
//   * The plaintext key is never written to disk, a log or stdout. Every emitted line is passed
//     through redact(); the only key-derived value reported is its SHA-1 fingerprint, which is
//     what the protocol itself uses as `keyHash` and is not invertible.
//   * Idempotent: if the target request already carries an `encryptedKey` the run is a no-op
//     unless --force is given (use --force exactly once to replace a stale/minted ciphertext).
//   * --dry-run does everything except POST Share.
//
// USAGE
//   node scripts/import-robot-loop-key.mjs \
//     --robot root@192.168.1.217 \
//     --loop-id 5a0b20f5ddee0000197e2881 \
//     --account-id 43ca532ad4090cfb80f2e7a5 \
//     --access-key-id <target account's accessKeyId> \
//     --secret-access-key <target account's secretAccessKey> \
//     --endpoint https://192.168.1.182 [--request-id <id>] [--public-key <spki-b64>] \
//     [--server-store /tmp/phoenix-key.json] [--dry-run] [--force]
//
// The Moth entrypoint presents a development CA, so trust it for the run:
//   NODE_EXTRA_CA_CERTS=/home/shell/.local/share/phoenix/moth/ca.crt node scripts/import-robot-loop-key.mjs ...
//
// Verify a passphrase backup round-trips the robot's key (no key material printed):
//   node scripts/import-robot-loop-key.mjs --verify-backup \
//     --robot root@192.168.1.217 --loop-id <id> --passphrase-file <secret-file> \
//     --access-key-id ... --secret-access-key ... --endpoint https://192.168.1.182
//
// Public-key resolution order (first hit wins):
//   1. --public-key <base64 SPKI DER>   (operator-supplied; see FALLBACK below)
//   2. --request-id <id>                (explicit pending-request record id)
//   3. Key_20160201.ListIncomingRequests as a loop sibling (--as-access-key-id/--as-secret-access-key,
//      defaults to the same credentials) -> the newest pending request for --account-id
//   4. --server-store <key.json>        (the server's pending-request record on disk)
//
// FALLBACK - extracting the public key from the device instead of its CreateRequest:
//   The app generates its RSA keypair in the Android KeyStore
//   (KeyManager -> KeyPairGeneratorSpec), so it is NOT a plain file and cannot be read with
//   `adb pull`. The honest ways to obtain it are (a) the device's own CreateRequest - which this
//   script reads from the server record - or (b) a wire capture of that request. Prefer (a); only
//   pass --public-key by hand if a record is genuinely unavailable, and say where it came from.

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, constants, publicEncrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';

const AMZ_JSON = 'application/x-amz-json-1.1';
const KEY_PREFIX = 'Key_20160201';
const LOOP_KEY_PATH = (loopId) => `/var/jibo/keys/symmetric-${loopId}.json`;
const KEY_BYTES = 32;

// The app's passphrase-backup format, read out of KeyManager.getEncryptedKey (jibo-aws-library AAR):
//   encryptedKey = BASE64( AES/CBC/PKCS5Padding( key = SHA-256(passphrase), iv = KeyManager.c,
//                                               plaintext = BASE64(rawKey) ) )
// KeyManager.c is a fixed 16-byte constant baked into the app (see the class <clinit>); it is a
// static IV, which is a real weakness of the original design but is what every shipped client
// uses, so a verifier or a one-time client must match it byte for byte.
const APP_AES_IV = Buffer.from([10, 32, 101, 88, 3, 75, 46, 57, 94, 11, 27, 40, 6, 112, 51, 80]);
const PASSWORD_HASH = 'sha1';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'dry-run' || name === 'force' || name === 'help' || name === 'verify-backup' || name === 'bootstrap-backup') { out[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

const need = (args, name) => {
  const value = args[name] ?? process.env[`${name.replace(/-/g, '_').toUpperCase()}`];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

// ---------------------------------------------------------------- redaction

const secrets = new Set();
/** Register any representation of the plaintext key so it can never reach a log or the repo. */
function protect(...values) {
  for (const value of values) if (value) secrets.add(String(value));
}
function redact(text) {
  let out = String(text);
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('<redacted>');
  return out;
}
const say = (...parts) => console.log(redact(parts.join(' ')));

// ---------------------------------------------------------------- SigV4

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

function authorization({ url, body, accessKeyId, secretAccessKey, region, target, service = 'jibo' }) {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const canonicalHeaders = `content-type:${AMZ_JSON}\nhost:${u.host}\nx-amz-date:${amzDate}\nx-amz-target:${target}\n`;
  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
  const canonicalRequest = ['POST', u.pathname || '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: { 'content-type': AMZ_JSON, 'x-amz-date': amzDate, 'x-amz-target': target },
  };
}

async function call({ endpoint, region, op, body, accessKeyId, secretAccessKey, service = 'jibo' }) {
  const target = `${KEY_PREFIX}.${op}`;
  const url = `${endpoint.replace(/\/+$/, '')}/`;
  const payload = JSON.stringify(body || {});
  const signed = authorization({ url, body: payload, accessKeyId, secretAccessKey, region, target, service });
  const res = await fetch(url, { method: 'POST', headers: { ...signed.headers, authorization: signed.authorization }, body: payload });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: parsed, raw: text };
}

// ---------------------------------------------------------------- key sources

/** Read the robot's loop key over SSH. Nothing is written on the robot; stdout only. */
function readRobotKey(robot, keyFile) {
  let base64;
  try {
    base64 = execFileSync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', robot, 'cat', keyFile,
    ], { encoding: 'utf8', maxBuffer: 1024 * 64 }).trim();
  } catch (error) {
    throw new Error(`could not read ${keyFile} from ${robot}: ${error.message}`);
  }
  let raw;
  try { raw = Buffer.from(base64, 'base64'); } catch { throw new Error('robot key is not valid base64'); }
  if (raw.length !== KEY_BYTES) {
    throw new Error(`robot key must decode to exactly ${KEY_BYTES} bytes; got ${raw.length}`);
  }
  protect(base64, raw.toString('base64'), raw.toString('hex'));
  return { raw, fingerprint: createHash('sha1').update(raw).digest('hex') };
}

/** The server's pending-request record on disk, as a fallback source of the device public key. */
function publicKeyFromStore(storeFile, accountId, loopId) {
  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  const candidates = (store.keys || [])
    .filter((k) => k && String(k.accountId) === String(accountId) && String(k.loopId) === String(loopId))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  if (!candidates.length) throw new Error(`no key request for ${accountId}/${loopId} in ${storeFile}`);
  return candidates[0];
}

// ---------------------------------------------------------------- verify-backup mode

function readPassphrase(args) {
  const inline = args.passphrase;
  const file = args['passphrase-file'];
  if (inline && file) throw new Error('use either --passphrase or --passphrase-file, not both');
  if (inline) return inline;
  if (file) return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  throw new Error('--passphrase or --passphrase-file is required for --verify-backup');
}

/**
 * Prove a passphrase backup really round-trips the robot's key: Restore it back, decrypt the
 * ciphertext with the app's documented scheme, and compare the SHA-1 of the recovered key to the
 * key still on the robot. Prints MATCH/MISMATCH and never any key material.
 */
async function verifyBackup(args) {
  const robot = need(args, 'robot');
  const loopId = need(args, 'loop-id');
  const endpoint = need(args, 'endpoint');
  const accessKeyId = need(args, 'access-key-id');
  const secretAccessKey = need(args, 'secret-access-key');
  const region = args.region || process.env.AWS_REGION || 'us-east-1';
  const passphrase = readPassphrase(args);
  const passwordHash = createHash(PASSWORD_HASH).update(passphrase, 'utf8').digest('hex');

  const keyFile = args['key-file'] || LOOP_KEY_PATH(loopId);
  const { fingerprint } = readRobotKey(robot, keyFile);
  say(`robot key sha1 ${fingerprint} (plaintext redacted); password hash ${passwordHash}`);

  const restored = await call({ endpoint, region, op: 'Restore', body: { loopId, passwordHash }, accessKeyId, secretAccessKey });
  if (restored.status !== 200) {
    say(`Restore failed: ${restored.status} ${restored.errType || ''} (no backup / wrong passphrase)`);
    return { loopId, backupFound: false, status: restored.status, errType: restored.errType, match: false };
  }
  const ciphertext = Buffer.from(String(restored.body.encryptedKey), 'base64');
  const aesKey = createHash('sha256').update(passphrase, 'utf8').digest();
  let recovered;
  try {
    const decipher = createDecipheriv('aes-256-cbc', aesKey, APP_AES_IV);
    const inner = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    protect(inner.toString('utf8'));
    recovered = Buffer.from(inner.toString('utf8'), 'base64');
  } catch (error) {
    say(`ciphertext did not decrypt with SHA-256(passphrase): ${error.message}`);
    return { loopId, backupFound: true, status: 200, match: false, reason: 'decrypt-failed' };
  }
  const match = recovered.length === KEY_BYTES
    && createHash('sha1').update(recovered).digest('hex') === fingerprint;
  const summary = {
    loopId, backupFound: true, ciphertextBytes: ciphertext.length,
    recoveredKeyBytes: recovered.length, passwordHashAlgorithm: PASSWORD_HASH,
    plaintextRedacted: true, match,
  };
  say(`backup ciphertext ${ciphertext.length} bytes; recovered key ${recovered.length} bytes`);
  say(`RESULT: ${match ? 'MATCH - the backup holds the robot\'s key' : 'MISMATCH - the backup does not hold the robot\'s key'}`);
  say(JSON.stringify(summary, null, 2));
  return summary;
}

// ---------------------------------------------------------------- bootstrap-backup mode

/**
 * Create the documented passphrase backup ONCE, for the loop owner.
 *
 * The documented design puts the AES/SHA-256 work on the client and never lets the server see the
 * key (wiki: "the cryptography must happen on the device"). This mode is a one-time client that
 * performs exactly that computation for the owner during the single bootstrap, because no shipped
 * client can any more: the robot's sharing code is gone and the owner's phone is not in the field.
 * Afterwards the ordinary in-app restore works and this mode should not be needed again.
 *
 *   encryptedKey = BASE64( AES-256-CBC( key = SHA-256(passphrase), iv = <app constant>,
 *                                       plaintext = BASE64(rawKey) ) )
 *   passwordHash = SHA-1(passphrase)   (hex, the app's Util.sha1)
 *
 * Key.Backup is behind ONLY_OWNER_CAN_BACKUP_RESTORE, so the credentials must be the loop owner's.
 */
async function bootstrapBackup(args) {
  const robot = need(args, 'robot');
  const loopId = need(args, 'loop-id');
  const endpoint = need(args, 'endpoint');
  const accessKeyId = need(args, 'access-key-id');
  const secretAccessKey = need(args, 'secret-access-key');
  const region = args.region || process.env.AWS_REGION || 'us-east-1';
  const passphrase = readPassphrase(args);
  const passwordHash = createHash(PASSWORD_HASH).update(passphrase, 'utf8').digest('hex');

  const keyFile = args['key-file'] || LOOP_KEY_PATH(loopId);
  const { raw, fingerprint } = readRobotKey(robot, keyFile);
  say(`robot key sha1 ${fingerprint} (plaintext redacted)`);

  const inner = Buffer.from(raw.toString('base64'), 'utf8'); // the app encrypts BASE64(rawKey)
  protect(inner.toString('utf8'));
  const aesKey = createHash('sha256').update(passphrase, 'utf8').digest();
  const cipher = createCipheriv('aes-256-cbc', aesKey, APP_AES_IV);
  const encryptedKey = Buffer.concat([cipher.update(inner), cipher.final()]).toString('base64');
  say(`computing encryptedKey = BASE64(AES-256-CBC(SHA-256(passphrase), <app iv>, BASE64(rawKey)))`);
  say(`passwordHash (${PASSWORD_HASH}) ${passwordHash}`);

  if (args['dry-run']) {
    say(`--dry-run: would POST Key_20160201.Backup with ${Buffer.from(encryptedKey, 'base64').length} ciphertext bytes; nothing sent.`);
    return { loopId, backupCreated: false, reason: 'dry-run', ciphertextBytes: Buffer.from(encryptedKey, 'base64').length };
  }

  const stored = await call({ endpoint, region, op: 'Backup', body: { loopId, encryptedKey, passwordHash }, accessKeyId, secretAccessKey });
  if (stored.status !== 200) throw new Error(`Backup failed: ${stored.status} ${stored.errType || ''}`);

  const readBack = await call({ endpoint, region, op: 'Restore', body: { loopId, passwordHash }, accessKeyId, secretAccessKey });
  const ok = readBack.status === 200 && readBack.body?.encryptedKey === encryptedKey;
  say(`Backup accepted; Restore read it back ${ok ? 'identically' : 'DIFFERENTLY'} (ciphertext only, server holds no plaintext)`);
  const summary = {
    loopId, backupCreated: ok, ciphertextBytes: Buffer.from(encryptedKey, 'base64').length,
    passwordHashAlgorithm: PASSWORD_HASH, keyFingerprintSha1: fingerprint,
    plaintextWritten: false, serverSawPlaintext: false,
  };
  say(JSON.stringify(summary, null, 2));
  return summary;
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { say(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(0, 20).join('\n')); return; }
  if (args['verify-backup']) return verifyBackup(args);
  if (args['bootstrap-backup']) return bootstrapBackup(args);

  const robot = need(args, 'robot');
  const loopId = need(args, 'loop-id');
  const accountId = need(args, 'account-id');
  const endpoint = need(args, 'endpoint');
  const accessKeyId = need(args, 'access-key-id');
  const secretAccessKey = need(args, 'secret-access-key');
  const region = args.region || process.env.AWS_REGION || 'us-east-1';
  const keyFile = args['key-file'] || LOOP_KEY_PATH(loopId);

  say(`[1/4] reading the loop key from ${robot}:${keyFile} (over SSH, nothing installed)`);
  const { raw, fingerprint } = readRobotKey(robot, keyFile);
  say(`      key: ${raw.length} bytes, sha1 fingerprint ${fingerprint} (plaintext redacted)`);

  say('[2/4] resolving the target device public key from its Key_20160201.CreateRequest record');
  let request = null;
  if (args['public-key']) {
    request = { id: args['request-id'] || null, publicKey: args['public-key'], source: 'operator-supplied --public-key' };
  } else if (args['request-id']) {
    const got = await call({ endpoint, region, op: 'GetRequest', body: { id: args['request-id'] }, accessKeyId, secretAccessKey });
    if (got.status !== 200 || !got.body?.publicKey) throw new Error(`GetRequest ${args['request-id']} failed: ${got.status} ${got.errType || ''}`);
    request = { id: got.body.id, publicKey: got.body.publicKey, encryptedKey: got.body.encryptedKey, source: 'GetRequest' };
  } else {
    const asKey = args['as-access-key-id'] || accessKeyId;
    const asSecret = args['as-secret-access-key'] || secretAccessKey;
    try {
      const listed = await call({ endpoint, region, op: 'ListIncomingRequests', body: { loopId }, accessKeyId: asKey, secretAccessKey: asSecret });
      const pending = Array.isArray(listed.body) ? listed.body : [];
      const mine = pending
        .filter((r) => String(r.accountId) === String(accountId))
        .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
      if (mine) request = { ...mine, source: 'ListIncomingRequests (pending, this device)' };
    } catch { /* fall through to the store file */ }
  }
  if (!request) {
    const storeFile = args['server-store'] || process.env.ETCO_classic_keyFile || '/tmp/phoenix-key.json';
    request = { ...publicKeyFromStore(storeFile, accountId, loopId), source: `server record ${storeFile}` };
  }
  const publicKeySha1 = createHash('sha1').update(String(request.publicKey)).digest('hex');
  say(`      request id ${request.id}, public key sha1 ${publicKeySha1}, source: ${request.source}`);

  if (request.encryptedKey && !args.force) {
    say('[3/4] the request already carries an encryptedKey - nothing to do (idempotent no-op).');
    say('      re-run with --force only to replace a stale or previously-minted ciphertext.');
    return report({ loopId, accountId, request, fingerprint, delivered: false, reason: 'already-satisfied' });
  }

  say(`[3/4] encrypting to the device public key with RSA/NONE/PKCS1Padding (the app's format)`);
  const der = Buffer.from(String(request.publicKey), 'base64');
  const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const encryptedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, raw).toString('base64');
  const ciphertextBytes = Buffer.from(encryptedKey, 'base64').length;
  say(`      ciphertext: ${ciphertextBytes} bytes (the server sees only this)`);

  if (args['dry-run']) {
    say('[4/4] --dry-run: skipping Key_20160201.Share. No server state changed.');
    return report({ loopId, accountId, request, fingerprint, delivered: false, reason: 'dry-run', ciphertextBytes });
  }

  say('[4/4] delivering via Key_20160201.Share (server relays ciphertext only)');
  const shared = await call({ endpoint, region, op: 'Share', body: { id: request.id, encryptedKey }, accessKeyId, secretAccessKey });
  if (shared.status !== 200) {
    throw new Error(`Share failed: ${shared.status} ${shared.errType || ''} ${redact(shared.raw || '')}`);
  }
  const confirmed = await call({ endpoint, region, op: 'GetRequest', body: { id: request.id }, accessKeyId, secretAccessKey });
  const satisfied = Boolean(confirmed.body?.encryptedKey);
  say(`      Share accepted; request now ${satisfied ? 'satisfied' : 'STILL UNSATISFIED'} (ciphertext only, server holds no plaintext)`);
  return report({ loopId, accountId, request, fingerprint, delivered: satisfied, reason: 'shared', ciphertextBytes });
}

function report({ loopId, accountId, request, fingerprint, delivered, reason, ciphertextBytes }) {
  // Machine-readable summary. Contains no key material - only a one-way fingerprint.
  const summary = {
    loopId, accountId, requestId: request.id, publicKeySha1: createHash('sha1').update(String(request.publicKey)).digest('hex'),
    keyFingerprintSha1: fingerprint, delivered, reason, ciphertextBytes: ciphertextBytes ?? null,
    plaintextWritten: false, robotInstalled: false,
  };
  say(JSON.stringify(summary, null, 2));
  return summary;
}

main().catch((error) => {
  console.error(redact(`import-robot-loop-key: ${error.message}`));
  process.exitCode = 1;
});

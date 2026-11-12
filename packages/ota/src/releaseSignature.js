// Signed OTA release records (format "phoenix-ota-release/1").
//
// An official release row in the OTA manifest carries a detached signature made with the
// offline Phoenix release key. The robot-side gate (official image downloader) refuses a
// package unless a pinned key signed it, its bytes match the signed SHA-256 and length, and
// its signed toVersion is newer than what the robot runs. A server, including a self-hosted
// sub-server, can pass the record on or hold it back but cannot change it.
//
// Wire field on the Update record (only present on signed rows):
//
//   phoenixSignature: {
//     format:    "phoenix-ota-release/1",
//     alg:       "RSA-SHA256",          // RSASSA-PKCS1-v1_5 with SHA-256, key >= 3072 bits
//     keyId:     "phoenix-ota-<date>",  // which pinned public key to verify with
//     payload:   "<statement JSON>",    // the exact signed bytes, as a UTF-8 string
//     signature: "<base64>"             // signature over Buffer.from(payload, 'utf8')
//   }
//
// The statement is JSON with this fixed key order (no whitespace):
//   {"format","keyId","id","subsystem","fromVersion","toVersion","filter","dependencies",
//    "length","sha256","sha1"}
// `fromVersion` is the manifest value ("*" for any installed version), NOT the value the
// catalog echoes on the wire, and `dependencies` has its keys sorted. A verifier never has to
// rebuild the statement: it verifies the served `payload` string as-is, then JSON.parses it and
// compares the fields with the record and the downloaded bytes. Node 6.9.2 can do all of this
// with crypto.createVerify('RSA-SHA256').

import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';

export const SIGNATURE_FORMAT = 'phoenix-ota-release/1';
export const SIGNATURE_ALG = 'RSA-SHA256';
export const MIN_RSA_BITS = 3072;
export const SIGNATURE_FIELD = 'phoenixSignature';
/** Package download response header: base64(JSON.stringify(phoenixSignature)). */
export const SIGNATURE_HEADER = 'x-phoenix-ota-signature';
const STATEMENT_KEYS = ['format', 'keyId', 'id', 'subsystem', 'fromVersion', 'toVersion', 'filter',
  'dependencies', 'length', 'sha256', 'sha1'];
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

function sortedDependencies(deps) {
  const out = {};
  for (const name of Object.keys(deps || {}).sort()) out[name] = String(deps[name]);
  return out;
}

/** The exact statement string signed for one manifest row and its package digests. */
export function buildStatement(row, { keyId, length, sha256, sha1 }) {
  if (!KEY_ID.test(String(keyId || ''))) throw new Error(`invalid keyId: ${keyId}`);
  if (!row || !row.id || !row.subsystem || !row.toVersion) throw new Error('row needs id, subsystem and toVersion');
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('length must be a byte count');
  if (!HEX(64).test(sha256)) throw new Error('sha256 must be 64 lowercase hex');
  if (!HEX(40).test(sha1)) throw new Error('sha1 must be 40 lowercase hex');
  const statement = {
    format: SIGNATURE_FORMAT,
    keyId,
    id: String(row.id),
    subsystem: String(row.subsystem),
    fromVersion: String(row.fromVersion ?? '*'),
    toVersion: String(row.toVersion),
    filter: String(row.filter ?? ''),
    dependencies: sortedDependencies(row.dependencies),
    length,
    sha256,
    sha1,
  };
  // Insertion order is the key order; nothing in a verifier depends on rebuilding it.
  return JSON.stringify(statement);
}

/** Refuse anything but an RSA key of at least MIN_RSA_BITS (robots verify with Node 6). */
export function assertReleaseKey(key) {
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`release key must be RSA (got ${key.asymmetricKeyType})`);
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (!bits || bits < MIN_RSA_BITS) throw new Error(`release key must be at least ${MIN_RSA_BITS} bits (got ${bits})`);
  return key;
}

export function loadPrivateKey(pem, passphrase) {
  return assertReleaseKey(createPrivateKey(passphrase ? { key: pem, passphrase } : pem));
}

export function loadPublicKey(pem) {
  return assertReleaseKey(createPublicKey(pem));
}

/** Sign one row: returns the `phoenixSignature` object for it. */
export function signRow(row, digests, { privateKey, keyId }) {
  const payload = buildStatement(row, { keyId, ...digests });
  const signature = createSign(SIGNATURE_ALG).update(Buffer.from(payload, 'utf8')).sign(privateKey, 'base64');
  return { format: SIGNATURE_FORMAT, alg: SIGNATURE_ALG, keyId, payload, signature };
}

/**
 * Parse a served signature object and check it is bound to this row and these package bytes.
 * No cryptography: the catalog uses this to refuse to serve a signature that cannot match.
 * Returns { ok: true, statement } or { ok: false, reason }.
 */
export function checkBinding(sig, row, { length, sha256, sha1 }) {
  if (!sig || typeof sig !== 'object') return { ok: false, reason: 'unsigned' };
  if (sig.format !== SIGNATURE_FORMAT || sig.alg !== SIGNATURE_ALG) return { ok: false, reason: 'unknown-format' };
  if (typeof sig.payload !== 'string' || typeof sig.signature !== 'string' || !KEY_ID.test(String(sig.keyId || ''))) {
    return { ok: false, reason: 'malformed' };
  }
  let expected;
  try {
    expected = buildStatement(row, { keyId: sig.keyId, length, sha256, sha1 });
  } catch (err) {
    return { ok: false, reason: `row: ${err.message}` };
  }
  if (sig.payload !== expected) {
    let statement = null;
    try { statement = JSON.parse(sig.payload); } catch { /* reported below */ }
    if (!statement) return { ok: false, reason: 'payload-not-json' };
    const field = STATEMENT_KEYS.find((k) => JSON.stringify(statement[k]) !== JSON.stringify(JSON.parse(expected)[k]));
    return { ok: false, reason: `mismatch:${field || 'encoding'}` };
  }
  return { ok: true, statement: JSON.parse(expected) };
}

/**
 * Full verification, as the robot gate must do it: the key named by keyId is trusted, the
 * signature is valid over `payload`, and the statement matches the row and the bytes.
 * `publicKeys` maps keyId -> KeyObject or PEM.
 */
export function verifyRow(sig, row, digests, publicKeys) {
  const bound = checkBinding(sig, row, digests);
  if (!bound.ok) return bound;
  const pem = publicKeys[sig.keyId];
  if (!pem) return { ok: false, reason: `untrusted-key:${sig.keyId}` };
  const key = typeof pem === 'string' ? loadPublicKey(pem) : pem;
  let valid = false;
  try {
    valid = createVerify(SIGNATURE_ALG).update(Buffer.from(sig.payload, 'utf8')).verify(key, sig.signature, 'base64');
  } catch {
    valid = false;
  }
  return valid ? bound : { ok: false, reason: 'bad-signature' };
}

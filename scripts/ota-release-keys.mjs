// ota-release-keys.mjs — the pinned Phoenix OTA release keys (deploy/ota-release-keys).
//
// release-keys.json names exactly one `current` key (signs releases) and at most one `next` key
// (pinned ahead of a rotation). Every listed file must be an RSA >= 3072-bit SPKI public key whose
// file SHA-256 and SPKI DER SHA-256 match the list. Anything else is refused: the set is what the
// official robot image trusts, so a quietly edited file must stop the release tools.
// deploy/robot-patches/bake_jibo_io_native_image.py (load_pinned_ota_release_keys) applies the
// same rules on the image side.

import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'phoenix-ota-release/1';
export const MIN_RSA_BITS = 3072;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.pub\.pem$/;
const PEM = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/;

export const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deploy/ota-release-keys');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function pinnedKeysDir() {
  // The override exists for tests of the refusals; release runs use the reviewed directory.
  return process.env.PHOENIX_OTA_RELEASE_KEYS_DIR || DEFAULT_DIR;
}

/**
 * Load and check the pinned set.
 * @returns {{dir: string, current: string, next: string|null,
 *            keys: Array<{keyId: string, role: string, path: string, pem: string, spkiDerSha256: string}>}}
 */
export function loadPinnedReleaseKeys(dir = pinnedKeysDir()) {
  const bad = (msg) => { throw new Error(`pinned OTA release keys (${dir}): ${msg}`); };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path.join(dir, 'release-keys.json'), 'utf8'));
  } catch (err) {
    bad(`cannot read release-keys.json: ${err.message}`);
  }
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.keys)) bad(`release-keys.json is not a ${FORMAT} key list`);
  if (doc.keys.length < 1 || doc.keys.length > 2) bad(`expected the current key and at most one next key, got ${doc.keys.length}`);
  const roles = doc.keys.map((k) => k && k.role);
  if (roles.filter((r) => r === 'current').length !== 1) bad('exactly one key must have role "current"');
  if (roles.some((r) => r !== 'current' && r !== 'next')) bad('roles must be "current" or "next"');
  const keys = [];
  const seen = new Set();
  for (const k of doc.keys) {
    if (!KEY_ID.test(k.keyId || '') || seen.has(k.keyId)) bad(`invalid or duplicate key id ${JSON.stringify(k.keyId)}`);
    seen.add(k.keyId);
    if (!FILE.test(k.file || '')) bad(`${k.keyId}: file must be a plain *.pub.pem name`);
    const file = path.join(dir, k.file);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (err) {
      bad(`${k.keyId}: cannot read ${k.file}: ${err.message}`);
    }
    if (sha256(bytes) !== k.pemSha256) bad(`${k.keyId}: ${k.file} does not match its pemSha256`);
    const pem = bytes.toString('ascii');
    if (/PRIVATE/.test(pem) || !PEM.test(pem)) bad(`${k.keyId}: ${k.file} must be exactly one SPKI public key PEM`);
    const key = createPublicKey(pem);
    const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    if (key.asymmetricKeyType !== 'rsa' || !(bits >= MIN_RSA_BITS)) bad(`${k.keyId}: must be RSA with at least ${MIN_RSA_BITS} bits`);
    if (k.bits !== bits) bad(`${k.keyId}: listed as ${k.bits} bits, file has ${bits}`);
    const spki = sha256(key.export({ type: 'spki', format: 'der' }));
    if (spki !== k.spkiDerSha256) bad(`${k.keyId}: SPKI does not match its spkiDerSha256`);
    keys.push({ keyId: k.keyId, role: k.role, path: file, pem, spkiDerSha256: spki });
  }
  if (new Set(keys.map((k) => k.spkiDerSha256)).size !== keys.length) bad('current and next must be different keys');
  const next = keys.find((k) => k.role === 'next');
  return { dir, current: keys.find((k) => k.role === 'current').keyId, next: next ? next.keyId : null, keys };
}

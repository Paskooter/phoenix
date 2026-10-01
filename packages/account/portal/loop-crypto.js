// Compatibility with shipped jibo-sts KeyExtended and Android KeyManager.
// All plaintext key/content operations happen on the user's device, never in
// an Account/Classic handler. Keep RSA PKCS#1 v1.5 (NOT OAEP) for stock robots.
export const CONTENT_IV_POSITIONS = [2, 4, 6, 8, 31, 29, 27, 25, 9, 11, 13, 15, 24, 22, 20, 18];
export const PASSPHRASE_IV = new Uint8Array([10, 32, 101, 88, 3, 75, 46, 57, 94, 11, 27, 40, 6, 112, 51, 80]);
const encoder = new TextEncoder();
export const base64 = (bytes) => btoa(Array.from(new Uint8Array(bytes), (x) => String.fromCharCode(x)).join(''));
export function unbase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.replace(/\s/g, ''))) throw new Error('Invalid encrypted data');
  return Uint8Array.from(atob(value.replace(/\s/g, '')), (x) => x.charCodeAt(0));
}
export function validateLoopKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Invalid loop encryption key');
  return bytes;
}
export async function createExchange(crypto, forge) {
  // Native CSPRNG/key generation; Forge is confined to stock RSA v1.5 unwrap,
  // which WebCrypto intentionally does not expose. No private key is uploaded.
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  const publicKey = base64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const der = base64(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const privateKey = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(forge.util.decode64(der)));
  return { publicKey, unwrap: (ciphertext) => {
    try {
      const bytes = privateKey.decrypt(forge.util.decode64(ciphertext), 'RSAES-PKCS1-V1_5');
      return validateLoopKey(Uint8Array.from(bytes, (x) => x.charCodeAt(0)));
    } catch { throw new Error('Jibo returned a key this browser could not unlock'); }
  } };
}
export async function passphraseProof(crypto, passphrase) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(passphrase))),
    (x) => x.toString(16).padStart(2, '0')).join('');
}
async function passphraseKey(crypto, passphrase) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(passphrase));
  return crypto.subtle.importKey('raw', digest, 'AES-CBC', false, ['encrypt', 'decrypt']);
}
export async function encryptBackup(crypto, key, passphrase) {
  validateLoopKey(key);
  // Original Android encrypts the UTF-8 base64 representation, not raw bytes.
  const encryptedKey = base64(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: PASSPHRASE_IV },
    await passphraseKey(crypto, passphrase), encoder.encode(base64(key))));
  return { encryptedKey, passwordHash: await passphraseProof(crypto, passphrase) };
}
export async function decryptBackup(crypto, encryptedKey, passphrase) {
  try {
    const bytes = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: PASSPHRASE_IV },
      await passphraseKey(crypto, passphrase), unbase64(encryptedKey));
    return validateLoopKey(unbase64(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()));
  } catch { throw new Error('Could not unlock the recovery backup. Check your passphrase.'); }
}
export async function decryptContent(crypto, ciphertext, key) {
  validateLoopKey(key);
  const aes = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC',
    iv: new Uint8Array(CONTENT_IV_POSITIONS.map((i) => key[i])) }, aes, ciphertext));
}
export function contentType(bytes) {
  const starts = (...values) => values.every((x, i) => bytes[i] === x);
  const text = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  if (starts(255, 216, 255)) return 'image/jpeg';
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') return 'audio/wav';
  if (text(4, 8) === 'ftyp') return 'video/mp4';
  if (text(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  throw new Error('The capture could not be decoded. Its file or encryption key may be unavailable.');
}
export async function readMedia(response, maxBytes = 64 * 1024 * 1024) {
  if (!response.ok) throw new Error(response.status === 404 ? 'This capture is no longer available' : 'Could not download this capture');
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('This capture is too large to open in the browser');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('This capture is too large to open in the browser'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

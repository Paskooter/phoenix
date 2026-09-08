// OOBE QR payload — EXACT contract of oobe-config/src/behaviors/oobe/config.bt:
// plaintext lines (ssid, password, [staticIP, netmask, gateway, dns1, dns2,] accessToken),
// XOR-scrambled with the jibo.com/jobs key, then chunked into frames "<i>/<N>\n<chunk>".
// The robot concatenates chunks in codeId order, XOR-decrypts the whole, splits on \n,
// .pop()s the token and positionally assigns the rest.

export const XOR_KEY = 'Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.';

/** UTF-8 content bytes, leaving room for the frame header in a version-6/M QR. */
const MAX_CHUNK = 90;

export function xorScramble(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    out += String.fromCharCode(text.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  }
  return out;
}

/** Plaintext payload lines; static network fields only when a static config is given. */
export function buildPlaintext({ ssid, password, staticConfig = null, token }) {
  const lines = [ssid, password ?? ''];
  if (staticConfig) {
    lines.push(staticConfig.ip ?? '', staticConfig.netmask ?? '', staticConfig.gateway ?? '',
      staticConfig.dns1 ?? '', staticConfig.dns2 ?? '');
  }
  lines.push(token);
  for (const l of lines) {
    if (String(l).includes('\n')) throw new Error('payload fields must not contain newlines');
  }
  return lines.join('\n');
}

/**
 * Full QR build: plaintext -> XOR -> frames. Each frame string is what one QR code encodes.
 * @returns {{ payload: string, codes: string[] }} payload = plaintext (for diagnostics)
 */
export function buildQrCodes(opts) {
  const payload = buildPlaintext(opts);
  const scrambled = xorScramble(payload);
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  // QR byte mode encodes UTF-8. Iterating code points also keeps surrogate pairs
  // together so encoding a frame cannot replace half of a pair with U+FFFD.
  for (const character of scrambled) {
    const length = Buffer.byteLength(character, 'utf8');
    if (bytes + length > MAX_CHUNK) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += length;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  const codes = chunks.map((value, i) => `${i + 1}/${chunks.length}\n${value}`);
  return { payload, codes };
}

/**
 * The robot's decode half (config.bt), reimplemented for round-trip tests: frames in any
 * order -> ordered chunks -> XOR -> lines -> {ssid, password, static?, token}.
 */
export function robotDecode(frames) {
  const parts = frames.map((f) => {
    const nl = f.indexOf('\n');
    const [idx, total] = f.slice(0, nl).split('/').map(Number);
    return { idx, total, chunk: f.slice(nl + 1) };
  }).sort((a, b) => a.idx - b.idx);
  const scrambled = parts.map((p) => p.chunk).join('');
  const lines = xorScramble(scrambled).split('\n'); // XOR is symmetric
  const token = lines.pop();
  const [ssid, password, ip, netmask, gateway, dns1, dns2] = lines;
  return { ssid, password, token, ...(lines.length > 2 ? { staticConfig: { ip, netmask, gateway, dns1, dns2 } } : {}) };
}

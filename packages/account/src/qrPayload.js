// OOBE QR payload — EXACT contract of oobe-config/src/behaviors/oobe/config.bt:
// plaintext lines (ssid, password, [staticIP, netmask, gateway, dns1, dns2,] accessToken),
// XOR-scrambled with the jibo.com/jobs key, then chunked into frames "<i>/<N>\n<chunk>".
// The robot concatenates chunks in codeId order, XOR-decrypts the whole, splits on \n,
// .pop()s the token and positionally assigns the rest.

export const XOR_KEY = 'Wow, you cracked our secret code. Impressive. Maybe you should check out jibo.com/jobs.';

/** Keep each frame comfortably inside a version-6/EC-M byte-mode QR. */
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
  const n = Math.max(1, Math.ceil(scrambled.length / MAX_CHUNK));
  const size = Math.ceil(scrambled.length / n);
  const codes = [];
  for (let i = 0; i < n; i += 1) {
    codes.push(`${i + 1}/${n}\n${scrambled.slice(i * size, (i + 1) * size)}`);
  }
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

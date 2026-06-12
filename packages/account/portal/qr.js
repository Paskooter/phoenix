// Minimal QR encoder — byte mode, versions 1-6, EC level M, automatic mask selection.
// Vendored pure-JS (no deps), ESM, runs in the browser (portal) and Node (tests — decoded
// against jsQR as a dev-only oracle). Implements ISO/IEC 18004: data codewords + Reed-Solomon
// EC over GF(2^8)/0x11D, block interleaving, function patterns, format info BCH, masks 0-7
// with the four penalty rules.
//
// API: qrMatrix(text) -> { size, get(x,y) }  (true = dark)
//      qrSvg(text, scale?) -> an <svg> string (what the portal renders)

const EC_M = 0; // index into the per-version table below

// Per version (1..6): total codewords, then for EC level M: [ecPerBlock, numBlocks].
const VERSIONS = [
  null,
  { size: 21, total: 26, ec: [10, 1] },
  { size: 25, total: 44, ec: [16, 1] },
  { size: 29, total: 70, ec: [26, 1] },
  { size: 33, total: 100, ec: [18, 2] },
  { size: 37, total: 134, ec: [24, 2] },
  { size: 41, total: 172, ec: [16, 4] },
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// --- GF(256) arithmetic -------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// Reed-Solomon (Nayuki QR reference): divisor coefficients (length = degree) and the
// remainder of data·x^degree mod divisor.
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const res = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ res[0];
    res.copyWithin(0, 1);
    res[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) res[i] ^= gfMul(divisor[i], factor);
  }
  return res;
}

// --- bit packing -----------------------------------------------------------------

class BitBuf {
  constructor() { this.bits = []; }
  push(value, length) { for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1); }
  toBytes(capacityBytes) {
    // terminator + pad to byte + 0xEC/0x11 padding (spec 8.4.9)
    const cap = capacityBytes * 8;
    for (let i = 0; i < 4 && this.bits.length < cap; i += 1) this.bits.push(0);
    while (this.bits.length % 8) this.bits.push(0);
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j += 1) b = (b << 1) | this.bits[i + j];
      bytes.push(b);
    }
    const pads = [0xec, 0x11];
    let p = 0;
    while (bytes.length < capacityBytes) { bytes.push(pads[p]); p ^= 1; }
    return bytes;
  }
}

// --- data layer --------------------------------------------------------------------

function toUtf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') return [...new TextEncoder().encode(text)];
  return [...Buffer.from(text, 'utf8')];
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 6; v += 1) {
    const { total, ec } = VERSIONS[v];
    const dataCw = total - ec[0] * ec[1];
    if (byteLen + 2 <= dataCw) return v; // mode(4) + count(8) bits = 1.5 bytes, round up
  }
  throw new Error(`payload too long for a v6-M QR (${byteLen} bytes)`);
}

function buildCodewords(bytes, version) {
  const { total, ec } = VERSIONS[version];
  const [ecPerBlock, numBlocks] = ec;
  const dataCw = total - ecPerBlock * numBlocks;

  const buf = new BitBuf();
  buf.push(0b0100, 4);            // byte mode
  buf.push(bytes.length, 8);      // count (8 bits for v1-9)
  for (const b of bytes) buf.push(b, 8);
  const data = buf.toBytes(dataCw);

  // split into blocks (all our versions have equal-size blocks), compute EC, interleave
  const per = dataCw / numBlocks;
  const blocks = [];
  for (let b = 0; b < numBlocks; b += 1) {
    const slice = data.slice(b * per, (b + 1) * per);
    blocks.push({ data: slice, ec: rsRemainder(slice, ecPerBlock) });
  }
  const out = [];
  for (let i = 0; i < per; i += 1) for (const b of blocks) out.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// --- matrix layer ---------------------------------------------------------------------

function makeMatrix(version) {
  const size = VERSIONS[version].size;
  const grid = Array.from({ length: size }, () => new Array(size).fill(null)); // null = data area

  const setRegion = (r, c, val) => { if (r >= 0 && r < size && c >= 0 && c < size) grid[r][c] = val; };
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const on = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
          && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setRegion(r + dr, c + dc, on ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (const cr of ALIGN[version]) {
    for (const cc of ALIGN[version]) {
      if (grid[cr][cc] !== null) continue; // skip overlap with finders
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          grid[cr + dr][cc + dc] = (Math.max(Math.abs(dr), Math.abs(dc)) !== 1) ? 1 : 0;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i += 1) { // timing
    if (grid[6][i] === null) grid[6][i] = i % 2 === 0 ? 1 : 0;
    if (grid[i][6] === null) grid[i][6] = i % 2 === 0 ? 1 : 0;
  }
  grid[size - 8][8] = 1; // dark module

  // reserve format areas (filled later)
  for (let i = 0; i <= 8; i += 1) {
    if (grid[8][i] === null) grid[8][i] = 0;
    if (grid[i][8] === null) grid[i][8] = 0;
    if (i < 8) {
      if (grid[8][size - 1 - i] === null) grid[8][size - 1 - i] = 0;
      if (grid[size - 1 - i][8] === null) grid[size - 1 - i][8] = 0;
    }
  }
  return grid;
}

function placeData(grid, codewords) {
  const size = grid.length;
  const path = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // skip the timing column
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (grid[row][c] === null) path.push([row, c]);
      }
    }
    upward = !upward;
  }
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((cw >> i) & 1);
  path.forEach(([r, c], i) => { grid[r][c] = { bit: bits[i] || 0 }; }); // data cells tagged
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function renderWithMask(grid, mask) {
  const size = grid.length;
  return grid.map((row, r) => row.map((cell, c) => {
    if (cell === null) return 0;
    if (typeof cell === 'object') return MASKS[mask](r, c) ? cell.bit ^ 1 : cell.bit;
    return cell;
  }));
}

function applyFormat(m, mask) {
  const size = m.length;
  // EC level M format value = 0b00<<3 | mask; BCH(15,5), gen 0x537, mask 0x5412 (Nayuki).
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => (bits >> i) & 1; // bit 0 = LSB

  // First copy: top-left finder's right column + bottom row. setModule(row, col).
  for (let i = 0; i <= 5; i += 1) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) m[8][14 - i] = bit(i);

  // Second copy: along the bottom-left finder column and the top-right finder row.
  for (let i = 0; i < 8; i += 1) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = 1; // dark module
  return m;
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  // N1: runs of 5+ same-color in row/col
  for (let pass = 0; pass < 2; pass += 1) {
    for (let r = 0; r < size; r += 1) {
      let run = 1;
      for (let c = 1; c <= size; c += 1) {
        const cur = c < size ? (pass ? m[c][r] : m[r][c]) : -1;
        const prev = pass ? m[c - 1][r] : m[r][c - 1];
        if (cur === prev) run += 1;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
    }
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
  }
  // N3: finder-like 1011101 with 4 light on either side
  const pat = [1, 0, 1, 1, 1, 0, 1];
  const matches = (get, i) => {
    const at = (k) => (k >= 0 && k < size ? get(k) : 0);
    if (!pat.every((p, j) => at(i + j) === p)) return false;
    return [1, 2, 3, 4].every((d) => at(i - d) === 0) || [1, 2, 3, 4].every((d) => at(i + 6 + d) === 0);
  };
  for (let r = 0; r < size; r += 1) {
    for (let i = 0; i < size - 6; i += 1) {
      if (matches((k) => m[r][k], i)) score += 40;
      if (matches((k) => m[k][r], i)) score += 40;
    }
  }
  // N4: dark proportion
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// --- public API -----------------------------------------------------------------------

export function qrMatrix(text) {
  const bytes = toUtf8Bytes(text);
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const grid = makeMatrix(version);
  placeData(grid, codewords);

  let best = null; let bestScore = Infinity; let bestMask = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyFormat(renderWithMask(grid, mask), mask);
    const s = penalty(candidate);
    if (s < bestScore) { best = candidate; bestScore = s; bestMask = mask; }
  }
  return { size: best.length, version, mask: bestMask, get: (x, y) => !!best[y][x], rows: best };
}

/** Render as an SVG string (4-module quiet zone, dark on white). */
export function qrSvg(text, scale = 6) {
  const { size, rows } = qrMatrix(text);
  const q = 4;
  const dim = (size + q * 2) * scale;
  let rects = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (rows[y][x]) rects += `<rect x="${(x + q) * scale}" y="${(y + q) * scale}" width="${scale}" height="${scale}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

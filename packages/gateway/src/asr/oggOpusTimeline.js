// Ogg Opus granules count decoded samples at 48 kHz. Native microphone streams
// sometimes carry an arbitrary 64-bit origin while their packet durations and
// subsequent granule increments remain correct. Rebase that origin before
// ffmpeg sees it; its demuxer rejects huge timestamps before decoding any PCM.
// Audio packets, pre-skip and end trimming remain untouched.
// Timing rules: RFC 7845 sections 4.2–4.5; Opus TOC durations: RFC 6716 section 3.1.

const NO_GRANULE = (1n << 64n) - 1n;
const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
  return crc >>> 0;
});

function checksum(page) {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 255]) >>> 0;
  }
  return crc;
}

function packetSamples(prefix, bytes) {
  if (!bytes) return null;
  const config = prefix[0] >> 3;
  const framing = prefix[0] & 3;
  if (framing === 3 && bytes < 2) return null;
  const frames = framing === 0 ? 1 : framing === 3 ? prefix[1] & 63 : 2;
  const frameSamples = config < 12 ? Math.max(480, 960 * (config & 3))
    : config < 16 ? 480 << (config & 1) : 120 << (config & 3);
  const samples = frames * frameSamples;
  return samples > 0 && samples <= 5760 ? samples : null;
}

export class OggOpusTimeline {
  constructor() {
    this.stream = null;
    this.normalizedPages = 0;
  }

  /** Accept a complete page from the bounded container parser. */
  normalize(page) {
    const flags = page[5];
    const serial = page.readUInt32LE(14);
    const sequence = page.readUInt32LE(18);
    const segments = page[26];
    let body = 27 + segments;
    if ((flags & 2) && page.subarray(body, body + 8).toString('ascii') === 'OpusHead') {
      this.stream = { serial, sequence, packet: 0, prefix: Buffer.alloc(0), bytes: 0, samples: 0n, origin: null };
    }
    const stream = this.stream;
    if (!stream || stream.serial !== serial) return page;
    // Never bless corrupted data with a new checksum or guess across missing
    // pages/packet fragments. Leave those errors to the existing decoder path.
    if (sequence !== stream.sequence || !!(flags & 1) !== (stream.bytes > 0)
      || checksum(page) !== page.readUInt32LE(22)) {
      this.stream = null;
      return page;
    }
    stream.sequence = (sequence + 1) >>> 0;
    let audioCompleted = false;
    for (let i = 0; i < segments; i++) {
      const size = page[27 + i];
      if (stream.prefix.length < 19) {
        stream.prefix = Buffer.concat([stream.prefix, page.subarray(body, body + Math.min(size, 19 - stream.prefix.length))]);
      }
      stream.bytes += size;
      body += size;
      if (size === 255) continue;
      if (stream.packet < 2) {
        const magic = stream.packet === 0 ? 'OpusHead' : 'OpusTags';
        if (stream.prefix.subarray(0, 8).toString('ascii') !== magic) {
          this.stream = null;
          return page;
        }
      } else {
        const samples = packetSamples(stream.prefix, stream.bytes);
        if (samples === null) { this.stream = null; return page; }
        stream.samples += BigInt(samples);
        audioCompleted = true;
      }
      stream.packet++;
      stream.prefix = Buffer.alloc(0);
      stream.bytes = 0;
    }
    const granule = page.readBigUInt64LE(6);
    if (!audioCompleted || granule === NO_GRANULE) return page;
    if (stream.origin === null) {
      // A first/final page alone cannot distinguish an origin from end trimming.
      // Preserve it. A continuing microphone page has no end trim, so its
      // completed packets establish the origin exactly, including uint64 wrap.
      if (flags & 4) return page;
      stream.origin = (granule - stream.samples) & NO_GRANULE;
    }
    if (stream.origin === 0n) return page;
    const rebased = (granule - stream.origin) & NO_GRANULE;
    if ((flags & 4) ? rebased > stream.samples : rebased !== stream.samples) {
      this.stream = null;
      return page;
    }
    const normalized = Buffer.from(page);
    normalized.writeBigUInt64LE(rebased, 6);
    normalized.writeUInt32LE(checksum(normalized), 22);
    this.normalizedPages++;
    return normalized;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { StreamingAudioDecoder } from '../src/asr/audioDecoder.js';
import { OggOpusTimeline } from '../src/asr/oggOpusTimeline.js';
import { OGG_OPUS, fixturePcm } from './fixtures/asrEncoded.js';

const ffmpeg = process.env.PHOENIX_FFMPEG || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const MASK = (1n << 64n) - 1n;
const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
function pages(source) {
  const result = [];
  for (let offset = 0; offset < source.length;) {
    const segments = source[offset + 26];
    let end = offset + 27 + segments;
    for (let i = offset + 27; i < offset + 27 + segments; i++) end += source[i];
    result.push(source.subarray(offset, end)); offset = end;
  }
  return result;
}
// Independent bitwise Ogg CRC, also checked by real ffmpeg in the decode tests.
function crc(page) {
  let value = 0;
  for (let i = 0; i < page.length; i++) {
    value ^= (i >= 22 && i < 26 ? 0 : page[i]) << 24;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ ((value & 0x80000000) ? 0x04c11db7 : 0);
  }
  return value >>> 0;
}
function shifted(source, origin) {
  return Buffer.concat(pages(source).map((page, i) => {
    const result = Buffer.from(page);
    if (i >= 2) result.writeBigUInt64LE((result.readBigUInt64LE(6) + origin) & MASK, 6);
    result.writeUInt32LE(crc(result), 22);
    return result;
  }));
}
function packetList(page) {
  const result = []; let size = 0; let offset = 27 + page[26];
  for (const segment of page.subarray(27, offset)) {
    size += segment;
    if (segment < 255) { result.push(page.subarray(offset, offset + size)); offset += size; size = 0; }
  }
  assert.equal(size, 0);
  return result;
}
function page(sequence, flags, granule, packets, lacing = null) {
  const segments = lacing || packets.flatMap(packet => [...Array(Math.floor(packet.length / 255)).fill(255), packet.length % 255]);
  const header = Buffer.alloc(27);
  header.write('OggS'); header[5] = flags; header.writeBigUInt64LE(granule & MASK, 6);
  header.writeUInt32LE(0x12345678, 14); header.writeUInt32LE(sequence, 18); header[26] = segments.length;
  const result = Buffer.concat([header, Buffer.from(segments), ...packets]);
  result.writeUInt32LE(crc(result), 22);
  return result;
}
function timed(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No decoded audio')), 3000); })])
    .finally(() => clearTimeout(timer));
}

for (const origin of [0n, 123456n, (1n << 62n) + 12345n, (1n << 63n) + 45678n, MASK - 24000n]) {
  test(`Ogg timestamp origin ${origin}: fragmented live input preserves every PCM sample`, { skip: !available }, async t => {
    const reference = spawnSync(ffmpeg, args, { input: OGG_OPUS });
    assert.equal(reference.status, 0);
    const input = shifted(OGG_OPUS, origin);
    if (origin === (1n << 62n) + 12345n) {
      const broken = spawnSync(ffmpeg, args, { input });
      assert.equal(broken.stdout.length, 0, 'the uncorrected timestamp reproduces the zero-audio failure');
      assert.match(broken.stderr.toString(), /huge granule|Invalid data/);
    }
    const chunks = [];
    const decoder = new StreamingAudioDecoder({ encoding: 'OGG_OPUS', log: {}, onPcm: chunk => chunks.push(chunk) });
    t.after(() => decoder.abort());
    const heard = timed(once(decoder, 'pcm'));
    decoder.start();
    const prefixEnd = pages(input).slice(0, 3).reduce((sum, part) => sum + part.length, 0);
    for (let offset = 0; offset < prefixEnd; offset += 13) decoder.write(input.subarray(offset, Math.min(prefixEnd, offset + 13)));
    await heard;
    assert.equal(decoder.failed, false);
    assert.equal(decoder.inputEnded, false, 'decoding starts while the microphone remains open');
    decoder.write(input.subarray(prefixEnd));
    await timed(decoder.finish());
    assert.deepEqual(Buffer.concat(chunks), reference.stdout);
    assert.equal(decoder.oggStartupRestarts, 0);
  });
}

test('native-style OpusTags sharing an audio page preserve packets and end trimming', { skip: !available }, async t => {
  const original = pages(OGG_OPUS);
  const audio = [...packetList(original[2]), ...packetList(original[3])];
  const origin = (1n << 63n) + 1234n; // invented timestamp, never a robot capture
  const input = Buffer.concat([
    page(0, 2, 0n, packetList(original[0])),
    page(1, 0, origin + 25n * 960n, [...packetList(original[1]), ...audio.slice(0, 25)]),
    page(2, 0, origin + 51n * 960n, audio.slice(25, 51)),
    page(3, 4, origin + original[3].readBigUInt64LE(6), audio.slice(51)),
  ]);
  const chunks = [];
  const decoder = new StreamingAudioDecoder({ encoding: 'OGG_OPUS', log: {}, onPcm: chunk => chunks.push(chunk) });
  t.after(() => decoder.abort()); decoder.start(); decoder.write(input); await timed(decoder.finish());
  assert.deepEqual(Buffer.concat(chunks), spawnSync(ffmpeg, args, { input: OGG_OPUS }).stdout);
});

test('continued comment packets are not counted as audio samples', { skip: !available }, () => {
  const original = pages(OGG_OPUS);
  const tags = Buffer.concat([packetList(original[1])[0], Buffer.alloc(300)]);
  const origin = (1n << 62n) + 111n;
  const input = [
    page(0, 2, 0n, packetList(original[0])),
    page(1, 0, MASK, [tags.subarray(0, 255)], [255]),
    page(2, 1, origin + original[2].readBigUInt64LE(6), [tags.subarray(255), ...packetList(original[2])]),
    page(3, 4, origin + original[3].readBigUInt64LE(6), packetList(original[3])),
  ];
  const timeline = new OggOpusTimeline();
  const normalized = Buffer.concat(input.map(part => timeline.normalize(part)));
  const actual = spawnSync(ffmpeg, args, { input: normalized });
  assert.equal(actual.status, 0, actual.stderr.toString());
  assert.deepEqual(actual.stdout, spawnSync(ffmpeg, args, { input: OGG_OPUS }).stdout);
});

test('normal streams remain byte-identical and corrupt packets are never given a fresh CRC', () => {
  const timeline = new OggOpusTimeline();
  assert.deepEqual(Buffer.concat(pages(OGG_OPUS).map(part => timeline.normalize(part))), OGG_OPUS);
  const damaged = pages(shifted(OGG_OPUS, 1n << 63n)).map(Buffer.from);
  damaged[2][damaged[2].length - 1] ^= 1;
  const corrupt = new OggOpusTimeline();
  for (const part of damaged) assert.equal(corrupt.normalize(part), part);
});

test('a first/final audio page retains its original end trimming', () => {
  const original = pages(OGG_OPUS);
  const tiny = [
    page(0, 2, 0n, packetList(original[0])),
    page(1, 0, 0n, packetList(original[1])),
    page(2, 4, 600n, [packetList(original[2])[0]]),
  ];
  const timeline = new OggOpusTimeline();
  for (const part of tiny) assert.equal(timeline.normalize(part), part);
});


test('an Opus audio packet continued across pages retains its duration and payload', { skip: !available }, () => {
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'off', '-f', 'ogg', 'pipe:1'], { input: fixturePcm() });
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  const original = pages(encoded.stdout);
  const audio = packetList(original[2]);
  assert.ok(audio[0].length > 255);
  const origin = (1n << 63n) + 9876n;
  const input = [
    page(0, 2, 0n, packetList(original[0])),
    page(1, 0, 0n, packetList(original[1])),
    page(2, 0, MASK, [audio[0].subarray(0, 255)], [255]),
    page(3, 1, origin + original[2].readBigUInt64LE(6), [audio[0].subarray(255), ...audio.slice(1)]),
    page(4, 4, origin + original[3].readBigUInt64LE(6), packetList(original[3])),
  ];
  const timeline = new OggOpusTimeline();
  const actual = spawnSync(ffmpeg, args, { input: Buffer.concat(input.map(part => timeline.normalize(part))) });
  assert.equal(actual.status, 0, actual.stderr.toString());
  assert.deepEqual(actual.stdout, spawnSync(ffmpeg, args, { input: encoded.stdout }).stdout);
});

test('a missing page disables timestamp repair instead of guessing its audio duration', () => {
  const input = pages(shifted(OGG_OPUS, 1n << 63n)).map(Buffer.from);
  input[2].writeUInt32LE(3, 18);
  input[2].writeUInt32LE(crc(input[2]), 22);
  const timeline = new OggOpusTimeline();
  for (const part of input) assert.equal(timeline.normalize(part), part);
});

#!/usr/bin/env node
/**
 * What does the trailing-silence window actually cost, on real captured turns?
 *
 * Replays each capture through the real ParakeetASRSession at several window
 * values and reports, for each, the pause between the last speech sample and the
 * moment the endpointer fires. Encoded captures are fed one OGG page at a time
 * because that is how they arrive: the silence is invisible until the page that
 * carries it lands, so a page-granular feed is the only honest model of the live
 * path. Linear16 captures are fed continuously, as they arrive.
 *
 * A value is only acceptable if it shortens the pause WITHOUT cutting speech:
 * every capture must still endpoint, and the endpoint must not fire before the
 * speaker stopped.
 *
 * usage: eos-sweep.mjs <capture-dir> [windowMs ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const SR = 16000;
const BYTES_PER_SEC = SR * 2;
const WINDOW_BYTES = (BYTES_PER_SEC * 10) / 1000;
const MODULE = path.resolve('packages/gateway/src/asr/parakeetSession.js');
const DEFAULT_WINDOWS = [700, 500, 400, 350, 300, 250];

function decodeOgg(buf) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0',
    '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { input: buf, maxBuffer: 1 << 28 });
}

/** Split a capture into the PCM the server actually has, chunk by chunk, in order. */
function arrivals(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.ogg')) {
    const chunks = [];
    for (let o = 0; o + WINDOW_BYTES <= buf.length; o += WINDOW_BYTES) chunks.push(buf.subarray(o, o + WINDOW_BYTES));
    return { chunks, granularity: 'continuous (linear16)' };
  }
  // One OGG page per arrival: offsets of the 'OggS' capture pattern. An Opus page
  // is only decodable inside the container, so each arrival is the PCM the
  // decoder can newly release once that page completes (decoded cumulatively).
  const offsets = [];
  let i = buf.indexOf('OggS');
  while (i !== -1) { offsets.push(i); i = buf.indexOf('OggS', i + 4); }
  const chunks = [];
  let decodedSoFar = 0;
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    let decoded;
    try { decoded = decodeOgg(buf.subarray(0, end)); } catch { break; }
    chunks.push(decoded.subarray(decodedSoFar));
    decodedSoFar = decoded.length;
  }
  const perPageSec = offsets.length ? ((buf.length / 8160) / offsets.length) : 0;
  return { chunks, granularity: `${offsets.length} ogg pages (~${perPageSec.toFixed(2)}s each)` };
}

function pcmFor(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.ogg')) return buf;
  return decodeOgg(buf);
}

function rms(buf) {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Last speech window BEFORE the endpoint, at the gate the session itself would apply. */
function lastSpeechBefore(pcm, upToMs, floor, gate) {
  const limit = Math.min(Math.floor(upToMs / 10), Math.floor(pcm.length / WINDOW_BYTES));
  let last = 0;
  for (let i = 0; i < limit; i++) {
    if (rms(pcm.subarray(i * WINDOW_BYTES, (i + 1) * WINDOW_BYTES)) > gate) last = (i + 1) * 10;
  }
  return last;
}

function floorGate(pcm) {
  const windows = [];
  for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) windows.push(rms(pcm.subarray(o, o + WINDOW_BYTES)));
  const sorted = [...windows].sort((a, b) => a - b);
  const floor = sorted[Math.floor(0.2 * (sorted.length - 1))] || 0;
  return { floor, gate: Math.max(400, floor * 1.8) };
}

/** Feed arrivals in order; report the stream-time position at which EOS fires. */
async function endpointAt(modulePath, windowMs, chunks) {
  // The window is read at module load, so set it before importing a fresh copy.
  process.env.PHOENIX_ASR_SILENCE_EOS_MS = String(windowMs);
  const { ParakeetASRSession } = await import(`${modulePath}?window=${windowMs}`);
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const session = new ParakeetASRSession('http://127.0.0.1:1', { lang: 'en-US', encoding: 'LINEAR16', sampleRate: SR }, quiet);
  session._finalize = async () => {};
  let decodedMs = 0;
  let eosMs = null;
  session.onEndOfSpeech(() => { if (eosMs === null) eosMs = decodedMs; });
  for (const chunk of chunks) {
    if (eosMs !== null) break;
    // Walk each arrival per window so the timeline is in 10 ms steps.
    for (let o = 0; o + WINDOW_BYTES <= chunk.length; o += WINDOW_BYTES) {
      session._consumePcm(chunk.subarray(o, o + WINDOW_BYTES));
      decodedMs += 10;
      if (eosMs !== null) break;
    }
  }
  return eosMs;
}

const dir = process.argv[2];
const windows = process.argv.slice(3).map(Number).filter((v) => v > 0);
const values = windows.length ? windows : DEFAULT_WINDOWS;
const MAC = { '8030dcec7b0d': 'AERO', '5cf821ea7bf9': 'MOTH' };

const captures = fs.readdirSync(dir).filter((f) => /\.(raw|ogg)$/.test(f)).sort()
  .map((name) => {
    const file = path.join(dir, name);
    let pcm;
    try { pcm = pcmFor(file); } catch (error) {
      return { name, robot: MAC[name.split('-').pop().replace(/\.(raw|ogg)$/, '')] || '?', skip: `decode failed: ${error.message}` };
    }
    if (!pcm.length) return { name, robot: MAC[name.split('-').pop().replace(/\.(raw|ogg)$/, '')] || '?', skip: 'no PCM' };
    const { gate } = floorGate(pcm);
    const { chunks, granularity } = arrivals(file);
    return { name, robot: MAC[name.split('-').pop().replace(/\.(raw|ogg)$/, '')] || '?', pcm, gate, chunks, granularity };
  });

const header = ['capture'.padEnd(30), 'robot'.padEnd(6), 'granularity'.padEnd(26), ...values.map((v) => `${v}ms`.padStart(9))].join(' ');
console.log(header);
const totals = Object.fromEntries(values.map((v) => [v, { pause: [], never: 0 }]));

for (const c of captures) {
  if (c.skip) { console.log(`${c.name.slice(4, 34).padEnd(30)} ${c.robot.padEnd(6)} skipped (${c.skip})`); continue; }
  const cells = [];
  for (const v of values) {
    const eosMs = await endpointAt(MODULE, v, c.chunks);
    if (eosMs === null) { cells.push('never'.padStart(9)); totals[v].never++; continue; }
    const last = lastSpeechBefore(c.pcm, eosMs, null, c.gate);
    const pause = eosMs - last;
    cells.push(`${(pause / 1000).toFixed(2)}s`.padStart(9));
    totals[v].pause.push(pause);
  }
  console.log(`${c.name.slice(4, 34).padEnd(30)} ${c.robot.padEnd(6)} ${c.granularity.padEnd(26)} ${cells.join(' ')}`);
}

console.log('');
for (const v of values) {
  const t = totals[v];
  const sorted = [...t.pause].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const worst = sorted.length ? sorted[sorted.length - 1] : null;
  console.log(`${String(v).padStart(4)}ms  endpointed ${t.pause.length}  never ${t.never}  median pause ${median === null ? '-' : (median / 1000).toFixed(2) + 's'}  worst ${worst === null ? '-' : (worst / 1000).toFixed(2) + 's'}`);
}

#!/usr/bin/env node
/**
 * How long after the speaker actually stops does the endpointer fire?
 *
 * vad-compare.mjs reports WHEN EOS fires inside a capture, but the capture keeps
 * growing after the endpoint until the robot closes the socket, so that number is
 * not the delay a person feels. This measures the delay directly:
 *
 *   gap = (time of the last speech window) -> (time the real session fires EOS)
 *
 * The gate used to locate "last speech" is the same one the session applies after
 * adapting (max(400, floor * margin)), computed over the capture's own windows, so
 * the two ends of the interval are on the same scale.
 *
 * usage: trailing-silence.mjs <capture-dir> [--module <parakeetSession.js>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SR = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SR * BYTES_PER_SAMPLE;
const WINDOW_MS = 10;
const WINDOW_BYTES = (BYTES_PER_SEC * WINDOW_MS) / 1000;
const SPEECH_RMS_THRESHOLD = 400;

const decode = (file) => {
  const raw = fs.readFileSync(file);
  if (!file.endsWith('.ogg')) return raw;
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0',
      '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { input: raw, maxBuffer: 1 << 28 });
  } catch (error) {
    return { decodeError: (error.stderr || Buffer.from('')).toString().trim().split('\n').pop() || error.message };
  }
};

const rms = (buf) => {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
};

/** Per-window RMS profile plus a robust floor (p20) and the gate derived from it. */
function profile(pcm) {
  const windows = [];
  for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) windows.push(rms(pcm.subarray(o, o + WINDOW_BYTES)));
  if (!windows.length) return null;
  const sorted = [...windows].sort((a, b) => a - b);
  const floor = sorted[Math.floor(0.2 * (sorted.length - 1))];
  const gate = Math.max(SPEECH_RMS_THRESHOLD, floor * 1.8);
  return { windows, floor, gate, speechWindows: windows.filter((v) => v > gate).length };
}

/** Where the real session decides end-of-speech, fed the same PCM. */
async function endpointMs(modPath, pcm) {
  const { ParakeetASRSession } = await import(modPath);
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const session = new ParakeetASRSession('http://127.0.0.1:1', { lang: 'en-US', encoding: 'LINEAR16', sampleRate: SR }, quiet);
  let eosAtMs = null;
  let fed = 0;
  session._finalize = async () => {};
  session.onEndOfSpeech(() => { if (eosAtMs === null) eosAtMs = (fed / BYTES_PER_SEC) * 1000; });
  for (let o = 0; o + WINDOW_BYTES <= pcm.length && eosAtMs === null; o += WINDOW_BYTES) {
    fed = o + WINDOW_BYTES;
    session._consumePcm(pcm.subarray(o, o + WINDOW_BYTES));
  }
  return eosAtMs;
}

const dir = process.argv[2];
const flag = process.argv.indexOf('--module');
const modulePath = path.resolve(flag === -1 ? 'packages/gateway/src/asr/parakeetSession.js' : process.argv[flag + 1]);
const MAC = { '8030dcec7b0d': 'AERO', '5cf821ea7bf9': 'MOTH' };

const rows = [];
for (const name of fs.readdirSync(dir).filter((f) => /\.(raw|ogg)$/.test(f)).sort()) {
  const file = path.join(dir, name);
  const pcm = decode(file);
  if (pcm.decodeError) {
    rows.push({ name, robot: MAC[name.replace(/\.(raw|ogg)$/, '').split('-').pop()] || '?', decodeError: pcm.decodeError });
    continue;
  }
  const shape = profile(pcm);
  if (!shape) { rows.push({ name, robot: '?', empty: true }); continue; }
  const eosMs = await endpointMs(modulePath, pcm);
  // Speech that matters is speech before the endpoint; audio after it is the
  // robot still streaming into a turn that has already been decided.
  const beforeEos = eosMs === null ? shape.windows.length : Math.floor(eosMs / WINDOW_MS);
  let lastSpeechMs = 0;
  for (let i = 0; i < beforeEos && i < shape.windows.length; i++) {
    if (shape.windows[i] > shape.gate) lastSpeechMs = (i + 1) * WINDOW_MS;
  }
  rows.push({
    name,
    robot: MAC[name.replace(/\.(raw|ogg)$/, '').split('-').pop()] || '?',
    audioMs: Math.round((pcm.length / BYTES_PER_SEC) * 1000),
    floor: Math.round(shape.floor),
    gate: Math.round(shape.gate),
    lastSpeechMs,
    eosMs: eosMs === null ? null : Math.round(eosMs),
    gapMs: eosMs === null ? null : Math.round(eosMs - lastSpeechMs),
  });
}

const withGap = rows.filter((r) => typeof r.gapMs === 'number' && r.gapMs >= 0);
const short = (r) => (r.decodeError ? `decode failed: ${r.decodeError}` : r.empty ? 'no PCM' : '');
console.log(`capture                            robot  audio    floor  gate   lastSpeech  eos      GAP`);
for (const r of rows) {
  if (r.decodeError || r.empty) { console.log(`${r.name.slice(4, 35).padEnd(34)} ${String(r.robot).padEnd(6)} ${short(r)}`); continue; }
  const fmt = (v) => (v === null ? '   never' : `${(v / 1000).toFixed(2)}s`.padStart(8));
  console.log(`${r.name.slice(4, 35).padEnd(34)} ${String(r.robot).padEnd(6)} ${(r.audioMs / 1000).toFixed(2).padStart(5)}s ${String(r.floor).padStart(5)} ${String(r.gate).padStart(5)}  ${fmt(r.lastSpeechMs)} ${fmt(r.eosMs)} ${r.gapMs === null ? '' : `${(r.gapMs / 1000).toFixed(2)}s`}`);
}
console.log(`\nmeasured ${withGap.length}/${rows.length}; gaps(s): ${withGap.map((r) => (r.gapMs / 1000).toFixed(2)).join(', ')}`);
console.log(`module: ${modulePath}`);

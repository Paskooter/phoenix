#!/usr/bin/env node
/**
 * The pause a person actually feels, measured on real captured turns.
 *
 * Clock: a robot streams its audio as it captures it, so the arrival time of the
 * Nth byte of a capture is N / bytesPerSecond of that capture. Both ends of the
 * interval therefore live on one clock:
 *
 *   pause = (byte position at which the session fired EOS / bytesPerSecond)
 *         - (position in the audio of the last speech sample)
 *
 * Encoded captures are fed to the REAL StreamingAudioDecoder through its public
 * `write()`, so the OGG page buffering that delays the silence is modelled by the
 * component that actually does it, not by an approximation. Linear16 captures
 * arrive as PCM and are fed directly.
 *
 * This isolates the cost of the trailing-silence window. It does not measure the
 * recognition round trip that follows EOS, which is added on top at run time.
 *
 * usage: eos-latency.mjs <capture-dir> [windowMs ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SR = 16000;
const BYTES_PER_SEC = SR * 2;
const WINDOW_BYTES = (BYTES_PER_SEC * 10) / 1000;
const MODULE = path.resolve('packages/gateway/src/asr/parakeetSession.js');
const DECODER = path.resolve('packages/gateway/src/asr/audioDecoder.js');
const DEFAULT_WINDOWS = [700, 500, 400, 350, 300, 250];

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const fullPcm = (file) => {
  const buf = fs.readFileSync(file);
  if (!file.endsWith('.ogg')) return { buf, pcm: buf, encoded: false };
  const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0',
    '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { input: buf, maxBuffer: 1 << 28 });
  return { buf, pcm, encoded: true };
};

const rms = (buf) => {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) : 0;
};

/**
 * Last speech sample in the audio, on the audio's own clock.
 *
 * Speech is a window well clear of the recording's own quiet level: above the
 * 10th-percentile window by 2.5x AND above an absolute floor. Using the session's
 * adaptive gate here would be circular -- the gate is what we are measuring -- and
 * a low percentile gate overstates "speech" in a loud room, which is exactly the
 * error that made an earlier version of this harness report impossible sub-window
 * pauses.
 */
function lastSpeechSec(pcm) {
  const windows = [];
  for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) windows.push(rms(pcm.subarray(o, o + WINDOW_BYTES)));
  if (!windows.length) return { sec: 0, threshold: null };
  const sorted = [...windows].sort((a, b) => a - b);
  const quietLevel = sorted[Math.floor(0.1 * (sorted.length - 1))];
  const threshold = Math.max(600, quietLevel * 2.5);
  let last = 0;
  for (let i = 0; i < windows.length; i++) if (windows[i] > threshold) last = (i + 1) * 10;
  return { sec: last / 1000, threshold: Math.round(threshold), quietLevel: Math.round(quietLevel) };
}

/** Feed one capture through the real session; return the byte position at EOS. */
async function bytesAtEos(windowMs, file) {
  process.env.PHOENIX_ASR_SILENCE_EOS_MS = String(windowMs);
  const { ParakeetASRSession } = await import(`${MODULE}?window=${windowMs}`);
  const { StreamingAudioDecoder } = await import(DECODER);
  const buf = fs.readFileSync(file);
  const encoded = file.endsWith('.ogg');
  const session = new ParakeetASRSession('http://127.0.0.1:1', {
    lang: 'en-US', encoding: encoded ? 'OGG_OPUS' : 'LINEAR16', sampleRate: SR,
  }, quiet);
  session._finalize = async () => {};
  let fed = 0;
  let eosAtBytes = null;
  session.onEndOfSpeech(() => { if (eosAtBytes === null) eosAtBytes = fed; });

  if (!encoded) {
    for (let o = 0; o + WINDOW_BYTES <= buf.length && eosAtBytes === null; o += WINDOW_BYTES) {
      fed = o + WINDOW_BYTES;
      session._consumePcm(buf.subarray(o, o + WINDOW_BYTES));
    }
    return eosAtBytes;
  }

  // Encoded: bytes arrive as socket reads and only become PCM when the decoder
  // has a complete frame, which is the whole point of measuring this way.
  const decoder = new StreamingAudioDecoder({
    encoding: 'OGG_OPUS', sampleRate: SR, onPcm: (pcm) => session._consumePcm(pcm), onError: () => {}, log: quiet,
  });
  const CHUNK = 4096;
  for (let o = 0; o < buf.length && eosAtBytes === null; o += CHUNK) {
    fed = Math.min(o + CHUNK, buf.length);
    decoder.write(buf.subarray(o, fed));
    await new Promise((r) => setImmediate(r));
  }
  try { decoder.close?.(); } catch {}
  return eosAtBytes;
}

const dir = process.argv[2];
const values = process.argv.slice(3).map(Number).filter((v) => v > 0);
const windows = values.length ? values : DEFAULT_WINDOWS;
const MAC = { '8030dcec7b0d': 'AERO', '5cf821ea7bf9': 'MOTH' };

const captures = fs.readdirSync(dir).filter((f) => /\.(raw|ogg)$/.test(f)).sort().map((name) => {
  const file = path.join(dir, name);
  let decoded;
  try { decoded = fullPcm(file); } catch (error) {
    return { name, robot: MAC[name.split('-').pop().replace(/\.(raw|ogg)$/, '')] || '?', skip: `decode failed: ${error.message.split('\n')[0]}` };
  }
  if (!decoded.pcm.length) return { name, robot: MAC[name.split('-').pop().replace(/\.(raw|ogg)$/, '')] || '?', skip: 'no PCM' };
  const bytesPerSec = decoded.encoded ? (decoded.buf.length / (decoded.pcm.length / BYTES_PER_SEC)) : BYTES_PER_SEC;
  return { name, file, robot: MAC[name.split('-').pop().replace(/\.(raw|ogg)$/, '')] || '?',
    durationSec: +(decoded.pcm.length / BYTES_PER_SEC).toFixed(2), bytesPerSec: Math.round(bytesPerSec),
    speech: lastSpeechSec(decoded.pcm), encoded: decoded.encoded };
});

console.log(`capture                        robot  dur    speechEnds  bytes/s  ${windows.map((w) => `${w}ms`.padStart(8)).join(' ')}`);
const totals = Object.fromEntries(windows.map((w) => [w, []]));
for (const c of captures) {
  if (c.skip) { console.log(`${c.name.slice(4, 34).padEnd(30)} ${c.robot.padEnd(6)} skipped (${c.skip})`); continue; }
  const cells = [];
  for (const w of windows) {
    const bytes = await bytesAtEos(w, c.file);
    if (bytes === null) { cells.push('never'.padStart(8)); continue; }
    const pause = bytes / c.bytesPerSec - c.speech.sec;
    cells.push(`${pause.toFixed(2)}s`.padStart(8));
    totals[w].push({ pause, robot: c.robot, name: c.name });
  }
  console.log(`${c.name.slice(4, 34).padEnd(30)} ${c.robot.padEnd(6)} ${String(c.durationSec).padStart(5)}s ${String(c.speech.sec).padStart(6)}s ${String(c.bytesPerSec).padStart(7)} ${cells.join(' ')}`);
}
console.log('');
for (const w of windows) {
  const all = totals[w];
  const aero = all.filter((r) => r.robot === 'AERO');
  const stat = (rows) => {
    if (!rows.length) return 'n/a';
    const s = rows.map((r) => r.pause).sort((a, b) => a - b);
    return `n=${s.length} median ${s[Math.floor(s.length / 2)].toFixed(2)}s worst ${s[s.length - 1].toFixed(2)}s`;
  };
  console.log(`${String(w).padStart(4)}ms  endpointed ${all.length}  ${stat(all)}   AERO: ${stat(aero)}`);
}

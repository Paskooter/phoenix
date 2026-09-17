#!/usr/bin/env node
/**
 * Replay one captured robot turn through a real ParakeetASRSession, once as the
 * encoding the robot sent and once as the LINEAR16 the other robot sends, and
 * report when start-of-speech, end-of-speech and the transcript actually land.
 *
 * The audio is byte-identical across both runs, so encoding is the only
 * variable: whatever differs is the encoding path's own behaviour.
 *
 * usage: replay.mjs <capture.ogg> [parakeetUrl]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ParakeetASRSession } from '../../packages/gateway/src/asr/parakeetSession.js';

const file = process.argv[2];
const url = process.argv[3] || process.env.ETCO_server_parakeetUrl || 'http://192.168.1.252:6972';
if (!file) { console.error('usage: replay.mjs <capture.ogg> [parakeetUrl]'); process.exit(2); }

const ogg = fs.readFileSync(file);
const dec = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0',
  '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { input: ogg, maxBuffer: 1 << 28 });
const pcm = dec.stdout;
const quiet = { debug(){}, info(){}, warn(){}, error(){} };
const FRAME_MS = 50; // AudioChannel.block_duration_ms on the robot

async function run(label, encoding, payload) {
  const t0 = Date.now();
  const ms = () => String(Date.now() - t0).padStart(5) + 'ms';
  const marks = [];
  const s = new ParakeetASRSession(url, { lang: 'en-US', earlyEOS: ['yes', 'no'], encoding, sampleRate: 16000 }, quiet);
  s.onStartOfSpeech(() => marks.push(`${ms()}  SOS`));
  s.onEndOfSpeech(() => marks.push(`${ms()}  EOS`));
  s.onResult((r) => marks.push(`${ms()}  RESULT ${JSON.stringify(r?.text ?? r).slice(0, 90)}`));
  await s.start();

  // Pace the bytes at the rate the robot produced them, in its own frame size.
  const bytesPerFrame = encoding === 'LINEAR16'
    ? 16000 * 2 * (FRAME_MS / 1000)
    : Math.max(1, Math.round(payload.length / (pcm.length / (16000 * 2) * 1000 / FRAME_MS)));
  let fed = 0;
  for (let off = 0; off < payload.length; off += bytesPerFrame) {
    if (s.eosFired || s.stopped) { marks.push(`${ms()}  robot would stop here, ${(fed / payload.length * 100).toFixed(0)}% of audio sent`); break; }
    s.provideAudio(payload.subarray(off, off + bytesPerFrame));
    fed = off + bytesPerFrame;
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }
  const sentAll = fed >= payload.length;
  let final = null;
  try {
    final = await Promise.race([
      s.finalizeNow(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('finalizeNow did not settle within 30s')), 30_000)),
    ]);
  } catch (err) { marks.push(`${ms()}  finalizeNow: ${err.message}`); }
  marks.push(`${ms()}  finalizeNow -> ${JSON.stringify(final?.text ?? final).slice(0, 90)}`);
  try { s.abort(); } catch {}
  console.log(`\n--- ${label} (${encoding}, ${payload.length} bytes, streamed whole turn: ${sentAll}) ---`);
  for (const m of marks) console.log('   ', m);
}

console.log(`capture : ${file}`);
console.log(`audio   : ${(pcm.length / (16000 * 2)).toFixed(2)}s of 16 kHz mono PCM (${ogg.length} B ogg -> ${pcm.length} B pcm)`);
console.log(`parakeet: ${url}`);
await run('as Aero sends it', 'OGG_OPUS', ogg);
await run('as Moth sends it', 'LINEAR16', pcm);

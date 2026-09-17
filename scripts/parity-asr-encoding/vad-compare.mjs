#!/usr/bin/env node
/**
 * Replay captured robot turns through two real ParakeetASRSession builds and
 * report when each fires end-of-speech.  Both are driven through their own
 * _consumePcm with finalisation stubbed, so nothing touches the network and only
 * the endpointer runs.
 *
 * The control is the previous build of the module itself, extracted from git --
 * not a reimplementation here, and not the new module with a flag flipped, both
 * of which quietly keep some of the new behaviour.
 *
 * usage: vad-compare.mjs <dir-of-captures> <control-module-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SR = 16000, BPS = 2;
const STEP = (SR * BPS * 10) / 1000;

async function run(modPath, pcm) {
  const { ParakeetASRSession } = await import(modPath);
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const s = new ParakeetASRSession('http://127.0.0.1:1', { lang: 'en-US', encoding: 'LINEAR16', sampleRate: 16000 }, quiet);
  let eosAtMs = null, fed = 0;
  s._finalize = async () => {};
  s.onEndOfSpeech(() => { if (eosAtMs === null) eosAtMs = (fed / (SR * BPS)) * 1000; });
  for (let o = 0; o + STEP <= pcm.length && eosAtMs === null; o += STEP) {
    fed = o + STEP;
    s._consumePcm(pcm.subarray(o, o + STEP));
  }
  return eosAtMs;
}

const dir = process.argv[2];
const controlDir = process.argv[3];
const MAC = { '8030dcec7b0d': 'AERO', '5cf821ea7bf9': 'MOTH' };
const control = path.resolve(controlDir, 'parakeetSession.js');
const current = path.resolve('packages/gateway/src/asr/parakeetSession.js');

console.log('robot      capture          audio        before        after');
let improved = 0, regressed = 0, same = 0;
for (const f of fs.readdirSync(dir).filter((x) => /\.(raw|ogg)$/.test(x)).sort()) {
  let pcm = fs.readFileSync(path.join(dir, f));
  if (f.endsWith('.ogg')) {
    pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { input: pcm, maxBuffer: 1 << 28 });
  }
  const mac = f.replace(/\.(raw|ogg)$/, '').split('-').pop();
  const who = MAC[mac] || (f.endsWith('.ogg') ? 'AERO/ogg' : '?');
  const a = await run(control, pcm), b = await run(current, pcm);
  const fmt = (v) => (v === null ? '      never' : `${(v / 1000).toFixed(2)}s`.padStart(11));
  let mark = '';
  if (a === null && b !== null) { mark = '  FIXED'; improved++; }
  else if (a !== null && b === null) { mark = '  REGRESSED'; regressed++; }
  else if (a !== null && b !== null && b < a - 100) { mark = `  -${((a - b) / 1000).toFixed(1)}s`; improved++; }
  else if (a !== null && b !== null && b > a + 100) { mark = `  +${((b - a) / 1000).toFixed(1)}s SLOWER`; regressed++; }
  else same++;
  console.log(`${who.padEnd(10)} ${f.slice(4, 17).padEnd(15)} ${(pcm.length / (SR * BPS)).toFixed(2).padStart(6)}s ${fmt(a)} ${fmt(b)}${mark}`);
}
console.log(`\nimproved ${improved}, regressed ${regressed}, unchanged ${same}`);

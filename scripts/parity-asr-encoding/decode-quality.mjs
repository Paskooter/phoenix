#!/usr/bin/env node
/**
 * Decode quality of each ASR capture: is the PCM the endpointer sees real audio?
 *
 * The endpointer can only find silence in a signal that reproduces the room. A
 * capture whose decode is loud, flat and broadband gives every window a high RMS,
 * so no silence run ever completes and the turn drags until the robot's own cap.
 * This prints the numbers that separate "quiet room misjudged" from "audio never
 * decoded".
 *
 * usage: decode-quality.mjs <capture-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SR = 16000;
const BYTES_PER_SEC = SR * 2;
const WINDOW_BYTES = (BYTES_PER_SEC * 10) / 1000;

function decode(file) {
  const raw = fs.readFileSync(file);
  if (!file.endsWith('.ogg')) return { pcm: raw, decoder: 'as-received (LINEAR16)' };
  try {
    const pcm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0',
      '-ac', '1', '-ar', String(SR), '-f', 's16le', 'pipe:1'], { input: raw, maxBuffer: 1 << 28 });
    return { pcm, decoder: 'ffmpeg ogg->s16le' };
  } catch (error) {
    return { error: (error.stderr || Buffer.from('')).toString().trim().split('\n').filter(Boolean).slice(-2).join(' | ') };
  }
}

function stats(pcm) {
  const n = pcm.length >> 1;
  if (!n) return null;
  const windows = [];
  let sum = 0, dc = 0, peak = 0, clipped = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s; dc += s;
    peak = Math.max(peak, Math.abs(s));
    if (Math.abs(s) >= 32700) clipped++;
  }
  for (let o = 0; o + WINDOW_BYTES <= pcm.length; o += WINDOW_BYTES) {
    let ws = 0;
    for (let i = 0; i < WINDOW_BYTES >> 1; i++) { const s = pcm.readInt16LE(o + i * 2); ws += s * s; }
    windows.push(Math.sqrt(ws / (WINDOW_BYTES >> 1)));
  }
  const sorted = [...windows].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return {
    durSec: +(pcm.length / BYTES_PER_SEC).toFixed(2),
    rms: Math.round(Math.sqrt(sum / n)),
    dcOffset: Math.round(dc / n),
    peak,
    clippedPct: +((100 * clipped) / n).toFixed(2),
    p10: Math.round(at(0.1)), p50: Math.round(at(0.5)), p90: Math.round(at(0.9)),
    // A signal that never drops near zero cannot contain a detectable pause.
    minWindow: Math.round(sorted[0]),
    windowSpread: Math.round(at(0.9) - at(0.1)),
  };
}

const dir = process.argv[2];
const MAC = { '8030dcec7b0d': 'AERO', '5cf821ea7bf9': 'MOTH' };
for (const name of fs.readdirSync(dir).filter((f) => /\.(raw|ogg)$/.test(f)).sort()) {
  const mac = name.replace(/\.(raw|ogg)$/, '').split('-').pop();
  const robot = MAC[mac] || '?';
  const { pcm, decoder, error } = decode(path.join(dir, name));
  const tag = `${robot}/${name.endsWith('.ogg') ? 'ogg' : 'raw'}`;
  if (error) { console.log(`${tag.padEnd(11)} ${name.slice(4, 30).padEnd(27)} DECODE FAILED: ${error}`); continue; }
  const s = stats(pcm);
  if (!s) { console.log(`${tag.padEnd(11)} ${name.slice(4, 30).padEnd(27)} no PCM (${decoder})`); continue; }
  console.log(`${tag.padEnd(11)} ${name.slice(4, 30).padEnd(27)} ${String(s.durSec).padStart(6)}s rms ${String(s.rms).padStart(5)} dc ${String(s.dcOffset).padStart(5)} peak ${String(s.peak).padStart(6)} clip ${String(s.clippedPct).padStart(5)}% p10/p50/p90 ${s.p10}/${s.p50}/${s.p90} min ${s.minWindow}`);
}

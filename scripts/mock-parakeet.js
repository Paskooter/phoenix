#!/usr/bin/env node
// Dev stand-in for the Parakeet ASR host (the reference LAN host is gone).
// Speaks the same trivial REST contract the gateway uses:
//   POST /transcribe  (multipart/form-data, one WAV part)  ->  {"transcript": "..."}
//
// It can't do real speech-to-text — it returns a canned transcript — but it
// SAVES every received WAV to /tmp/parakeet-rx/ so you can listen to exactly
// what the browser-mic -> hub-bridge -> gateway-VAD pipeline captured and
// verify timing/level/quality before pointing the gateway at a real STT.
//
// Run:   node scripts/mock-parakeet.js
// Env:   PORT (default 6972)  MOCK_TRANSCRIPT (default "what time is it")
// Wire:  ETCO_server_parakeetUrl=http://localhost:6972 for the gateway.

import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 6972;
const TRANSCRIPT = process.env.MOCK_TRANSCRIPT || 'what time is it';
const RX_DIR = '/tmp/parakeet-rx';
mkdirSync(RX_DIR, { recursive: true });
let n = 0;

// Pull the first file part out of a multipart body: everything between the
// part's blank line and the next boundary marker.
function extractWav(body, contentType) {
  const m = /boundary=([^\s;]+)/.exec(contentType || '');
  if (!m) return body;                       // not multipart? take it raw
  const boundary = Buffer.from(`--${m[1]}`);
  const start = body.indexOf(boundary);
  if (start < 0) return body;
  const headEnd = body.indexOf('\r\n\r\n', start);
  if (headEnd < 0) return body;
  const dataStart = headEnd + 4;
  let dataEnd = body.indexOf(boundary, dataStart);
  if (dataEnd < 0) dataEnd = body.length;
  while (dataEnd > dataStart && (body[dataEnd - 1] === 0x0a || body[dataEnd - 1] === 0x0d)) dataEnd -= 1;
  return body.subarray(dataStart, dataEnd);
}

function wavStats(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return null;
  const sr = wav.readUInt32LE(24);
  const pcm = wav.subarray(44);
  const samples = pcm.length / 2;
  let sumSq = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const v = pcm.readInt16LE(i); sumSq += v * v; }
  return { sr, ms: Math.round(samples / sr * 1000), rms: Math.round(Math.sqrt(sumSq / Math.max(1, samples))) };
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && req.url.startsWith('/transcribe')) {
      const wav = extractWav(body, req.headers['content-type']);
      n += 1;
      const file = `${RX_DIR}/${String(n).padStart(3, '0')}-${Date.now()}.wav`;
      writeFileSync(file, wav);
      const s = wavStats(wav);
      console.log(`[mock-parakeet] #${n} ${wav.length} B${s ? ` ${s.sr} Hz ${s.ms} ms rms=${s.rms}` : ' (not RIFF?)'} -> ${file} -> "${TRANSCRIPT}"`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transcript: TRANSCRIPT }));
      return;
    }
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(`mock-parakeet: POST /transcribe -> "${TRANSCRIPT}" (WAVs saved to ${RX_DIR})\n`);
  });
}).listen(PORT, () => console.log(`[mock-parakeet] listening on :${PORT}; transcript="${TRANSCRIPT}"; WAVs -> ${RX_DIR}`));

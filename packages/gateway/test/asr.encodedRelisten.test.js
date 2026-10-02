import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';

const ffmpeg = process.env.PHOENIX_FFMPEG || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const silentLog = { info() {}, debug() {}, warn() {}, error() {} };
function timed(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Relisten timed out')), 3000);
  })]).finally(() => clearTimeout(timer));
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Relisten did not resume');
    await sleep(1);
  }
}

// Invented tones only: two utterances separated by an endpoint-length pause.
function audio() {
  const pauseMs = ASR_SILENCE_TO_EOS_MS + 300;
  const pcm = Buffer.alloc((500 + pauseMs + 600 + pauseMs) * 32);
  for (let i = 0; i < pcm.length / 2; i++) {
    const ms = i / 16;
    if (ms < 500 || (ms >= 500 + pauseMs && ms < 1100 + pauseMs)) {
      pcm.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI / 20)), i * 2);
    }
  }
  return pcm;
}
function encoded(encoding, pcm) {
  if (encoding === 'LINEAR16') return pcm;
  const codec = encoding === 'OGG_OPUS'
    ? ['-c:a', 'libopus', '-page_duration', '20000', '-f', 'ogg']
    : ['-c:a', 'flac', '-frame_size', '1600', '-f', 'flac'];
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1', '-i', 'pipe:0', ...codec, 'pipe:1'], { input: pcm });
  assert.equal(result.status, 0, result.stderr.toString());
  if (encoding !== 'OGG_OPUS') return result.stdout;
  // A listening microphone keeps its container open until ASR confirms EOS.
  let offset = 0;
  while (offset + 27 <= result.stdout.length) {
    if (result.stdout[offset + 5] & 4) return result.stdout.subarray(0, offset);
    const segments = result.stdout[offset + 26];
    let end = offset + 27 + segments;
    for (let i = offset + 27; i < offset + 27 + segments; i++) end += result.stdout[i];
    offset = end;
  }
  throw new Error('Synthetic Ogg fixture has no EOS page');
}

for (const [encoding, delivery] of ['LINEAR16', 'OGG_OPUS', 'FLAC'].flatMap(encoding => ['burst', 'stream'].map(delivery => [encoding, delivery]))) {
  test(`${encoding} ${delivery}: speech arriving during an empty recognition survives relistening`, { skip: encoding !== 'LINEAR16' && !available }, async t => {
    let firstResponse;
    let announceFirst;
    const firstRequest = new Promise(resolve => { announceFirst = resolve; });
    const waves = [];
    const server = http.createServer(async (req, res) => {
      if (req.url !== '/transcribe') { res.writeHead(404); res.end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const offset = body.indexOf('RIFF');
      waves.push(body.subarray(offset + 44, offset + 44 + body.readUInt32LE(offset + 40)));
      res.setHeader('content-type', 'application/json');
      if (waves.length === 1) { firstResponse = res; announceFirst(); }
      else res.end(JSON.stringify({ transcript: 'synthetic second utterance' }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const session = new ParakeetASRSession(`http://127.0.0.1:${server.address().port}`, { lang: 'en-US', encoding }, silentLog);
    t.after(() => { session.abort(); server.closeAllConnections(); server.close(); });
    let eos = 0;
    session.onEndOfSpeech(() => { eos++; });
    const result = session.start(); result.catch(() => {});
    const source = encoded(encoding, audio());
    let remaining;
    if (delivery === 'burst') session.provideAudio(source);
    else {
      let offset = 0;
      const chunkBytes = encoding === 'LINEAR16' ? 3200 : 127;
      while (!firstResponse && offset < source.length) {
        const end = Math.min(offset + chunkBytes, source.length);
        session.provideAudio(source.subarray(offset, end));
        offset = end;
        await sleep(1);
      }
      await timed(firstRequest);
      assert.ok(offset < source.length, 'the microphone is still supplying audio');
      const split = offset + Math.floor((source.length - offset) / 2);
      session.provideAudio(source.subarray(offset, split));
      remaining = source.subarray(split);
    }
    await timed(firstRequest);
    // Hold the empty recognition open while later microphone bytes arrive.
    await sleep(100);
    assert.equal(eos, 0);
    firstResponse.end(JSON.stringify({ transcript: '' }));
    if (remaining) {
      await timed(until(() => session.relistenCount === 1));
      session.provideAudio(remaining);
    }
    assert.equal((await timed(result)).text, 'synthetic second utterance');
    assert.equal(waves.length, 2);
    let speechMs = 0;
    for (let offset = 0; offset + 320 <= waves[1].length; offset += 320) {
      if (ParakeetASRSession.computeRMS(waves[1].subarray(offset, offset + 320)) > 1000) speechMs += 10;
    }
    assert.ok(speechMs >= 550, `the following 600 ms tone survives decoding: ${speechMs} ms retained`);
    assert.equal(eos, 1);
  });
}

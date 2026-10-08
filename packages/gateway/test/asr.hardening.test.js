// Synthetic PCM and loopback recognizers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createParakeetTransport } from '../src/asr/parakeetTransport.js';
import { createFailoverTransport } from '../src/asr/failoverTransport.js';
import { ParakeetASRSession, ASR_SILENCE_TO_EOS_MS } from '../src/asr/parakeetSession.js';
import {
  AUDIO_DECODER_LIMITS,
  AUDIO_ENCODINGS,
  AudioDecodeError,
  StreamingAudioDecoder,
} from '../src/asr/audioDecoder.js';
import { cleanHintsEOS, startSession } from '../src/asr/factory.js';
import { normalizeString } from '../src/stringNormalizer.js';
import {
  FLAC,
  FLAC_SHA256,
  fixturePcm,
  OGG_OPUS,
  OGG_OPUS_SHA256,
  RAW_PCM_SHA256,
} from './fixtures/asrEncoded.js';

const FFMPEG_AVAILABLE = spawnSync(process.env.PHOENIX_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// Synthetic 16 kHz 16-bit mono PCM: 100 ms = 3200 bytes (1600 samples).
function pcmChunk(amplitude, ms = 100) {
  const samples = Math.floor(16000 * ms / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE((i % 2 ? 1 : -1) * amplitude, i * 2);
  return buf;
}
const SILENCE = () => pcmChunk(0);
const SPEECH = () => pcmChunk(8000); // RMS 8000 >> 400 threshold

function mockParakeet(transcript) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // Only the batch recognition is a recognizer call; the session also probes
      // /healthz for a streaming endpoint, which this 0.1.0 stand-in lacks.
      if (req.method !== 'POST' || req.url !== '/transcribe') {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        srv._lastBody = body;
        srv._requests = (srv._requests || 0) + 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transcript }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

function wavPayload(body) {
  const offset = body.indexOf(Buffer.from('RIFF'));
  assert.ok(offset >= 0, 'multipart body contains a RIFF WAV');
  const dataSize = body.readUInt32LE(offset + 40);
  return body.subarray(offset + 44, offset + 44 + dataSize);
}

function rms(buf) {
  return ParakeetASRSession.computeRMS(buf);
}

function withTimeout(promise, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function endOfOggPage(buffer, offset = 0) {
  assert.equal(buffer.toString('ascii', offset, offset + 4), 'OggS');
  const segments = buffer[offset + 26];
  let bodyBytes = 0;
  for (let index = 0; index < segments; index += 1) bodyBytes += buffer[offset + 27 + index];
  return offset + 27 + segments + bodyBytes;
}

async function cleanupDecoder(decoder) {
  if (!decoder) return;
  decoder.abort();
  await decoder.nativeFlacChain?.catch(() => {});
}

async function cleanupSession(session, startPromise, server) {
  if (session && !session.stopped) session.stop();
  if (startPromise) await Promise.race([startPromise.catch(() => undefined), sleep(1000)]);
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** A deterministic Parakeet peer whose response is released by the test. */
async function heldParakeet(transcripts) {
  const remaining = [...transcripts];
  const requests = [];
  const requestSignals = [];
  const responseGates = [];
  const responseCloseSignals = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const index = requests.length;
    const record = { body: Buffer.concat(chunks), req, res };
    requests.push(record);
    requestSignals[index] ||= deferred();
    requestSignals[index].resolve(record);
    const responseGate = deferred();
    responseGates[index] = responseGate;
    const answer = remaining.length > 1 ? remaining.shift() : remaining[0];
    const responseClosed = deferred();
    responseCloseSignals[index] = responseClosed;
    res.once('close', () => responseClosed.resolve());
    await responseGate.promise;
    if (!res.destroyed) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ transcript: answer }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  server.requests = requests;
  server.waitForRequest = (index) => {
    if (requests[index]) return Promise.resolve(requests[index]);
    requestSignals[index] ||= deferred();
    return requestSignals[index].promise;
  };
  server.release = (index) => responseGates[index]?.resolve();
  server.responseClosed = (index) => {
    responseCloseSignals[index] ||= deferred();
    return responseCloseSignals[index].promise;
  };
  return server;
}

function encodeRawPcm(raw, format) {
  const codec = format === 'ogg' ? 'libopus' : 'flac';
  const result = spawnSync(process.env.PHOENIX_FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '16000', '-ac', '1',
    '-i', 'pipe:0', '-c:a', codec, '-f', format, 'pipe:1',
  ], { input: raw });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}


test('failover cancellation closes a held primary POST without a paid retry or health penalty', async () => {
  const peer = await heldParakeet(['never returned']);
  let secondaryCalls = 0;
  const healthFailures = [];
  const transport = createFailoverTransport({
    primary: createParakeetTransport(`http://127.0.0.1:${peer.address().port}`),
    secondary: { available: () => true, recognizeWav() { secondaryCalls += 1; return Promise.resolve({ text: 'late paid retry', confidence: 1 }); }, cancel() {} },
    health: { markDown: reason => healthFailures.push(reason) },
  });
  try {
    const work = transport.recognizeWav(ParakeetASRSession.makeWav(SPEECH()));
    const observed = work.catch(e => e);
    await withTimeout(peer.waitForRequest(0));
    const closed = withTimeout(peer.responseClosed(0));
    transport.cancel();
    await closed;
    assert.match((await observed).message, /abort/i);
    assert.equal(secondaryCalls, 0);
    assert.deepEqual(healthFailures, []);
    await assert.rejects(transport.recognizeWav(Buffer.alloc(44)), /abort/i);
  } finally {
    peer.release(0);
    peer.closeAllConnections();
    await new Promise(resolve => peer.close(resolve));
  }
});

test('empty silence candidates require fresh speech before another endpoint', async () => {
  const peer = await heldParakeet(['']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${peer.address().port}`, {}, console);
  const start = session.start();
  try {
    session.provideAudio(Buffer.concat([pcmChunk(8000, 300), pcmChunk(0, ASR_SILENCE_TO_EOS_MS)]));
    await withTimeout(peer.waitForRequest(0));
    peer.release(0);
    while (session.state === 'FINALIZING') await sleep(1);
    session.provideAudio(pcmChunk(0, ASR_SILENCE_TO_EOS_MS * 2));
    assert.equal(session.state, 'WAITING', 'silence alone must not submit another candidate');
    assert.equal(peer.requests.length, 1);
  } finally {
    session.abort();
    await start;
    peer.closeAllConnections();
    await new Promise(resolve => peer.close(resolve));
  }
});

test('empty Parakeet max-speech finalization returns a concrete annotated result', async () => {
  const session = new ParakeetASRSession('http://127.0.0.1:9', {}, console);
  const start = session.start();
  await session.finalizeNow();
  assert.deepEqual(await start, { text: '', confidence: 0, annotation: 'MAX_SPEECH_TIMEOUT' });
  session.abort();
});

test('decoder failure aborts a held Parakeet candidate request', async () => {
  const peer = await heldParakeet(['never returned']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${peer.address().port}`, {}, console);
  const start = session.start();
  const observed = start.catch(e => e);
  try {
    session.provideAudio(Buffer.concat([pcmChunk(8000, 300), pcmChunk(0, ASR_SILENCE_TO_EOS_MS)]));
    await withTimeout(peer.waitForRequest(0));
    const closed = withTimeout(peer.responseClosed(0));
    session._handleAudioError(new AudioDecodeError('synthetic decoder failure'));
    assert.equal((await observed).code, 'ERR_AUDIO_DECODE');
    await closed;
  } finally {
    session.abort();
    peer.release(0);
    peer.closeAllConnections();
    await new Promise(resolve => peer.close(resolve));
  }
});

test('VAD: a short request after the hotphrase tail is not ignored', async () => {
  const srv = await mockParakeet('short request');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, {
    lang: 'en-US', hotphrase: true,
  }, console);
  const startPr = session.start();
  try {
    // The first 200 ms burst is the wake tail. The second 100 ms burst is the
    // legitimate request and must be retained despite being shorter than SOS.
    session.provideAudio(Buffer.concat([
      SPEECH(), SPEECH(), ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, SILENCE),
      SPEECH(), ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, SILENCE),
    ]));
    assert.deepEqual(await withTimeout(startPr), { text: 'short request', confidence: 1.0 });
    assert.equal(srv._requests, 1, 'the wake tail is not posted as an utterance');
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('hotphrase continuous wake-tail plus a short first command is not discarded', async () => {
  const srv = await mockParakeet('no');
  const source = fixturePcm(); // 300 ms continuous speech, then 1 s silence
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, {
    lang: 'en-US', hotphrase: true, encoding: AUDIO_ENCODINGS.LINEAR16,
  }, console);
  const startPr = session.start();
  try {
    session.provideAudio(source);
    assert.deepEqual(await withTimeout(startPr), { text: 'no', confidence: 1.0 });
    assert.equal(srv._requests, 1, 'the combined wake-tail and command are recognized once');
    assert.deepEqual(wavPayload(srv._lastBody), source.subarray(0, (300 + ASR_SILENCE_TO_EOS_MS) * 32));
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('hotphrase does not discard a 250 ms continuous first utterance', async () => {
  const srv = await mockParakeet('no');
  const source = Buffer.concat([fixturePcm().subarray(0, 8000), Buffer.alloc(32000)]);
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, {
    lang: 'en-US', hotphrase: true, encoding: AUDIO_ENCODINGS.LINEAR16,
  }, console);
  const startPr = session.start();
  try {
    session.provideAudio(source);
    assert.deepEqual(await withTimeout(startPr), { text: 'no', confidence: 1.0 });
    assert.equal(srv._requests, 1, 'a continuous command shorter than 400 ms is still recognized');
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('hotphrase continuous short first command survives OGG and FLAC decoding', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required by the encoded hotphrase fixtures' }, async () => {
  const raw = fixturePcm(); // 300 ms continuous speech, then 1 s silence
  for (const [encoding, format] of [[AUDIO_ENCODINGS.OGG_OPUS, 'ogg'], [AUDIO_ENCODINGS.FLAC, 'flac']]) {
    const srv = await mockParakeet(`no-${encoding}`);
    const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, {
      lang: 'en-US', hotphrase: true, encoding,
    }, console);
    const startPr = session.start();
    try {
      const encoded = encodeRawPcm(raw, format);
      for (let offset = 0; offset < encoded.length;) {
        const size = Math.min(1 + ((offset * 19) % 127), encoded.length - offset);
        session.provideAudio(encoded.subarray(offset, offset + size));
        offset += size;
      }
      assert.deepEqual(await withTimeout(startPr), { text: `no-${encoding}`, confidence: 1.0 });
      assert.equal(srv._requests, 1, `${encoding}: the combined wake-tail and command are recognized once`);
      assert.ok(wavPayload(srv._lastBody).length >= 32000, `${encoding}: decoded speech is retained through the endpoint`);
    } finally {
      await cleanupSession(session, startPr, srv);
    }
  }
});

test('PCM in the same buffer as an empty endpoint is preserved for relisten', async () => {
  const parakeet = await heldParakeet(['', 'same-buffer request']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, SILENCE)]);
  let eos = 0;
  session.onEndOfSpeech(() => { eos += 1; });
  try {
    session.provideAudio(Buffer.concat([burst, burst]));
    const first = await withTimeout(parakeet.waitForRequest(0));
    assert.equal(eos, 0, 'an empty candidate does not emit wire EOS');
    assert.equal(wavPayload(first.body).length, burst.length);

    parakeet.release(0);
    const second = await withTimeout(parakeet.waitForRequest(1));
    assert.equal(eos, 0, 'wire EOS remains deferred until a candidate is accepted');
    assert.equal(wavPayload(second.body).length, burst.length);
    parakeet.release(1);

    assert.deepEqual(await withTimeout(startPr), { text: 'same-buffer request', confidence: 1.0 });
    assert.equal(eos, 1);
  } finally {
    if (!session.stopped) session.abort();
    for (let i = 0; i < 2; i += 1) parakeet.release(i);
    parakeet.closeAllConnections?.();
    await new Promise((resolve) => parakeet.close(resolve));
  }
});

test('PCM arriving while an empty candidate POST is held is preserved for relisten', async () => {
  const parakeet = await heldParakeet(['', 'held-response request']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, SILENCE)]);
  try {
    session.provideAudio(burst);
    await withTimeout(parakeet.waitForRequest(0));
    session.provideAudio(burst);
    assert.equal(parakeet.requests.length, 1, 'the second endpoint waits behind the held candidate');

    parakeet.release(0);
    await withTimeout(parakeet.waitForRequest(1));
    parakeet.release(1);
    assert.deepEqual(await withTimeout(startPr), { text: 'held-response request', confidence: 1.0 });
  } finally {
    if (!session.stopped) session.abort();
    for (let i = 0; i < 2; i += 1) parakeet.release(i);
    parakeet.closeAllConnections?.();
    await new Promise((resolve) => parakeet.close(resolve));
  }
});

test('encoded OGG and FLAC relisten keep their decoder alive across an empty candidate', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required to build the relisten fixtures' }, async () => {
  const raw = Buffer.concat([fixturePcm(), fixturePcm()]);
  for (const [encoding, format] of [[AUDIO_ENCODINGS.OGG_OPUS, 'ogg'], [AUDIO_ENCODINGS.FLAC, 'flac']]) {
    const parakeet = await heldParakeet(['', `encoded ${encoding}`]);
    const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US', encoding }, console);
    const startPr = session.start();
    try {
      session.provideAudio(encodeRawPcm(raw, format));
      await withTimeout(parakeet.waitForRequest(0));
      assert.ok(session.decoder, `${encoding}: decoder remains open while candidate response is held`);
      parakeet.release(0);
      await withTimeout(parakeet.waitForRequest(1));
      assert.ok(session.decoder, `${encoding}: relisten still has a live decoder`);
      parakeet.release(1);
      assert.deepEqual(await withTimeout(startPr), { text: `encoded ${encoding}`, confidence: 1.0 });
      assert.equal(session.decoder, null, `${encoding}: decoder closes only after the accepted result`);
    } finally {
      if (!session.stopped) session.abort();
      for (let i = 0; i < 2; i += 1) parakeet.release(i);
      parakeet.closeAllConnections?.();
      await new Promise((resolve) => parakeet.close(resolve));
    }
  }
});

test('abort destroys an in-flight Parakeet HTTP request', async () => {
  const parakeet = await heldParakeet(['never returned']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: Math.ceil(ASR_SILENCE_TO_EOS_MS / 100) }, SILENCE)]);
  try {
    session.provideAudio(burst);
    await withTimeout(parakeet.waitForRequest(0));
    const responseClosed = withTimeout(parakeet.responseClosed(0));
    session.abort();
    assert.equal(await withTimeout(startPr), undefined);
    await responseClosed;
  } finally {
    parakeet.release(0);
    parakeet.closeAllConnections?.();
    await new Promise((resolve) => parakeet.close(resolve));
  }
});

test('decoder error before session start rejects the later start promise', async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'OGG_OPUS' }, console);
  session.provideAudio(Buffer.alloc(AUDIO_DECODER_LIMITS.maxPendingInputBytes + 1));
  const startPr = session.start();
  await assert.rejects(withTimeout(startPr), (err) => err.code === 'ERR_AUDIO_DECODE' && /input queue exceeded/.test(err.message));
});


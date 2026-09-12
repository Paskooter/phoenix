import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { ParakeetASRSession } from '../src/asr/parakeetSession.js';
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

test('VAD: SOS after 150ms speech, EOS after 700ms silence, transcript via mock', async () => {
  const srv = await mockParakeet('what time is it');
  const url = `http://localhost:${srv.address().port}`;
  const session = new ParakeetASRSession(url, { lang: 'en-US' }, console);
  let sos = 0; let eos = 0;
  session.onStartOfSpeech(() => { sos += 1; });
  session.onEndOfSpeech(() => { eos += 1; });
  const startPr = session.start();
  try {
    session.provideAudio(SILENCE());            // 100ms silence: no SOS
    assert.equal(sos, 0);
    session.provideAudio(SPEECH());             // 100ms speech (<150ms cumulative)
    assert.equal(sos, 0, 'SOS needs >=150ms cumulative speech');
    session.provideAudio(SPEECH());             // 200ms cumulative -> SOS
    assert.equal(sos, 1);
    for (let i = 0; i < 6; i += 1) session.provideAudio(SILENCE()); // 600ms silence: no EOS yet
    assert.equal(eos, 0);
    session.provideAudio(SILENCE());            // 700ms -> recognition candidate (wire EOS waits)
    assert.equal(eos, 0);

    const result = await withTimeout(startPr);
    assert.equal(eos, 1, 'EOS is emitted only when the candidate is accepted');
    assert.equal(result.text, 'what time is it');
    assert.equal(result.confidence, 1.0);
    // the POSTed body is a WAV: RIFF header + all buffered PCM
    assert.equal(srv._lastBody.includes('audio.wav'), true);
  } finally {
    await cleanupSession(session, startPr, srv);
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
      SPEECH(), SPEECH(), ...Array.from({ length: 7 }, SILENCE),
      SPEECH(), ...Array.from({ length: 7 }, SILENCE),
    ]));
    assert.deepEqual(await withTimeout(startPr), { text: 'short request', confidence: 1.0 });
    assert.equal(srv._requests, 1, 'the wake tail is not posted as an utterance');
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('VAD: stop() before SOS resolves start() with undefined', async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US' }, console);
  const startPr = session.start();
  session.provideAudio(SILENCE());
  session.stop();
  assert.equal(await withTimeout(startPr), undefined);
});

test('WAV header: 44-byte RIFF, 16kHz mono 16-bit', () => {
  const wav = ParakeetASRSession.makeWav(Buffer.alloc(3200));
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);   // sample rate
  assert.equal(wav.readUInt16LE(22), 1);       // mono
  assert.equal(wav.readUInt16LE(34), 16);      // bits/sample
  assert.equal(wav.readUInt32LE(40), 3200);    // data size
});

test('LINEAR16 remains byte-for-byte PCM across odd network fragment boundaries', async () => {
  const srv = await mockParakeet('linear16');
  const source = Buffer.concat([SPEECH(), SPEECH()]);
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US', encoding: 'LINEAR16' }, console);
  const startPr = session.start();
  try {
    let offset = 0;
    for (const size of [1, 3, 17, 511, 2, 4097]) {
      if (offset >= source.length) break;
      const end = Math.min(source.length, offset + size);
      session.provideAudio(source.subarray(offset, end));
      offset = end;
    }
    if (offset < source.length) session.provideAudio(source.subarray(offset));
    session.stop();
    assert.equal((await withTimeout(startPr)).text, 'linear16');
    assert.deepEqual(wavPayload(srv._lastBody), source);
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('LINEAR16 rejects an odd final PCM byte instead of wrapping invalid WAV', async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'LINEAR16' }, console);
  const startPr = session.start();
  session.provideAudio(SPEECH());
  session.provideAudio(SPEECH());
  session.provideAudio(Buffer.from([0x7f]));
  session.stop();
  await assert.rejects(withTimeout(startPr), (err) => err.code === 'ERR_AUDIO_FORMAT' && /odd byte boundary/.test(err.message));
  assert.equal(session.state, 'DONE');
});

test('LINEAR16 stop preserves an even final partial VAD window', async () => {
  const srv = await mockParakeet('partial-stop');
  const source = Buffer.concat([SPEECH(), SPEECH(), Buffer.alloc(160)]);
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US', encoding: 'LINEAR16' }, console);
  const startPr = session.start();
  try {
    session.provideAudio(source);
    session.stop();
    assert.equal((await withTimeout(startPr)).text, 'partial-stop');
    assert.deepEqual(wavPayload(srv._lastBody), source);
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('VAD and EOS are invariant across PCM chunk boundaries', async () => {
  const source = Buffer.concat([
    SPEECH(), SPEECH(), SPEECH(),
    ...Array.from({ length: 10 }, () => SILENCE()),
  ]);
  const expectedPcm = source.subarray(0, 32000); // 300 ms speech + 700 ms silence
  const arbitrary = [];
  let offset = 0;
  const sizes = [1, 3, 17, 511, 2, 4097];
  for (let index = 0; offset < source.length; index += 1) {
    const size = Math.min(sizes[index % sizes.length], source.length - offset);
    arbitrary.push(source.subarray(offset, offset + size));
    offset += size;
  }
  const native50ms = Array.from({ length: source.length / 1600 }, (_, index) => source.subarray(index * 1600, (index + 1) * 1600));

  const run = async (chunks) => {
    const srv = await mockParakeet('pcm-equivalent');
    const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US' }, console);
    let sos = 0;
    let eos = 0;
    session.onStartOfSpeech(() => { sos += 1; });
    session.onEndOfSpeech(() => { eos += 1; });
    const startPr = session.start();
    try {
      for (const chunk of chunks) session.provideAudio(chunk);
      const result = await withTimeout(startPr);
      return { result, sos, eos, pcm: wavPayload(srv._lastBody) };
    } finally {
      await cleanupSession(session, startPr, srv);
    }
  };

  const results = await Promise.all([run([source]), run(native50ms), run(arbitrary)]);
  for (const result of results) {
    assert.deepEqual(result.result, { text: 'pcm-equivalent', confidence: 1.0 });
    assert.equal(result.sos, 1);
    assert.equal(result.eos, 1);
    assert.deepEqual(result.pcm, expectedPcm);
  }
});

test('encoded fixtures preserve VAD events and PCM cut across decoder chunking', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required by the audio decoder candidate' }, async () => {
  const makeChunks = (source) => {
    const chunks = [];
    let offset = 0;
    const sizes = [1, 3, 17, 511, 2, 4097];
    for (let index = 0; offset < source.length; index += 1) {
      const size = Math.min(sizes[index % sizes.length], source.length - offset);
      chunks.push(source.subarray(offset, offset + size));
      offset += size;
    }
    return chunks;
  };
  const run = async (encoding, source, chunks) => {
    const srv = await mockParakeet(`encoded-${encoding}`);
    const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US', encoding }, console);
    let sos = 0;
    let eos = 0;
    session.onStartOfSpeech(() => { sos += 1; });
    session.onEndOfSpeech(() => { eos += 1; });
    const startPr = session.start();
    try {
      for (const chunk of chunks) session.provideAudio(chunk);
      const result = await withTimeout(startPr);
      return { result, sos, eos, pcm: wavPayload(srv._lastBody) };
    } finally {
      await cleanupSession(session, startPr, srv);
    }
  };

  for (const [encoding, source] of [[AUDIO_ENCODINGS.OGG_OPUS, OGG_OPUS], [AUDIO_ENCODINGS.FLAC, FLAC]]) {
    const large = await run(encoding, source, [source]);
    const split = await run(encoding, source, makeChunks(source));
    assert.deepEqual(large.result, split.result);
    assert.equal(large.sos, 1);
    assert.equal(split.sos, 1);
    assert.equal(large.eos, 1);
    assert.equal(split.eos, 1);
    assert.deepEqual(large.pcm, split.pcm);
  }
});

test('PCM in the same buffer as an empty endpoint is preserved for relisten', async () => {
  const parakeet = await heldParakeet(['', 'same-buffer request']);
  const session = new ParakeetASRSession(`http://127.0.0.1:${parakeet.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: 7 }, SILENCE)]);
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
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: 7 }, SILENCE)]);
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
  const burst = Buffer.concat([SPEECH(), SPEECH(), ...Array.from({ length: 7 }, SILENCE)]);
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

test('max-buffer EOS cuts a large PCM chunk at the 30-second boundary', async () => {
  const srv = await mockParakeet('max-buffer');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US' }, console);
  const startPr = session.start();
  try {
    session.provideAudio(Buffer.alloc(960000 + 3200));
    const result = await withTimeout(startPr);
    assert.deepEqual(result, { text: 'max-buffer', confidence: 1.0 });
    assert.equal(wavPayload(srv._lastBody).length, 960000);
    assert.equal(session.finalizeReason, 'max-buffer');
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('declared audio formats are validated before a provider session starts', () => {
  assert.throws(() => new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'AMR' }), /Unsupported ASR audio encoding/);
  assert.throws(() => new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'FLAC', sampleRate: 8000 }), /requires 16000/);
});

test('decoder error before session start rejects the later start promise', async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'OGG_OPUS' }, console);
  session.provideAudio(Buffer.alloc(AUDIO_DECODER_LIMITS.maxPendingInputBytes + 1));
  const startPr = session.start();
  await assert.rejects(withTimeout(startPr), (err) => err.code === 'ERR_AUDIO_DECODE' && /input queue exceeded/.test(err.message));
});

test('bounded decoder queue rejects input without buffering a whole turn', async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.OGG_OPUS, log: { error() {} } });
  try {
    assert.throws(() => decoder.write(Buffer.alloc(AUDIO_DECODER_LIMITS.maxPendingInputBytes + 1)), AudioDecodeError);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('missing ffmpeg is an explicit runtime decoder error', async () => {
  const session = new ParakeetASRSession('http://localhost:9', {
    lang: 'en-US', encoding: 'OGG_OPUS', ffmpegPath: '/phoenix-test/no-such-ffmpeg',
  }, { error() {} });
  const startPr = session.start();
  try {
    await assert.rejects(withTimeout(startPr), (err) => err.code === 'ERR_AUDIO_DECODE' && /was not found/.test(err.message));
    assert.equal(session.decoder, null);
  } finally {
    await cleanupSession(session, startPr);
  }
});

test('decoder rejects empty or truncated FLAC streams at end-of-input', async () => {
  const cases = [
    { name: 'empty', bytes: Buffer.alloc(0), message: /Empty FLAC stream/ },
    { name: 'marker only', bytes: Buffer.from('fLaC'), message: /Truncated FLAC metadata/ },
    { name: 'metadata only', bytes: FLAC.subarray(0, 92), message: /no audio frames/ },
  ];
  for (const item of cases) {
    const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.FLAC, log: { error() {} } });
    decoder.start();
    try {
      if (item.bytes.length > 0) decoder.write(item.bytes);
      await assert.rejects(withTimeout(decoder.finish()), item.message, item.name);
      assert.equal(decoder.finishResolve, null, `${item.name}: finish resolve cleared`);
      assert.equal(decoder.finishReject, null, `${item.name}: finish reject cleared`);
      assert.equal(decoder.child, null, `${item.name}: no child leaked`);
      assert.equal(decoder.nativeFlacDecoder, null, `${item.name}: native decoder released`);
    } finally {
      await cleanupDecoder(decoder);
    }
  }
});

test('decoder finish followed by abort settles without a dangling OGG promise', async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.OGG_OPUS, log: { error() {} } });
  decoder.start();
  const finish = decoder.finish();
  decoder.abort();
  try {
    await assert.rejects(withTimeout(finish), (err) => err.code === 'ERR_AUDIO_DECODE' && /aborted/.test(err.message));
    assert.equal(decoder.child, null);
    assert.equal(decoder.finishResolve, null);
    assert.equal(decoder.finishReject, null);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('OGG finish rejects a prefix that ffmpeg decodes without an EOS page', async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.OGG_OPUS, log: { error() {} } });
  decoder.start();
  try {
    decoder.write(OGG_OPUS.subarray(0, -28));
    await assert.rejects(withTimeout(decoder.finish()), (err) => err.code === 'ERR_AUDIO_DECODE' && /Truncated OGG page/.test(err.message));
    assert.equal(decoder.child, null);
    assert.equal(decoder.queuedBytes, 0);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('explicit OGG end-of-input accepts decoded audio before a missing EOS page', async () => {
  const decoded = [];
  const decoder = new StreamingAudioDecoder({
    encoding: AUDIO_ENCODINGS.OGG_OPUS,
    onPcm: (chunk) => decoded.push(chunk),
    log: { error() {} },
  });
  decoder.start();
  try {
    decoder.write(OGG_OPUS.subarray(0, -28));
    await withTimeout(decoder.finish({ allowTruncated: true }));
    assert.ok(Buffer.concat(decoded).length > 0);
    assert.equal(decoder.child, null);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('decoder bounds include an active FLAC frame and clean up on overflow', async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.FLAC, log: { error() {} } });
  decoder.start();
  // Native decode work is queued independently of the parser; the bound must
  // include bytes waiting for that persistent decoder.
  try {
    decoder.write(FLAC.subarray(0, 458));
    assert.ok(decoder.nativeFlacPendingBytes > 0);
    assert.throws(() => decoder.write(Buffer.alloc(AUDIO_DECODER_LIMITS.maxPendingInputBytes)), AudioDecodeError);
    assert.equal(decoder.child, null);
    assert.equal(decoder.nativeFlacDecoder, null);
    assert.equal(decoder.nativeFlacPendingBytes, 0);
    await decoder.nativeFlacChain;
    assert.equal(decoder.nativeFlacPendingBytes, 0);
    assert.equal(decoder.nativeFlacDecoder, null);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('decoder reports a missing process and clears its child without a pending finish', async () => {
  const decoder = new StreamingAudioDecoder({
    encoding: AUDIO_ENCODINGS.OGG_OPUS,
    ffmpegPath: '/phoenix-test/no-such-ffmpeg',
    log: { error() {} },
  });
  decoder.start();
  const finish = decoder.finish();
  try {
    await assert.rejects(withTimeout(finish), (err) => err.code === 'ERR_AUDIO_DECODE' && /was not found/.test(err.message));
    assert.equal(decoder.child, null);
    assert.equal(decoder.finishResolve, null);
    assert.equal(decoder.finishReject, null);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('OGG decoder emits PCM before the paced source reaches EOF', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required by the audio decoder candidate' }, async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.OGG_OPUS, log: { error() {} } });
  decoder.start();
  // Stop after the complete audio page and hold the EOS page back. This keeps
  // the assertion independent of whether ffmpeg delivers stdout in the same
  // turn as the next 64-byte write.
  const audioPageEnd = OGG_OPUS.length - 91;
  let fed = 0;
  let bytesAtPcm = null;
  const pcm = withTimeout(new Promise((resolve, reject) => {
    decoder.on('pcm', (chunk) => {
      if (chunk.length > 0 && bytesAtPcm === null) {
        bytesAtPcm = fed;
        resolve(chunk);
      }
    });
    decoder.once('error', reject);
  }));
  try {
    while (fed < audioPageEnd && bytesAtPcm === null) {
      const size = Math.min(64, audioPageEnd - fed);
      decoder.write(OGG_OPUS.subarray(fed, fed + size));
      fed += size;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await pcm;
    assert.ok(bytesAtPcm <= audioPageEnd, `PCM arrived after ${bytesAtPcm}/${audioPageEnd} audio-page bytes`);
    assert.equal(decoder.queuedBytes, 0);
  } finally {
    decoder.abort();
  }
});

test('FLAC decoder emits PCM before the paced source reaches EOF', async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.FLAC, log: { error() {} } });
  decoder.start();
  let fed = 0;
  let bytesAtPcm = null;
  const pcm = withTimeout(new Promise((resolve, reject) => {
    decoder.on('pcm', (chunk) => {
      if (chunk.length > 0 && bytesAtPcm === null) {
        bytesAtPcm = fed;
        resolve(chunk);
      }
    });
    decoder.once('error', reject);
  }));
  try {
    while (fed < FLAC.length - 100 && bytesAtPcm === null) {
      const size = Math.min(17, FLAC.length - 100 - fed);
      decoder.write(FLAC.subarray(fed, fed + size));
      fed += size;
      await sleep(10);
    }
    await pcm;
    assert.ok(bytesAtPcm < FLAC.length - 100, `PCM arrived after ${bytesAtPcm}/${FLAC.length} source bytes`);
    assert.equal(decoder.nativeFlacPendingBytes, 0);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('paced OGG input can reach SOS before the source reaches EOF', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required by the audio decoder candidate' }, async () => {
  const srv = await mockParakeet('paced-ogg');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, {
    lang: 'en-US', encoding: 'OGG_OPUS',
  }, { error() {}, debug() {} });
  const startPr = session.start();
  let fed = 0;
  let resolveSOS;
  const sos = new Promise((resolve) => { resolveSOS = resolve; });
  session.onStartOfSpeech(() => resolveSOS(fed));
  const audioPageEnd = OGG_OPUS.length - 91;
  try {
    while (fed < audioPageEnd && !session.sosFired) {
      const size = Math.min(64, audioPageEnd - fed);
      session.provideAudio(OGG_OPUS.subarray(fed, fed + size));
      fed += size;
      await sleep(10);
    }
    const bytesAtSOS = await withTimeout(sos);
    assert.ok(bytesAtSOS <= audioPageEnd, `SOS arrived after ${bytesAtSOS}/${audioPageEnd} audio-page bytes`);
    session.stop();
    assert.equal((await withTimeout(startPr)).text, 'paced-ogg');
    assert.equal(session.decoder, null);
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('paced FLAC input can reach SOS before the source reaches EOF', async () => {
  const srv = await mockParakeet('paced-flac');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, {
    lang: 'en-US', encoding: 'FLAC',
  }, { error() {}, debug() {} });
  const startPr = session.start();
  let fed = 0;
  let resolveSOS;
  const sos = new Promise((resolve) => { resolveSOS = resolve; });
  session.onStartOfSpeech(() => resolveSOS(fed));
  try {
    while (fed < FLAC.length - 100 && !session.sosFired) {
      const size = Math.min(17, FLAC.length - 100 - fed);
      session.provideAudio(FLAC.subarray(fed, fed + size));
      fed += size;
      await sleep(10);
    }
    const bytesAtSOS = await withTimeout(sos);
    assert.ok(bytesAtSOS < FLAC.length - 100, `SOS arrived after ${bytesAtSOS}/${FLAC.length} source bytes`);
    session.stop();
    assert.equal((await withTimeout(startPr)).text, 'paced-flac');
    assert.equal(session.decoder, null);
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('OGG_OPUS is decoded before VAD and WAV wrapping across fragmented frames', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required by the audio decoder candidate' }, async () => {
  assert.equal(createHash('sha256').update(OGG_OPUS).digest('hex'), OGG_OPUS_SHA256);
  assert.equal(createHash('sha256').update(fixturePcm()).digest('hex'), RAW_PCM_SHA256);
  const srv = await mockParakeet('ogg');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US', encoding: 'OGG_OPUS' }, console);
  const startPr = session.start();
  try {
    for (let offset = 0; offset < OGG_OPUS.length;) {
      const size = Math.min(1 + ((offset * 13) % 97), OGG_OPUS.length - offset);
      session.provideAudio(OGG_OPUS.subarray(offset, offset + size));
      offset += size;
    }
    assert.equal((await withTimeout(startPr)).text, 'ogg');
    const decoded = wavPayload(srv._lastBody);
    assert.ok(decoded.length >= 32000, `decoded PCM length ${decoded.length}`);
    assert.ok(rms(decoded.subarray(0, 3200)) > 400, 'speech reaches VAD as PCM');
    assert.ok(rms(decoded.subarray(decoded.length - 6400)) < 400, 'trailing silence reaches VAD as PCM');
    assert.equal(session.decoder, null, 'decoder child is cleaned up after EOS');
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('FLAC frames are decoded incrementally before VAD despite fragmented input', async () => {
  assert.equal(createHash('sha256').update(FLAC).digest('hex'), FLAC_SHA256);
  const srv = await mockParakeet('flac');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US', encoding: 'FLAC' }, console);
  const startPr = session.start();
  try {
    for (let offset = 0; offset < FLAC.length;) {
      const size = Math.min(1 + ((offset * 17) % 113), FLAC.length - offset);
      session.provideAudio(FLAC.subarray(offset, offset + size));
      offset += size;
    }
    assert.equal((await withTimeout(startPr)).text, 'flac');
    const decoded = wavPayload(srv._lastBody);
    assert.ok(decoded.length >= 32000, `decoded PCM length ${decoded.length}`);
    assert.ok(rms(decoded.subarray(0, 3200)) > 400, 'speech reaches VAD as PCM');
    assert.ok(rms(decoded.subarray(decoded.length - 6400)) < 400, 'trailing silence reaches VAD as PCM');
    assert.equal(session.decoder, null, 'decoder children are cleaned up after EOS');
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('FLAC decoded waveform matches the immutable lossless fixture', async () => {
  const decoded = [];
  const decoder = new StreamingAudioDecoder({
    encoding: AUDIO_ENCODINGS.FLAC,
    onPcm: (chunk) => decoded.push(chunk),
    log: { error() {} },
  });
  decoder.start();
  try {
    for (let offset = 0; offset < FLAC.length; offset += 17) decoder.write(FLAC.subarray(offset, offset + 17));
    await withTimeout(decoder.finish());
    assert.deepEqual(Buffer.concat(decoded), fixturePcm());
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('FLAC surfaces a native decoder error even when it decoded no PCM', async () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.FLAC, log: { error() {} } });
  decoder.start();
  try {
    decoder.write(FLAC);
    // Keep the real persistent decoder/lifecycle, but make its next native
    // result deterministic so this regression covers the zero-sample error
    // shape returned by the WASM package.
    decoder.nativeFlacDecoder.decode = async () => ({
      samplesDecoded: 0,
      errors: [{ message: 'corrupt FLAC frame' }],
    });
    await assert.rejects(withTimeout(decoder.finish()), (err) => (
      err.code === 'ERR_AUDIO_DECODE' && /corrupt FLAC frame/.test(err.message)
    ));
    assert.equal(decoder.nativeFlacDecoder, null);
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('FLAC rejects an oversized native chunk before allocating PCM', () => {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.FLAC, log: { error() {} } });
  assert.throws(() => decoder._emitNativeFlac({
    samplesDecoded: (4 * 1024 * 1024 / 2) + 1,
    sampleRate: 16000,
    channelData: [[]],
    bitDepth: 16,
  }), (err) => err.code === 'ERR_AUDIO_DECODE' && /exceeded 4194304 bytes/.test(err.message));
  decoder.abort();
});

test('FLAC accepts every single-byte split across metadata and frame headers', async () => {
  const decoded = [];
  const decoder = new StreamingAudioDecoder({
    encoding: AUDIO_ENCODINGS.FLAC,
    onPcm: (chunk) => decoded.push(chunk),
    log: { error() {} },
  });
  decoder.start();
  try {
    for (let offset = 0; offset < FLAC.length; offset += 1) {
      decoder.write(FLAC.subarray(offset, offset + 1));
    }
    await withTimeout(decoder.finish());
    assert.deepEqual(Buffer.concat(decoded), fixturePcm());
  } finally {
    await cleanupDecoder(decoder);
  }
});

test('malformed declared audio rejects the session with a decoder error', async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'FLAC' }, console);
  const startPr = session.start();
  try {
    session.provideAudio(Buffer.from('not a flac stream'));
    await assert.rejects(withTimeout(startPr), (err) => err.code === 'ERR_AUDIO_DECODE' && /fLaC marker/.test(err.message));
    assert.equal(session.decoder, null);
  } finally {
    await cleanupSession(session, startPr);
  }
});

test('encoded session cancellation aborts decoder resources before SOS', { skip: !FFMPEG_AVAILABLE && 'ffmpeg is required by the audio decoder candidate' }, async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US', encoding: 'OGG_OPUS' }, console);
  const startPr = session.start();
  try {
    session.provideAudio(OGG_OPUS.subarray(0, 32));
    session.stop();
    assert.equal(await withTimeout(startPr), undefined);
    assert.equal(session.decoder, null);
  } finally {
    await cleanupSession(session, startPr);
  }
});

test('encoded session cancellation after SOS closes decoder without waiting for encoded EOS', async () => {
  const srv = await mockParakeet('cancelled');
  const session = new ParakeetASRSession(`http://localhost:${srv.address().port}`, { lang: 'en-US', encoding: 'FLAC' }, console);
  const startPr = session.start();
  let sawSOS;
  const sosPr = new Promise((resolve) => { sawSOS = resolve; });
  session.onStartOfSpeech(sawSOS);
  try {
    // Queue a second encoded fragment before the first decode resolves. stop()
    // must drain that accepted fragment into the WAV.
    session.provideAudio(FLAC.subarray(0, 900));
    session.provideAudio(FLAC.subarray(900, 1164));
    await withTimeout(sosPr);
    const bytesAtSOS = session.chunks.reduce((total, chunk) => total + chunk.length, 0);
    session.stop();
    assert.equal((await withTimeout(startPr)).text, 'cancelled');
    assert.ok(wavPayload(srv._lastBody).length > bytesAtSOS, 'stop drains decoded PCM already accepted by the decoder');
    assert.equal(session.decoder, null);
  } finally {
    await cleanupSession(session, startPr, srv);
  }
});

test('hints: $YESNO expands, unknown templates drop, global "jibo" appends, deduped', () => {
  const out = cleanHintsEOS(['$YESNO', '$BOGUS', 'time', 'time'], true);
  assert.ok(out.includes('yes') && out.includes('nope') && out.includes('sure'));
  assert.ok(!out.includes('$BOGUS') && !out.includes('$YESNO'));
  assert.ok(out.includes('jibo'));
  assert.equal(out.filter((w) => w === 'time').length, 1);
});

test('factory: non-English languages throw (reference gate)', () => {
  assert.throws(() => startSession({ lang: 'fr-FR' }, console), /Unsupported ASR language/);
});

test('normalizeString: smart quotes/dashes -> ascii; non-strings -> ""', () => {
  assert.equal(normalizeString('what’s up — ok'), "what's up - ok");
  assert.equal(normalizeString(42), '');
  assert.equal(normalizeString('a  b   c'), 'a b c');
});

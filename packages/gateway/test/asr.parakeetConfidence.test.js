// The ASR confidence the robot receives must come from the recognizer when the
// recognizer supplies one.
//
// DIVERGENCES H07c: this client used to report `confidence: 1.0` for any
// non-empty transcript. NeMo leaves every confidence field null unless the
// decoding config asks for them, so the deployed 0.1.0 server had none to give
// and the constant was invented here — and reached the robot in
// LISTEN.data.asr.confidence looking like a measurement. The original reported
// Google's real per-utterance value and ranked interim results by it
// (GoogleASRSession.ts:125,129).
//
// services/parakeet-asr serves a real value; older deployments do not. Both
// must work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ParakeetASRSession } from '../src/asr/parakeetSession.js';

const SILENT_LOG = { debug() {}, info() {}, warn() {}, error() {} };

/** A Parakeet stand-in that answers with whatever body the test supplies. */
async function withServer(body, run) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function speech(ms = 1200) {
  // Loud enough to pass the session's VAD, or nothing is ever transcribed.
  const samples = Math.round(16000 * (ms / 1000));
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(i % 2 ? 9000 : -9000, i * 2);
  return pcm;
}

async function transcribe(url) {
  const session = new ParakeetASRSession(url, { lang: 'en-US' }, SILENT_LOG);
  const started = session.start();
  const pcm = speech();
  for (let i = 0; i < pcm.length; i += 3200) session.provideAudio(pcm.slice(i, i + 3200));
  await session.finalizeNow();
  void started;
  return session.getLastIncremental();
}

test('a server-reported confidence is passed through, not overwritten', async () => {
  const result = await withServer(
    { transcript: { text: 'testing testing one two three' }, confidence: 0.93 },
    transcribe,
  );
  assert.equal(result.text, 'testing testing one two three');
  assert.equal(result.confidence, 0.93);
});

test('confidence nested in the hypothesis is also honoured', async () => {
  const result = await withServer(
    { transcript: { text: 'hello', confidence: 0.42 } },
    transcribe,
  );
  assert.equal(result.confidence, 0.42);
});

test('a 0.1.0 server with no confidence still works, via the synthetic fallback', async () => {
  // The exact shape the deployed server returns: a dumped NeMo hypothesis whose
  // confidence fields are all null.
  const result = await withServer(
    {
      filename: 'a.wav',
      transcript: {
        score: 396.3960266113281,
        text: 'testing testing one two three',
        frame_confidence: null,
        token_confidence: null,
        word_confidence: null,
      },
    },
    transcribe,
  );
  assert.equal(result.text, 'testing testing one two three');
  assert.equal(result.confidence, 1.0);
});

test('a genuine zero confidence is not mistaken for "absent"', async () => {
  // `0` is falsy; a null-coalescing slip here would silently replace a real
  // zero with the synthetic 1.0 and invert the meaning.
  const result = await withServer(
    { transcript: { text: 'mumble' }, confidence: 0 },
    transcribe,
  );
  assert.equal(result.confidence, 0);
});

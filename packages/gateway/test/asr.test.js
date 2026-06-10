import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ParakeetASRSession } from '../src/asr/parakeetSession.js';
import { cleanHintsEOS, startSession } from '../src/asr/factory.js';
import { normalizeString } from '../src/stringNormalizer.js';

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
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ transcript }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

test('VAD: SOS after 150ms speech, EOS after 700ms silence, transcript via mock', async () => {
  const srv = await mockParakeet('what time is it');
  const url = `http://localhost:${srv.address().port}`;
  const session = new ParakeetASRSession(url, { lang: 'en-US' }, console);
  let sos = 0; let eos = 0;
  session.onStartOfSpeech(() => { sos += 1; });
  session.onEndOfSpeech(() => { eos += 1; });
  const startPr = session.start();

  session.provideAudio(SILENCE());            // 100ms silence: no SOS
  assert.equal(sos, 0);
  session.provideAudio(SPEECH());             // 100ms speech (<150ms cumulative)
  assert.equal(sos, 0, 'SOS needs >=150ms cumulative speech');
  session.provideAudio(SPEECH());             // 200ms cumulative -> SOS
  assert.equal(sos, 1);
  for (let i = 0; i < 6; i += 1) session.provideAudio(SILENCE()); // 600ms silence: no EOS yet
  assert.equal(eos, 0);
  session.provideAudio(SILENCE());            // 700ms -> EOS + finalize
  assert.equal(eos, 1);

  const result = await startPr;
  assert.equal(result.text, 'what time is it');
  assert.equal(result.confidence, 1.0);
  // the POSTed body is a WAV: RIFF header + all buffered PCM
  assert.equal(srv._lastBody.includes('audio.wav'), true);
  srv.close();
});

test('VAD: stop() before SOS resolves start() with undefined', async () => {
  const session = new ParakeetASRSession('http://localhost:9', { lang: 'en-US' }, console);
  const startPr = session.start();
  session.provideAudio(SILENCE());
  session.stop();
  assert.equal(await startPr, undefined);
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

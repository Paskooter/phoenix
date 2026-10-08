// Request serialization and adapter ownership only: never initialize a real RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  buildRecognitionConfig, buildStreamingRequest, buildRecognizeRequest,
  createGoogleSpeechClient, googleModelLocationSupported,
} from '../src/asr/googleSpeech.js';

test('official V2 adapter sends the raw first request, bounded calls without retries, and closes once', async () => {
  const writes = []; const seen = {}; const response = { results: [] };
  class SpeechClient {
    constructor(options) { seen.options = options; }
    async initialize() { seen.initialized = true; }
    _streamingRecognize(options) { seen.streamOptions = options; return { write: (r) => writes.push(r) }; }
    async recognize(request, options) { seen.batch = { request, options }; return [response]; }
    async close() { seen.closed = (seen.closed || 0) + 1; }
  }
  const client = await createGoogleSpeechClient({ projectId: 'synthetic-project', location: 'eu',
    credentialsFile: '/synthetic/not-read.json', importer: async (name) => {
      assert.equal(name, '@google-cloud/speech'); return { v2: { SpeechClient } };
    } });
  const config = buildRecognitionConfig({ model: 'chirp_3', hints: ['jibo'], lang: 'en-CA', denoise: true });
  const first = buildStreamingRequest({ recognizer: 'projects/synthetic-project/locations/eu/recognizers/_', config });
  const stream = client.streamingRecognize(first);
  stream.write({ audio: Buffer.alloc(6400) });
  assert.deepEqual(seen.options, { projectId: 'synthetic-project', apiEndpoint: 'eu-speech.googleapis.com', keyFilename: '/synthetic/not-read.json' });
  assert.deepEqual(seen.streamOptions, { timeout: 45000 });
  assert.equal(seen.initialized, true);
  assert.equal(writes[0], first); assert.deepEqual(Object.keys(writes[1]), ['audio']);
  const batch = buildRecognizeRequest({ recognizer: first.recognizer, config, content: Buffer.alloc(3200) });
  assert.equal(await client.recognize(batch, { timeoutMs: 10000 }), response);
  assert.deepEqual(seen.batch, { request: batch, options: { retry: null, timeout: 10000 } });
  await client.close(); assert.equal(seen.closed, 1);
});

test('documented Chirp model/location pairs are accepted and incompatible pairs are refused', () => {
  for (const location of ['us', 'eu']) assert.equal(googleModelLocationSupported('chirp_3', location), true);
  for (const location of ['us-central1', 'europe-west4', 'asia-southeast1']) assert.equal(googleModelLocationSupported('chirp_2', location), true);
  assert.equal(googleModelLocationSupported('chirp_2', 'us'), false);
  assert.equal(googleModelLocationSupported('chirp_3', 'global'), false);
  assert.equal(googleModelLocationSupported('unknown', 'eu'), false);
});

let sdk;
try { sdk = await import('@google-cloud/speech'); } catch { /* Optional on Parakeet-only installs. */ }
test('pinned SDK encodes Phoenix requests as V2 protos without network or credentials', {
  skip: !sdk && 'optional Google SDK omitted from this install',
}, () => {
  const speech = sdk.protos.google.cloud.speech.v2;
  const config = buildRecognitionConfig({ model: 'chirp_3', lang: 'en-US', hints: ['synthetic hint'], denoise: true, hintBoost: 4 });
  const first = buildStreamingRequest({ recognizer: 'projects/synthetic-project/locations/us/recognizers/_', config });
  const encoded = speech.StreamingRecognizeRequest.encode(speech.StreamingRecognizeRequest.fromObject(first)).finish();
  const decoded = speech.StreamingRecognizeRequest.decode(encoded);
  assert.equal(decoded.recognizer, first.recognizer);
  assert.equal(decoded.streamingConfig.config.denoiserConfig.denoiseAudio, true);
  assert.equal(decoded.streamingConfig.config.adaptation.phraseSets[0].inlinePhraseSet.boost, 4);
  assert.equal(decoded.streamingConfig.config.explicitDecodingConfig.encoding, 1);
  assert.equal(decoded.streamingConfig.streamingFeatures.interimResults, true);
  const audio = Buffer.alloc(6400, 7);
  const decodedAudio = speech.StreamingRecognizeRequest.decode(speech.StreamingRecognizeRequest.encode({ audio }).finish());
  assert.deepEqual(Buffer.from(decodedAudio.audio), audio);
  const batch = buildRecognizeRequest({ recognizer: first.recognizer, config, content: audio });
  assert.deepEqual(Buffer.from(speech.RecognizeRequest.decode(speech.RecognizeRequest.encode(speech.RecognizeRequest.fromObject(batch)).finish()).content), audio);
});

test('actual pinned SDK bootstrap rejection is caught before methods can create an unhandled rejection', {
  skip: !sdk && 'optional Google SDK omitted from this install',
}, () => {
  const adapterUrl = new URL('../src/asr/googleSpeech.js', import.meta.url).href;
  const script = `
    import speech from '@google-cloud/speech';
    import { createGoogleSpeechClient } from ${JSON.stringify(adapterUrl)};
    let stubCalls = 0;
    class LocalSpeechClient extends speech.v2.SpeechClient {
      constructor(options) {
        super(options);
        this._gaxGrpc.createStub = () => { stubCalls++; return Promise.reject(Object.assign(new Error('synthetic bootstrap rejection'), { code: 'EACCES' })); };
      }
    }
    try {
      await createGoogleSpeechClient({ projectId: 'synthetic-project', location: 'us', credentialsFile: '/synthetic/never-read.json',
        importer: async () => ({ v2: { SpeechClient: LocalSpeechClient } }) });
      process.exitCode = 2;
    } catch (error) {
      if (error.code !== 'EACCES') process.exitCode = 3;
    }
    await new Promise(r => setTimeout(r, 100));
    if (stubCalls !== 1) process.exitCode = 4;
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || String(child.error || 'SDK bootstrap child failed'));
});

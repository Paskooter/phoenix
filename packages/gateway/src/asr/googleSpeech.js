// Google Cloud Speech-to-Text V2: requests, responses and the client adapter.
//
// Phoenix keeps its own endpointing (ParakeetASRSession's VAD), so Google is
// used the way Parakeet's `/stream` is: audio flows while the person speaks,
// interim results arrive, and the session half-closes the stream at its own
// end-of-speech to get the final. Nothing here enables Google's endpointing,
// voice-activity events, punctuation, profanity masking or word timings.
//
// Request shapes follow google.cloud.speech.v2 (cloud_speech.proto):
//   StreamingRecognizeRequest #1 { recognizer, streamingConfig }
//   StreamingRecognizeRequest #n { audio }                  <= 15 KB each
//   RecognizeRequest             { recognizer, config, content }   <= 1 min
// Field names are the camelCase the Node client (@google-cloud/speech) expects.
//
// The client is the official library, loaded only when Google is enabled.
// The pinned optional dependency is installed by npm ci on Node 22+. Parakeet
// still runs when optional dependencies are omitted. Its `streamingRecognize()` helper is
// V1-shaped (it writes {streamingConfig} and wraps audio as audioContent), so
// the adapter drives the raw bidirectional `_streamingRecognize()` stream.

export const GOOGLE_SAMPLE_RATE_HZ = 16000;
export const GOOGLE_BYTES_PER_SECOND = GOOGLE_SAMPLE_RATE_HZ * 2;
/** Conservative limit: the Node V2 reference says 15 KB, quotas say 25 KB. */
export const GOOGLE_MAX_AUDIO_BYTES_PER_REQUEST = 15_000;
/** Synchronous Recognize accepts at most one minute of audio. */
export const GOOGLE_MAX_SYNC_SECONDS = 60;

export const GOOGLE_MODELS = ['chirp_3', 'chirp_2', 'short', 'long', 'telephony_short', 'telephony'];
export const GOOGLE_LOCATIONS = ['us', 'eu', 'global', 'us-central1', 'europe-west4', 'asia-southeast1'];
export function googleModelLocationSupported(model, location) {
  if (!GOOGLE_MODELS.includes(model) || !GOOGLE_LOCATIONS.includes(location)) return false;
  if (model === 'chirp_3') return ['us', 'eu'].includes(location);
  if (model === 'chirp_2') return ['us-central1', 'europe-west4', 'asia-southeast1'].includes(location);
  return true; // Legacy models require an operator's region/language availability check.
}

// Chirp models return a value in `confidence`, but Google documents that it
// "isn't truly a confidence score" (chirp_3-model and chirp_2-model pages).
// Passing it on would put an invented number in LISTEN.data.asr.confidence, the
// mistake DIVERGENCES H07c records; such models report no confidence instead.
const MODELS_WITHOUT_CONFIDENCE = new Set(['chirp_3', 'chirp_2', 'chirp']);
export function modelReportsConfidence(model) {
  return !MODELS_WITHOUT_CONFIDENCE.has(model);
}

/** The API host for a location: "us" -> us-speech.googleapis.com. */
export function googleApiEndpoint(location) {
  return location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`;
}

/** The implicit recognizer: every setting travels in the request. */
export function googleRecognizerPath(projectId, location) {
  return `projects/${projectId}/locations/${location}/recognizers/_`;
}

/**
 * Robot language -> V2 language code. V2 lists no English (Canada) model in any
 * region, so en-CA robots are recognized as en-US; Parakeet has one English
 * model for both, so this matches it.
 */
export function googleLanguageCode(lang) {
  if (lang === 'en-CA' || lang === 'en-US' || !lang) return 'en-US';
  return lang;
}

/**
 * The robot's ASR hints (already $TEMPLATE-expanded, with "jibo" appended) as
 * V2 phrases. Limits: 100 characters per phrase, 1,200 phrases per phrase set.
 */
export function adaptationPhrases(hints) {
  const seen = new Set();
  const phrases = [];
  for (const hint of Array.isArray(hints) ? hints : []) {
    if (typeof hint !== 'string') continue;
    const value = hint.trim();
    if (!value || value.length > 100 || seen.has(value)) continue;
    seen.add(value);
    phrases.push(value);
    if (phrases.length >= 500) break;
  }
  return phrases;
}

/** RecognitionConfig for 16 kHz mono PCM16LE (what the session always sends). */
export function buildRecognitionConfig({ model, lang, hints, denoise = false, hintBoost = null }) {
  const config = {
    explicitDecodingConfig: {
      encoding: 'LINEAR16',
      sampleRateHertz: GOOGLE_SAMPLE_RATE_HZ,
      audioChannelCount: 1,
    },
    languageCodes: [googleLanguageCode(lang)],
    model,
    // Punctuation off; nothing masked. Capitals and digits still come back and
    // are removed by normalizeGoogleTranscript (transcriptNormalizer.js).
    features: {
      enableAutomaticPunctuation: false,
      profanityFilter: false,
      maxAlternatives: 1,
    },
  };
  const phrases = adaptationPhrases(hints);
  if (phrases.length) {
    // The original sent hints as V1 speechContexts without a boost
    // (pegasus GoogleASRProvider.ts createGoogleRequest).
    const inlinePhraseSet = { phrases: phrases.map((value) => ({ value })) };
    if (Number.isFinite(hintBoost) && hintBoost > 0) inlinePhraseSet.boost = Math.min(20, hintBoost);
    config.adaptation = { phraseSets: [{ inlinePhraseSet }] };
  }
  if (denoise) config.denoiserConfig = { denoiseAudio: true, snrThreshold: 0 };
  return config;
}

export function buildStreamingRequest({ recognizer, config }) {
  return {
    recognizer,
    streamingConfig: {
      config,
      streamingFeatures: { interimResults: true },
    },
  };
}

export function buildRecognizeRequest({ recognizer, config, content }) {
  return { recognizer, config, content };
}

/** Seconds from a google.protobuf.Duration as the Node client returns it. */
export function durationSeconds(duration) {
  if (!duration || typeof duration !== 'object') return null;
  const seconds = Number(duration.seconds ?? 0);
  const nanos = Number(duration.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
  return seconds + nanos / 1e9;
}

/** Billed audio seconds Google reported for a request, when it did. */
export function billedSecondsOf(response) {
  return durationSeconds(response?.metadata?.totalBilledDuration);
}

export function topAlternative(result) {
  const alternative = Array.isArray(result?.alternatives) ? result.alternatives[0] : null;
  return {
    transcript: typeof alternative?.transcript === 'string' ? alternative.transcript : '',
    // 0.0 is Google's documented sentinel for "not set".
    confidence: typeof alternative?.confidence === 'number' && alternative.confidence > 0
      ? Math.min(1, alternative.confidence) : null,
  };
}

/**
 * One utterance-level confidence from several final segments: the mean of the
 * segments that carry one, weighted by their word count. Null when none do.
 */
export function combineConfidence(segments) {
  let weighted = 0;
  let words = 0;
  for (const segment of segments) {
    if (typeof segment.confidence !== 'number') continue;
    const count = Math.max(1, String(segment.transcript || '').trim().split(/\s+/).filter(Boolean).length);
    weighted += segment.confidence * count;
    words += count;
  }
  return words ? weighted / words : null;
}

// --- errors -------------------------------------------------------------------

// gRPC status codes that mean "this configuration cannot work" rather than "try
// again": a wrong project, model or location, missing permission, bad key.
const CONFIG_CODES = new Set([3, 5, 7, 9, 12, 16]);

export class GoogleSttError extends Error {
  constructor(message, { code = 'GOOGLE_STT_ERROR', grpcCode = null, cause } = {}) {
    super(message);
    this.name = 'GoogleSttError';
    this.code = code;
    this.grpcCode = grpcCode;
    if (cause) this.cause = cause;
  }
}

/** Classify a client error without copying its message into logs verbatim. */
export function classifyGoogleError(err) {
  const grpcCode = Number.isInteger(err?.code) ? err.code : null;
  if (err?.code === 'GOOGLE_STT_CLIENT_MISSING') return { kind: 'client-missing', grpcCode };
  if (err?.code === 'ENOENT' || err?.code === 'EACCES') return { kind: 'credentials', grpcCode };
  if (grpcCode !== null && CONFIG_CODES.has(grpcCode)) {
    return { kind: grpcCode === 7 || grpcCode === 16 ? 'credentials' : 'configuration', grpcCode };
  }
  if (grpcCode === 8) return { kind: 'quota', grpcCode };
  return { kind: 'transient', grpcCode };
}

/** Safe to pass to shared session logs or the Hub error response. */
export function sanitizedGoogleError(error) {
  const code = typeof error?.code === 'string' && /^GOOGLE_STT_(?:BUDGET|CLIENT_MISSING|BUSY|TOO_LONG|TIMEOUT|UNAVAILABLE|CANCELLED|ERROR)$/.test(error.code)
    ? error.code : 'GOOGLE_STT_ERROR';
  return new GoogleSttError('Google speech request failed', { code, grpcCode: classifyGoogleError(error).grpcCode });
}

// --- the client adapter ----------------------------------------------------------

/**
 * Create the real V2 client. `importer` exists for tests; production imports
 * @google-cloud/speech on first use.
 * @returns {Promise<{streamingRecognize(first:object):object, recognize(req:object,opts?:object):Promise<object>, close():Promise<void>}>}
 */
export async function createGoogleSpeechClient({
  location, credentialsFile, projectId, importer = (name) => import(name),
}) {
  let mod;
  try {
    mod = await importer('@google-cloud/speech');
  } catch (cause) {
    throw new GoogleSttError(
      'Google Speech-to-Text needs the @google-cloud/speech package installed in this release',
      { code: 'GOOGLE_STT_CLIENT_MISSING', cause },
    );
  }
  const speech = mod?.v2 ? mod : (mod?.default || mod);
  if (!speech?.v2?.SpeechClient) {
    throw new GoogleSttError('@google-cloud/speech has no V2 client', { code: 'GOOGLE_STT_CLIENT_MISSING' });
  }
  const client = new speech.v2.SpeechClient({
    apiEndpoint: googleApiEndpoint(location),
    keyFilename: credentialsFile,
    projectId,
  });
  // Generated SDK methods call initialize().catch(rethrow) internally. Exposing
  // them before initialization rejects can crash Node despite stream handlers.
  // Bootstrap inside the transport's bounded, caught client promise instead.
  try { await client.initialize(); }
  catch (error) { try { await client.close(); } catch { /* failed bootstrap */ } throw error; }
  return {
    streamingRecognize(firstRequest) {
      const stream = client._streamingRecognize({ timeout: 45000 });
      stream.write(firstRequest);
      return stream;
    },
    async recognize(request, { timeoutMs } = {}) {
      // One admitted request, with no hidden unary retry after a lost response.
      const [response] = await client.recognize(request, { retry: null, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
      return response;
    },
    close() {
      return client.close();
    },
  };
}

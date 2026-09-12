// Google streaming ASR session — faithful port of
// pegasus:packages/hub/src/asr/google/GoogleASRSession.ts.
//
// This is the ORIGINAL ASR behavior: a full-duplex recognizer stream
// (`recStream`) carries audio up and ASROutput frames down. The frame shape is
// the pinned interface packages/interfaces/src/google/asr.ts:
//
//   ASROutput { speechEventType, results?: ASROutputResult[], error? }
//   SpeechEventType = 'END_OF_SINGLE_UTTERANCE' | 'SPEECH_EVENT_UNSPECIFIED'
//   ASROutputResult { isFinal, alternatives: [{transcript, confidence, words}] }
//
// Client-visible behavior preserved exactly:
//   * interimResults: every non-final alternative updates lastASRResult and
//     drives getLastIncremental(); SOS fires on the FIRST transcript the session
//     hears (incremental or final).
//   * final transcript: an isFinal result resolves start() and invokes onResult.
//   * FAST_EOS annotation: an incremental matching the earlyEOS regex resolves
//     immediately with annotation FAST_EOS (docs "Simplified ASR": fast_eos is
//     "apply[ied] ... if it see[s] any of the words in the list in incremental
//     responses").
//   * GARBAGE annotation: an incremental longer than 13 words that does not
//     begin with a question word is treated as non-user speech.
//   * END_OF_SINGLE_UTTERANCE: SOS (if none yet) + EOS, then a 3 s wait for the
//     final result; on timeout it resolves with the last good incremental.
//   * error envelope: `data.error` or a stream 'error' event rejects start().
//   * stop() ends the recognizer stream and clears the final-result timer.
//
// The recognizer stream is injected, which is the replaceable-provider seam: the
// production provider supplies a socket to the configured speech endpoint while
// tests supply a recorded/fake recognizer stream (no live vendor).

import { FastEOS } from './fastEOS.js';

const FINAL_RESULT_WAIT_MS = 3000;

export class GoogleASRSession {
  /**
   * @param {{write:(b:Buffer)=>void, end:()=>void, on:(e:string,h:Function)=>void}} recStream
   * @param {{lang?:string, hints?:string[], earlyEOS?:string[]}} config
   * @param {object} log
   */
  constructor(recStream, config, log) {
    this.recStream = recStream;
    this.config = config || {};
    this.log = log || console;
    this.stopped = false;
    this.sosHandler = null;
    this.eosHandler = null;
    this.resultHandler = null;
    this.lastASRResult = null;
    this.fastEOSRegex = null;
    this.isQuestionRegex = /^(who|what|when|where|why|how|which|are|can|did|do|does|is|was|were)/i;
    this.haveSentSOS = false;
    this.haveSentEOS = false;
    this.finalResultTimeout = null;
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.startSettled = false;

    if (this.config.earlyEOS && this.config.earlyEOS.length > 0) {
      this.fastEOSRegex = FastEOS.buildRegex(this.config.earlyEOS);
    }
  }

  /** Provide audio to the recognizer for transcription. */
  provideAudio(audioBuffer) {
    if (!this.stopped) this.recStream.write(audioBuffer);
  }

  /** Stop the current session: close the recognizer stream, clear the timer. */
  stop() {
    this._resolveStart(undefined);
    this._closeStream();
  }

  _closeStream() {
    clearTimeout(this.finalResultTimeout);
    this.finalResultTimeout = null;
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.recStream.end();
    } catch (error) {
      this.log.warn?.(`Google recognizer stream close failed: ${error.message}`);
    }
  }

  _resolveStart(value) {
    if (this.startSettled) return;
    this.startSettled = true;
    clearTimeout(this.finalResultTimeout);
    this.finalResultTimeout = null;
    const resolve = this.resolveStart;
    this.resolveStart = null;
    this.rejectStart = null;
    this._closeStream();
    resolve?.(value);
  }

  _rejectStart(error) {
    if (this.startSettled) return;
    this.startSettled = true;
    clearTimeout(this.finalResultTimeout);
    this.finalResultTimeout = null;
    const reject = this.rejectStart;
    this.resolveStart = null;
    this.rejectStart = null;
    this._closeStream();
    reject?.(error);
  }

  onStartOfSpeech(handler) { this.sosHandler = handler; }
  onEndOfSpeech(handler) { this.eosHandler = handler; }
  onResult(handler) { this.resultHandler = handler; }

  /** Retrieve the last valid incremental result (never null). */
  getLastIncremental() {
    return this.lastASRResult || { text: '', confidence: 0 };
  }

  /** Start the current session; resolves with the ASRResult. */
  start() {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) {
      this.startSettled = true;
      this.startPromise = Promise.resolve(undefined);
      return this.startPromise;
    }

    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;

      const fail = (error) => this._rejectStart(error);
      const handleData = (rawData) => {
        const data = rawData || {};
        this.log.debug?.(`Received data from google: ${JSON.stringify(data)}`);
        if (this.stopped || this.startSettled) {
          this.log.debug?.('ASR data arrived but GoogleASRSession is stopped already');
          return;
        }
        if (data.error) {
          fail(data.error);
          return;
        }
        if (!data.speechEventType) {
          this.log.warn?.(`Missing speechEventType: ${JSON.stringify(data)}`);
          return;
        }

        if (data.speechEventType === 'END_OF_SINGLE_UTTERANCE') {
          if (this.haveSentEOS) return;
          if (!this.haveSentSOS) this.sendSOS();
          if (this.startSettled) return;
          this.sendEOS();
          this.finalResultTimeout = setTimeout(() => {
            if (this.startSettled) return;
            const asrResult = this.getLastIncremental();
            this.log.info?.(`Timeout waiting for final result after EOS, returning ${JSON.stringify(asrResult)}`);
            this.sendResult(asrResult);
            this._resolveStart(asrResult);
          }, FINAL_RESULT_WAIT_MS);
          return;
        }

        if (data.speechEventType !== 'SPEECH_EVENT_UNSPECIFIED') {
          this.log.warn?.(`Unknown speechEventType '${data.speechEventType}': ${JSON.stringify(data)}`);
          return;
        }

        const results = Array.isArray(data.results) ? data.results : [];
        if (results.length === 0) {
          // Google occasionally sends a progress frame without results. It is
          // not speech and must not advance SOS or settle the transaction.
          this.log.info?.(`Received empty results: ${JSON.stringify(data)}`);
          return;
        }
        const result = results[0];
        const alternative = result && Array.isArray(result.alternatives) ? result.alternatives[0] : null;
        if (!alternative) {
          this.log.info?.(`Received a result without an alternative: ${JSON.stringify(data)}`);
          return;
        }
        const asrResult = {
          text: typeof alternative.transcript === 'string' ? alternative.transcript : '',
          confidence: typeof alternative.confidence === 'number' ? alternative.confidence : 0,
        };

        // Keep the last good ASR result that we receive.
        if (!this.lastASRResult || asrResult.confidence >= this.lastASRResult.confidence) {
          this.lastASRResult = asrResult;
        }

        // We have incremental results; SOS fires on the first one.
        if (!this.haveSentSOS) this.sendSOS();

        if (asrResult.text.split(' ').length > 13 && !this.isQuestionRegex.test(asrResult.text)) {
          this.log.warn?.('Incremental transcription appears to potentially be "garbage". Stopping ASR and ignoring.');
          const annotatedResult = Object.assign({}, asrResult, { annotation: 'GARBAGE' });
          this.sendEOS();
          this.sendResult(annotatedResult);
          this._resolveStart(annotatedResult);
        } else if (result.isFinal) {
          this.sendResult(asrResult);
          this._resolveStart(asrResult);
        } else if (this.fastEOSRegex && this.fastEOSRegex.test(asrResult.text)) {
          this.log.info?.('Incremental transcription contains a FastEOS trigger word/phrase. Stopping ASR and returning.');
          const annotatedResult = Object.assign({}, asrResult, { annotation: 'FAST_EOS' });
          this.sendEOS();
          this.sendResult(annotatedResult);
          this._resolveStart(annotatedResult);
        }
      };
      const handleEnd = () => {
        if (this.startSettled) return;
        // A transport ending without a final frame is still a terminal provider
        // outcome. Preserve the robot's SOS/EOS ordering for any speech already
        // observed and return a concrete empty envelope when it ended silently.
        if (this.haveSentSOS) this.sendEOS();
        this._resolveStart(this.lastASRResult || { text: '', confidence: 0 });
      };

      try {
        this.recStream.on('error', fail);
        this.recStream.on('data', handleData);
        this.recStream.on('end', handleEnd);
      } catch (error) {
        fail(error);
      }
    });
    return this.startPromise;
  }

  sendSOS() {
    this.haveSentSOS = true;
    if (!this.stopped && this.sosHandler) this.sosHandler(null);
  }

  sendEOS() {
    if (this.haveSentEOS) return;
    this.haveSentEOS = true;
    if (!this.stopped && this.eosHandler) this.eosHandler(null);
  }

  sendResult(asrResult) {
    if (!this.stopped && this.resultHandler) this.resultHandler(asrResult);
  }
}

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
    this.finalResultTimeout = null;

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
    if (!this.stopped) {
      this.stopped = true;
      this.recStream.end();
    }
    clearTimeout(this.finalResultTimeout);
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
    return new Promise((resolve, reject) => {
      this.recStream
        .on('error', (error) => {
          this.stop();
          reject(error);
        })
        .on('data', (data) => {
          this.log.debug?.(`Received data from google: ${JSON.stringify(data)}`);
          if (this.stopped) {
            this.log.debug?.('ASR data arrived but GoogleASRSession is stopped already');
            return;
          }
          if (data.error) {
            reject(data.error);
          } else if (data.speechEventType) {
            if (data.speechEventType === 'END_OF_SINGLE_UTTERANCE') {
              if (!this.haveSentSOS) this.sendSOS();
              this.sendEOS();
              // Begin waiting for the final message.
              this.finalResultTimeout = setTimeout(() => {
                const asrResult = this.getLastIncremental();
                this.log.info?.(`Timeout waiting for final result after EOS, returning ${JSON.stringify(asrResult)}`);
                this.sendResult(asrResult);
                resolve(asrResult);
              }, FINAL_RESULT_WAIT_MS);
            } else if (data.speechEventType === 'SPEECH_EVENT_UNSPECIFIED') {
              if (data.results.length) {
                const result = data.results[0];
                const asrResult = {
                  text: result.alternatives[0].transcript,
                  confidence: result.alternatives[0].confidence,
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
                  resolve(annotatedResult);
                } else if (result.isFinal) {
                  this.sendResult(asrResult);
                  resolve(asrResult);
                } else if (this.fastEOSRegex && this.fastEOSRegex.test(asrResult.text)) {
                  this.log.info?.('Incremental transcription contains a FastEOS trigger word/phrase. Stopping ASR and returning.');
                  const annotatedResult = Object.assign({}, asrResult, { annotation: 'FAST_EOS' });
                  this.sendEOS();
                  this.sendResult(annotatedResult);
                  resolve(annotatedResult);
                }
              } else {
                // This happens now and then and doesn't seem to have a negative effect.
                this.log.info?.(`Received empty results: ${JSON.stringify(data)}`);
              }
            } else {
              this.log.warn?.(`Unknown speechEventType '${data.speechEventType}': ${JSON.stringify(data)}`);
            }
          } else {
            this.log.warn?.(`Missing speechEventType: ${JSON.stringify(data)}`);
          }
        })
        .on('end', () => {
          if (this.stopped) resolve();
          this.stopped = true;
        });
    }).catch((error) => {
      this.stop();
      throw error;
    }).then((result) => {
      this.stop();
      return result;
    });
  }

  sendSOS() {
    this.haveSentSOS = true;
    if (!this.stopped && this.sosHandler) this.sosHandler(null);
  }

  sendEOS() {
    if (!this.stopped && this.eosHandler) this.eosHandler(null);
  }

  sendResult(asrResult) {
    if (!this.stopped && this.resultHandler) this.resultHandler(asrResult);
  }
}

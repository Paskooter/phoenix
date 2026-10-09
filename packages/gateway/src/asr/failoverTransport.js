// Parakeet first, Google when Parakeet cannot answer.
//
// The decision is made at three points of a turn, and audio is never lost at
// any of them because ParakeetASRSession keeps every accepted PCM byte of the
// current recognition window until the window is recognized:
//
//   1. Turn start. If Parakeet is already known to be down, the turn goes to
//      Google without waiting. Otherwise the session's usual /healthz probe
//      runs (with a short timeout); a refused connection, a timeout or a 5xx
//      marks Parakeet down and the turn streams to Google instead. Audio that
//      arrives meanwhile is queued by the session as it always is.
//   2. Mid-stream. FailoverSocket stands in for Parakeet's /stream socket and
//      keeps a copy of everything sent in the window. If the Parakeet socket
//      errors, closes unexpectedly, does not open in time, or gives no final
//      within a deadline after end-of-speech, it opens a Google stream and
//      replays the start and audio. If EOS already happened, the complete ended
//      window instead uses synchronous Google Recognize: replaying 30 seconds
//      at real time would consume the Hub's remaining ASR deadline.
//      The session sees one socket and one result.
//   3. Batch. If the window is recognized by POST /transcribe (an old server,
//      or a stream that failed) and Parakeet fails, the same WAV goes to
//      Google's synchronous Recognize.
//
// Recovery: ParakeetHealth probes /healthz in the background while Parakeet is
// down and declares it back after consecutive successes; new turns then use
// Parakeet again. A Parakeet that fails again soon after recovering is probed
// less often (doubling, capped), so a flapping server does not bounce every
// turn between recognizers. A turn never switches back mid-window.

import { CLOSED, CLOSING, CONNECTING, OPEN, RecognizerSocket, parseControl } from './recognizerSocket.js';

export const FAILOVER_DEFAULTS = Object.freeze({
  probeTimeoutMs: 1500,
  openTimeoutMs: 2000,
  finalTimeoutMs: 2500,
  batchTimeoutMs: 6000,
  recoveryIntervalMs: 10000,
  maxRecoveryIntervalMs: 5 * 60 * 1000,
  recoverySuccesses: 2,
  flapWindowMs: 2 * 60 * 1000,
});

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
// A large backlog cannot be resent at real time inside the same 40s turn.
export const MAX_STREAM_REPLAY_SECONDS = 3;
const DEFAULT_START = JSON.stringify({ type: 'start', sampleRate: 16000, normalize: false });
const EOS = JSON.stringify({ type: 'eos' });

/** Shared view of whether Parakeet is answering, with background recovery. */
export class ParakeetHealth {
  constructor({
    probe, recoveryIntervalMs = FAILOVER_DEFAULTS.recoveryIntervalMs,
    maxRecoveryIntervalMs = FAILOVER_DEFAULTS.maxRecoveryIntervalMs,
    recoverySuccesses = FAILOVER_DEFAULTS.recoverySuccesses,
    flapWindowMs = FAILOVER_DEFAULTS.flapWindowMs, now = Date.now, log = null,
  }) {
    this.probe = probe;
    this.baseIntervalMs = recoveryIntervalMs;
    this.maxIntervalMs = maxRecoveryIntervalMs;
    this.recoverySuccesses = recoverySuccesses;
    this.flapWindowMs = flapWindowMs;
    this.now = now;
    this.log = log;
    this.state = 'unknown';
    this.since = null;
    this.reason = null;
    this.successes = 0;
    this.intervalMs = recoveryIntervalMs;
    this.lastRecoveredAt = null;
    this.timer = null;
    this.closed = false;
  }

  isDown() { return this.state === 'down'; }

  markDown(reason) {
    if (this.closed) return;
    if (this.state === 'down') return;
    const flapped = this.lastRecoveredAt !== null && this.now() - this.lastRecoveredAt < this.flapWindowMs;
    this.intervalMs = flapped ? Math.min(this.maxIntervalMs, this.intervalMs * 2) : this.baseIntervalMs;
    this.state = 'down';
    this.since = this.now();
    this.reason = reason;
    this.successes = 0;
    this.log?.warn?.('[asr] Parakeet is not answering; new turns use Google until it recovers', {
      reason, recheckMs: this.intervalMs,
    });
    this._schedule();
  }

  markUp(reason = 'ok') {
    if (this.closed) return;
    const wasDown = this.state === 'down';
    this.state = 'up';
    this.since = this.now();
    this.reason = reason;
    this.successes = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (wasDown) {
      this.lastRecoveredAt = this.now();
      this.log?.info?.('[asr] Parakeet is answering again; new turns use it');
    }
  }

  _schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this._check(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async _check() {
    if (this.closed || this.state !== 'down') return;
    let result;
    try { result = await this.probe(); } catch { result = { reachable: false }; }
    if (this.closed || this.state !== 'down') return;
    if (result?.reachable) {
      this.successes += 1;
      if (this.successes >= this.recoverySuccesses) { this.markUp('recovered'); return; }
    } else {
      this.successes = 0;
    }
    this._schedule();
  }

  status() {
    return { state: this.state, since: this.since, reason: this.reason, recheckMs: this.state === 'down' ? this.intervalMs : null };
  }

  close() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

function quietly(socket) {
  if (!socket) return;
  try { socket.on?.('error', () => { /* replaced; its errors no longer matter */ }); } catch { /* ignore */ }
  try { socket.terminate ? socket.terminate() : socket.close?.(); } catch { /* already gone */ }
}

/**
 * A /stream-compatible socket that starts on Parakeet and can move the window
 * to Google exactly once, replaying what the session already sent.
 */
export class FailoverSocket extends RecognizerSocket {
  constructor({
    openPrimary, openSecondary = null, onEndedFailure = null, onSwitch = null, log = null,
    openTimeoutMs = FAILOVER_DEFAULTS.openTimeoutMs, finalTimeoutMs = FAILOVER_DEFAULTS.finalTimeoutMs,
  }) {
    super();
    this.openSecondary = openSecondary;
    this.onSwitch = onSwitch;
    this.onEndedFailure = onEndedFailure;
    this.log = log;
    this.finalTimeoutMs = finalTimeoutMs;
    this.startMessage = null;
    this.pcm = [];
    this.pcmBytes = 0;
    this.replayable = true;
    this.eosSent = false;
    this.finalSeen = false;
    this.closedByCaller = false;
    this.switched = false;
    this.finalTimer = null;
    this.openTimer = null;
    this.inner = null;
    this.innerName = null;
    this.switchReason = null;
    this._attach(openPrimary(), 'parakeet');
    if (this.openSecondary && openTimeoutMs > 0) {
      this.openTimer = setTimeout(() => {
        this.openTimer = null;
        if (this.innerName === 'parakeet' && this.readyState === CONNECTING) {
          this._innerFailed(this.inner, new Error('Parakeet stream did not open in time'), 'parakeet-open-timeout');
        }
      }, openTimeoutMs);
      this.openTimer.unref?.();
    }
  }

  /** Which recognizer currently carries the window. */
  get provider() { return this.innerName; }

  _attach(socket, name) {
    this.inner = socket;
    this.innerName = name;
    socket.on('open', () => {
      if (this.inner !== socket || this.closedByCaller) return;
      if (this.readyState === CONNECTING) {
        this._clearOpenTimer();
        this._emitOpen();
      } else {
        this._replay(socket);
      }
    });
    socket.on('message', (data, isBinary) => {
      if (this.inner !== socket || this.closedByCaller || this.readyState === CLOSED || this.finalSeen) return;
      if (!isBinary && parseControl(data)?.type === 'final') {
        this.finalSeen = true;
        this._clearFinalTimer();
      }
      this.emit('message', data, isBinary);
    });
    socket.on('error', (err) => {
      if (this.inner === socket) this._innerFailed(socket, err);
    });
    socket.on('close', () => {
      if (this.inner !== socket) return;
      if (this.closedByCaller || this.finalSeen) { this._emitClose(); return; }
      this._innerFailed(socket, new Error(`${name} stream closed unexpectedly`));
    });
  }

  send(data) {
    if (this.readyState !== OPEN || this.closedByCaller || this.finalSeen || this.eosSent) return;
    if (typeof data === 'string') {
      const control = parseControl(data);
      if (control?.type === 'start') this.startMessage = data;
      if (control?.type === 'eos') {
        this.eosSent = true;
        this._armFinalTimer();
      }
    } else if (this.replayable) {
      const chunk = Buffer.from(data);
      if (this.pcmBytes + chunk.length > MAX_REPLAY_BYTES) {
        // Beyond any real window; stop keeping a copy rather than grow.
        this.replayable = false;
        this.pcm = [];
        this.pcmBytes = 0;
      } else {
        this.pcm.push(chunk);
        this.pcmBytes += chunk.length;
      }
    }
    const inner = this.inner;
    if (inner && inner.readyState === OPEN) {
      try {
        inner.send(data);
      } catch (err) {
        this._innerFailed(inner, err);
      }
    }
    // Otherwise the secondary is still connecting: _replay() sends it all.
  }

  _armFinalTimer() {
    if (this.innerName !== 'parakeet' || !this.openSecondary || !(this.finalTimeoutMs > 0)) return;
    this._clearFinalTimer();
    this.finalTimer = setTimeout(() => {
      this.finalTimer = null;
      if (!this.finalSeen && this.innerName === 'parakeet') {
        this._innerFailed(this.inner, new Error('Parakeet final result timed out'), 'parakeet-slow');
      }
    }, this.finalTimeoutMs);
    this.finalTimer.unref?.();
  }

  _clearFinalTimer() {
    if (this.finalTimer) { clearTimeout(this.finalTimer); this.finalTimer = null; }
  }

  _clearOpenTimer() {
    if (this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; }
  }

  _innerFailed(socket, err, reason = null) {
    if (this.closedByCaller || this.finalSeen || this.readyState === CLOSED || this.inner !== socket) return;
    this._clearFinalTimer();
    this._clearOpenTimer();
    if (this.innerName === 'parakeet' && !this.switched && this.replayable
      && (this.eosSent || this.pcmBytes > MAX_STREAM_REPLAY_SECONDS * 32000)) {
      const why = reason || 'parakeet-stream-failed';
      let admitted = false;
      try { admitted = this.onEndedFailure?.(why, Math.ceil(this.pcmBytes / 32000)) === true; } catch { /* fail closed */ }
      if (admitted) {
        this.switched = true;
        this.switchReason = why;
        this.inner = null;
        quietly(socket);
        // The session owns the authoritative PCM. If speech is still arriving,
        // it keeps buffering to EOS; an ended window's final waiter rejects now.
        this._emitError(new Error('Parakeet ended stream failed; using Google batch'));
        this._emitClose();
        return;
      }
    }
    if (this.innerName === 'parakeet' && !this.switched && this.openSecondary && this.replayable) {
      let next = null;
      try { next = this.openSecondary(); } catch { next = null; }
      if (next) {
        this.switched = true;
        const why = reason || (this.readyState === CONNECTING ? 'parakeet-unreachable' : 'parakeet-stream-failed');
        this.switchReason = why;
        this.log?.warn?.('[asr] Parakeet stream failed; this window continues on Google', {
          reason: why, replayMs: Math.round(this.pcmBytes / 32), afterEos: this.eosSent,
        });
        try { this.onSwitch?.(why); } catch { /* reporting only */ }
        this._attach(next, 'google');
        // Detach ownership before teardown: close/error can be synchronous.
        quietly(socket);
        return;
      }
    }
    // Nothing to switch to: fail exactly as the inner socket did.
    this._emitError(err instanceof Error ? err : new Error(String(err)));
    this._emitClose();
  }

  _replay(socket) {
    try {
      socket.send(this.startMessage || DEFAULT_START);
      for (const chunk of this.pcm) socket.send(chunk);
      if (this.eosSent) socket.send(EOS);
    } catch (err) {
      this._innerFailed(socket, err);
    }
  }

  close() { this._closeByCaller(true); }

  terminate() { this._closeByCaller(false); }

  _closeByCaller(graceful) {
    if (this.readyState === CLOSED) return;
    this.closedByCaller = true;
    this._clearFinalTimer();
    this._clearOpenTimer();
    this.readyState = CLOSING;
    const inner = this.inner;
    if (inner) {
      try { inner.on('error', () => { /* teardown races must not throw */ }); } catch { /* ignore */ }
      try {
        if (graceful && inner.readyState === OPEN) inner.close();
        else inner.terminate();
      } catch { /* already gone */ }
    }
    setImmediate(() => this._emitClose());
  }
}

/**
 * The per-session failover transport.
 * @param {object} options
 * @param {object} options.primary    createParakeetTransport(...)
 * @param {object|null} options.secondary  createGoogleTransport(...), or null when Google is not configured
 * @param {ParakeetHealth} options.health
 */
export function createFailoverTransport({ primary, secondary = null, health, timeouts = {}, log = null }) {
  const limits = { ...FAILOVER_DEFAULTS, ...timeouts };
  let active = 'parakeet';
  let failover = null;
  let cancelled = false;
  const secondaryReady = (seconds) => !!secondary && secondary.available(seconds);
  const useSecondary = (reason) => {
    active = 'google';
    failover = failover || reason;
  };

  return {
    name: 'failover',

    async probeStreaming() {
      if (health.isDown() && secondaryReady()) {
        useSecondary('parakeet-down');
        return secondary.probeStreaming();
      }
      const probe = await primary.probe();
      if (probe.reachable) {
        active = 'parakeet';
        if (health.state !== 'up') health.markUp('probe');
        return probe.streaming;
      }
      health.markDown(`probe-${probe.reason || 'failed'}`);
      if (secondaryReady()) {
        useSecondary('parakeet-unreachable');
        return secondary.probeStreaming();
      }
      // Nothing better: behave exactly as Parakeet alone would (batch, then an
      // ASR error if it really is gone).
      return false;
    },

    openStream() {
      if (active === 'google') return secondary.openStream();
      return new FailoverSocket({
        openPrimary: () => primary.openStream(),
        openSecondary: secondary ? () => (secondaryReady() ? secondary.openStream() : null) : null,
        onEndedFailure: (reason, seconds) => {
          if (!secondaryReady(seconds)) return false;
          health.markDown(reason);
          useSecondary(reason);
          return true;
        },
        openTimeoutMs: limits.openTimeoutMs,
        finalTimeoutMs: limits.finalTimeoutMs,
        onSwitch: (reason) => {
          health.markDown(reason);
          useSecondary(reason);
        },
        log,
      });
    },

    async recognizeWav(wav) {
      if (cancelled) throw new Error('ASR recognition aborted');
      if (active === 'google') return secondary.recognizeWav(wav);
      try {
        return await primary.recognizeWav(wav);
      } catch (err) {
        if (cancelled) throw err;
        health.markDown('batch-failed');
        // Session WAVs have a canonical 44-byte header and 16 kHz PCM16.
        // A short batch may fit the remaining budget even when a complete
        // streaming reservation would not.
        const seconds = Math.ceil(Math.max(0, wav.length - 44) / 32000);
        if (!secondaryReady(seconds)) throw err;
        useSecondary('parakeet-batch-failed');
        log?.warn?.('[asr] Parakeet recognition failed; recognizing this window with Google');
        return secondary.recognizeWav(wav);
      }
    },

    describe() {
      if (active !== 'google') return { provider: 'parakeet' };
      return { ...(secondary?.describe?.() || { provider: 'google' }), ...(failover ? { failover } : {}) };
    },
    cancel() {
      cancelled = true;
      primary.cancel?.();
      secondary?.cancel?.();
    },
  };
}

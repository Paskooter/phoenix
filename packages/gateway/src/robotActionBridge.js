import { WebSocket, WebSocketServer } from 'ws';
import { accountVerifyTimeout } from './config.js';
import { RobotActionReservations } from './robotActionReservations.js';
import {
  ROBOT_ACTION_PATH, ROBOT_ACTION_VERSION, MAX_ROBOT_ACTION_FRAME_BYTES,
  ROBOT_ACTION_STATUS_MAX_AGE_MS, actionError, actionUncertain, robotIdentity,
  sameRobotIdentity, validateAnnouncement, validReceiverFrame, receiverResult,
} from './robotActionProtocol.js';

/** Verify all three identity fields against live Account state on this new path. */
export async function verifyRobotActionIdentity(identity, accountUrl, {
  fetchImpl = fetch, timeoutMs, signal,
} = {}) {
  const wanted = robotIdentity(identity);
  if (!wanted || !accountUrl) return null;
  try {
    const timeout = AbortSignal.timeout(accountVerifyTimeout(timeoutMs));
    const response = await fetchImpl(`${accountUrl.replace(/\/$/, '')}/api/verify?accessKeyId=${encodeURIComponent(wanted.accessKeyId)}`, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) return null;
    const account = await response.json();
    if (account.valid !== true || account.id !== wanted.id || account.friendlyId !== wanted.friendlyId) return null;
    return { id: account.id, accessKeyId: wanted.accessKeyId, friendlyId: account.friendlyId };
  } catch { return null; }
}

/** Observe retained native execution without queuing or replaying an action. */
export class RobotActionBridge {
  constructor({ config, authenticate, activity, log, peerToken, now = Date.now, fetchImpl = fetch,
    heartbeatMs = 20_000, statusMaxAgeMs = ROBOT_ACTION_STATUS_MAX_AGE_MS,
    voiceInterruptTimeoutMs = 1500, maxSessions = 1000, maxSeenRequests = 10_000,
    reservations = new RobotActionReservations(),
  }) {
    this.config = config;
    this.authenticate = authenticate;
    this.activity = activity;
    this.log = log;
    this.now = now;
    this.fetch = fetchImpl;
    this.peerToken = peerToken;
    this.statusMaxAgeMs = statusMaxAgeMs;
    this.voiceInterruptTimeoutMs = voiceInterruptTimeoutMs;
    this.maxSessions = maxSessions;
    this.maxSeenRequests = maxSeenRequests;
    this.sessions = new Map();
    this.voice = new Map();
    this.verifiedVoice = new Map();
    this.jobs = new Map();
    this.pending = new Map();
    this.seenRequests = new Map();
    this.reservations = reservations;
    this.unknownReservation = reservations.loadFault || reservations.unknown || (reservations.writeFault && !reservations.entries.size);
    if (this.unknownReservation) this.activity.trackExisting('robot-action');
    else for (const entry of reservations.entries.values()) {
      this.trackExecution({ ...entry, session: null, recovered: true,
        endActivity: this.activity.trackExisting('robot-action') });
      if (this.seenRequests.size < this.maxSeenRequests) this.seenRequests.set(entry.requestId, this.now() + 10 * 60_000);
    }
    this.closed = false;
    this.enabled = !config.disableAuth && !!config.hubTokenSecret && !!config.accountUrl
      && typeof peerToken === 'string' && !!peerToken && reservations.configured;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ROBOT_ACTION_FRAME_BYTES,
      perMessageDeflate: false, verifyClient: (info, callback) => this.verifyUpgrade(info, callback) });
    this.wss.on('connection', (socket, request) => this.attach(socket, request));
    this.timer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (this.now() >= session.expiresAt || this.now() - session.lastPong > heartbeatMs * 2) session.socket.terminate();
        else if (session.socket.readyState === WebSocket.OPEN) session.socket.ping();
      }
    }, heartbeatMs);
    this.timer.unref?.();
  }

  async verifyUpgrade(info, callback) {
    if (info.req.url !== ROBOT_ACTION_PATH) return callback(false, 404, 'No robot action handler');
    if (!this.enabled || this.closed) return callback(false, 503, 'Robot actions unavailable');
    const { auth, error } = this.authenticate(info.req.headers, this.config.hubTokenSecret);
    if (error || !robotIdentity(auth) || !Number.isSafeInteger(auth.exp) || auth.exp * 1000 <= this.now()) {
      return callback(false, 401, 'Verified robot authentication required');
    }
    const identity = await verifyRobotActionIdentity(auth, this.config.accountUrl, {
      fetchImpl: this.fetch, timeoutMs: this.config.accountVerifyTimeoutMs,
    });
    if (!identity || auth.exp * 1000 <= this.now()) return callback(false, 401, 'Robot account unavailable');
    if (this.closed || (!this.sessions.has(identity.id) && this.sessions.size >= this.maxSessions)) {
      return callback(false, 503, 'Robot actions unavailable');
    }
    info.req._robotActionIdentity = identity;
    info.req._robotActionExpiresAt = auth.exp * 1000;
    callback(true);
  }

  attach(socket, request) {
    const identity = request._robotActionIdentity;
    const previous = this.sessions.get(identity.id);
    if (previous) {
      this.disconnect(previous);
      previous.socket.close(4000, 'Robot action connection replaced');
    }
    const session = { identity, socket, expiresAt: request._robotActionExpiresAt,
      ready: false, busy: true, lastStatusAt: 0, lastPong: this.now() };
    this.sessions.set(identity.id, session);
    // A receiver estimates server time from this welcome plus monotonic elapsed
    // time. A skewed robot wall clock must not extend an announcement deadline.
    socket.send(JSON.stringify({ v: ROBOT_ACTION_VERSION, type: 'ready', server_time_ms: this.now() }));
    socket.on('pong', () => { session.lastPong = this.now(); });
    socket.on('message', (data, binary) => {
      if (this.sessions.get(identity.id) !== session || session.expiresAt <= this.now()) {
        socket.close(4001, 'Robot action connection expired'); return;
      }
      let frame;
      try { if (binary) throw new Error('binary'); frame = JSON.parse(data.toString('utf8')); }
      catch { socket.close(4002, 'Invalid robot action frame'); return; }
      if (!validReceiverFrame(frame) || (!session.ready && frame.type !== 'ready')
        || (session.ready && frame.type === 'ready')) {
        socket.close(4002, 'Invalid robot action frame'); return;
      }
      if (frame.type === 'ready' || frame.type === 'status') {
        session.ready = true; session.busy = frame.busy; session.lastStatusAt = this.now();
        this.observeExecution(session, frame.active_request_id?.toLowerCase() || null);
        return;
      }
      const job = this.jobs.get(identity.id);
      // Late acknowledgements never create a job or revive a timed-out result.
      // A rejection after observing actual execution is not native stop proof.
      if (job?.session === session && job.requestId === frame.request_id.toLowerCase()
        && !(job.observedActive && frame.outcome === 'rejected')) job.endExecution(receiverResult(frame));
    });
    socket.on('close', () => this.disconnect(session));
    socket.on('error', () => this.disconnect(session));
  }

  trackExecution({ requestId, identity, session, endActivity, recovered = false, resolveResult = () => {} }) {
    let resolveEnded;
    const ended = new Promise(resolve => { resolveEnded = resolve; });
    const job = { requestId, identity, session, recovered, observedActive: recovered,
      ended, settled: false, executionEnded: false, cancelRequested: false, deadlineExpired: false,
      resolveResult: (value) => { if (!job.settled) { job.settled = true; resolveResult(value); } },
      endExecution: (value) => {
        if (job.executionEnded) return;
        job.nativeProof = true;
        if (!this.reservations.clear(job.identity, job.requestId)) {
          job.resolveResult(actionUncertain());
          return;
        }
        job.executionEnded = true;
        clearTimeout(job.timer);
        if (this.jobs.get(identity.id) === job) this.jobs.delete(identity.id);
        endActivity();
        // Recovery has no original waiting caller and can never claim success.
        job.resolveResult(job.recovered ? actionUncertain() : value);
        resolveEnded();
      },
    };
    this.jobs.set(identity.id, job);
    return job;
  }

  observeExecution(session, activeRequestId) {
    const identity = session.identity;
    let job = this.jobs.get(identity.id);
    // A newly verified credential binding cannot release a different binding's
    // unresolved speech. Retain that conservative reservation for investigation.
    if (job && !sameRobotIdentity(job.identity, identity)) return;
    if (activeRequestId) {
      const newlyObserved = !job || job.requestId !== activeRequestId;
      if (job && job.requestId !== activeRequestId) {
        // Native startup may replace an unreadable durable marker with a new
        // recovery UUID. Retain the same reservation without any zero-count
        // snapshot; only its stop correlation changes, never its speech payload.
        job.resolveResult(actionUncertain());
        clearTimeout(job.timer);
        this.reservations.reserve(identity, activeRequestId);
        this.restoreUnknownReservation();
        job.requestId = activeRequestId;
        job.recovered = true;
        job.deadlineExpired = false;
        job.cancelRequested = false;
      }
      if (!job) {
        this.reservations.reserve(identity, activeRequestId);
        this.restoreUnknownReservation();
        if (this.unknownReservation) return;
        const endActivity = this.activity.trackExisting('robot-action');
        if (!endActivity) return;
        job = this.trackExecution({ requestId: activeRequestId, identity, session, endActivity, recovered: true });
      } else {
        if (job.session !== session) job.cancelRequested = false;
        job.session = session;
        job.observedActive = true;
      }
      if (newlyObserved) {
        // Account's ledger remains authoritative; bound these extra transport
        // tombstones independently without dropping observed execution counts.
        for (const [id, expiresAt] of this.seenRequests) if (expiresAt <= this.now()) this.seenRequests.delete(id);
        if (this.seenRequests.size < this.maxSeenRequests) this.seenRequests.set(activeRequestId, this.now() + 10 * 60_000);
      }
      return;
    }
    // A fresh connection's idle marker proves stop even before the old deadline.
    // On the original connection, ignore idle status that preceded dispatch until
    // actual execution was observed or the native deadline has expired.
    if (job && !session.busy && (job.recovered || job.observedActive || job.nativeProof
      || job.deadlineExpired || job.session !== session)) {
      job.endExecution(actionUncertain(job.deadlineExpired ? 'timeout' : 'confirmation_lost'));
    }
  }

  restoreUnknownReservation() {
    if (!this.unknownReservation && this.reservations.unknown) {
      this.unknownReservation = true;
      this.activity.trackExisting('robot-action');
    }
  }

  disconnect(session) {
    if (this.sessions.get(session.identity.id) === session) this.sessions.delete(session.identity.id);
    const job = this.jobs.get(session.identity.id);
    if (job?.session === session) {
      // Speech may already be playing. The native receiver stops on disconnect,
      // but without its acknowledgement retain admission until native idle.
      job.resolveResult(actionUncertain());
    }
  }

  sessionFor(identity) {
    const wanted = robotIdentity(identity);
    const session = wanted && this.sessions.get(wanted.id);
    if (!session || !sameRobotIdentity(wanted, session.identity) || !session.ready
      || session.socket.readyState !== WebSocket.OPEN || session.expiresAt <= this.now()
      || this.now() - session.lastStatusAt > this.statusMaxAgeMs) return null;
    return session;
  }

  status(identity) {
    const wanted = robotIdentity(identity);
    const session = this.sessionFor(wanted);
    return { online: !!session || (!!wanted && !!this.verifiedVoice.get(wanted.id)),
      busy: !!wanted && (this.unknownReservation || !!this.voice.get(wanted.id) || this.pending.has(wanted.id)
        || this.jobs.has(wanted.id) || !!session?.busy),
      announcements_supported: !!session && this.reservations.healthy };
  }

  reserveVoice(auth, { verifiedIdentity } = {}) {
    const id = typeof auth?.id === 'string' ? auth.id : null;
    if (!id) return () => {};
    const pending = this.pending.get(id);
    if (pending) pending.cancelled = true;
    this.voice.set(id, (this.voice.get(id) || 0) + 1);
    const verified = sameRobotIdentity(robotIdentity(auth), verifiedIdentity);
    if (verified) this.verifiedVoice.set(id, (this.verifiedVoice.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.voice.get(id) || 1) - 1;
      if (remaining) this.voice.set(id, remaining); else this.voice.delete(id);
      if (verified) {
        const verifiedRemaining = (this.verifiedVoice.get(id) || 1) - 1;
        if (verifiedRemaining) this.verifiedVoice.set(id, verifiedRemaining); else this.verifiedVoice.delete(id);
      }
    };
  }

  async prepareVoice(auth, { interrupt = true, verifiedIdentity } = {}) {
    if (this.unknownReservation) return false;
    const job = this.jobs.get(auth?.id);
    if (!job) return true;
    if (!interrupt || !sameRobotIdentity(verifiedIdentity, job.identity)) return false;
    if (!job.cancelRequested && job.session?.socket.readyState === WebSocket.OPEN) {
      job.cancelRequested = true;
      try {
        job.session.socket.send(JSON.stringify({ v: ROBOT_ACTION_VERSION, type: 'cancel',
          request_id: job.requestId, reason: 'voice' }));
      } catch { /* No replay; admission remains held until native final/fresh idle. */ }
    }
    let timer;
    await Promise.race([job.ended, new Promise(resolve => { timer = setTimeout(resolve, this.voiceInterruptTimeoutMs); })]);
    clearTimeout(timer);
    return !this.jobs.has(auth?.id);
  }

  async announce(input) {
    const invalid = validateAnnouncement(input, this.now());
    if (invalid) return actionError(invalid);
    const identity = robotIdentity(input.identity);
    const requestId = input.requestId.toLowerCase();
    // This bounded cache is defensive transport deduplication. Account's
    // persisted single-use ledger is the restart-safe authority; never a queue.
    for (const [id, expiresAt] of this.seenRequests) if (expiresAt <= this.now()) this.seenRequests.delete(id);
    if (this.seenRequests.has(requestId)) return actionError('duplicate_request');
    if (this.seenRequests.size >= this.maxSeenRequests) return actionError('busy');
    this.seenRequests.set(requestId, this.now() + 10 * 60_000);
    if (!this.enabled || this.closed || !this.sessionFor(identity)) return actionError('robot_offline');
    const verified = await verifyRobotActionIdentity(identity, this.config.accountUrl, {
      fetchImpl: this.fetch, timeoutMs: this.config.accountVerifyTimeoutMs,
      signal: AbortSignal.timeout(Math.max(1, input.deadline - this.now())),
    });
    if (input.deadline <= this.now()) return actionError('expired');
    if (!verified) return actionError('unverified_robot');
    const preparedSession = this.sessionFor(verified);
    if (!preparedSession || this.closed) return actionError('robot_offline');
    if (this.status(verified).busy) return actionError('busy');
    if (!this.reservations.healthy) return actionError('unavailable');
    if (!this.reservations.entries.has(verified.id) && this.reservations.entries.size >= this.reservations.maxEntries) return actionError('busy');
    const pending = { identity: verified, requestId, session: preparedSession, cancelled: false };
    this.pending.set(verified.id, pending);
    if (!this.reservations.reserve(verified, requestId)) {
      this.restoreUnknownReservation();
      this.pending.delete(verified.id);
      this.recoverPreparation(pending);
      return actionError('unavailable');
    }
    if (input.deadline <= this.now()) return this.rollbackPreparation(pending, actionError('expired'));
    // Identity can remain unchanged across a household transfer. Ask Account
    // to re-check the exact persisted action's live permission and binding after
    // the asynchronous identity lookup, immediately before native admission.
    const authorization = await this.authorizeAction({ ...input, identity: verified, requestId });
    if (input.deadline <= this.now()) return this.rollbackPreparation(pending, actionError('expired'));
    if (!authorization.allowed) return this.rollbackPreparation(pending, actionError(authorization.code));
    const session = this.sessionFor(verified);
    if (this.closed || !session || session !== preparedSession) return this.rollbackPreparation(pending, actionError('robot_offline'));
    if (pending.cancelled || this.voice.get(verified.id) || this.jobs.has(verified.id) || session.busy
      || !this.reservations.healthy) return this.rollbackPreparation(pending, actionError('busy'));
    const endActivity = this.activity.begin('robot-action');
    if (!endActivity) return this.rollbackPreparation(pending, actionError('server_draining'));
    if (input.deadline <= this.now()) {
      endActivity();
      return this.rollbackPreparation(pending, actionError('expired'));
    }
    this.pending.delete(verified.id);
    // There is no await between the final busy check, reservation and send.
    let resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const job = this.trackExecution({ requestId, identity: verified, session, endActivity, resolveResult });
    job.timer = setTimeout(() => {
      job.deadlineExpired = true;
      job.resolveResult(actionUncertain('timeout'));
      if (job.session.socket.readyState === WebSocket.OPEN) {
        try { job.session.socket.send(JSON.stringify({ v: ROBOT_ACTION_VERSION, type: 'cancel',
          request_id: requestId, reason: 'deadline' })); } catch { /* Native idle remains required. */ }
      }
      // Expiry limits execution and settles the request, but a failed native stop
      // is never proof of completion. Keep deployment and voice admission held.
    }, Math.max(1, input.deadline - this.now()));
    job.timer.unref?.();
    try {
      session.socket.send(JSON.stringify({ v: ROBOT_ACTION_VERSION, type: 'announce', request_id: requestId,
        text: input.text.trim(), deadline_ms: input.deadline }),
      (error) => { if (error) job.resolveResult(actionUncertain()); });
    } catch { job.resolveResult(actionUncertain()); }
    return result;
  }

  recoverPreparation(pending) {
    if (this.jobs.has(pending.identity.id) || !this.reservations.entries.has(pending.identity.id)) return;
    this.trackExecution({ ...pending, recovered: true, endActivity: this.activity.trackExisting('robot-action') });
  }

  rollbackPreparation(pending, result) {
    if (this.pending.get(pending.identity.id) === pending) this.pending.delete(pending.identity.id);
    // This path has never called native send. It cannot clear any observed or
    // dispatched job, including a different native UUID learned while awaiting
    // Account. A failed rollback still becomes durable execution quarantine.
    const entry = this.reservations.entries.get(pending.identity.id);
    if (!this.jobs.has(pending.identity.id) && entry?.requestId === pending.requestId
      && !this.reservations.clear(pending.identity, pending.requestId)) this.recoverPreparation(pending);
    return result;
  }

  async authorizeAction(input) {
    try {
      const timeout = AbortSignal.timeout(accountVerifyTimeout(this.config.accountVerifyTimeoutMs));
      const deadline = AbortSignal.timeout(Math.max(1, input.deadline - this.now()));
      const response = await this.fetch(`${this.config.accountUrl.replace(/\/$/, '')}/internal/home-assistant/robot-action/authorize`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenix-internal-token': this.peerToken },
        body: JSON.stringify(input), signal: AbortSignal.any([timeout, deadline]),
      });
      if (!response.ok) return { allowed: false, code: 'unavailable' };
      const result = await response.json();
      if (result.allowed === true) return { allowed: true };
      return { allowed: false, code: typeof result.code === 'string' && /^[a-z_]{1,40}$/.test(result.code)
        ? result.code : 'unavailable' };
    } catch { return { allowed: false, code: 'unavailable' }; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const job of this.jobs.values()) { clearTimeout(job.timer); job.resolveResult(actionUncertain()); }
    for (const session of this.sessions.values()) session.socket.terminate();
    this.sessions.clear();
    this.wss.close();
  }
}

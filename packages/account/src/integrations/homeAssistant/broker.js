import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { liveBinding, reconcileHomeAssistantBindings } from './bindings.js';
import {
  CAPABILITIES, ROUTE_CAPABILITIES, MAX_ACTION_TIMEOUT_MS, MAX_ANNOUNCEMENT_TEXT,
  isUuid, negotiatedCapabilities, normalizePhrase, rosterName, validatePreferences,
} from './protocol.js';

export const PROTOCOL_VERSION = 1;
export const CONNECTOR_PATH = '/api/home-assistant/connect';
export const COMMAND_TIMEOUT_MS = 7500;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 20_000;
const MAX_FRAME_BYTES = 8192;
const ACTION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ACTION_RECORDS = 5000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
// Keep v1's retired optional-field slot null so existing no-volume durable
// request hashes still identify the same payload after this protocol change.
const announcementHash = (robotId, text, deadline) => digest(JSON.stringify([robotId, 'announce', text.trim(), null, deadline]));
const constantEqual = (a, b) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
export const errorResult = (code, outcome = 'error') => ({ outcome, code, response_type: 'error', speech: '' });

export class HomeAssistantBroker {
  constructor(store, { now = Date.now, commandTimeoutMs = COMMAND_TIMEOUT_MS, robotAdapter = null } = {}) {
    this.store = store;
    this.now = now;
    this.commandTimeoutMs = commandTimeoutMs;
    // This adapter must prove native spoken completion. Notification queues
    // and socket-send acknowledgements do not meet this contract.
    this.robotAdapter = robotAdapter;
    this.sessions = new Map();
    this.pending = new Map();
    this.activeActions = new Map();
    this.attempts = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    this.wss.on('connection', (socket, _request, installation) => this.attach(socket, installation));
    this.timer = null;
    this.closed = false;
    this.recoverActions();
  }

  issueCode(owner, robotIds, name = 'Home Assistant') {
    if (!owner || owner.friendlyId || owner.isActive === false || owner.isDeleted) throw failure('forbidden', 403);
    if (!Array.isArray(robotIds) || !robotIds.length || robotIds.length > 20
      || new Set(robotIds).size !== robotIds.length || robotIds.some((id) => typeof id !== 'string')) {
      throw failure('select_robots');
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw failure('invalid_name');
    this.sweep();
    if ([...this.store.homeAssistantInstallations.values()].filter((row) => row.ownerId === owner._id && !row.revokedAt).length >= 4) {
      throw failure('installation_limit', 409);
    }
    const bindings = robotIds.map((id) => {
      const robot = this.store.accountByFriendlyId(id);
      const loops = [...this.store.loops.values()].filter((loop) => String(loop.robot) === String(robot?._id));
      const loop = loops.length === 1 ? loops[0] : null;
      const binding = { id: randomUUID(), accountId: robot?._id, loopId: loop?._id };
      if (!liveBinding(this.store, owner._id, binding)) throw failure('robot_not_owned', 403);
      if ([...this.store.homeAssistantInstallations.values()].some((row) => !row.revokedAt
        && row.bindings.some((existing) => existing.accountId === robot._id))) throw failure('robot_already_linked', 409);
      return binding;
    });
    // Generating another code replaces this owner's pending codes, making the
    // portal's current code unambiguous. The raw code is returned only here.
    for (const [id, row] of this.store.homeAssistantCodes) {
      if (row.ownerId === owner._id) this.store.homeAssistantCodes.delete(id);
    }
    const rawCode = randomBytes(10).toString('hex').toUpperCase();
    const row = { _id: randomUUID(), codeHash: digest(rawCode), ownerId: owner._id,
      bindings, name: name.trim(), expiresAt: this.now() + CODE_LIFETIME_MS };
    this.store.homeAssistantCodes.set(row._id, row);
    this.store.flush();
    return { code: rawCode.match(/.{4}/g).join('-'), expiresAt: row.expiresAt };
  }

  allowExchange(address) {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const key = address || 'unknown';
    if (!this.attempts.has(key) && this.attempts.size >= 2000) return false;
    const row = this.attempts.get(key) || { until: now + 15 * 60 * 1000, count: 0 };
    this.attempts.set(key, row);
    return ++row.count <= 30;
  }

  exchangeCode(code) {
    if (typeof code !== 'string' || code.length > 64) throw failure('invalid_code', 401);
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-F0-9]{20}$/.test(normalized)) throw failure('invalid_code', 401);
    this.sweep();
    const hash = digest(normalized);
    const pair = [...this.store.homeAssistantCodes].find(([, row]) => constantEqual(row.codeHash, hash));
    if (!pair) throw failure('invalid_code', 401);
    const [codeId, codeRow] = pair;
    if (codeRow.bindings.some((binding) => [...this.store.homeAssistantInstallations.values()].some((row) =>
      !row.revokedAt && row.bindings.some((existing) => existing.accountId === binding.accountId)))) {
      throw failure('robot_already_linked', 409);
    }
    const installationId = randomUUID();
    const credential = `${installationId}.${randomBytes(32).toString('base64url')}`;
    const row = { _id: installationId, ownerId: codeRow.ownerId, bindings: codeRow.bindings,
      name: codeRow.name, credentialHash: digest(credential), createdAt: this.now(), revokedAt: null,
      announcementsEnabled: false };
    // Consume the code and persist the credential verifier in the same write.
    this.store.homeAssistantCodes.delete(codeId);
    this.store.homeAssistantInstallations.set(installationId, row);
    try { this.store.flush(); }
    catch (error) {
      this.store.homeAssistantInstallations.delete(installationId);
      this.store.homeAssistantCodes.set(codeId, codeRow);
      throw error;
    }
    return { v: PROTOCOL_VERSION, installation_id: installationId, credential };
  }

  authenticate(authorization) {
    if (typeof authorization !== 'string' || authorization.length > 200 || !authorization.startsWith('Bearer ')) return null;
    const token = authorization.slice(7);
    const id = token.split('.')[0];
    const row = this.store.homeAssistantInstallations.get(id);
    if (!row || row.revokedAt || !constantEqual(row.credentialHash, digest(token))) return null;
    if (!row.bindings.every((binding) => liveBinding(this.store, row.ownerId, binding))) {
      this.revoke(row, 'ownership_changed');
      return null;
    }
    return row;
  }

  resolveRobot(identity) {
    if (!identity || typeof identity.id !== 'string' || typeof identity.accessKeyId !== 'string'
      || typeof identity.friendlyId !== 'string') return null;
    const robot = this.store.accounts.get(identity.id);
    if (!robot?.friendlyId || robot.isDeleted || robot.isActive === false
      || robot.accessKeyId !== identity.accessKeyId || robot.friendlyId !== identity.friendlyId) return null;
    return robot;
  }

  selection(identity) {
    const robot = this.resolveRobot(identity);
    if (!robot) throw failure('unverified_robot', 403);
    this.sweep();
    for (const row of this.store.homeAssistantInstallations.values()) {
      const binding = row.bindings.find((item) => item.accountId === robot._id);
      if (!row.revokedAt && binding && liveBinding(this.store, row.ownerId, binding)) return { row, binding };
    }
    return null;
  }

  selectionDetails(identity) {
    const selected = this.selection(identity);
    if (!selected) return { enabled: false };
    const session = this.sessions.get(selected.row._id);
    const capabilities = session?.ready ? ROUTE_CAPABILITIES.filter((item) => session.capabilities.includes(item)) : [];
    const until = capabilities.includes('follow_up') ? session.preferences.followUp.get(selected.binding.id) || 0 : 0;
    return { enabled: true, capabilities,
      shortcuts: capabilities.includes('routine_shortcuts') ? session.preferences.shortcuts.map((item) => ({ ...item })) : [],
      follow_up: { available: until > this.now(), expires_at_ms: until > this.now() ? until : 0 } };
  }

  status(owner) {
    this.sweep();
    return { installations: [...this.store.homeAssistantInstallations.values()]
      .filter((row) => row.ownerId === owner._id && !row.revokedAt)
      .map((row) => {
        const session = this.sessions.get(row._id);
        return { id: row._id, name: row.name, createdAt: row.createdAt,
          connected: !!session?.ready, lastConnectedAt: row.lastConnectedAt || null,
          haVersion: session?.haVersion || null,
          announcementsEnabled: row.announcementsEnabled === true,
          robots: row.bindings.map((binding) => this.store.accounts.get(binding.accountId)?.friendlyId).filter(Boolean) };
      }),
      pending: [...this.store.homeAssistantCodes.values()].filter((row) => row.ownerId === owner._id)
        .map((row) => ({ expiresAt: row.expiresAt })) };
  }

  setAnnouncements(owner, installationId, enabled) {
    this.sweep();
    const row = this.store.homeAssistantInstallations.get(installationId);
    if (!row || row.revokedAt || row.ownerId !== owner._id) throw failure('not_found', 404);
    if (typeof enabled !== 'boolean') throw failure('invalid_permission');
    const previous = row.announcementsEnabled;
    row.announcementsEnabled = enabled;
    try { this.store.flush(); }
    catch (error) { row.announcementsEnabled = previous; throw error; }
    void this.sendRoster(this.sessions.get(row._id));
    return { announcementsEnabled: enabled };
  }

  revoke(row, reason = 'owner_revoked') {
    if (!row.revokedAt) {
      row.revokedAt = this.now(); row.reason = reason;
      this.store.flush();
    }
    const session = this.sessions.get(row._id);
    if (session) {
      this.disconnect(session);
      session.socket.close(4001, 'Credential revoked');
    }
  }

  upgrade(request, socket, head) {
    if (request.url !== CONNECTOR_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
    }
    const row = this.authenticate(request.headers.authorization);
    if (!row) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request, row));
  }

  attach(socket, row) {
    const previous = this.sessions.get(row._id);
    if (previous) { this.disconnect(previous); previous.socket.close(4002, 'Connection replaced'); }
    const session = { id: randomUUID(), socket, installationId: row._id, ready: false, lastPong: this.now(),
      capabilities: [], preferences: { shortcuts: [], followUp: new Map() }, rosterPending: false };
    this.sessions.set(row._id, session);
    socket.on('error', () => {}); // Network errors settle pending work on close.
    socket.on('close', () => this.disconnect(session));
    socket.on('pong', () => { session.lastPong = this.now(); });
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Error('binary');
        const frame = JSON.parse(data.toString());
        if (frame.v !== PROTOCOL_VERSION || frame.session_id !== session.id) throw new Error('protocol');
        if (frame.type === 'ready' && !session.ready && frame.agent === 'home_assistant'
          && typeof frame.ha_version === 'string' && frame.ha_version.length <= 32) {
          session.capabilities = negotiatedCapabilities(frame.capabilities);
          session.ready = true; session.haVersion = frame.ha_version;
          row.lastConnectedAt = this.now(); this.store.flush();
          void this.sendRoster(session); return;
        }
        if (!session.ready) throw new Error('not_ready');
        if (this.sessions.get(row._id) !== session || row.revokedAt
          || !row.bindings.every((binding) => liveBinding(this.store, row.ownerId, binding))) {
          this.revoke(row, 'ownership_changed'); return;
        }
        if (frame.type === 'preferences') {
          if (!session.capabilities.some((capability) => ['follow_up', 'routine_shortcuts'].includes(capability))) throw new Error('capabilities');
          session.preferences = validatePreferences(frame, row, session, this.now()); return;
        }
        if (frame.type === 'robot_action') {
          if (!session.capabilities.includes('robot_action')) throw new Error('capabilities');
          void this.robotAction(session, frame).then((result) => {
            this.sendFrame(session, { type: 'action_result', request_id: frame.request_id, robot_id: frame.robot_id, result });
          }).catch(() => {
            this.sendFrame(session, { type: 'action_result', request_id: frame.request_id, robot_id: frame.robot_id,
              result: errorResult('confirmation_lost', 'uncertain') });
          });
          return;
        }
        const pending = this.pending.get(frame.request_id);
        if (!pending || pending.session !== session) return; // Late or duplicate result.
        if (this.now() >= pending.deadline) { pending.finish(errorResult('confirmation_lost', 'uncertain')); return; }
        if (frame.type === 'accepted') { pending.accepted = true; return; }
        if (frame.type !== 'result') throw new Error('protocol');
        const result = frame.result;
        if (!result || !['success', 'partial', 'error', 'uncertain', 'expired'].includes(result.outcome)
          || !['action_done', 'query_answer', 'error'].includes(result.response_type)
          || typeof result.speech !== 'string' || result.speech.length > 500) throw new Error('result');
        pending.finish({ outcome: result.outcome, response_type: result.response_type, speech: result.speech,
          ...(typeof result.code === 'string' && /^[a-z0-9_]{1,64}$/.test(result.code) ? { code: result.code } : {}),
          ...(typeof result.conversation_id === 'string' && result.conversation_id.length <= 100
            ? { conversation_id: result.conversation_id } : {}),
          ...(Number.isSafeInteger(result.success_count) ? { success_count: result.success_count } : {}),
          ...(Number.isSafeInteger(result.failed_count) ? { failed_count: result.failed_count } : {}) });
      } catch { socket.close(4003, 'Invalid protocol message'); }
    });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'welcome', session_id: session.id,
      server_time_ms: this.now(), heartbeat_ms: HEARTBEAT_MS, capabilities: CAPABILITIES }));
  }

  sendFrame(session, frame) {
    if (!session?.ready || session.socket.readyState !== WebSocket.OPEN
      || this.sessions.get(session.installationId) !== session) return;
    try { session.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, session_id: session.id, ...frame }), () => {}); }
    catch { /* A reconnect never replays an action or result. */ }
  }

  identityFor(binding) {
    const robot = this.store.accounts.get(binding.accountId);
    return robot ? { id: robot._id, friendlyId: robot.friendlyId, accessKeyId: robot.accessKeyId } : null;
  }

  bindingBusy(bindingId) {
    return [...this.pending.values()].some((item) => item.bindingId === bindingId)
      || [...this.activeActions.values()].some((item) => item.bindingId === bindingId);
  }

  async robotStatus(binding, deadline = this.now() + 1500) {
    if (typeof this.robotAdapter?.status !== 'function') return { online: false, busy: false, announcements_supported: false };
    let timer;
    try {
      const status = Promise.resolve(this.robotAdapter.status(this.identityFor(binding)));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, Math.min(1500, deadline - this.now())));
      });
      const result = await Promise.race([status, timeout]);
      return { online: result?.online === true, busy: result?.busy === true,
        announcements_supported: result?.announcements_supported === true };
    } catch { return { online: false, busy: false, announcements_supported: false }; }
    finally { clearTimeout(timer); }
  }

  async sendRoster(session) {
    if (!session?.ready || !session.capabilities.includes('robot_roster')) return;
    if (session.rosterPending) { session.rosterAgain = true; return; }
    const row = this.store.homeAssistantInstallations.get(session.installationId);
    if (!row || row.revokedAt) return;
    session.rosterPending = true;
    try {
      const robots = await Promise.all(row.bindings.map(async (binding) => {
        const status = await this.robotStatus(binding);
        const loop = this.store.loops.get(binding.loopId);
        const name = rosterName(loop?.name);
        return { robot_id: binding.id, name,
          online: status.online, busy: status.busy || this.bindingBusy(binding.id),
          announcements_supported: status.announcements_supported,
          announcements_allowed: row.announcementsEnabled === true };
      }));
      // Status calls can outlive a revoke/ownership change. Do not publish an
      // old household snapshot when they finish.
      if (!row.revokedAt && row.bindings.every((binding) => liveBinding(this.store, row.ownerId, binding))) {
        this.sendFrame(session, { type: 'roster', robots });
      }
    } finally {
      session.rosterPending = false;
      if (session.rosterAgain) { session.rosterAgain = false; void this.sendRoster(session); }
    }
  }

  broadcastRoster() {
    return Promise.all([...this.sessions.values()].map((session) => this.sendRoster(session)));
  }

  recoverActions() {
    let changed = false;
    for (const row of this.store.homeAssistantActions.values()) {
      if (row.state !== 'finished') {
        // An interrupted process cannot know whether speech started. The
        // durable admission record is a tombstone, never a retry queue.
        row.state = 'finished'; row.finishedAt = this.now();
        row.result = errorResult('confirmation_lost', 'uncertain'); changed = true;
      }
    }
    if (changed) this.store.flush({ durable: true });
  }

  finishAction(record, result) {
    record.state = 'finished'; record.finishedAt = this.now(); record.result = result;
    try { this.store.flush({ durable: true }); }
    catch {
      // An earlier durable admission still forbids redispatch on restart.
      // Keep this process's duplicate replies conservative as well.
      record.result = errorResult('confirmation_lost', 'uncertain');
    }
    return record.result;
  }

  authorizeAction(input) {
    const denied = (code) => ({ allowed: false, code });
    if (input && Object.hasOwn(input, 'volume')) return denied('unsupported_volume');
    if (this.closed || !input || !isUuid(input.requestId)) return denied('invalid_action');
    let selected;
    try { selected = this.selection(input.identity); }
    catch { return denied('forbidden'); }
    if (!selected) return denied('revoked');
    const { row, binding } = selected;
    const key = `${row._id}:${input.requestId.toLowerCase()}`;
    const record = this.store.homeAssistantActions.get(key);
    const active = this.activeActions.get(key);
    const session = this.sessions.get(row._id);
    if (input.authorizationId !== key || !record || record.state !== 'dispatching' || record.robotId !== binding.id
      || !active || active.bindingId !== binding.id || active.installationId !== row._id) return denied('invalid_action');
    if (!session?.ready || active.sessionId !== session.id) return denied('offline');
    if (row.announcementsEnabled !== true) return denied('permission_disabled');
    if (record.deadline <= this.now()) return denied('expired');
    if (typeof input.text !== 'string' || input.text.length > MAX_ANNOUNCEMENT_TEXT
      || !Number.isSafeInteger(input.deadline)
      || announcementHash(binding.id, input.text, input.deadline) !== record.requestHash) {
      return denied('invalid_action');
    }
    return { allowed: true };
  }

  async robotAction(session, frame) {
    const now = this.now();
    // Native per-utterance volume is unsupported. Reject even 0/null rather
    // than silently dropping a caller's requested setting.
    if (Object.hasOwn(frame, 'volume')) return errorResult('unsupported_volume');
    if (!isUuid(frame.request_id) || !isUuid(frame.robot_id) || frame.action !== 'announce'
      || typeof frame.text !== 'string' || !frame.text.trim() || frame.text.length > MAX_ANNOUNCEMENT_TEXT
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(frame.text)
      || !Number.isSafeInteger(frame.deadline_ms) || frame.deadline_ms < 0
      || frame.deadline_ms > now + MAX_ACTION_TIMEOUT_MS) {
      return errorResult('invalid_action');
    }
    const installation = this.store.homeAssistantInstallations.get(session.installationId);
    if (this.closed || !installation || installation.revokedAt || !session.ready
      || this.sessions.get(session.installationId) !== session || !session.capabilities.includes('robot_action')
      || !installation.bindings.every((binding) => liveBinding(this.store, installation.ownerId, binding))) {
      return errorResult('revoked');
    }
    const requestId = frame.request_id.toLowerCase();
    const key = `${installation._id}:${requestId}`;
    const requestHash = announcementHash(frame.robot_id, frame.text, frame.deadline_ms);
    const existing = this.store.homeAssistantActions.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) return errorResult('request_id_conflict');
      return existing.result || errorResult('request_in_progress', 'uncertain');
    }
    if ([...this.store.homeAssistantActions.values()].filter((item) => item.installationId === installation._id).length >= MAX_ACTION_RECORDS) {
      return errorResult('busy');
    }
    // Persist admission before any asynchronous status check or native call.
    // Do not retain spoken content or Account identities in this ledger.
    const record = { _id: key, installationId: installation._id, requestId,
      robotId: frame.robot_id, requestHash, createdAt: now, deadline: frame.deadline_ms, state: 'admitted', result: null };
    this.store.homeAssistantActions.set(key, record);
    try { this.store.flush({ durable: true }); }
    catch { this.store.homeAssistantActions.delete(key); return errorResult('unavailable'); }
    const finish = (result) => this.finishAction(record, result);
    const binding = installation.bindings.find((item) => item.id === frame.robot_id);
    if (!binding || !liveBinding(this.store, installation.ownerId, binding)) return finish(errorResult('invalid_robot'));
    if (frame.deadline_ms <= now) return finish(errorResult('expired', 'expired'));
    if (installation.announcementsEnabled !== true) return finish(errorResult('permission_disabled'));
    if (typeof this.robotAdapter?.announce !== 'function' || typeof this.robotAdapter?.status !== 'function') {
      return finish(errorResult('unavailable'));
    }
    if (this.bindingBusy(binding.id)
      || [...this.activeActions.values()].filter((item) => item.installationId === installation._id).length >= 4) {
      return finish(errorResult('busy'));
    }
    // Reserve this robot while status is being checked so concurrent requests
    // cannot both pass an idle check or overlap a voice command.
    this.activeActions.set(key, { bindingId: binding.id, installationId: installation._id, sessionId: session.id });
    let dispatch;
    try {
      const status = await this.robotStatus(binding, frame.deadline_ms);
      // Ownership, permission and admission may have changed while awaiting
      // status. This is the last check before invoking the real dispatcher.
      if (this.closed || installation.revokedAt || !liveBinding(this.store, installation.ownerId, binding)) {
        return finish(errorResult('revoked'));
      }
      if (installation.announcementsEnabled !== true) return finish(errorResult('permission_disabled'));
      if (this.sessions.get(installation._id) !== session) return finish(errorResult('offline'));
      if (this.now() >= frame.deadline_ms) return finish(errorResult('expired', 'expired'));
      if (!status.online) return finish(errorResult('offline'));
      if (!status.announcements_supported) return finish(errorResult('unavailable'));
      if (status.busy) return finish(errorResult('busy'));
      record.state = 'dispatching';
      try { this.store.flush({ durable: true }); }
      catch { return finish(errorResult('unavailable')); }
      try {
        dispatch = Promise.resolve(this.robotAdapter.announce({ identity: this.identityFor(binding), requestId, authorizationId: record._id,
          text: frame.text.trim(), deadline: frame.deadline_ms }));
      } catch { return finish(errorResult('confirmation_lost', 'uncertain')); }
      // A connection loss or deadline cannot prove nonexecution once this
      // call starts. Native work remains reserved until the adapter settles.
      let timer;
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(errorResult('confirmation_lost', 'uncertain')), Math.max(1, frame.deadline_ms - this.now()));
      });
      const completed = dispatch.then((result) => {
        if (this.now() >= frame.deadline_ms) return errorResult('confirmation_lost', 'uncertain');
        if (result?.outcome === 'success' && result.confirmed === true) {
          return { outcome: 'success', response_type: 'action_done', speech: '' };
        }
        if (['error', 'expired'].includes(result?.outcome) && typeof result.code === 'string'
          && /^[a-z0-9_]{1,64}$/.test(result.code)) return errorResult(result.code, result.outcome);
        return errorResult('confirmation_lost', 'uncertain');
      }, () => errorResult('confirmation_lost', 'uncertain'));
      const result = await Promise.race([completed, expired]);
      clearTimeout(timer);
      return finish(result);
    } finally {
      const release = () => { this.activeActions.delete(key); void this.broadcastRoster(); };
      if (dispatch) void dispatch.then(release, release);
      else release();
    }
  }

  disconnect(session) {
    if (this.sessions.get(session.installationId) === session) this.sessions.delete(session.installationId);
    for (const item of this.pending.values()) {
      if (item.session === session) item.finish(errorResult('confirmation_lost', 'uncertain'));
    }
    session.preferences = { shortcuts: [], followUp: new Map() };
  }

  async command(identity, text, language = 'en', route = { kind: 'command' }) {
    const selection = this.selection(identity);
    if (!selection) return errorResult('not_linked');
    if (typeof text !== 'string' || !text.trim() || text.length > 500 || language !== 'en') return errorResult('invalid_command');
    const { row, binding } = selection;
    const session = this.sessions.get(row._id);
    if (!session?.ready || session.socket.readyState !== WebSocket.OPEN) return errorResult('offline');
    if (this.bindingBusy(binding.id)
      || [...this.pending.values()].filter((item) => item.session === session).length >= 4) return errorResult('busy');
    if (!route || !['command', 'query', 'follow_up', 'routine'].includes(route.kind)) return errorResult('invalid_route');
    if (route.kind === 'query' && !session.capabilities.includes('state_queries')) return errorResult('unsupported_route');
    if (route.kind === 'follow_up' && (!session.capabilities.includes('follow_up')
      || (session.preferences.followUp.get(binding.id) || 0) <= this.now())) return errorResult('follow_up_expired');
    if (route.kind === 'routine' && (!session.capabilities.includes('routine_shortcuts')
      || !session.preferences.shortcuts.some((item) => item.id === route.shortcut_id
        && normalizePhrase(item.phrase) === normalizePhrase(text)))) return errorResult('invalid_shortcut');
    const commandRoute = { kind: route.kind, ...(route.kind === 'routine' ? { shortcut_id: route.shortcut_id } : {}) };
    // A hint authorizes one selected follow-up. Sending a command consumes it
    // until HA supplies the next live context snapshot.
    session.preferences.followUp.delete(binding.id);
    const requestId = randomUUID();
    const deadline = this.now() + this.commandTimeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(errorResult('confirmation_lost', 'uncertain')), this.commandTimeoutMs);
      const finish = (result) => {
        if (!this.pending.has(requestId)) return;
        clearTimeout(timer); this.pending.delete(requestId); resolve(result);
      };
      this.pending.set(requestId, { session, bindingId: binding.id, deadline, finish });
      // A send error can occur after bytes were delivered. Never retry an
      // action or claim it failed just because its response is missing.
      try {
        session.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'command', session_id: session.id,
          request_id: requestId, robot_id: binding.id, text: text.trim(), language, deadline_ms: deadline,
          ...(session.capabilities.some((item) => ROUTE_CAPABILITIES.includes(item)) ? { route: commandRoute } : {}) }),
        (error) => { if (error) finish(errorResult('confirmation_lost', 'uncertain')); });
      } catch { finish(errorResult('confirmation_lost', 'uncertain')); }
    });
  }

  sweep() {
    const before = [...this.store.homeAssistantInstallations.values()].filter((row) => row.revokedAt).length;
    const codes = this.store.homeAssistantCodes.size;
    let pruned = false;
    for (const [id, row] of this.store.homeAssistantActions) {
      if (row.state === 'finished' && row.deadline < this.now()
        && row.finishedAt < this.now() - ACTION_RETENTION_MS) {
        this.store.homeAssistantActions.delete(id); pruned = true;
      }
    }
    reconcileHomeAssistantBindings(this.store, this.now());
    if (before !== [...this.store.homeAssistantInstallations.values()].filter((row) => row.revokedAt).length
      || codes !== this.store.homeAssistantCodes.size || pruned) this.store.flush();
    for (const [id, session] of this.sessions) {
      const row = this.store.homeAssistantInstallations.get(id);
      if (!row || row.revokedAt) { this.disconnect(session); session.socket.close(4001, 'Credential revoked'); }
    }
  }

  start() {
    this.timer = setInterval(() => {
      this.sweep();
      for (const session of this.sessions.values()) {
        if (this.now() - session.lastPong > HEARTBEAT_MS * 2) session.socket.terminate();
        else { session.socket.ping(); void this.sendRoster(session); }
      }
    }, HEARTBEAT_MS);
    this.timer.unref?.();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const session of this.sessions.values()) { this.disconnect(session); session.socket.close(1001, 'Server restarting'); }
    this.wss.close();
  }
}

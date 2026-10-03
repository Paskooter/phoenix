import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { liveBinding, reconcileHomeAssistantBindings } from './bindings.js';

export const PROTOCOL_VERSION = 1;
export const CONNECTOR_PATH = '/api/home-assistant/connect';
export const COMMAND_TIMEOUT_MS = 7500;
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 20_000;
const MAX_FRAME_BYTES = 8192;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const constantEqual = (a, b) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
export const errorResult = (code, outcome = 'error') => ({ outcome, code, response_type: 'error', speech: '' });

export class HomeAssistantBroker {
  constructor(store, { now = Date.now, commandTimeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    this.store = store;
    this.now = now;
    this.commandTimeoutMs = commandTimeoutMs;
    this.sessions = new Map();
    this.pending = new Map();
    this.attempts = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
    this.wss.on('connection', (socket, _request, installation) => this.attach(socket, installation));
    this.timer = null;
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
      name: codeRow.name, credentialHash: digest(credential), createdAt: this.now(), revokedAt: null };
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

  status(owner) {
    this.sweep();
    return { installations: [...this.store.homeAssistantInstallations.values()]
      .filter((row) => row.ownerId === owner._id && !row.revokedAt)
      .map((row) => {
        const session = this.sessions.get(row._id);
        return { id: row._id, name: row.name, createdAt: row.createdAt,
          connected: !!session?.ready, lastConnectedAt: row.lastConnectedAt || null,
          haVersion: session?.haVersion || null,
          robots: row.bindings.map((binding) => this.store.accounts.get(binding.accountId)?.friendlyId).filter(Boolean) };
      }),
      pending: [...this.store.homeAssistantCodes.values()].filter((row) => row.ownerId === owner._id)
        .map((row) => ({ expiresAt: row.expiresAt })) };
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
    const session = { id: randomUUID(), socket, installationId: row._id, ready: false, lastPong: this.now() };
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
          session.ready = true; session.haVersion = frame.ha_version;
          row.lastConnectedAt = this.now(); this.store.flush(); return;
        }
        if (!session.ready) throw new Error('not_ready');
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
      server_time_ms: this.now(), heartbeat_ms: HEARTBEAT_MS }));
  }

  disconnect(session) {
    if (this.sessions.get(session.installationId) === session) this.sessions.delete(session.installationId);
    for (const item of this.pending.values()) {
      if (item.session === session) item.finish(errorResult('confirmation_lost', 'uncertain'));
    }
  }

  async command(identity, text, language = 'en') {
    const selection = this.selection(identity);
    if (!selection) return errorResult('not_linked');
    if (typeof text !== 'string' || !text.trim() || text.length > 500 || language !== 'en') return errorResult('invalid_command');
    const { row, binding } = selection;
    const session = this.sessions.get(row._id);
    if (!session?.ready || session.socket.readyState !== WebSocket.OPEN) return errorResult('offline');
    if ([...this.pending.values()].some((item) => item.bindingId === binding.id)
      || [...this.pending.values()].filter((item) => item.session === session).length >= 4) return errorResult('busy');
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
          request_id: requestId, robot_id: binding.id, text: text.trim(), language, deadline_ms: deadline }),
        (error) => { if (error) finish(errorResult('confirmation_lost', 'uncertain')); });
      } catch { finish(errorResult('confirmation_lost', 'uncertain')); }
    });
  }

  sweep() {
    const before = [...this.store.homeAssistantInstallations.values()].filter((row) => row.revokedAt).length;
    const codes = this.store.homeAssistantCodes.size;
    reconcileHomeAssistantBindings(this.store, this.now());
    if (before !== [...this.store.homeAssistantInstallations.values()].filter((row) => row.revokedAt).length
      || codes !== this.store.homeAssistantCodes.size) this.store.flush();
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
        else session.socket.ping();
      }
    }, HEARTBEAT_MS);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) { this.disconnect(session); session.socket.close(1001, 'Server restarting'); }
    this.wss.close();
  }
}

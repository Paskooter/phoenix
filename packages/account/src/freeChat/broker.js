import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { InferenceLedger, emptyCounters } from '../agentInference/ledger.js';

// USD budgets are admission ceilings, not prices or member tiers. Reuse the
// inference prototype's full-context reservation and never refund uncertainty.
export const GLOBAL_DAILY_CAP_MICRO_USD = 5_000_000;
export const FREE_MODEL = 'google/gemma-4-26b-a4b-it:free';
export const OVERFLOW_MODEL = 'deepseek/deepseek-v4.1-flash';
export const LIMITS = Object.freeze({ accountDailyRequests: 50, requestsPerMinute: 4,
  globalDailyRequests: 5000, globalRequestsPerMinute: 60, freeDailyRequests: 900, freeRequestsPerMinute: 20,
  accountDailyCapMicroUsd: 500_000, dailyCapMicroUsd: GLOBAL_DAILY_CAP_MICRO_USD,
  lifetimeCapMicroUsd: 150_000_000, globalConcurrency: 2, bodyTimeoutMs: 5000,
  providerTimeoutMs: 20000, maxResponseBytes: 65536 });
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export class ChatError extends Error {
  constructor(code, status = 400, retryAfter) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export function fail(code, status, retry) { throw new ChatError(code, status, retry); }
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

function validate(body) {
  if (!object(body) || Object.keys(body).some(k => !['text', 'detail', 'history'].includes(k))
    || !text(body.text, 2000) || !['short', 'detailed'].includes(body.detail ?? 'short')
    || (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 6
      || body.history.some(row => !object(row) || Object.keys(row).some(k => !['role', 'content'].includes(k))
        || !['user', 'assistant'].includes(row.role) || !text(row.content, 2200))))) fail('invalid_chat');
  return { text: body.text.trim(), detail: body.detail ?? 'short', history: body.history || [] };
}
async function responseJson(response, maxBytes) {
  const chunks = []; let size = 0; const reader = response.body?.getReader();
  if (!reader) fail('provider_invalid_response', 502);
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maxBytes) fail('provider_response_too_large', 502);
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('provider_invalid_response', 502); }
}

export class FreeChat {
  constructor(store, options = {}) {
    this.store = store; this.config = { ...LIMITS, ...options };
    this.now = options.now || Date.now; this.inFlight = new Map(); this.addresses = new Map();
    this.defaultEnabled = options.defaultEnabled !== false;
    // Account preference is ON even before an operator provisions inference.
    // Missing provisioning never creates/resets counters or spends money.
    this.ready = !!(options.ledgerFile && options.provider?.apiKey && options.encryptionKey);
    if (!this.ready) return;
    for (const key of Object.keys(LIMITS)) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] < (key.includes('Cap') ? 0 : 1)
        || this.config[key] > LIMITS[key]) throw new Error('free_chat_limits_invalid');
    }
    this.secret = Buffer.from(options.encryptionKey);
    if (this.secret.length !== 32) throw new Error('free_chat_encryption_key_required');
    this.endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    if (options.provider.mockUrl) {
      const url = new URL(options.provider.mockUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('free_chat_mock_must_be_loopback');
      this.endpoint = url.href;
    }
    this.ledger = new InferenceLedger(options.ledgerFile);
  }
  human(account) {
    if (!account || account.isActive !== true || account.isDeleted || account.friendlyId) fail('account_unavailable', 403);
    return account;
  }
  current(id) { return this.human(this.store.accounts.get(id)); }
  row(account, create = false) {
    this.human(account);
    if (!this.ledger) return null;
    const key = hash(account._id);
    if (!this.ledger.state.accounts[key] && create) {
      if (Object.keys(this.ledger.state.accounts).length >= 10000) fail('chat_unavailable', 503);
      this.ledger.state.accounts[key] = { ...emptyCounters(), policy: null, tokenHash: null, tokenExpires: 0, authVersion: 0 };
    }
    return this.ledger.state.accounts[key];
  }
  status(account) {
    const row = this.row(account); const day = new Date(this.now()).toISOString().slice(0, 10);
    return { enabled: row?.freeChatEnabled ?? account.freeChatEnabled ?? this.defaultEnabled,
      available: this.ready && !this.closed && !this.ledger.failed, ownKey: !!row?.sealedKey,
      detail: row?.detail || account.freeChatDetail || 'short',
      limits: { requestsPerDay: row?.sealedKey ? null : this.config.accountDailyRequests,
        requestsPerMinute: row?.sealedKey ? 20 : this.config.requestsPerMinute,
        requestsUsed: row?.day === day ? row.dayRequests : 0 } };
  }
  setSettings(account, body) {
    this.current(account._id);
    if (!object(body) || !Object.keys(body).length || Object.keys(body).some(k => !['enabled', 'detail'].includes(k))
      || ('enabled' in body && typeof body.enabled !== 'boolean') || ('detail' in body && !['short', 'detailed'].includes(body.detail))) fail('invalid_settings');
    if (this.ledger) {
      const row = this.row(account, true);
      if ('enabled' in body) row.freeChatEnabled = body.enabled;
      if ('detail' in body) row.detail = body.detail;
      this.ledger.save();
    } else {
      // Classic choice works without any provider or spend-ledger setup.
      const next = { ...account, ...('enabled' in body ? { freeChatEnabled: body.enabled } : {}),
        ...('detail' in body ? { freeChatDetail: body.detail } : {}) };
      this.store.accounts.set(account._id, next);
      try { this.store.flush(); } catch { this.store.accounts.set(account._id, account); throw new ChatError('chat_unavailable', 503); }
    }
    this.inFlight.get(hash(account._id))?.abort();
    return this.status(this.current(account._id));
  }
  setKey(account, body) {
    this.human(account); this.available();
    if (!object(body) || Object.keys(body).some(k => k !== 'key')
      || !(body.key === null || typeof body.key === 'string' && /^[\x21-\x7e]{16,512}$/.test(body.key))) fail('invalid_key');
    const row = this.row(account, true); const aad = hash(account._id);
    if (body.key === null) delete row.sealedKey;
    else {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
      cipher.setAAD(Buffer.from(aad));
      const encrypted = Buffer.concat([cipher.update(body.key, 'utf8'), cipher.final()]);
      row.sealedKey = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }
    this.ledger.save(); this.inFlight.get(aad)?.abort();
    return this.status(account); // Never return the key or its ciphertext.
  }
  providerKey(account) {
    const sealed = this.row(account)?.sealedKey;
    if (!sealed) return this.config.provider.apiKey;
    try {
      const bytes = Buffer.from(sealed, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.secret, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(hash(account._id))); decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    } catch { fail('key_unavailable', 503); }
  }
  available() { if (!this.ready || this.closed || this.ledger.failed) fail('chat_unavailable', 503); }
  allowAddress(address) {
    const minute = Math.floor(this.now() / 60000); const key = hash(address);
    if (this.addresses.size >= 4096) for (const [id, row] of this.addresses) if (row.minute !== minute) this.addresses.delete(id);
    let row = this.addresses.get(key);
    if (!row || row.minute !== minute) {
      if (this.addresses.size >= 4096) fail('rate_limited', 429, 60);
      this.addresses.set(key, row = { minute, count: 0 });
    }
    if (++row.count > 120) fail('rate_limited', 429, 60);
  }
  reserve(account, paid) {
    this.available(); const row = this.row(account, true); const state = this.ledger.state; const c = this.config;
    const now = this.now(); const day = new Date(now).toISOString().slice(0, 10); const minute = Math.floor(now / 60000);
    if (day < state.day || minute < state.minute || day < row.day || minute < row.minute) fail('clock_unavailable', 503);
    for (const counter of [state, row]) {
      if (counter.day !== day) { counter.day = day; counter.dayRequests = 0; counter.dayMicroUsd = 0; counter.freeDayRequests = 0; }
      if (counter.minute !== minute) { counter.minute = minute; counter.minuteRequests = 0; counter.freeMinuteRequests = 0; }
    }
    const ownKey = !!row.sealedKey;
    if (row.minuteRequests >= (ownKey ? 20 : c.requestsPerMinute)
      || state.minuteRequests >= c.globalRequestsPerMinute) fail('rate_limited', 429, 60);
    if (!ownKey && (row.dayRequests >= c.accountDailyRequests || state.dayRequests >= c.globalDailyRequests)) fail('daily_quota_exhausted', 429);
    if (!paid && !ownKey && ((state.freeDayRequests || 0) >= c.freeDailyRequests
      || (state.freeMinuteRequests || 0) >= c.freeRequestsPerMinute)) return false;
    // Pinned full upstream context (1,048,576) at $0.05/M input plus
    // 512 output at $0.50/M. Integer ceiling; provider max_price matches.
    const amount = paid && !ownKey ? Number((1048576n * 50000n + 512n * 500000n + 999999n) / 1000000n) : 0;
    if (amount > c.dailyCapMicroUsd - state.dayMicroUsd || amount > c.lifetimeCapMicroUsd - state.lifetimeMicroUsd) fail('global_budget_exhausted', 503);
    if (amount > c.accountDailyCapMicroUsd - row.dayMicroUsd) fail('account_budget_exhausted', 429);
    state.lifetimeMicroUsd += amount; state.dayMicroUsd += amount; row.dayMicroUsd += amount;
    row.dayRequests++; row.minuteRequests++;
    if (!ownKey) state.dayRequests++;
    state.minuteRequests++;
    if (!paid && !ownKey) { state.freeDayRequests = (state.freeDayRequests || 0) + 1; state.freeMinuteRequests = (state.freeMinuteRequests || 0) + 1; }
    this.ledger.save(); // Synchronous fsync/rename/directory fsync BEFORE dispatch; never refund.
    return true;
  }
  async complete(account, body, recheck = () => this.current(account._id), signal) {
    account = recheck(); const request = validate(body); const status = this.status(account);
    if (!status.enabled) return { mode: 'classic' };
    this.available(); const key = hash(account._id);
    if (signal?.aborted) fail('request_cancelled', 499);
    if (this.inFlight.has(key)) fail('account_busy', 429, 1);
    if (this.inFlight.size >= this.config.globalConcurrency) fail('chat_busy', 503, 1);
    const controller = new AbortController(); this.inFlight.set(key, controller);
    const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    let timer;
    const detail = body.detail ?? status.detail;
    try {
      const apiKey = this.providerKey(account);
      for (const paid of [false, true]) {
        if (controller.signal.aborted) fail('request_cancelled', 499);
        account = recheck(); if (!this.status(account).enabled) fail('chat_disabled', 403);
        if (!this.reserve(account, paid)) continue;
        // Like the shared inference prototype, start the provider deadline
        // after the first durable reservation, not while local fsync blocks.
        // Reuse it across the free/overflow sequence; never reset on retry.
        if (!timer) timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.providerTimeoutMs);
        let response;
        try {
          response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: paid ? OVERFLOW_MODEL : FREE_MODEL, stream: false,
              max_tokens: detail === 'detailed' ? 512 : 160, plugins: [],
              messages: [{ role: 'system', content: 'You are Jibo, a friendly conversational robot. Only talk: no tools, browsing, search, actions, or claims of live access. Never claim to have done things. Reply as JSON with text (plain spoken words, no markup) and keepTalking (boolean, true only when a reply is needed). ' + (detail === 'detailed' ? 'Give at most six short sentences.' : 'Give one or two short sentences.') },
                ...request.history, { role: 'user', content: request.text }],
              response_format: { type: 'json_object' },
              // Owner policy 2026-10-30: permissive data retention on OpenRouter.
              // data_collection:'deny' + zdr filtered providers and reduced free-model
              // availability; the owner explicitly prefers availability over provider
              // data collection limits here. Retained as env overrides if ever needed.
              provider: { allow_fallbacks: false, require_parameters: true,
                data_collection: process.env.PHOENIX_FREE_CHAT_DATA_COLLECTION === 'deny' ? 'deny' : 'allow',
                zdr: process.env.PHOENIX_FREE_CHAT_DATA_COLLECTION === 'deny',
                max_price: { prompt: paid ? 0.05 : 0, completion: paid ? 0.50 : 0, request: 0, image: 0 } } }) });
        } catch { if (!paid && !controller.signal.aborted) continue; fail('provider_unavailable', 503); }
        if (!response.ok) {
          const overflow = !paid && [404, 408, 429, 500, 502, 503, 504].includes(response.status);
          await response.body?.cancel(); if (overflow) continue;
          fail('provider_unavailable', 503);
        }
        const result = await responseJson(response, this.config.maxResponseBytes);
        const choice = result?.choices?.[0]; const message = choice?.message;
        let reply;
        try { reply = JSON.parse(message.content); } catch { fail('provider_invalid_response', 502); }
        if (choice.finish_reason !== 'stop' || message.tool_calls || message.function_call || !object(reply)
          || Object.keys(reply).some(k => !['text', 'keepTalking'].includes(k)) || !text(reply.text, detail === 'detailed' ? 2200 : 800)
          || typeof reply.keepTalking !== 'boolean') fail('provider_invalid_response', 502);
        account = recheck();
        if (!this.status(account).enabled || controller.signal.aborted) fail('request_cancelled', 499);
        return { mode: 'ai', text: reply.text.trim(), keepTalking: reply.keepTalking, detail };
      }
      fail('provider_unavailable', 503);
    } catch (error) {
      if (timedOut) fail('provider_timeout', 504);
      if (controller.signal.aborted) fail('request_cancelled', 499);
      if (error instanceof ChatError) throw error;
      fail('chat_unavailable', 503);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.inFlight.delete(key); }
  }
  close() { this.closed = true; for (const controller of this.inFlight.values()) controller.abort(); this.ledger?.close(); }
}

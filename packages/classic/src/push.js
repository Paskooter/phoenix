// `push` service (Push_20160729) — mobile push device registration and delivery.
//
// Mirrors jiborobot/srv-push-ws (pinned source, read via the Jibo archive):
//   - AccountController.createDevice/removeDevice  — device CRUD under one account
//   - AccountPush (Mongo)                          — the durable account->devices store
//   - MobileController.send                        — delivery dispatch by device.type
//   - ios2/android-fcm controllers                 — the replaceable provider seam
//   - PushTokenNotRegistered event handler         — token-invalidation downstream
//
// The original APNs/FCM providers and their credentials are dead, and no surviving
// mobile app exists. Phoenix therefore keeps registrations durable in an atomic JSON
// file (the local counterpart of the Mongo AccountPush collection) and routes
// delivery through an injected PushProvider. Tests inject a FixturePushProvider;
// a future real provider (APNs/FCM) only has to implement send() and optionally
// report invalid tokens. The robot-facing push goes over the entrypoint socket.

import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { sendAmz, sendAmzError, accessKeyIdFromAuth, ValidationException } from './awsJson.js';

const DEFAULT_FILE = join(tmpdir(), 'phoenix-push-devices.json');

// Source error catalogue (srv-push-ws src/errors/account.js + Boom.createWithCode).
export const PUSH_ERRORS = {
  ACCOUNT_NOT_FOUND: { statusCode: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' },
  DEVICE_NOT_FOUND: { statusCode: 404, code: 'DEVICE_NOT_FOUND', message: 'Device not found' },
};

const DEFAULT_PERSISTENCE = {
  chmod: chmodSync, exists: existsSync, mkdir: mkdirSync,
  readFile: readFileSync, rename: renameSync, unlink: unlinkSync, writeFile: writeFileSync,
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isoNow(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('push store clock returned an invalid date');
  return date.toISOString();
}

function boomError({ statusCode, code, message }) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/** The Device output shape (name/pushToken/type) that serializes on the wire. */
function deviceView(device) {
  return { name: device.name, pushToken: device.pushToken, type: device.type };
}

/**
 * Durable account -> devices[] store, the Phoenix counterpart of the source's
 * AccountPush Mongo collection. One account owns its device list; a pushToken is
 * globally single-owner (createDevice strips it from every other account). Each
 * mutation is atomically persisted to one JSON file (same pattern as NotificationStore).
 *
 * @param {string} [file]
 * @param {{ clock?: () => number|Date, persistence?: Partial<typeof DEFAULT_PERSISTENCE> }} [options]
 */
export class DeviceRegistry {
  constructor(file = process.env.ETCO_classic_pushFile || DEFAULT_FILE, options = {}) {
    this.file = file;
    this.persistence = { ...DEFAULT_PERSISTENCE, ...(options.persistence || {}) };
    this.clock = options.clock || (() => Date.now());
    this.accounts = new Map(); // accountId -> { accountId, devices: [{name,pushToken,type,isDeleted,created}] }
    this._load();
    this._committed = this._snapshot();
  }

  _load() {
    if (!this.persistence.exists(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(this.persistence.readFile(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`push store unreadable (${this.file}): ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`push store has an invalid root (${this.file})`);
    }
    for (const acc of raw.accounts || []) {
      if (!acc || typeof acc !== 'object') continue;
      this.accounts.set(String(acc.accountId), {
        accountId: acc.accountId,
        devices: Array.isArray(acc.devices) ? acc.devices.map((d) => ({ ...d })) : [],
      });
    }
  }

  _snapshot() {
    return { accounts: new Map([...this.accounts].map(([key, value]) => [key, clone(value)])) };
  }

  _restore(snapshot) {
    this.accounts = snapshot.accounts;
  }

  _commit(mutator) {
    const before = this._snapshot();
    try {
      const result = mutator();
      this.flush({ rollbackOnError: false });
      return result;
    } catch (error) {
      this._restore(before);
      throw error;
    }
  }

  /** Atomically replace the persisted file after a mutation. */
  flush({ rollbackOnError = true } = {}) {
    const output = { version: 1, accounts: [...this.accounts.values()].map((a) => clone(a)) };
    const parent = dirname(this.file);
    const temporary = `${this.file}.tmp`;
    let renamed = false;
    try {
      this.persistence.mkdir(parent, { recursive: true, mode: 0o700 });
      this.persistence.writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      this.persistence.chmod(temporary, 0o600);
      this.persistence.rename(temporary, this.file);
      renamed = true;
      this._committed = this._snapshot();
    } catch (error) {
      if (!renamed) {
        try { this.persistence.unlink(temporary); } catch { /* cleanup is best effort */ }
        if (rollbackOnError && this._committed) this._restore(this._committed);
      }
      throw error;
    }
  }

  _account(accountId) {
    return this.accounts.get(String(accountId)) || null;
  }

  /** Active (non-deleted) devices for an account, in the Device output shape. */
  activeDevices(accountId) {
    const acc = this._account(accountId);
    if (!acc) return [];
    return acc.devices.filter((d) => !d.isDeleted).map(deviceView);
  }

  /**
   * Source AccountController.createDevice: upsert by `name` within the account
   * (re-registering sets isDeleted=false and refreshes pushToken), then strip that
   * pushToken from every OTHER account (removeStalePushTokens — a token is owned by
   * at most one account). Implicitly creates the account when it does not exist.
   * Returns the account's active devices.
   */
  createDevice(accountId, { name, pushToken, type } = {}) {
    const key = String(accountId);
    this._commit(() => {
      let acc = this.accounts.get(key);
      if (!acc) {
        acc = { accountId: key, devices: [] };
        this.accounts.set(key, acc);
      }
      const existing = acc.devices.find((d) => d.name === name);
      if (existing) {
        existing.pushToken = pushToken;
        existing.isDeleted = false;
      } else {
        acc.devices.push({ name, pushToken, type, isDeleted: false, created: isoNow(this.clock) });
      }
      for (const [otherKey, other] of this.accounts) {
        if (otherKey === key) continue;
        if (other.devices.some((d) => d.pushToken === pushToken)) {
          other.devices = other.devices.filter((d) => d.pushToken !== pushToken);
        }
      }
      return true;
    });
    return this.activeDevices(accountId);
  }

  /**
   * Source AccountController.removeDevice: mark matching device(s) isDeleted=true.
   * ACCOUNT_NOT_FOUND when the account was never created; DEVICE_NOT_FOUND when no
   * device has that name. Returns the account's active devices.
   */
  removeDevice(accountId, name) {
    const key = String(accountId);
    const acc = this._account(key);
    if (!acc) throw boomError(PUSH_ERRORS.ACCOUNT_NOT_FOUND);
    if (!acc.devices.some((d) => d.name === name)) throw boomError(PUSH_ERRORS.DEVICE_NOT_FOUND);
    this._commit(() => {
      const current = this.accounts.get(key);
      for (const d of current.devices) if (d.name === name) d.isDeleted = true;
      return true;
    });
    return this.activeDevices(accountId);
  }

  /** Source token.not.registered handler -> accountCtrl.removeDeviceByToken. */
  removeDeviceByToken(pushToken) {
    this._commit(() => {
      for (const acc of this.accounts.values()) {
        acc.devices = acc.devices.filter((d) => d.pushToken !== pushToken);
      }
      return true;
    });
  }

  /** Source AccountController.listDevices: { accountId: activeDevices } for many ids. */
  listDevices(accountIds) {
    const ids = (Array.isArray(accountIds) ? accountIds : [accountIds]).map(String);
    const out = {};
    for (const id of ids) out[id] = this.activeDevices(id);
    return out;
  }

  /**
   * Source MobileEventHandler.notifyDevices -> MobileController.send: deliver one
   * notification to every active device of an account through the provider. Provider
   * failures are contained (caught+logged, never rethrown — source mobile.ctrl.js),
   * and a provider that reports an invalid token triggers the downstream
   * removeDeviceByToken once delivery has observed it.
   *
   * @param {PushProvider} [provider] defaults to a recording FixturePushProvider
   */
  async sendNotification(accountId, notification, provider) {
    const p = provider || new FixturePushProvider();
    if (typeof p.setInvalidTokenHandler === 'function') {
      p.setInvalidTokenHandler((pushToken) => {
        try { this.removeDeviceByToken(pushToken); } catch { /* contained (source logs) */ }
      });
    }
    const devices = this.activeDevices(accountId);
    await Promise.allSettled(devices.map((device) =>
      Promise.resolve().then(() => p.send({ device, notification })).catch(() => {})));
  }
}

/**
 * Replaceable push-delivery seam. A real APNs/FCM backend only needs to implement
 * send(); it may report an invalid (unregistered) token by calling, or wiring its
 * own not-registered detection to, the handler set via setInvalidTokenHandler.
 */
export class PushProvider {
  setInvalidTokenHandler() { /* optional */ }
  async send() {
    throw new Error('PushProvider.send must be implemented');
  }
}

/**
 * In-memory fixture provider used to exercise delivery, provider failure and token
 * invalidation without any real APNs/FCM backend.
 *
 * @param {{ sent?: Array, fail?: Error|(() => Error), invalidTokens?: Iterable<string>,
 *   onInvalidToken?: (pushToken:string)=>void }} [options]
 */
export class FixturePushProvider extends PushProvider {
  constructor({ sent, fail, invalidTokens, onInvalidToken } = {}) {
    super();
    this.sent = sent || [];
    this.fail = fail || null;
    this.invalidTokens = new Set(invalidTokens || []);
    if (onInvalidToken) this.setInvalidTokenHandler(onInvalidToken);
  }

  setInvalidTokenHandler(handler) { this._onInvalid = handler; }

  async send({ device, notification }) {
    this.sent.push({ device, notification });
    if (this.invalidTokens.has(device.pushToken)) {
      if (typeof this._onInvalid === 'function') {
        try { await this._onInvalid(device.pushToken); } catch { /* contained */ }
      }
      return { success: true, invalid: true };
    }
    if (this.fail) {
      throw typeof this.fail === 'function' ? this.fail() : this.fail;
    }
    return { success: true };
  }
}

/** Joi-derived validation messages, matching the source @validatePayload (Boom.badData). */
function validateCreateDevice(body) {
  const o = body || {};
  const required = [];
  if (!Object.prototype.hasOwnProperty.call(o, 'name') || o.name === undefined) required.push('name');
  if (!Object.prototype.hasOwnProperty.call(o, 'pushToken') || o.pushToken === undefined) required.push('pushToken');
  if (!Object.prototype.hasOwnProperty.call(o, 'type') || o.type === undefined) required.push('type');
  if (required.length) return `child "${required[0]}" fails because ["${required[0]}" is required]`;
  if (typeof o.name !== 'string') return 'child "name" fails because ["name" must be a string]';
  if (typeof o.pushToken !== 'string') return 'child "pushToken" fails because ["pushToken" must be a string]';
  if (typeof o.type !== 'string') return 'child "type" fails because ["type" must be a string]';
  if (o.type !== 'ios' && o.type !== 'android') return 'child "type" fails because ["type" must be one of [ios, android]]';
  return null;
}

function validateRemoveDevice(body) {
  const o = body || {};
  if (!Object.prototype.hasOwnProperty.call(o, 'name') || o.name === undefined) {
    return 'child "name" fails because ["name" is required]';
  }
  if (typeof o.name !== 'string') return 'child "name" fails because ["name" must be a string]';
  return null;
}

/** Boom.badData (422) envelope produced by the source validatePayload decorator. */
function sendPushValidationError(res, message) {
  const body = JSON.stringify({ statusCode: 422, error: 'Unprocessable Entity', message });
  res.removeHeader?.('x-powered-by');
  res.writeHead(422, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** AWS-JSON handler for Push_20160729 (CreateDevice / RemoveDevice). */
export function makePushHandler(registry = new DeviceRegistry()) {
  return function pushHandler({ req, res, body, op, log }) {
    const accountId = accessKeyIdFromAuth(req) || 'anon';
    const b = body || {};
    switch (op.toLowerCase()) {
      case 'createdevice': {
        const validation = validateCreateDevice(b);
        if (validation) return void sendPushValidationError(res, validation);
        try {
          const devices = registry.createDevice(accountId, {
            name: b.name, pushToken: b.pushToken, type: b.type,
          });
          log?.info?.('push device registered', { name: b.name, type: b.type });
          return void sendAmz(res, 200, devices);
        } catch (error) {
          return void sendAmzError(res, error);
        }
      }
      case 'removedevice': {
        const validation = validateRemoveDevice(b);
        if (validation) return void sendPushValidationError(res, validation);
        try {
          const devices = registry.removeDevice(accountId, b.name);
          return void sendAmz(res, 200, devices);
        } catch (error) {
          return void sendAmzError(res, error);
        }
      }
      default:
        return void sendAmzError(res, ValidationException, `unknown Push operation: ${op}`);
    }
  };
}

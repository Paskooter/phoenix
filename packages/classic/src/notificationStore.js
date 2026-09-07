// Durable local counterpart of the two Mongo collections used by the original
// notification-ws service.  The real service stores Token and Notification
// documents in Mongo; Phoenix has no Mongo dependency, so this module uses one
// atomically replaced JSON file while keeping the source document boundaries.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_FILE = join(tmpdir(), 'phoenix-notifications.json');

export const NOTIFICATIONS_LIMIT = 100;
export const NOTIFICATION_TTL_MS = 300 * 1000;
export const DATE_IN_PAST = '2000-01-01T00:00:00.000Z';

function nowDate(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('notification store clock returned an invalid date');
  return date;
}

function iso(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`notification store has an invalid date: ${String(value)}`);
  return date.toISOString();
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function id() {
  // Mongo ObjectIds are 12 random bytes represented as 24 hexadecimal
  // characters.  The value is opaque to the public token operation.
  return randomBytes(12).toString('hex');
}

function tokenKey() {
  // srv-notification-ws uses promisified randomBytes(64), then hex encodes it.
  return randomBytes(64).toString('hex');
}

function compareCreated(left, right) {
  // The source query sorts only by `created`; retain insertion order for rows
  // sharing the same millisecond (modern V8's stable sort preserves Map order).
  return new Date(left.created).getTime() - new Date(right.created).getTime();
}

/**
 * A synchronous, atomically persisted Token/Notification store.
 *
 * The synchronous writes keep the current Classic handlers small and make a
 * successful enqueue visible before its HTTP response is returned.  The file
 * path is deliberately explicit in deployment (`ETCO_classic_notificationFile`)
 * and can be passed to tests or a later event consumer.
 */
export class NotificationStore {
  /**
   * @param {string} [file]
   * @param {{ clock?: () => number|Date, notificationTtlMs?: number }} [options]
   */
  constructor(file = process.env.ETCO_classic_notificationFile || DEFAULT_FILE, options = {}) {
    this.file = file;
    this.clock = options.clock || (() => Date.now());
    this.notificationTtlMs = Number.isFinite(options.notificationTtlMs)
      ? Math.max(0, Number(options.notificationTtlMs))
      : NOTIFICATION_TTL_MS;
    this.tokens = new Map();
    this.notifications = new Map();
    this._load();
    this._purgeExpired(false);
  }

  _load() {
    if (!existsSync(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`notification store unreadable (${this.file}): ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`notification store has an invalid root (${this.file})`);
    }
    for (const source of raw.tokens || []) {
      if (!source || typeof source !== 'object') continue;
      const record = {
        _id: requiredString(source._id, 'token._id'),
        accountId: requiredString(source.accountId, 'token.accountId'),
        tokenKey: requiredString(source.tokenKey, 'token.tokenKey'),
        created: iso(source.created, nowDate(this.clock).toISOString()),
        lastConnected: iso(source.lastConnected, DATE_IN_PAST),
        updated: iso(source.updated, source.created || nowDate(this.clock).toISOString()),
      };
      this.tokens.set(record._id, record);
    }
    for (const source of raw.notifications || []) {
      if (!source || typeof source !== 'object') continue;
      const record = {
        _id: requiredString(source._id, 'notification._id'),
        created: iso(source.created, nowDate(this.clock).toISOString()),
        payload: clone(source.payload),
        skillId: source.skillId === undefined || source.skillId === null ? '-1' : String(source.skillId),
        tokenId: requiredString(source.tokenId, 'notification.tokenId'),
      };
      this.notifications.set(record._id, record);
    }
  }

  /** Atomically replace the persisted file after a mutation. */
  flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const output = {
      version: 1,
      tokens: [...this.tokens.values()].map((token) => clone(token)),
      notifications: [...this.notifications.values()].map((notification) => clone(notification)),
    };
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`);
    renameSync(temporary, this.file);
  }

  _purgeExpired(write = true) {
    const now = nowDate(this.clock).getTime();
    let changed = false;
    for (const [notificationId, notification] of this.notifications) {
      const created = new Date(notification.created).getTime();
      if (Number.isFinite(created) && now - created >= this.notificationTtlMs) {
        this.notifications.delete(notificationId);
        changed = true;
      }
    }
    if (changed && write) this.flush();
    return changed;
  }

  _tokenDocument(token) {
    return token ? clone(token) : null;
  }

  _notificationDocument(notification) {
    return notification ? clone(notification) : null;
  }

  /** Create or rotate the one source Token document associated with an account. */
  newToken({ accountId } = {}) {
    accountId = requiredString(accountId, 'accountId');
    const now = nowDate(this.clock).toISOString();
    let token = [...this.tokens.values()].find((entry) => entry.accountId === accountId);
    if (token) {
      token.tokenKey = tokenKey();
      token.updated = now;
    } else {
      token = {
        _id: id(),
        accountId,
        created: now,
        lastConnected: DATE_IN_PAST,
        tokenKey: tokenKey(),
        updated: now,
      };
      this.tokens.set(token._id, token);
    }
    this.flush();
    return this._tokenDocument(token);
  }

  findTokenById(tokenId) {
    this._purgeExpired();
    return this._tokenDocument(this.tokens.get(String(tokenId)) || null);
  }

  findTokenByKey(tokenKeyValue) {
    this._purgeExpired();
    const token = [...this.tokens.values()].find((entry) => entry.tokenKey === tokenKeyValue);
    return this._tokenDocument(token || null);
  }

  findTokenByAccountId(accountId) {
    this._purgeExpired();
    return this._tokenDocument([...this.tokens.values()].find((entry) => entry.accountId === accountId) || null);
  }

  /** Source Controller.populateToken: token JSON plus its oldest pending rows. */
  populateToken(tokenId) {
    this._purgeExpired();
    const token = this.tokens.get(String(tokenId));
    if (!token) return null;
    const notifications = this.findNotificationsByTokenIds([token._id]);
    return { ...this._tokenDocument(token), notifications };
  }

  /** Persist one source Notification document and create the account token when absent. */
  enqueue({ accountId, skillId = '-1', payload } = {}) {
    accountId = requiredString(accountId, 'accountId');
    let token = [...this.tokens.values()].find((entry) => entry.accountId === accountId);
    if (!token) token = this.newToken({ accountId });
    const notification = {
      _id: id(),
      created: nowDate(this.clock).toISOString(),
      payload: clone(payload),
      skillId: skillId === undefined || skillId === null ? '-1' : String(skillId),
      tokenId: token._id,
    };
    this.notifications.set(notification._id, notification);
    this.flush();
    return this._notificationDocument(notification);
  }

  /** Find at most the source controller's global 100 oldest pending rows. */
  findNotificationsByTokenIds(tokenIds = []) {
    this._purgeExpired();
    const ids = new Set((Array.isArray(tokenIds) ? tokenIds : [tokenIds]).map((value) => String(value)));
    return [...this.notifications.values()]
      .filter((notification) => ids.has(String(notification.tokenId)))
      .sort(compareCreated)
      .slice(0, NOTIFICATIONS_LIMIT)
      .map((notification) => this._notificationDocument(notification));
  }

  removeNotification(notificationId) {
    this._purgeExpired();
    const key = String(notificationId);
    const notification = this.notifications.get(key);
    if (!notification) return null;
    this.notifications.delete(key);
    this.flush();
    return this._notificationDocument(notification);
  }

  markConnected({ accountId } = {}) {
    accountId = requiredString(accountId, 'accountId');
    const connected = nowDate(this.clock).toISOString();
    let changed = false;
    for (const token of this.tokens.values()) {
      if (token.accountId === accountId) {
        token.lastConnected = connected;
        changed = true;
      }
    }
    if (changed) this.flush();
    return changed;
  }

  markDisconnected({ accountId } = {}) {
    accountId = requiredString(accountId, 'accountId');
    let changed = false;
    for (const token of this.tokens.values()) {
      if (token.accountId === accountId) {
        token.lastConnected = DATE_IN_PAST;
        changed = true;
      }
    }
    if (changed) this.flush();
    return changed;
  }

  getStatus({ accountId } = {}) {
    accountId = requiredString(accountId, 'accountId');
    const cutoff = nowDate(this.clock).getTime() - 24 * 60 * 60 * 1000;
    return {
      connected: [...this.tokens.values()].some((token) => token.accountId === accountId
        && new Date(token.lastConnected).getTime() > cutoff),
    };
  }
}

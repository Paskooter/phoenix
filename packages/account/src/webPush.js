// Browser Web Push for the signed-in portal.
//
// Browser push endpoints are bearer capabilities: anyone who learns one can ask
// its push service to deliver a message. They therefore stay in the private
// Account store and are never returned to the portal. The endpoints are also
// deliberately restricted to the public browser push providers by default. A
// signed-in user must not be able to turn a later server-side notification into
// an SSRF request to an arbitrary URL.

import { createHash, randomBytes } from 'node:crypto';
import webpush from 'web-push';

const DEFAULT_ENDPOINT_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'push.apple.com',
]);
const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 16;
const TEST_WINDOW_MS = 60 * 60 * 1000;
const MAX_TESTS_PER_WINDOW = 3;

export class WebPushError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'WebPushError';
    this.statusCode = statusCode;
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validVapidSubject(value) {
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validHost(value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function endpointHosts(env) {
  const configured = clean(env.ETCO_account_webPushEndpointHosts)
    .split(',').map((value) => value.trim().toLowerCase()).filter(validHost);
  return [...new Set([...DEFAULT_ENDPOINT_HOSTS, ...configured])];
}

/** Read the optional VAPID deployment configuration without exposing its private key. */
export function webPushConfigFromEnv(env = process.env) {
  const publicKey = clean(env.ETCO_account_webPushPublicKey);
  const privateKey = clean(env.ETCO_account_webPushPrivateKey);
  const subject = clean(env.ETCO_account_webPushSubject);
  if (!publicKey && !privateKey && !subject) return { enabled: false, reason: 'not configured' };
  if (!publicKey || !privateKey || !subject) return { enabled: false, reason: 'configuration is incomplete' };
  if (!validVapidSubject(subject)) return { enabled: false, reason: 'VAPID subject is invalid' };
  // VAPID public/private keys are URL-safe base64 values. The web-push package
  // performs the curve-level check when it is configured below.
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,200}$/.test(privateKey)) {
    return { enabled: false, reason: 'VAPID key format is invalid' };
  }
  return { enabled: true, publicKey, privateKey, subject, endpointHosts: endpointHosts(env) };
}

function endpointAllowed(hostname, hosts) {
  const host = String(hostname || '').toLowerCase();
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function safeLabel(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return (text || 'This browser').slice(0, 80);
}

function endpointHash(endpoint) {
  return createHash('sha256').update(endpoint).digest('base64url');
}

function publicSubscription(row) {
  return {
    id: row._id,
    label: row.label,
    created: row.created,
    lastSeen: row.lastSeen,
  };
}

function validateKey(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(value)) {
    throw new WebPushError(`subscription ${name} is invalid`);
  }
  return value;
}

function normalizeSubscription(value, allowedHosts) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebPushError('a browser push subscription is required');
  }
  const endpoint = clean(value.endpoint);
  if (!endpoint || endpoint.length > 2048) throw new WebPushError('subscription endpoint is invalid');
  let parsed;
  try { parsed = new URL(endpoint); }
  catch { throw new WebPushError('subscription endpoint is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !endpointAllowed(parsed.hostname, allowedHosts)) {
    throw new WebPushError('subscription endpoint is not an approved browser push service');
  }
  const keys = value.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new WebPushError('subscription keys are required');
  }
  return {
    endpoint: parsed.toString(),
    keys: {
      p256dh: validateKey(keys.p256dh, 'p256dh key'),
      auth: validateKey(keys.auth, 'auth key'),
    },
  };
}

function notificationPayload({ title, body, url, tag }) {
  const safeUrl = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/app';
  return {
    title: String(title || 'Jibo').slice(0, 120),
    body: String(body || '').slice(0, 240),
    url: safeUrl,
    tag: typeof tag === 'string' ? tag.slice(0, 128) : undefined,
  };
}

function deliveryStatus(error) {
  return Number(error?.statusCode || error?.status || 0);
}

/**
 * Persist subscriptions and deliver encrypted Web Push messages. `sender` is
 * injectable for tests; its contract is `(subscription, payload, options)`.
 */
export class WebPushService {
  constructor({ store, config = webPushConfigFromEnv(), sender, clock = () => Date.now() } = {}) {
    if (!store?.webPushSubscriptions) throw new TypeError('web push requires a persistent Account store');
    this.store = store;
    this.clock = clock;
    this.testAttempts = new Map();
    this.config = config || { enabled: false, reason: 'not configured' };
    this.enabled = this.config.enabled === true;
    this.reason = this.config.reason || null;
    this.allowedHosts = this.config.endpointHosts || DEFAULT_ENDPOINT_HOSTS;
    this.sender = null;

    if (!this.enabled) return;
    if (typeof sender === 'function') {
      this.sender = sender;
      return;
    }
    try {
      webpush.setVapidDetails(this.config.subject, this.config.publicKey, this.config.privateKey);
      this.sender = (subscription, payload, options) => webpush.sendNotification(subscription, JSON.stringify(payload), options);
    } catch {
      this.enabled = false;
      this.reason = 'VAPID configuration is invalid';
    }
  }

  status(accountId) {
    const subscriptions = this.list(accountId);
    return {
      available: this.enabled,
      ...(this.enabled ? { publicKey: this.config.publicKey } : { reason: this.reason || 'not configured' }),
      subscriptions,
    };
  }

  list(accountId) {
    return [...this.store.webPushSubscriptions.values()]
      .filter((row) => String(row.accountId) === String(accountId))
      .sort((a, b) => Number(b.lastSeen || b.created || 0) - Number(a.lastSeen || a.created || 0))
      .map(publicSubscription);
  }

  subscribe(accountId, subscription, label) {
    if (!this.enabled) throw new WebPushError('browser notifications are not configured on this server', 503);
    const normalized = normalizeSubscription(subscription, this.allowedHosts);
    const now = this.clock();
    let existing = null;
    let changed = false;
    for (const [id, row] of this.store.webPushSubscriptions) {
      if (row.endpoint !== normalized.endpoint) continue;
      if (String(row.accountId) === String(accountId)) existing = row;
      else this.store.webPushSubscriptions.delete(id);
      changed = true;
    }
    if (!existing) {
      const mine = this.list(accountId);
      if (mine.length >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
        if (changed) this.store.flush();
        throw new WebPushError(`this account already has ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} notification devices`, 409);
      }
      existing = {
        _id: randomBytes(18).toString('base64url'),
        accountId: String(accountId),
        endpoint: normalized.endpoint,
        endpointHash: endpointHash(normalized.endpoint),
        keys: normalized.keys,
        label: safeLabel(label),
        created: now,
        lastSeen: now,
      };
      this.store.webPushSubscriptions.set(existing._id, existing);
    } else {
      existing.keys = normalized.keys;
      existing.label = safeLabel(label || existing.label);
      existing.lastSeen = now;
    }
    this.store.flush();
    return publicSubscription(existing);
  }

  unsubscribe(accountId, subscription) {
    const rawEndpoint = clean(subscription?.endpoint);
    if (!rawEndpoint) throw new WebPushError('a browser push subscription is required');
    let endpoint;
    try { endpoint = new URL(rawEndpoint).toString(); }
    catch { throw new WebPushError('subscription endpoint is invalid'); }
    let removed = false;
    for (const [id, row] of this.store.webPushSubscriptions) {
      if (String(row.accountId) === String(accountId) && row.endpoint === endpoint) {
        this.store.webPushSubscriptions.delete(id);
        removed = true;
      }
    }
    if (removed) this.store.flush();
    return { removed };
  }

  async sendTest(accountId) {
    if (!this.enabled) throw new WebPushError('browser notifications are not configured on this server', 503);
    const now = this.clock();
    const prior = (this.testAttempts.get(String(accountId)) || []).filter((at) => now - at < TEST_WINDOW_MS);
    if (prior.length >= MAX_TESTS_PER_WINDOW) {
      throw new WebPushError('too many test notifications; try again later', 429);
    }
    prior.push(now);
    this.testAttempts.set(String(accountId), prior);
    return this.notifyAccounts([accountId], {
      title: 'Jibo notifications are on',
      body: 'This browser can receive notifications from your household.',
      url: '/app#/profile',
      tag: 'web-push-test',
    });
  }

  async notifyAccounts(accountIds, message) {
    if (!this.enabled || !this.sender) return { delivered: 0, expired: 0, skipped: true };
    const wanted = new Set((accountIds || []).map((id) => String(id)));
    const rows = [...this.store.webPushSubscriptions.values()]
      .filter((row) => wanted.has(String(row.accountId)));
    const payload = notificationPayload(message || {});
    const results = await Promise.all(rows.map(async (row) => {
      try {
        await this.sender({ endpoint: row.endpoint, keys: row.keys }, payload, {
          TTL: 5 * 60,
          urgency: 'normal',
          ...(payload.tag ? { topic: payload.tag } : {}),
        });
        return { delivered: true };
      } catch (error) {
        return { expired: deliveryStatus(error) === 404 || deliveryStatus(error) === 410, id: row._id };
      }
    }));
    let expired = 0;
    for (const result of results) {
      if (result.expired && this.store.webPushSubscriptions.delete(result.id)) expired++;
    }
    if (expired) this.store.flush();
    return { delivered: results.filter((result) => result.delivered).length, expired, skipped: false };
  }
}

/** VAPID keys are generated only on the operator machine; this function never writes them. */
export function generateVapidKeys() {
  return webpush.generateVAPIDKeys();
}

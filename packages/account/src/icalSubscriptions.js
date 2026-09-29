import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { getSettingsData, setSettingsData } from './settingsData.js';
import { ical } from '@phoenix/common';

const { IcalParseError, parseICalendar } = ical;

export const ICAL_MAX_BYTES = 2 * 1024 * 1024;
export const ICAL_FETCH_TIMEOUT_MS = 8000;
export const ICAL_MAX_REDIRECTS = 3;
export const ICAL_MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;
export const ICAL_CACHE_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;
export const ICAL_CACHE_AFTER_MS = 370 * 24 * 60 * 60 * 1000;
export const ICAL_ALLOW_PRIVATE_ENV = 'ETCO_account_allowPrivateCalendarHosts';
const SUBSCRIPTIONS_KEY = 'icalSubscriptions';
const TIME_ZONE_KEY = 'calendarTimeZone';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'webcal:']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function genericError(message) {
  return new Error(message);
}

function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return 'UTC';
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
    return zone;
  } catch {
    return 'UTC';
  }
}

export function accountTimeZone(data) {
  return validTimeZone(data?.[TIME_ZONE_KEY]?.value);
}

function privateIpv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19)
    || a >= 224;
}

function privateHostLiteral(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')
    || normalized === 'metadata.google.internal' || normalized === 'instance-data') return true;
  const kind = net.isIP(normalized);
  if (kind === 4) return privateIpv4(normalized);
  if (kind === 6) {
    // IPv6 loopback, unspecified, link-local, ULA and IPv4-mapped private
    // addresses.  URL.hostname retains brackets on some Node versions.
    if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
      || normalized.startsWith('fd') || normalized.startsWith('fe8')
      || normalized.startsWith('fe9') || normalized.startsWith('fea')
      || normalized.startsWith('feb') || normalized.startsWith('2001:db8:')) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateIpv4(mapped[1]);
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
  }
  return false;
}

/**
 * Validate an iCal URL before any outbound request.  Private/loopback/link-local
 * destinations are blocked by default because this endpoint is Internet-facing
 * and otherwise becomes an authenticated SSRF primitive.  A deliberate LAN
 * deployment may opt in with `ETCO_account_allowPrivateCalendarHosts=true` (and
 * should firewall the service accordingly).
 */
export function validateIcalUrl(input, { allowPrivateHosts = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw genericError('calendar URL is required');
  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw genericError('calendar URL is invalid');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw genericError('calendar URL scheme is not allowed (use http, https, or webcal)');
  }
  if (!parsed.hostname) throw genericError('calendar URL must include a host');
  if (parsed.username || parsed.password) throw genericError('calendar URL userinfo is not allowed');
  if (!allowPrivateHosts && privateHostLiteral(parsed.hostname)) {
    throw genericError('calendar URL host is not allowed');
  }
  return parsed;
}

function fetchURL(url, options) {
  const parsed = validateIcalUrl(url, options);
  if (parsed.protocol === 'webcal:') parsed.protocol = 'http:';
  return parsed.toString();
}

async function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function resolveSafeHost(parsed, { allowPrivateHosts, dnsLookup, signal }) {
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  if (literalFamily) return { address: hostname, family: literalFamily };
  let records;
  try {
    records = await withAbort(dnsLookup(hostname, { all: true, verbatim: true }), signal);
  } catch {
    if (signal.aborted) throw abortError();
    throw genericError('calendar URL host could not be resolved');
  }
  if (!Array.isArray(records) || !records.length
    || records.some((record) => !record || net.isIP(record.address) !== record.family)) {
    throw genericError('calendar URL host could not be resolved');
  }
  if (!allowPrivateHosts && records.some((record) => privateHostLiteral(record.address))) {
    throw genericError('calendar URL host is not allowed');
  }
  return records[0];
}

async function fetchPinned(url, { signal, headers }, { allowPrivateHosts, dnsLookup }) {
  const parsed = new URL(url);
  const { address, family } = await resolveSafeHost(parsed, { allowPrivateHosts, dnsLookup, signal });
  // The connection uses exactly the address we checked. The original hostname
  // remains in the URL, Host header and TLS peer-name verification. Resolving
  // once for validation and again inside fetch() would permit DNS rebinding.
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, {
      headers,
      signal,
      lookup: (_host, options, callback) => {
        if (typeof options === 'function') callback = options;
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      resolve({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
        body: Readable.toWeb(response),
      });
    });
    request.once('error', reject);
  });
}

function abortError() {
  const error = new Error('calendar fetch timed out');
  error.name = 'AbortError';
  return error;
}

function readWithSignal(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      finish(reject, abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function readResponseBody(response, maxBytes, signal) {
  const advertised = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw genericError('calendar response exceeds the size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await readWithSignal(reader, signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw genericError('calendar response exceeds the size limit');
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* an aborted read may still be settling */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fetch without ever putting the source URL or response body in an error/log value. */
export async function fetchIcalText(input, {
  fetchImpl = globalThis.fetch,
  dnsLookup = lookup,
  timeoutMs = Number(process.env.ETCO_account_icalTimeoutMs) || ICAL_FETCH_TIMEOUT_MS,
  maxBytes = ICAL_MAX_BYTES,
  maxRedirects = ICAL_MAX_REDIRECTS,
  allowPrivateHosts = process.env[ICAL_ALLOW_PRIVATE_ENV] === 'true',
} = {}) {
  const usePinnedFetch = fetchImpl === globalThis.fetch;
  if (!usePinnedFetch && typeof fetchImpl !== 'function') throw genericError('calendar fetch is unavailable');
  let current = validateIcalUrl(input, { allowPrivateHosts });
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestUrl = fetchURL(current.toString(), { allowPrivateHosts });
      const requestOptions = {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1' },
      };
      const response = usePinnedFetch
        ? await fetchPinned(requestUrl, requestOptions, { allowPrivateHosts, dnsLookup })
        : await fetchImpl(requestUrl, requestOptions);

      if (response.status >= 300 && response.status < 400) {
        if (typeof response.body?.cancel === 'function') {
          await Promise.resolve(response.body.cancel()).catch(() => {});
        }
        if (redirect === maxRedirects) throw genericError('calendar redirect limit exceeded');
        const location = response.headers?.get?.('location');
        if (!location) throw genericError('calendar redirect has no location');
        try {
          current = new URL(location, current);
          validateIcalUrl(current.toString(), { allowPrivateHosts });
        } catch (error) {
          if (error.message.startsWith('calendar URL')) throw error;
          throw genericError('calendar redirect URL is invalid');
        }
        continue;
      }
      if (!response.ok) throw genericError(`calendar fetch returned HTTP ${response.status}`);
      return await readResponseBody(response, maxBytes, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw genericError('calendar fetch timed out');
      }
      if (String(error?.message || '').startsWith('calendar ')) throw error;
      throw genericError('calendar fetch failed (network error)');
    } finally {
      clearTimeout(timer);
    }
  }
  throw genericError('calendar redirect limit exceeded');
}

export async function fetchAndParseIcal(input, {
  timeZone = 'UTC',
  now = Date.now(),
  fetchImpl,
  timeoutMs,
  maxBytes,
  maxRedirects,
} = {}) {
  const text = await fetchIcalText(input, { fetchImpl, timeoutMs, maxBytes, maxRedirects });
  try {
    const events = parseICalendar(text, {
      timeZone,
      windowStart: now - ICAL_CACHE_BEFORE_MS,
      windowEnd: now + ICAL_CACHE_AFTER_MS,
      maxOccurrences: 2000,
    });
    return { events };
  } catch (error) {
    if (error instanceof IcalParseError) throw error;
    throw genericError('calendar could not be parsed');
  }
}

function normalizeVerification(value) {
  const source = value && typeof value === 'object' ? value : {};
  const status = ['ok', 'invalid', 'unknown'].includes(source.status) ? source.status : 'unknown';
  const lastChecked = Number.isFinite(source.lastChecked) ? source.lastChecked : null;
  return {
    status,
    eventCount: Number.isInteger(source.eventCount) && source.eventCount >= 0 ? source.eventCount : 0,
    lastChecked,
    // Older saved subscriptions only have lastChecked. For a successful old
    // verification, that timestamp is also the last successful refresh.
    lastSuccess: Number.isFinite(source.lastSuccess) ? source.lastSuccess
      : status === 'ok' ? lastChecked : null,
    lastError: typeof source.lastError === 'string' ? source.lastError : null,
  };
}

function normalizeSubscription(item) {
  return {
    id: typeof item?.id === 'string' && item.id ? item.id : randomUUID(),
    label: typeof item?.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 120) : 'Calendar',
    url: typeof item?.url === 'string' ? item.url.trim() : '',
    enabled: item?.enabled !== false,
    verification: normalizeVerification(item?.verification),
    events: Array.isArray(item?.events) ? item.events : [],
    checkedTimeZone: typeof item?.checkedTimeZone === 'string' ? validTimeZone(item.checkedTimeZone) : null,
  };
}

export function subscriptionsFromData(data) {
  const value = data?.[SUBSCRIPTIONS_KEY];
  const list = Array.isArray(value) ? value : value?.subscriptions;
  return Array.isArray(list) ? list.map(normalizeSubscription) : [];
}

export function setSubscriptionsInData(data, subscriptions) {
  return {
    ...data,
    [SUBSCRIPTIONS_KEY]: { subscriptions: subscriptions.map(normalizeSubscription) },
  };
}

export function listSubscriptions(store, accountId) {
  return subscriptionsFromData(getSettingsData(store, accountId));
}

export function saveSubscriptions(store, accountId, subscriptions) {
  const data = getSettingsData(store, accountId);
  setSettingsData(store, accountId, setSubscriptionsInData(data, subscriptions));
  return subscriptions;
}

export function publicSubscription(item) {
  const subscription = normalizeSubscription(item);
  return {
    id: subscription.id,
    label: subscription.label,
    url: subscription.url,
    enabled: subscription.enabled,
    verification: clone(subscription.verification),
  };
}

export function publicEvent(event, subscription) {
  return {
    ...event,
    subscriptionId: subscription.id,
    subscriptionLabel: subscription.label,
  };
}

export async function verifySubscription(subscription, {
  timeZone = 'UTC',
  fetcher = fetchAndParseIcal,
  fetchOptions = {},
  now = Date.now(),
  preserveOnError = false,
} = {}) {
  const next = normalizeSubscription(subscription);
  try {
    const parsed = await fetcher(next.url, { timeZone, now, ...fetchOptions });
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    return {
      ...next,
      events,
      checkedTimeZone: validTimeZone(timeZone),
      verification: {
        status: 'ok', eventCount: events.length, lastChecked: now, lastSuccess: now, lastError: null,
      },
    };
  } catch (error) {
    // Do not preserve arbitrary provider error text: a URL, response body, or auth
    // detail must not become a log/store leak. Parser diagnostics are safe and useful.
    const message = error instanceof IcalParseError
      ? error.message
      : String(error?.message || 'calendar verification failed')
        .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, '[url]');
    const useSavedEvents = preserveOnError && next.verification.status === 'ok';
    return {
      ...next,
      events: useSavedEvents ? next.events : [],
      checkedTimeZone: validTimeZone(timeZone),
      verification: {
        status: useSavedEvents ? 'ok' : 'invalid',
        eventCount: useSavedEvents ? next.events.length : 0,
        lastChecked: now,
        lastSuccess: useSavedEvents ? next.verification.lastSuccess : null,
        lastError: message.slice(0, 240),
      },
    };
  }
}

export function calendarEventsForWindow(subscriptions, start, end) {
  const startMs = Number(start);
  const endMs = Number(end);
  return subscriptions.flatMap((subscription) => {
    if (!subscription.enabled || subscription.verification.status !== 'ok') return [];
    return subscription.events
      .filter((event) => event?.start && event?.end
        && event.start.timestamp < endMs && event.end.timestamp > startMs)
      .map((event) => publicEvent(event, subscription));
  }).sort((a, b) => a.start.timestamp - b.start.timestamp);
}

export { accountTimeZone as getAccountTimeZone, validTimeZone };

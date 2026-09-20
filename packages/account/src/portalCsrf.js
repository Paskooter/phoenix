// Same-origin boundary for the cookie-authenticated portal.
//
// SameSite=Lax is useful defence in depth, but it is not a complete CSRF
// policy: browser behaviour varies by request type and a deployment may
// deliberately choose a different cookie policy.  Every state-changing
// /api/* route therefore passes through this guard before its handler runs.

import { sendJson } from '@phoenix/common';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BROWSER_USER_AGENT = /(?:mozilla|chrome|safari|firefox|edg|edge|opera|webkit|android|iphone|ipad)/i;

function originFromConfiguredValue(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredOrigins(env = process.env) {
  const values = [
    env.ETCO_account_csrfOrigins,
    env.ETCO_account_portalUrl,
    env.PHOENIX_SITE_URL,
  ];
  const origins = new Set();
  for (const value of values) {
    for (const candidate of String(value || '').split(',')) {
      const origin = originFromConfiguredValue(candidate);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

function requestOrigins(req) {
  const host = String(req?.headers?.host || '').trim();
  if (!host || /[\s\\]/.test(host)) return new Set();
  // A native service may sit behind a TLS-terminating reverse proxy.  The
  // proxy must overwrite (not append to) X-Forwarded-Proto; if it does not,
  // accepting either scheme still cannot make an unrelated Origin valid.
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0].trim().toLowerCase();
  const protocol = ['http', 'https'].includes(forwarded)
    ? forwarded
    : (req?.protocol === 'https' ? 'https' : 'http');
  const origins = new Set([`${protocol}://${host}`]);
  if (!forwarded && !req?.protocol) origins.add(`https://${host}`);
  return origins;
}

function expectedOrigins(req, env = process.env) {
  const configured = configuredOrigins(env);
  return configured.size ? configured : requestOrigins(req);
}

function normaliseOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Check the browser-origin boundary for one portal request.
 *
 * Requests from non-browser API clients commonly have no Origin.  They are
 * accepted only when they have a non-browser user agent, or when they
 * explicitly identify themselves with
 * X-Phoenix-API-Client.  A cross-origin browser cannot set that custom header
 * without a CORS preflight, which this service does not enable.
 */
export function checkPortalOrigin(req, { env = process.env } = {}) {
  const originHeader = req?.headers?.origin;
  if (originHeader !== undefined) {
    const origin = normaliseOrigin(Array.isArray(originHeader) ? originHeader[0] : originHeader);
    if (!origin || !expectedOrigins(req, env).has(origin)) {
      return { allowed: false, reason: 'origin is not allowed' };
    }
    return { allowed: true };
  }

  const clientMarker = String(req?.headers?.['x-phoenix-api-client'] || '').trim();
  if (clientMarker) return { allowed: true, reason: 'explicit non-browser client' };

  const userAgent = String(req?.headers?.['user-agent'] || '');
  // Node's built-in fetch (Undici) sends Sec-Fetch-Mode despite not being a
  // browser. Origin, which browsers attach to cross-origin unsafe requests,
  // is the authoritative signal; when it is absent, retain the conservative
  // browser-UA check rather than treating Fetch Metadata alone as proof.
  if (!BROWSER_USER_AGENT.test(userAgent)) {
    return { allowed: true, reason: 'non-browser client without Origin' };
  }
  return { allowed: false, reason: 'Origin is required for browser requests' };
}

export function isStateChangingPortalRoute(method, path) {
  return MUTATING_METHODS.has(String(method || '').toUpperCase())
    && /^\/api(?:\/|$)/i.test(String(path || ''));
}

function copyRouteProperties(source, target) {
  for (const property of ['bodyDefault', 'rawBody', 'rawRequest', 'jsonStrict', 'jsonTypes', 'parserError']) {
    if (Object.prototype.hasOwnProperty.call(source, property)) target[property] = source[property];
  }
  return target;
}

/** Wrap the complete Account route map so no mutating portal route can bypass the guard. */
export function protectPortalRoutes(routes, { env = process.env } = {}) {
  const protectedRoutes = {};
  for (const [key, handler] of Object.entries(routes || {})) {
    const separator = key.indexOf(' ');
    if (separator < 1 || typeof handler !== 'function') {
      protectedRoutes[key] = handler;
      continue;
    }
    const method = key.slice(0, separator);
    const path = key.slice(separator + 1);
    if (!isStateChangingPortalRoute(method, path)) {
      protectedRoutes[key] = handler;
      continue;
    }
    const wrapped = (ctx) => {
      const check = checkPortalOrigin(ctx?.req, { env });
      if (!check.allowed) {
        sendJson(ctx.res, 403, { error: 'cross-origin request rejected' });
        return undefined;
      }
      return handler(ctx);
    };
    protectedRoutes[key] = copyRouteProperties(handler, wrapped);
  }
  return protectedRoutes;
}

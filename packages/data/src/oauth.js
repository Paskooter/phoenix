// OAuth2 — Phoenix port of lasso/oauth2 + the calendar-client token lifecycle.
//
// Pinned reference (5c0a7390539663ba749d360de348a428c088505c):
//   packages/lasso/src/oauth2/interfaces.ts        OAuth2Credentials / OAuth2ClientSecret / OAuth2Service
//   packages/lasso/src/oauth2/OAuth2Client.ts      Oauth2Client (redeemAuthCode/setCredentials/refreshCredentials)
//   packages/lasso/src/oauth2/OAuth2Secrets.ts     client_*.json registry + getClientSecret error messages
//   packages/lasso/src/calendar-client/GoogleCalendarClient.ts    token endpoint + error envelope
//   packages/lasso/src/calendar-client/OutlookCalendarClient.ts   token endpoint + error envelope
//   packages/lasso/src/mongo/StoredCredential.ts   setTokens / updateTokens / setInactive
//   packages/lasso/src/credential/interfaces.ts    CredentialError
//
// The reference constructs a google-auth-library / simple-oauth2 client whose
// only observable effects are (a) the HTTP request it makes to the provider's
// token endpoint and (b) the tokens or the error message it produces. This
// module reproduces exactly those two effects so the exchange can be driven at
// runtime against a real endpoint (default: the live Google/Microsoft URLs) or
// against a recorded-fixture endpoint (tests inject a tokenUrl).

import assert from 'node:assert';
import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs';
import { DEFAULT_UPSTREAM_TIMEOUT_MS, withUpstreamTimeout } from './upstream.js';

/** credential/interfaces.ts:39-43 — error codes stored on an inactive credential. */
export const CredentialError = Object.freeze({
  REFRESH_FAILED: 'REFRESH_FAILED',
  REVOKED_ACCESS: 'REVOKED_ACCESS',
  INVALID_TOKEN: 'INVALID_TOKEN',
});

/** oauth2/interfaces.ts:20-23 — the services Lasso knows. */
export const OAuth2Service = Object.freeze({ google: 'google', outlook: 'outlook' });

// oauth2/interfaces.ts:7-10 — Google answers `expiry_date` (ms timestamp),
// Outlook answers `expires_in` (seconds). Both are accepted by setTokens.
export const GOOGLE_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
export const OUTLOOK_TOKEN_HOST = 'https://login.microsoftonline.com';
export const OUTLOOK_TOKEN_PATH = 'common/oauth2/v2.0/token';
export const OUTLOOK_TOKEN_URL = `${OUTLOOK_TOKEN_HOST}/${OUTLOOK_TOKEN_PATH}`;
export const OAUTH_TIMEOUT_MS = DEFAULT_UPSTREAM_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// OAuth2Secrets.ts — a registry of client_<shortId>.json secrets
// ---------------------------------------------------------------------------

const SECRET_FILE_REGEX = /^client_(.+).json$/;
const SECRETS = new Map(); // legacy module registry for the exported helpers

function setRegistrySecret(registry, service, secret, shortKey) {
  if (!registry.has(service)) registry.set(service, new Map());
  const serviceSecrets = registry.get(service);
  if (shortKey) serviceSecrets.set(shortKey, secret);
  serviceSecrets.set(secret.client_id, secret);
  return secret;
}

function copyRegistry(source) {
  const copy = new Map();
  for (const [service, secrets] of source) copy.set(service, new Map(secrets));
  return copy;
}

/** Register one client secret under both its short file key and full client_id. */
export function setClientSecret(service, secret, shortKey) {
  return setRegistrySecret(SECRETS, service, secret, shortKey);
}

export function clearSecrets() { SECRETS.clear(); }

/** oauth2/OAuth2Secrets.ts:68-83 — validate a parsed client secret. */
export function validateClientSecret(secret, fullFilePath) {
  if (typeof secret !== 'object' || secret === null) {
    throw new Error(`Invalid secret in file ${fullFilePath}: should be an object`);
  }
  if (typeof secret.client_id !== 'string' || secret.client_id.length === 0) {
    throw new Error(`Invalid secret in file ${fullFilePath}: client_id must be a non-empty string`);
  }
  if (typeof secret.client_secret !== 'string') {
    throw new Error(`Invalid secret in file ${fullFilePath}: client_secret must be a string`);
  }
  if (typeof secret.redirect_uri !== 'string' || secret.redirect_uri.length === 0) {
    throw new Error(`Invalid secret in file ${fullFilePath}: redirect_uri must be a non-empty string`);
  }
  return secret;
}

/**
 * oauth2/OAuth2Secrets.ts:31-39,45-61 — find a secret by short clientID or full
 * client_id; unknown service/clientID throws the pinned messages (which surface
 * on POST /v1/credential as a 400 plain-text body).
 */
function getRegistrySecret(registry, serviceName, clientId) {
  if (!registry.has(serviceName)) {
    throw new Error(`Cannot find secrets for ${serviceName}`);
  }
  if (!registry.get(serviceName).has(clientId)) {
    throw new Error(`Cannot find secret for ${serviceName} client ${clientId}`);
  }
  return registry.get(serviceName).get(clientId);
}

export function getClientSecret(serviceName, clientId) {
  return getRegistrySecret(SECRETS, serviceName, clientId);
}

/**
 * Load every client_(.+).json in a directory (OAuth2Secrets.loadSecrets).
 * Synchronous variant of the reference's async fs walk — the store's
 * constructor is synchronous, and the reference only ever reads these files.
 */
export function loadSecretsSync(serviceName, secretsDir, {
  readdirSync = fsReaddirSync, readFileSync = fsReadFileSync, registry = SECRETS,
} = {}) {
  const files = readdirSync(secretsDir);
  for (const fileName of files) {
    if (!SECRET_FILE_REGEX.test(fileName)) continue;
    const matches = fileName.match(SECRET_FILE_REGEX);
    const secret = validateClientSecret(
      JSON.parse(readFileSync(`${secretsDir}/${fileName}`, 'utf8')),
      `${secretsDir}/${fileName}`,
    );
    setRegistrySecret(registry, serviceName, secret, matches[1]);
  }
}

// ---------------------------------------------------------------------------
// Token-endpoint HTTP. The error objects are shaped like the axios errors the
// reference's google-auth-library / simple-oauth2 surface so the message
// builders below can be a faithful transliteration.
// ---------------------------------------------------------------------------

/** POST a form body; resolve parsed JSON, or reject with an axios-shaped error. */
export async function postForm(url, form, {
  fetchImpl = fetch, signal, timeoutMs = OAUTH_TIMEOUT_MS,
} = {}) {
  return withUpstreamTimeout(async (upstreamSignal) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: upstreamSignal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Request failed with status code ${res.status}`);
      err.response = { status: res.status, data };
      // simple-oauth2 also exposes status/context on its error object.
      err.status = res.status;
      err.context = data;
      const code = providerErrorCode(err);
      if (code) err.code = code;
      throw err;
    }
    return data;
  }, { signal, timeoutMs, label: 'OAuth' });
}

function isAbortFailure(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
}

function providerErrorCode(error) {
  return error?.code
    || error?.response?.data?.error?.code
    || error?.response?.data?.code
    || error?.context?.code
    || error?.context?.error?.code;
}

function postToken(post, url, form, { signal, timeoutMs, fetchImpl, label }) {
  return withUpstreamTimeout(
    (upstreamSignal) => post(url, form, { signal: upstreamSignal, timeoutMs, fetchImpl }),
    { signal, timeoutMs, label },
  );
}

/** calendar-client/GoogleCalendarClient.ts:147-164 — Google error envelope. */
function googleError(errorMessage, originalError) {
  let message = errorMessage;
  if (originalError) {
    const response = originalError.response;
    if (response && response.status && response.data && response.data.error_description) {
      message += `, Google response was ${response.status} ${response.data.error_description}`;
    } else if (response && response.status && response.data && response.data.message) {
      message += `, Google response was ${response.status} ${response.data.message}`;
    } else if (response && response.status) {
      message += `, Google response was ${response.status} ${originalError.message}`;
    } else {
      message += `, Google response was ${originalError.message}`;
    }
  }
  const error = new Error(message);
  const code = providerErrorCode(originalError);
  if (code) error.code = code;
  throw error;
}

/** calendar-client/OutlookCalendarClient.ts:170-181 — Outlook error envelope. */
function outlookError(errorMessage, originalError) {
  let message = errorMessage;
  if (originalError && originalError.statusCode && originalError.code) {
    message += `, Outlook response was ${originalError.statusCode} ${originalError.code}`;
  } else if (originalError && originalError.context && originalError.context.error_description) {
    message += `, Outlook response was ${originalError.status} ${originalError.context.error_description}`;
  } else if (originalError && originalError.message) {
    message += ` ${originalError.message}`;
  }
  const error = new Error(`${message}`);
  const code = providerErrorCode(originalError);
  if (code) error.code = code;
  throw error;
}

/** google-auth-library stamps `expiry_date`; a raw token reply carries `expires_in`. */
function toGoogleCredentials(tokens) {
  if (tokens && !tokens.expiry_date && tokens.expires_in) {
    tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Oauth2Client implementation (OAuth2Client.ts:4-13)
// ---------------------------------------------------------------------------

/**
 * calendar-client/GoogleCalendarClient.ts:70-75 — redeem an authCode.
 * `redirectUri || secret.redirect_uri` matches the client constructor.
 */
export async function googleRedeemAuthCode(secret, authCode, redirectUri, {
  post = postForm, tokenUrl = GOOGLE_TOKEN_URL, signal, timeoutMs = OAUTH_TIMEOUT_MS, fetchImpl,
} = {}) {
  try {
    return toGoogleCredentials(await postToken(post, tokenUrl, {
      code: authCode,
      client_id: secret.client_id,
      client_secret: secret.client_secret,
      redirect_uri: redirectUri || secret.redirect_uri,
      grant_type: 'authorization_code',
    }, { signal, timeoutMs, fetchImpl, label: 'Google OAuth' }));
  } catch (err) {
    if (isAbortFailure(err)) throw err;
    return googleError('Failed to redeem authCode', err);
  }
}

/** calendar-client/GoogleCalendarClient.ts:92-99 — refresh via refresh_token. */
export async function googleRefreshCredentials(secret, refreshToken, {
  post = postForm, tokenUrl = GOOGLE_TOKEN_URL, signal, timeoutMs = OAUTH_TIMEOUT_MS, fetchImpl,
} = {}) {
  try {
    return toGoogleCredentials(await postToken(post, tokenUrl, {
      refresh_token: refreshToken,
      client_id: secret.client_id,
      client_secret: secret.client_secret,
      grant_type: 'refresh_token',
    }, { signal, timeoutMs, fetchImpl, label: 'Google OAuth' }));
  } catch (err) {
    if (isAbortFailure(err)) throw err;
    return googleError('Failed to refresh access token', err);
  }
}

/** calendar-client/OutlookCalendarClient.ts:97-107 — authorizePath tokenPath exchange. */
export async function outlookRedeemAuthCode(secret, authCode, scopes, redirectUri, {
  post = postForm, tokenUrl = OUTLOOK_TOKEN_URL, signal, timeoutMs = OAUTH_TIMEOUT_MS, fetchImpl,
} = {}) {
  try {
    return await postToken(post, tokenUrl, {
      code: authCode,
      redirect_uri: redirectUri || secret.redirect_uri,
      scope: (scopes || []).join(' '),
      grant_type: 'authorization_code',
      client_id: secret.client_id,
      client_secret: secret.client_secret,
    }, { signal, timeoutMs, fetchImpl, label: 'Microsoft OAuth' });
  } catch (err) {
    if (isAbortFailure(err)) throw err;
    return outlookError('Failed to redeem authCode', err);
  }
}

/** calendar-client/OutlookCalendarClient.ts:119-132 — refresh via simple-oauth2. */
export async function outlookRefreshCredentials(secret, refreshToken, scopes, {
  post = postForm, tokenUrl = OUTLOOK_TOKEN_URL, signal, timeoutMs = OAUTH_TIMEOUT_MS, fetchImpl,
} = {}) {
  try {
    return await postToken(post, tokenUrl, {
      refresh_token: refreshToken,
      client_id: secret.client_id,
      client_secret: secret.client_secret,
      scope: (scopes || []).join(' '),
      grant_type: 'refresh_token',
    }, { signal, timeoutMs, fetchImpl, label: 'Microsoft OAuth' });
  } catch (err) {
    if (isAbortFailure(err)) throw err;
    return outlookError('Failed to refresh access token', err);
  }
}

// ---------------------------------------------------------------------------
// mongo/StoredCredential.ts:143-169 — setTokens / updateTokens
// ---------------------------------------------------------------------------

/** Apply provider tokens to `credential.oauth2` exactly like the schema method. */
export function setTokens(credential, tokens) {
  assert(tokens.access_token, 'Cannot set tokens, access_token is missing');
  credential.oauth2.accessToken = tokens.access_token;
  if (tokens.expiry_date) {
    credential.oauth2.expiresAt = tokens.expiry_date;
  } else if (tokens.expires_in) {
    credential.oauth2.expiresAt = Date.now() + tokens.expires_in * 1000;
  } else {
    throw new Error('Expiry date did not arrive');
  }
  // A refresh token arrives only on the first authorization (Google) or is
  // rotated occasionally (Outlook) — update it only when it actually arrived.
  if (tokens.refresh_token) {
    credential.oauth2.refreshToken = tokens.refresh_token;
  }
  return credential;
}

// ---------------------------------------------------------------------------
// Configurable provider registry
// ---------------------------------------------------------------------------

function secretsEntries(secrets) {
  const out = [];
  for (const [service, byId] of Object.entries(secrets || {})) {
    for (const [shortKey, secret] of Object.entries(byId || {})) out.push([service, shortKey, secret]);
  }
  return out;
}

/**
 * Build the configurable OAuth provider the credential store and calendar
 * handlers call. Secrets may be supplied inline and/or loaded from a directory
 * tree that mirrors the reference resources/ layout
 * (`<dir>/google/client_*.json`, `<dir>/outlook/client_*.json`).
 *
 * @param {{
 *   secrets?: Record<string, Record<string, object>>,
 *   secretsDir?: string,
 *   post?: (url: string, form: object) => Promise<object>,
 *   endpoints?: { google?: { tokenUrl?: string }, outlook?: { tokenUrl?: string } },
 *   timeoutMs?: number,
 * }} [opts]
 */
export function createOAuthProvider({ secrets, secretsDir, post, endpoints = {}, timeoutMs = OAUTH_TIMEOUT_MS, fetchImpl } = {}) {
  // A configured provider owns a fresh registry. The legacy module registry is
  // only copied for callers that still use setClientSecret() followed by an
  // unconfigured createOAuthProvider(); no provider reads another provider's
  // registry after construction.
  const registry = secrets !== undefined || secretsDir ? new Map() : copyRegistry(SECRETS);
  for (const [service, shortKey, secret] of secretsEntries(secrets)) {
    setRegistrySecret(registry, service, secret, shortKey);
    // Keep the exported OAuth2Secrets compatibility helpers working. Exchange
    // and refresh below use only `registry`, never this shared compatibility map.
    setClientSecret(service, secret, shortKey);
  }
  if (secretsDir) {
    for (const service of [OAuth2Service.google, OAuth2Service.outlook]) {
      try { loadSecretsSync(service, `${secretsDir}/${service}`, { registry }); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
  const tokens = {
    google: endpoints.google?.tokenUrl || GOOGLE_TOKEN_URL,
    outlook: endpoints.outlook?.tokenUrl || OUTLOOK_TOKEN_URL,
  };
  return {
    supports: (serviceName) => serviceName === OAuth2Service.google || serviceName === OAuth2Service.outlook,
    redeem: async (serviceName, params) => {
      const secret = getRegistrySecret(registry, serviceName, params.clientId);
      if (serviceName === OAuth2Service.google) {
        return googleRedeemAuthCode(secret, params.authCode, params.redirectUri, {
          post: post || postForm, tokenUrl: tokens.google, signal: params.signal,
          timeoutMs: params.timeoutMs ?? timeoutMs, fetchImpl,
        });
      }
      if (serviceName === OAuth2Service.outlook) {
        return outlookRedeemAuthCode(secret, params.authCode, params.scopes, params.redirectUri, {
          post: post || postForm, tokenUrl: tokens.outlook, signal: params.signal,
          timeoutMs: params.timeoutMs ?? timeoutMs, fetchImpl,
        });
      }
      throw new Error(`Service is not supported by Lasso: ${serviceName}`);
    },
    refresh: async (serviceName, params) => {
      const secret = getRegistrySecret(registry, serviceName, params.clientId);
      if (serviceName === OAuth2Service.google) {
        return googleRefreshCredentials(secret, params.refreshToken, {
          post: post || postForm, tokenUrl: tokens.google, signal: params.signal,
          timeoutMs: params.timeoutMs ?? timeoutMs, fetchImpl,
        });
      }
      if (serviceName === OAuth2Service.outlook) {
        return outlookRefreshCredentials(secret, params.refreshToken, params.scopes, {
          post: post || postForm, tokenUrl: tokens.outlook, signal: params.signal,
          timeoutMs: params.timeoutMs ?? timeoutMs, fetchImpl,
        });
      }
      throw new Error(`Service is not supported by Lasso: ${serviceName}`);
    },
    getClientSecret: (serviceName, clientId) => getRegistrySecret(registry, serviceName, clientId),
  };
}

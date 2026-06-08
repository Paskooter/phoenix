// Credential store — Phoenix port of lasso/credential (Credentials.ts + CredentialRequestsHandler).
// In-memory (the reference used Mongo with a unique compound index on
// accountId+skillId+serviceName+serviceAccountName). POST/GET/DELETE /v1/credential.
// testAuthCode short-circuits the OAuth exchange (integration-test path); real google/outlook
// token exchange is out of scope here (501) — supply tokens directly or use testAuthCode.

const DEFAULT_GOOGLE_CLIENT_ID = '830717411721';
const SPECIAL_AUTH_CODE = 'testAuthCode';
const REQUIRED_SAVE = ['accountId', 'skillId', 'serviceName', 'serviceAccountName', 'scopes', 'clientId'];
const REQUIRED_FIND = ['accountId', 'skillId', 'serviceName', 'serviceAccountName', 'scopes'];

const keyOf = (c) => [c.accountId, c.skillId, c.serviceName, c.serviceAccountName].join('|');

function validateScopes(scopes) {
  if (!Array.isArray(scopes)) throw new Error('Scopes should be an array');
  if (!scopes.length) throw new Error('Scopes should be not empty array');
  if (!scopes.every((s) => typeof s === 'string')) throw new Error('Scopes should be strings');
}

function requireProps(obj, props) {
  for (const p of props) {
    if (!obj[p]) throw new Error(`Missing ${p} in request`);
    if (p === 'scopes') validateScopes(obj.scopes);
  }
}

export class CredentialStore {
  constructor() { this.m = new Map(); }

  find(query, allowInactive = false) {
    const c = this.m.get(keyOf(query));
    if (!c) return null;
    if (!allowInactive && c.isActive === false) return null;
    if (query.scopes && !query.scopes.every((s) => c.scopes.includes(s))) return null;
    return c;
  }

  /** Save (create/update) a credential. Returns the stored credential. */
  save(data) {
    requireProps(data, REQUIRED_SAVE);
    const tokensArrived = data.accessToken && data.refreshToken && data.expiresAt;
    if (!data.authCode && !tokensArrived) {
      throw new Error('Missing authCode or tokens (accessToken, refreshToken, expiresAt) in request');
    }
    const existing = this.find(data, true);
    const existingOauth = existing && existing.oauth2 && existing.oauth2.clientId === data.clientId ? existing.oauth2 : {};
    if (data.authCode && existingOauth.authCode === data.authCode) {
      const e = new Error('Credential already exists'); e.code = 'DUPLICATE_KEY'; throw e;
    }
    const cred = existing || {
      accountId: data.accountId, skillId: data.skillId, serviceName: data.serviceName,
      serviceAccountName: data.serviceAccountName, scopes: data.scopes, isActive: true, createdAt: Date.now(),
    };
    cred.isActive = true; cred.error = undefined;
    const redirectUri = data.redirectUri || existingOauth.redirectUri;
    if (tokensArrived) {
      cred.oauth2 = { clientId: data.clientId, authCode: existingOauth.authCode, redirectUri, accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt };
    } else {
      cred.oauth2 = { clientId: data.clientId, authCode: data.authCode, redirectUri, accessToken: null, refreshToken: existingOauth.refreshToken || null, expiresAt: null };
      this._redeem(cred);
    }
    this.m.set(keyOf(cred), cred);
    this._deleteOther(cred);
    return cred;
  }

  _redeem(cred) {
    if (cred.oauth2.authCode === SPECIAL_AUTH_CODE) {
      cred.oauth2.accessToken = 'testAccessToken';
      cred.oauth2.refreshToken = 'testRefreshToken';
      cred.oauth2.expiresAt = new Date(2050, 0, 1).getTime();
      return;
    }
    if (cred.serviceName === 'google' || cred.serviceName === 'outlook') {
      const e = new Error(`OAuth token exchange not configured for ${cred.serviceName} (use testAuthCode or supply tokens)`);
      e.status = 501; throw e;
    }
    throw new Error(`Service is not supported by Lasso: ${cred.serviceName}`);
  }

  // DIVERGENCE B3: reference had `if (newCredential.skillId = 'report-skill')` (assignment bug);
  // fixed to a comparison here.
  _deleteOther(newCred) {
    if (newCred.skillId === 'report-skill' && ['workCalendar', 'personalCalendar'].includes(newCred.serviceAccountName)) {
      for (const [k, c] of [...this.m]) {
        if (c.accountId === newCred.accountId && c.skillId === newCred.skillId && c.serviceName !== newCred.serviceName && c.serviceAccountName === newCred.serviceAccountName) {
          this.m.delete(k);
        }
      }
    }
  }

  checkExists(query) { requireProps(query, REQUIRED_FIND); return { credentialExists: !!this.find(query) }; }

  delete(query) {
    requireProps(query, ['accountId', 'skillId', 'serviceName', 'serviceAccountName']);
    for (const [k, c] of [...this.m]) {
      if (c.accountId !== query.accountId) continue;
      if (query.skillId !== '*' && c.skillId !== query.skillId) continue;
      if (query.serviceName !== '*' && c.serviceName !== query.serviceName) continue;
      if (query.serviceAccountName !== '*' && c.serviceAccountName !== query.serviceAccountName) continue;
      if (query.scopes && query.scopes[0] !== '*' && !query.scopes.every((s) => c.scopes.includes(s))) continue;
      this.m.delete(k);
    }
  }
}

/** Parse a credential query object from URL search params (scopes: repeated or comma-separated). */
export function credentialQueryFromParams(q) {
  const scopes = q.getAll('scopes').length ? q.getAll('scopes') : (q.get('scopes') || '').split(',').filter(Boolean);
  return {
    accountId: q.get('accountId'), skillId: q.get('skillId'),
    serviceName: q.get('serviceName'), serviceAccountName: q.get('serviceAccountName'),
    scopes,
  };
}

/** Build the POST/GET/DELETE /v1/credential route handlers for createService. */
export function credentialHandlers(store) {
  return {
    post: ({ body = {}, res }) => {
      if (body.skillId === 'report-skill' && body.serviceName === 'google' && !body.clientId) body.clientId = DEFAULT_GOOGLE_CLIENT_ID;
      try {
        store.save(body);
        return { created: true };
      } catch (e) {
        if (e.code === 'DUPLICATE_KEY') return { credentialExists: true };
        res.writeHead(e.status || 400, { 'content-type': 'text/plain' }); res.end(e.message); return undefined;
      }
    },
    get: ({ url, res }) => {
      try { return store.checkExists(credentialQueryFromParams(url.searchParams)); }
      catch (e) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(e.message); return undefined; }
    },
    del: ({ url, res }) => {
      try { store.delete(credentialQueryFromParams(url.searchParams)); return { deleted: true }; }
      catch (e) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(e.message); return undefined; }
    },
  };
}

// Credential store — Phoenix port of lasso/credential (Credentials.ts + CredentialRequestsHandler).
//
// Uniqueness: the reference Mongo schema declares a unique compound index
// (accountId, skillId, serviceName, serviceAccountName, scopes —
// StoredCredential.ts:107-119 `credentials_index`). `scopes` is an array, so
// Mongo builds that index MULTIKEY (one key per element): two same-slot records
// that share even ONE scope value collide, the second insert raises E11000, and
// CredentialRequestsHandler.ts:36-39 answers 200 {credentialExists:true}. The
// in-memory Map key uses the same 5-tuple with the scope SET sorted, and `save`
// refuses a new record whose scope list intersects an existing same-slot
// record's (`_sharesScopeWithSlot`), so Phoenix reproduces the reference's
// state space: equal scope sets update in place, disjoint sets coexist (the
// original fixture "store google:personalCalendar credential with other
// scopes"), overlapping sets are rejected. Two credentials for the same slot
// with *different* scopes therefore coexist, and a stored scope can never
// multi-match. find() uses Mongo's `scopes: {$all: query.scopes}` semantics.
//
// Persistence: credentials live in a JSON snapshot at
// packages/data/data/credentials.json (a host mount in compose), mirroring the
// account-service Store. `new CredentialStore({ file })` (or a path string, or
// the ETCO_data_credentialsFile env var) overrides the path. Each mutation
// rewrites the snapshot atomically (exclusive tmp + rename, 0600 file / 0700
// dir); a fresh store on the same file recovers the credentials ("survives
// restarts"). This is durable by default because the reference backed
// credentials with Mongo and they survived a service restart; an in-memory
// default silently dropped every credential on restart (D-02 gap, verified by
// restarting `node packages/data/src/index.js`).
//
// testAuthCode short-circuits the OAuth exchange (integration-test path); real
// google/outlook token exchange is out of scope here (501) — supply tokens
// directly or use testAuthCode.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_GOOGLE_CLIENT_ID = '830717411721';
// Durable-by-default store path, mirroring packages/account/src/store.js
// (`../data/store.json`). Override with ETCO_data_credentialsFile.
const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '../data/credentials.json');
const SPECIAL_AUTH_CODE = 'testAuthCode';
const REQUIRED_SAVE = ['accountId', 'skillId', 'serviceName', 'serviceAccountName', 'scopes', 'clientId'];
const REQUIRED_FIND = ['accountId', 'skillId', 'serviceName', 'serviceAccountName', 'scopes'];

/**
 * Unique key matching the reference `credentials_index` compound index.
 * Scopes are sorted so order permutations of the same scope set collapse.
 */
const keyOf = (c) => JSON.stringify([c.accountId, c.skillId, c.serviceName, c.serviceAccountName, [...(c.scopes || [])].sort()]);

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
  constructor(fileOrOpts = {}) {
    const opts = typeof fileOrOpts === 'string' ? { file: fileOrOpts } : (fileOrOpts || {});
    this.file = opts.file ?? process.env.ETCO_data_credentialsFile ?? DEFAULT_FILE;
    this.m = new Map();
    this._load();
  }

  _load() {
    if (!this.file || !existsSync(this.file)) return;
    let items;
    try {
      items = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(`credential store unreadable (${this.file}): ${err.message}`);
    }
    if (!Array.isArray(items)) throw new Error(`credential store unreadable (${this.file}): expected an array`);
    for (const item of items) {
      if (!item || typeof item.accountId !== 'string' || typeof item.skillId !== 'string') continue;
      this.m.set(keyOf(item), item);
    }
  }

  /** Replace the snapshot atomically (exclusive tmp + rename), 0600 file / 0700 dir. */
  _flush() {
    if (!this.file) return;
    const serialized = JSON.stringify([...this.m.values()], null, 2);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, serialized);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or cleanup unavailable */ }
    }
  }

  /**
   * Find up to one matching credential. Query scope semantics are
   * `scopes: { $all: query.scopes }` — an extra stored scope does not prevent a
   * match, a requested scope the stored credential lacks does.
   * Returns null when absent; mirrors the reference's >1-match "critical bug"
   * path (unique index violation) by returning undefined and warning.
   */
  find(query, allowInactive = false) {
    requireProps(query, REQUIRED_FIND);
    const matches = [];
    for (const c of this.m.values()) {
      if (c.accountId !== query.accountId) continue;
      if (c.skillId !== query.skillId) continue;
      if (c.serviceName !== query.serviceName) continue;
      if (c.serviceAccountName !== query.serviceAccountName) continue;
      if (query.scopes && !query.scopes.every((s) => c.scopes.includes(s))) continue;
      if (!allowInactive && c.isActive === false) continue;
      matches.push(c);
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    console.warn(`Credentials query ${JSON.stringify(query)} returned more than one result`);
    return undefined;
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
      // Reference marks this with MongoErrorCodes.DUPLICATE_KEY (11000); Phoenix
      // keeps its pre-existing string marker. Never crosses the wire — both
      // representations are mapped to {credentialExists: true} (status 200).
      const e = new Error('Credential already exists'); e.code = 'DUPLICATE_KEY'; throw e;
    }
    // Update the existing credential or create a new one (new key when the
    // 5-tuple differs, e.g. new scopes — the original "other scopes" fixture).
    // A NEW record whose scopes share a value with another same-slot record is
    // rejected exactly like the reference's multikey `credentials_index`
    // (E11000 → handler answers 200 {credentialExists:true}) — see the
    // uniqueness note at the top of this file.
    if (!existing && this._sharesScopeWithSlot(data)) {
      const e = new Error('Credential already exists'); e.code = 'DUPLICATE_KEY'; throw e;
    }
    const cred = existing || {
      accountId: data.accountId, skillId: data.skillId, serviceName: data.serviceName,
      serviceAccountName: data.serviceAccountName, scopes: data.scopes, isActive: true, createdAt: Date.now(),
    };
    if (existing) { cred.isActive = true; cred.error = undefined; }
    const redirectUri = data.redirectUri || existingOauth.redirectUri;
    if (tokensArrived) {
      cred.oauth2 = { clientId: data.clientId, authCode: existingOauth.authCode, redirectUri, accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt };
    } else {
      cred.oauth2 = { clientId: data.clientId, authCode: data.authCode, redirectUri, accessToken: null, refreshToken: existingOauth.refreshToken || null, expiresAt: null };
      this._redeem(cred);
    }
    this.m.set(keyOf(cred), cred);
    this._deleteOther(cred);
    this._flush();
    return cred;
  }

  /**
   * Mongo's unique `credentials_index` is MULTIKEY because `scopes` is an array
   * (StoredCredential.ts:107-119), so an insert collides with any other record
   * that has the same (accountId, skillId, serviceName, serviceAccountName) and
   * shares at least one scope VALUE. `save` calls this on the insert path only
   * (an update of a matched record reuses its _id and cannot collide).
   */
  _sharesScopeWithSlot(data) {
    for (const c of this.m.values()) {
      if (c.accountId !== data.accountId || c.skillId !== data.skillId) continue;
      if (c.serviceName !== data.serviceName || c.serviceAccountName !== data.serviceAccountName) continue;
      if (c.scopes.some((s) => data.scopes.includes(s))) return true;
    }
    return false;
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

  // RECORDED DIVERGENCE (see D-02 candidate 20260910): the reference wrote
  // `if (newCredential.skillId = 'report-skill')` — an assignment, always truthy —
  // so it fires for ANY skillId, then deletes with skillId='report-skill' (the
  // value the assignment just wrote). Phoenix treats it as a *comparison*, so
  // cross-provider deletion fires only when the arriving credential itself is
  // report-skill. The reference would delete an existing report-skill
  // credential other-service when ANY skill saves the same calendar; Phoenix
  // does not. Pinned by test `assignment-bug regression fixture` (see
  // packages/data/test/credential-durable.test.js).
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
    // `scopes` is optional for DELETE (Credentials.ts:243-248) and is never
    // run through validateScopes, so a lone non-array `scopes` query value is
    // treated as a one-element list here (the reference hands the raw value to
    // Mongo's `$all`, an unobservable server-side error — see UNKNOWN in the
    // D-02 report). Indexed/bracketed forms (`scopes[0]=`, `scopes[]=`) already
    // arrive as arrays from credentialQueryFromParams.
    const scopes = query.scopes == null ? null : (Array.isArray(query.scopes) ? query.scopes : [query.scopes]);
    let changed = false;
    for (const [k, c] of [...this.m]) {
      if (c.accountId !== query.accountId) continue;
      if (query.skillId !== '*' && c.skillId !== query.skillId) continue;
      if (query.serviceName !== '*' && c.serviceName !== query.serviceName) continue;
      if (query.serviceAccountName !== '*' && c.serviceAccountName !== query.serviceAccountName) continue;
      if (scopes && scopes[0] !== '*' && !scopes.every((s) => c.scopes.includes(s))) continue;
      this.m.delete(k); changed = true;
    }
    if (changed) this._flush();
  }
}

// The reference reads its query with Express 4.16.2's default `'extended'`
// parser (qs 6.5.1, both pinned in .parity/reference/5c0a739…/node_modules),
// which maps the client wire forms like this:
//   scopes[0]=a&scopes[1]=b -> ['a','b']  (srv-settings-ws src/clients/lasso.ts:38-40)
//   scopes[]=a&scopes[]=b   -> ['a','b']  (pinned axios 0.17.1 array serialization)
//   scopes=a&scopes=b       -> ['a','b']
//   scopes=a                -> 'a'    -> validateScopes -> 400 "Scopes should be an array"
//   scopes=a,b              -> 'a,b'  -> 400
//   (absent)                -> undefined -> 400 "Missing scopes in request"
// (this function returns null for the absent case — both are falsy and produce
// the identical message.)
// This function returns the same shapes so `validateScopes` produces the
// reference's exact messages, and so the two bracket forms (which the original
// fixtures and the Settings service actually send) resolve instead of 400ing.
const INDEXED_SCOPES = /^scopes\[(\d*)\]$/;

function scopesFromParams(q) {
  const indexed = [];
  const bare = [];
  for (const [key, value] of q) {
    if (key === 'scopes') { bare.push(value); continue; }
    const m = INDEXED_SCOPES.exec(key);
    if (m) indexed.push([m[1] === '' ? Number.MAX_SAFE_INTEGER : Number(m[1]), value]);
  }
  if (indexed.length) {
    indexed.sort((a, b) => a[0] - b[0]);
    return [...indexed.map(([, value]) => value), ...bare];
  }
  if (bare.length === 0) return null;
  return bare.length === 1 ? bare[0] : bare;
}

/**
 * Parse a credential query object from URL search params, reproducing the
 * qs-parsed shape the reference sees (see INDEXED_SCOPES above). With no scopes
 * param at all the field is null, so required-field validation reports
 * `Missing scopes in request` — the reference's message when a client omits
 * scopes. A single plain `scopes` value stays a STRING, so `validateScopes`
 * rejects it with `Scopes should be an array` exactly as the reference does.
 */
export function credentialQueryFromParams(q) {
  return {
    accountId: q.get('accountId'), skillId: q.get('skillId'),
    serviceName: q.get('serviceName'), serviceAccountName: q.get('serviceAccountName'),
    scopes: scopesFromParams(q),
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
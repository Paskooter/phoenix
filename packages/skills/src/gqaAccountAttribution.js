// Source-backed account and attribution seams for the opt-in GQA profile.
//
// Source: jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26,
// gqa/account.py and gqa/attribute.py.  The source account lookup uses a
// configured HTTP endpoint; attribution uses a Mongo collection.  Neither
// boundary has a Phoenix default, so selecting one is always explicit.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const GQA_ACCOUNT_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_ACCOUNT_SOURCE_MODULE = 'gqa/account.py';
export const GQA_ATTRIBUTE_SOURCE_REVISION = 'ebe1a7d38f511570060c1fbf61bec89d58419b26';
export const GQA_ATTRIBUTE_SOURCE_MODULE = 'gqa/attribute.py';
export const GQA_ACCOUNT_SERVICE_ENV = 'ETCO_server_accountService';
export const PHOENIX_ACCOUNT_LOOP_PATH = '/listAssociatedLoops';
export const PHOENIX_ACCOUNT_VERIFY_PATH = '/api/verify';

// gqa/attribute.py creates this index after every insert.  The object form is
// the native Node Mongo representation of the same ordered source keys.
export const GQA_ATTRIBUTE_INDEX = Object.freeze({
  loop_id: -1,
  timestamp: -1,
  service: -1,
});

// The file counterpart is opt-in through a factory or an explicit service
// configuration. Keep the default outside the repository and use one stable
// path so a process restart can recover the same local attribution history.
export const GQA_ATTRIBUTE_DEFAULT_FILE = join(tmpdir(), 'phoenix-gqa-attribution.json');

const DEFAULT_FILE_PERSISTENCE = Object.freeze({
  chmod: chmodSync,
  exists: existsSync,
  mkdir: mkdirSync,
  readFile: readFileSync,
  rename: renameSync,
  unlink: unlinkSync,
  writeFile: writeFileSync,
});

// Flask/Werkzeug's malformed and empty JSON requests use this same standard
// 400 body. It is kept at the opt-in attribution route boundary; other
// Phoenix routes continue using the common JSON error action.
const SOURCE_BAD_REQUEST_HTML = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n'
  + '<title>400 Bad Request</title>\n<h1>Bad Request</h1>\n'
  + '<p>The browser (or proxy) sent a request that this server could not understand.</p>\n';

function escapeNonAscii(json) {
  // Python json.dumps defaults to ensure_ascii=True.  Deliberately iterate
  // UTF-16 code units so astral values become the same pair of \u escapes.
  return json.replace(/[\u0080-\uFFFF]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

/** The subset of Python json.dumps needed by account/attribution payloads. */
export function sourceJsonDumps(value) {
  if (value === undefined) throw new TypeError('undefined is not JSON serializable');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    const json = JSON.stringify(value);
    return typeof value === 'string' ? escapeNonAscii(json) : json;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number is not JSON serializable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(sourceJsonDumps).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => (
      `${escapeNonAscii(JSON.stringify(key))}: ${sourceJsonDumps(item)}`
    )).join(', ')}}`;
  }
  throw new TypeError(`${typeof value} is not JSON serializable`);
}

/** Python truthiness for JSON values used by account/attribution branches. */
export function sourceTruthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function sourceObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a mapping`);
  }
  return value;
}

function requiredField(value, name, label) {
  const object = sourceObject(value, label);
  if (!Object.prototype.hasOwnProperty.call(object, name)) {
    throw new TypeError(`${label} is missing '${name}'`);
  }
  return object[name];
}

function accountKey(value) {
  // JSON object keys use Python's JSON spelling for the values that can reach
  // the source account call through a request body.
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  return String(value);
}

function configuredEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('GQA account service endpoint must be configured explicitly');
  }
  return endpoint;
}

function trimEndpoint(endpoint) {
  return String(endpoint).replace(/\/+$/, '');
}

function endpointFromBase(base, path) {
  if (typeof base !== 'string' || base.length === 0) return null;
  return `${trimEndpoint(base)}${path}`;
}

function deriveVerifyEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${PHOENIX_ACCOUNT_VERIFY_PATH}`;
  } catch (_error) {
    // Relative endpoint values are useful in local adapters; callers that
    // need verification for one must provide verifyEndpoint explicitly.
    return null;
  }
}

function valueOrNull(value) {
  if (value === undefined) return undefined;
  return value === null || value === '' ? null : String(value);
}

/**
 * Normalize the two identities that reach the source account lookup:
 * an Account `_id`, or a Classic request's direct SigV4 accessKeyId.
 *
 * The object forms are intentionally explicit. The string form remains the
 * historical account-id API. Classic tags direct SigV4 identities with
 * `credentials.accessKeyId`, avoiding assumptions about credential length or
 * Account ID shape. Other callers may use the explicit context flags.
 */
export function normalizePhoenixGqaIdentity(identity, context = {}) {
  const source = identity && typeof identity === 'object' && !Array.isArray(identity)
    ? identity : null;
  const credentials = context?.credentials && typeof context.credentials === 'object'
    ? context.credentials : null;
  const explicitAccessKey = valueOrNull(source?.accessKeyId)
    || valueOrNull(context?.accessKeyId)
    || valueOrNull(credentials?.accessKeyId);
  const explicitAccountId = valueOrNull(source?._id)
    || valueOrNull(source?.accountId)
    || valueOrNull(context?.accountId)
    || valueOrNull(credentials?.id && credentials?.accessKeyId ? credentials.id : null);

  if (explicitAccessKey) {
    return { accessKeyId: explicitAccessKey, accountId: explicitAccountId || explicitAccessKey };
  }
  if (source) {
    const id = valueOrNull(source._id) || valueOrNull(source.accountId) || valueOrNull(source.id);
    if (id !== null && (source.kind === 'accessKeyId' || source.identityType === 'accessKeyId')) {
      return { accessKeyId: id, accountId: id };
    }
    return { accountId: id };
  }

  const id = valueOrNull(identity);
  if (context?.kind === 'accessKeyId'
    || context?.identityType === 'accessKeyId'
    || context?.directSigV4 === true) {
    return { accessKeyId: id, accountId: id };
  }
  return { accountId: id };
}

async function responseJson(response, label) {
  if (!response || typeof response.json !== 'function') {
    throw new TypeError(`${label} response has no json() method`);
  }
  return response.json();
}

async function verifyPhoenixAccessKey({ verifyEndpoint, accessKeyId, fetchImpl }) {
  if (!verifyEndpoint) return null;
  const separator = verifyEndpoint.includes('?') ? '&' : '?';
  const response = await fetchImpl(
    `${verifyEndpoint}${separator}accessKeyId=${encodeURIComponent(accessKeyId)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
  );
  const value = await responseJson(response, 'Phoenix account verify');
  return value && value.valid === true && value.id !== undefined && value.id !== null
    ? String(value.id) : null;
}

/**
 * Construct the Phoenix-aware source account lookup.
 *
 * `endpoint` is the Account peer `POST /listAssociatedLoops` URL. When a
 * `baseUrl` is supplied instead, both peer paths are derived from it. An
 * explicit `verifyEndpoint` overrides the derived `/api/verify` URL. Account
 * IDs go directly to the POST; explicit/direct access keys first use verify,
 * then fall back to the raw account-id candidate before the source-shaped
 * first-loop selection.
 */
export function createPhoenixGqaAccountLookup({
  endpoint,
  baseUrl,
  verifyEndpoint,
  verifyAccessKeys = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const accountEndpoint = configuredEndpoint(endpoint || endpointFromBase(baseUrl, PHOENIX_ACCOUNT_LOOP_PATH));
  const accountVerifyEndpoint = verifyEndpoint || endpointFromBase(baseUrl, PHOENIX_ACCOUNT_VERIFY_PATH)
    || deriveVerifyEndpoint(accountEndpoint);
  if (typeof fetchImpl !== 'function') throw new TypeError('GQA account fetch implementation must be a function');

  return async function getLoopId(identity, context = {}) {
    const normalized = normalizePhoenixGqaIdentity(identity, context);
    if (!verifyAccessKeys && normalized.accessKeyId) {
      normalized.accessKeyId = undefined;
      normalized.accountId = identity;
    }
    let accountId = normalized.accountId;
    if (normalized.accessKeyId) {
      try {
        accountId = await verifyPhoenixAccessKey({
          verifyEndpoint: accountVerifyEndpoint,
          accessKeyId: normalized.accessKeyId,
          fetchImpl,
        }) || accountId;
      } catch (_error) {
        // The source account call treats a failed identity service as a
        // recoverable empty lookup. Preserve the raw candidate so a trusted
        // peer that already accepts it still gets the normal POST attempt.
      }
    }

    let accountServiceOutput;
    try {
      const response = await fetchImpl(accountEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: sourceJsonDumps({ accountsIds: [accountId] }),
      });
      accountServiceOutput = await responseJson(response, 'GQA account');
    } catch (_error) {
      return {};
    }

    const mapping = sourceObject(accountServiceOutput, 'account service response');
    const key = accountKey(accountId);
    if (!Object.prototype.hasOwnProperty.call(mapping, key)) {
      // gqa/account.py uses account_service_output[user_id], so a missing
      // source key is a visible post-HTTP failure rather than an empty map.
      throw new Error(`Account service response is missing '${key}'`);
    }
    const loopValues = mapping[key];
    if (!sourceTruthy(loopValues)) return {};
    if (loopValues === null || loopValues === undefined || typeof loopValues[0] === 'undefined') {
      throw new TypeError(`Account service value for '${key}' is not indexable`);
    }
    return loopValues[0];
  };
}

/**
 * Construct the source account.get_loop_id boundary.
 *
 * The source intentionally does not inspect HTTP status: it calls
 * response.json() and indexes the returned mapping. Network/JSON failures
 * return a fresh empty object; a structurally invalid successful mapping is
 * allowed to remain visible to the caller, matching the source's access
 * outside its try/except block.
 */
export function createGqaAccountLookup({ endpoint, fetchImpl = globalThis.fetch } = {}) {
  return createPhoenixGqaAccountLookup({ endpoint, fetchImpl, verifyEndpoint: null, verifyAccessKeys: false });
}

function timestampMs(clock) {
  const value = clock();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('GQA attribution clock must return a finite number');
  return Math.trunc(value);
}

// Python compares a truthy JSON timestamp with an integer before building the
// Mongo query. JavaScript's relational operators would coerce strings,
// arrays, and objects instead, turning a source TypeError into a successful
// (and often different) query. Booleans remain numeric in Python and are
// therefore deliberately accepted here.
function sourceTimestamp(value, label) {
  if (sourceTruthy(value)
    && typeof value !== 'number'
    && typeof value !== 'boolean') {
    throw new TypeError(`${label} must be numeric`);
  }
  return value;
}

function attributionRecord(service, query, url, imageUrl, loopId, clock) {
  return {
    service,
    query,
    url,
    image_url: imageUrl,
    loop_id: loopId,
    timestamp: timestampMs(clock),
  };
}

async function collectCursor(cursor) {
  if (cursor && typeof cursor[Symbol.asyncIterator] === 'function') {
    const values = [];
    for await (const item of cursor) values.push(item);
    return values;
  }
  if (cursor && typeof cursor[Symbol.iterator] === 'function') return [...cursor];
  throw new TypeError('GQA attribution collection.find() must return an iterable cursor');
}

/** Wrap a real Mongo-style `DATABASE.attributes` collection. */
export function createGqaAttributionStore({ collection, clock = Date.now } = {}) {
  if (!collection || typeof collection.insertOne !== 'function'
    || typeof collection.createIndex !== 'function'
    || typeof collection.find !== 'function' || typeof collection.deleteMany !== 'function') {
    throw new TypeError('GQA attribution collection must provide Mongo insertOne/createIndex/find/deleteMany methods');
  }

  return Object.freeze({
    async insert(service, query, url, imageUrl, loopId) {
      const record = attributionRecord(service, query, url, imageUrl, loopId, clock);
      await collection.insertOne(record);
      await collection.createIndex(GQA_ATTRIBUTE_INDEX);
    },

    async search(loopId, service, before, after) {
      const threshold = timestampMs(clock) - (90 * 24 * 60 * 60 * 1000);
      sourceTimestamp(after, 'after');
      if (!sourceTruthy(after) || after < threshold) after = threshold;
      const timestamp = { $gt: after };
      if (sourceTruthy(before)) timestamp.$lt = before;
      const query = { loop_id: loopId, timestamp };
      if (sourceTruthy(service)) query.service = service;
      // The source passes a PyMongo projection as its second positional
      // argument. Node's modern Mongo driver takes FindOptions there, so the
      // equivalent projection must be nested under `projection`.
      const cursor = collection.find(query, { projection: { _id: 0 } });
      const limited = cursor && typeof cursor.limit === 'function' ? cursor.limit(50) : cursor;
      return collectCursor(limited);
    },

    async wipe(loopId) {
      const result = await collection.deleteMany({ loop_id: loopId });
      return result?.deletedCount ?? result?.deleted_count ?? 0;
    },
  });
}

function cloneAttributionValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function attributionSnapshot(records) {
  return records.map((record) => cloneAttributionValue(record));
}

/**
 * Durable local counterpart of the source Mongo attribution collection.
 *
 * The file is an implementation detail of an explicitly selected Phoenix
 * profile. Each mutation writes a complete `{version, records}` snapshot to
 * a private temporary file and then atomically replaces the destination. The
 * public methods intentionally have the same async insert/search/wipe shape as
 * the Mongo adapter, so callers do not need to know which persistence seam is
 * selected.
 */
export class GqaFileAttributionStore {
  constructor(
    file = process.env.ETCO_gqa_attributionFile || GQA_ATTRIBUTE_DEFAULT_FILE,
    { clock = Date.now, persistence = {} } = {},
  ) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError('GQA attribution file must be a non-empty path');
    }
    if (typeof clock !== 'function') throw new TypeError('GQA attribution clock must be a function');
    this.file = file;
    this.clock = clock;
    this.persistence = { ...DEFAULT_FILE_PERSISTENCE, ...persistence };
    this.records = [];
    this._load();
    this._committed = this._snapshot();
  }

  _load() {
    if (!this.persistence.exists(this.file)) return;
    let raw;
    try {
      raw = JSON.parse(this.persistence.readFile(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`GQA attribution store unreadable (${this.file}): ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`GQA attribution store has an invalid root (${this.file})`);
    }
    if (raw.records !== undefined && !Array.isArray(raw.records)) {
      throw new Error(`GQA attribution store has invalid records (${this.file})`);
    }
    for (const record of raw.records || []) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`GQA attribution store has an invalid record (${this.file})`);
      }
      if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
        throw new Error(`GQA attribution store has an invalid record timestamp (${this.file})`);
      }
      this.records.push(cloneAttributionValue(record));
    }
  }

  _snapshot() {
    return attributionSnapshot(this.records);
  }

  _restore(snapshot) {
    this.records = attributionSnapshot(snapshot);
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

  /** Atomically replace the private JSON snapshot after a mutation. */
  flush({ rollbackOnError = true } = {}) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const output = {
        version: 1,
        records: this._snapshot(),
      };
      const serialized = `${JSON.stringify(output, null, 2)}\n`;
      this.persistence.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      this.persistence.writeFile(temporary, serialized, {
        encoding: 'utf8',
        mode: 0o600,
      });
      // writeFile's mode is ignored if a stale temporary path is ever reused;
      // chmod keeps the private-file guarantee explicit before the swap.
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

  async insert(service, query, url, imageUrl, loopId) {
    const record = cloneAttributionValue(attributionRecord(service, query, url, imageUrl, loopId, this.clock));
    this._commit(() => {
      this.records.push(record);
    });
  }

  async search(loopId, service, before, after) {
    const threshold = timestampMs(this.clock) - (90 * 24 * 60 * 60 * 1000);
    sourceTimestamp(after, 'after');
    if (!sourceTruthy(after) || after < threshold) after = threshold;
    // Stored timestamps are numeric. Mongo's range operators bracket BSON
    // types; a truthy nonnumeric bound matches no numeric timestamp. Empty
    // arrays/objects and false are false in Python and therefore omit bounds.
    if (typeof after !== 'number'
      || (sourceTruthy(before) && typeof before !== 'number')) return [];
    return this.records
      .filter((record) => record.loop_id === loopId
        && (!sourceTruthy(service) || record.service === service)
        && typeof record.timestamp === 'number'
        && record.timestamp > after
        && (!sourceTruthy(before) || record.timestamp < before))
      .slice(0, 50)
      .map((record) => cloneAttributionValue(record));
  }

  async wipe(loopId) {
    const count = this.records.filter((record) => record.loop_id === loopId).length;
    if (count === 0) return 0;
    this._commit(() => {
      this.records = this.records.filter((record) => record.loop_id !== loopId);
    });
    return count;
  }

  /** A test/diagnostic view; callers receive detached records. */
  snapshot() {
    return this._snapshot();
  }
}

export function createGqaFileAttributionStore(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('GQA file attribution options must be a mapping');
  }
  const { file, ...storeOptions } = options;
  return new GqaFileAttributionStore(file, storeOptions);
}

/**
 * Deterministic offline store with the source Mongo query semantics.  It is a
 * test/deployment seam only; the profile never selects it implicitly.
 */
export function createGqaMemoryAttributionStore({ clock = Date.now } = {}) {
  const records = [];
  return Object.freeze({
    async insert(service, query, url, imageUrl, loopId) {
      records.push(attributionRecord(service, query, url, imageUrl, loopId, clock));
    },

    async search(loopId, service, before, after) {
      const threshold = timestampMs(clock) - (90 * 24 * 60 * 60 * 1000);
      sourceTimestamp(after, 'after');
      if (!sourceTruthy(after) || after < threshold) after = threshold;
      // Stored timestamps are numeric. Mongo's range operators bracket BSON
      // types; a truthy nonnumeric bound matches no numeric timestamp. The
      // source passes `before` to Mongo without a Python numeric comparison.
      if (typeof after !== 'number'
        || (sourceTruthy(before) && typeof before !== 'number')) return [];
      return records
        .filter((record) => record.loop_id === loopId
          && (!sourceTruthy(service) || record.service === service)
          && record.timestamp > after
          && (!sourceTruthy(before) || record.timestamp < before))
        .slice(0, 50)
        .map((record) => ({ ...record }));
    },

    async wipe(loopId) {
      let count = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index].loop_id === loopId) {
          records.splice(index, 1);
          count += 1;
        }
      }
      return count;
    },

    snapshot() {
      return records.map((record) => ({ ...record }));
    },
  });
}

function sendSourceJson(context, value, status = 200) {
  const response = context?.res;
  const body = sourceJsonDumps(value);
  if (response && typeof response.status === 'function'
    && typeof response.type === 'function' && typeof response.send === 'function') {
    response.status(status).type('html').send(body);
    return undefined;
  }
  return value;
}

function sourceError(error) {
  return {
    version: '5.2.15',
    message: error?.message || String(error),
    stacktrace: error?.stack,
  };
}

function credentialsFromRequest(request) {
  const headers = request?.headers || {};
  const raw = headers['x-amz-credentials'] ?? headers['X-Amz-Credentials'];
  if (raw === undefined) throw new Error("Missing 'x-amz-credentials' header");
  return requiredField(JSON.parse(raw), 'id', 'x-amz-credentials');
}

function sourceRequestMapping(body) {
  return sourceObject(body, 'request JSON');
}

function requestContentType(request) {
  const headers = request?.headers || {};
  const value = headers['content-type'] ?? headers['Content-Type'];
  if (value === undefined || value === null) return undefined;
  return String(value).split(';', 1)[0].trim().toLowerCase();
}

function requestHasEntity(request) {
  const headers = request?.headers || {};
  const rawLength = headers['content-length'] ?? headers['Content-Length'];
  const length = Number(rawLength);
  if (Number.isFinite(length)) return length > 0;
  return headers['transfer-encoding'] !== undefined || headers['Transfer-Encoding'] !== undefined;
}

function isSourceJsonRequest(request) {
  const type = requestContentType(request);
  return type === 'application/json'
    || (type?.startsWith('application/') && type.endsWith('+json'));
}

function sourceRequestBody(context) {
  // Flask 0.12 accepts application/json and application/*+json. Keep
  // unsupported media out of the parser as well as this route's body access.
  if (!isSourceJsonRequest(context?.req)) return null;
  return context?.body;
}

function emptyJsonRequest(request) {
  return isSourceJsonRequest(request) && !requestHasEntity(request);
}

function sendSourceBadRequest(context) {
  const response = context?.res;
  if (response && typeof response.status === 'function'
    && typeof response.setHeader === 'function' && typeof response.end === 'function') {
    response.status(400);
    // Express's `res.set()` appends a charset to text media types. The source
    // Flask response has exactly `text/html`, so use Node's header primitive
    // for this opt-in framework error body.
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Length', String(Buffer.byteLength(SOURCE_BAD_REQUEST_HTML)));
    response.end(SOURCE_BAD_REQUEST_HTML);
    return undefined;
  }
  if (response && typeof response.status === 'function'
    && typeof response.type === 'function' && typeof response.send === 'function') {
    response.status(400).type('html').send(SOURCE_BAD_REQUEST_HTML);
    return undefined;
  }
  return SOURCE_BAD_REQUEST_HTML;
}

function sourceParserError(context) {
  return sendSourceBadRequest(context);
}

/** Source `/retrieveAtt`, exposed only when account and storage are selected. */
export function createGqaRetrieveAttributionRoute({ accountLookup, attribution } = {}) {
  if (typeof accountLookup !== 'function') throw new TypeError('GQA retrieveAtt requires an account lookup');
  if (!attribution || typeof attribution.search !== 'function') throw new TypeError('GQA retrieveAtt requires attribution storage');
  const route = async (context = {}) => {
    // Flask rejects an empty application/json entity in request.json before
    // the account lookup. Keep that route-local 400 without changing the
    // common parser used by other services.
    if (emptyJsonRequest(context.req)) return sendSourceBadRequest(context);
    try {
      const userId = credentialsFromRequest(context.req);
      const loopId = await accountLookup(userId);
      if (!sourceTruthy(loopId)) throw new Error('No robot ID!');
      // Source performs the account call before data.get(), so top-level
      // JSON values retain the account side effect before their 500.
      const body = sourceRequestMapping(sourceRequestBody(context));
      const data = await attribution.search(loopId, body.Service, body.before, body.after);
      return sendSourceJson(context, { data });
    } catch (error) {
      return sendSourceJson(context, sourceError(error), 500);
    }
  };
  // Flask accepts top-level JSON values and lets the route produce its own
  // failure; the common service's loose parser gives this route that boundary.
  route.jsonStrict = false;
  route.jsonTypes = ['application/json', 'application/*+json'];
  route.bodyDefault = null;
  route.parserError = sourceParserError;
  return route;
}

/** Source `/wipeID`; storage is explicit but no account call is made. */
export function createGqaWipeAttributionRoute({ attribution } = {}) {
  if (!attribution || typeof attribution.wipe !== 'function') throw new TypeError('GQA wipeID requires attribution storage');
  const route = async (context = {}) => {
    if (emptyJsonRequest(context.req)) return sendSourceBadRequest(context);
    try {
      const body = sourceRequestMapping(sourceRequestBody(context));
      const targetId = requiredField(body, 'ID', 'wipeID request');
      if (!sourceTruthy(targetId)) return sendSourceJson(context, { message: 'No id provided.' });
      return sendSourceJson(context, { deleted_row: await attribution.wipe(targetId) });
    } catch (error) {
      return sendSourceJson(context, sourceError(error), 500);
    }
  };
  route.jsonStrict = false;
  route.jsonTypes = ['application/json', 'application/*+json'];
  route.bodyDefault = null;
  route.parserError = sourceParserError;
  return route;
}

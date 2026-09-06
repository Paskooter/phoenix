// Explicit transport adapters for the two recovered Settings boundaries.
//
// The Pegasus SettingsClient is an internal peer client: it sends ordinary JSON and
// an x-amz-credentials identity to settings.jibo.aws.  The public AWS-JSON request
// first passes through security-gw, where SigV4 has already been checked.  That gateway
// changes the AWS JSON content type and replaces the caller's credentials header before
// routing to api-gw.  Keep these operations separate; content type alone must not select
// a trust boundary.

export const SETTINGS_TRANSPORTS = Object.freeze({
  INTERNAL: 'internal-settings',
  PUBLIC: 'public-aws-json',
});

export const SETTINGS_API_VERSION = '20160801';
// Axios 0.17.1 (the pinned Pegasus dependency) adds this charset when it
// serializes an object. The security gateway's own rewritten hop is plain
// application/json, so keep the two source contracts distinct.
export const SETTINGS_INTERNAL_CONTENT_TYPE = 'application/json;charset=utf-8';
export const SETTINGS_GATEWAY_CONTENT_TYPE = 'application/json';
export const SETTINGS_PUBLIC_CONTENT_TYPE = 'application/x-amz-json-1.1';

const REDACTED_SECRET = '***hidden***';

/**
 * Build the request emitted by the pinned Hub/Report SettingsClient.
 *
 * The caller selects the destination separately (the source uses NET_settings); this
 * function only prepares the request body and internal peer headers. It intentionally
 * does not add Authorization or accept a public AWS-JSON request as an internal one.
 */
export function prepareInternalSettingsRequest({
  accountId,
  operation = 'GetSettings',
  body,
  apiVersion = SETTINGS_API_VERSION,
} = {}) {
  if (!accountId) throw new TypeError('Settings internal transport requires accountId');
  if (!operation || typeof operation !== 'string') {
    throw new TypeError('Settings internal transport requires operation');
  }
  if (!apiVersion || typeof apiVersion !== 'string') {
    throw new TypeError('Settings internal transport requires apiVersion');
  }

  return {
    headers: {
      'content-type': SETTINGS_INTERNAL_CONTENT_TYPE,
      'x-amz-credentials': JSON.stringify({ id: accountId }),
      'x-amz-target': `Settings_${apiVersion}.${operation}`,
    },
    // JSON.stringify preserves the caller's property order, which is the wire order
    // produced by Axios for the source client's data object.
    body: JSON.stringify(body),
  };
}

/**
 * Build a public gateway adapter around an actual authentication boundary.
 *
 * The security gateway authenticates the original AWS request before it calls its
 * forwarding route. Requiring both callbacks keeps this module from becoming an
 * unauthenticated public proxy: the caller cannot supply an identity as request data,
 * and there is no fallback authenticator. `authenticate` must return the credentials
 * produced by that boundary; `forward` is the API-gateway/registry sink.
 *
 * The returned function preserves the original body object/Buffer and returns the
 * result of `forward`. It is intentionally transport-only; SigV4 verification belongs
 * to the security gateway implementation.
 */
export function createPublicSettingsForwarder({ authenticate, forward } = {}) {
  if (typeof authenticate !== 'function') {
    throw new TypeError('Public Settings transport requires an authenticator');
  }
  if (typeof forward !== 'function') {
    throw new TypeError('Public Settings transport requires a forwarder');
  }

  return async function forwardPublicSettings(request = {}) {
    const credentials = await authenticate(request);
    if (!credentials) {
      throw new TypeError('Public Settings authenticator returned no credentials');
    }
    const prepared = prepareAuthenticatedPublicForward({
      headers: request.headers,
      body: request.body,
      verifiedCredentials: credentials,
    });
    return forward(prepared);
  };
}

/**
 * Translate the request after the private authenticator has completed.
 *
 * This helper is deliberately private. A public caller can provide an
 * `x-amz-credentials` header, but it cannot call this path with an identity; only
 * `createPublicSettingsForwarder` can obtain the credential object and invoke it.
 */
function prepareAuthenticatedPublicForward({ headers = {}, body, verifiedCredentials } = {}) {
  const credentials = buildVerifiedCredentialEnvelope(verifiedCredentials);
  const forwarded = { ...headers };

  deleteHeader(forwarded, 'accept-encoding');
  deleteHeader(forwarded, 'connection');

  const contentType = readHeader(forwarded, 'content-type');
  if (contentType === SETTINGS_PUBLIC_CONTENT_TYPE) {
    deleteHeader(forwarded, 'content-type');
    forwarded['content-type'] = SETTINGS_GATEWAY_CONTENT_TYPE;
  }
  deleteHeader(forwarded, 'x-amz-credentials');
  forwarded['x-amz-credentials'] = JSON.stringify(credentials);

  return { headers: forwarded, body };
}

/**
 * Select a boundary explicitly. No default is provided because the public and internal
 * contracts have different authentication and content-type semantics.
 */
export function prepareSettingsRequest({ transport, ...options } = {}) {
  if (transport === SETTINGS_TRANSPORTS.INTERNAL) {
    return prepareInternalSettingsRequest(options);
  }
  if (transport === SETTINGS_TRANSPORTS.PUBLIC) {
    return createPublicSettingsForwarder(options);
  }
  throw new TypeError(`Unknown Settings transport: ${String(transport)}`);
}

function buildVerifiedCredentialEnvelope(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new TypeError('Public Settings transport requires verified credentials');
  }
  const id = credentials._id;
  if (!id) throw new TypeError('Public Settings transport requires verified credentials._id');
  if (credentials.secretAccessKey !== undefined
    && credentials.secretAccessKey !== null
    && credentials.secretAccessKey !== REDACTED_SECRET) {
    throw new TypeError('Public Settings transport requires a redacted secretAccessKey');
  }

  // Preserve the source route's key order and undefined-property omission while making
  // the redaction precondition explicit at this reusable boundary.
  return {
    _id: id,
    id,
    email: credentials.email,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    isAdmin: credentials.isAdmin,
    friendlyId: credentials.friendlyId,
  };
}

function readHeader(headers, name) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function deleteHeader(headers, name) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}

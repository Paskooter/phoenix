// The Update service's codified errors — extracted verbatim from the pinned server
// (jiborobot/srv-update-ws src/errors/update.ts) plus the framework decorator error
// (jiborobot/srv-server src/errors.ts). The source raised these with
// `Boom.createWithCode(...)`, which Hapi renders as a payload carrying the code
// (`error.output.payload.code = code`) at the given statusCode.
//
// The robot's aws-sdk fork resolves the client-visible `err.code` as
// `body.__type || body.code || body.error` with the body overriding the
// `x-amzn-errortype` header (srv-jibo-server-client lib/protocol/json.js:52-73), so a
// coded envelope is indistinguishable whether the code rides `__type` (Phoenix) or
// `code` (source) — the same equivalence A-02/A11 established for the Classic services.

export const UPDATE_NOT_FOUND = {
  code: 'UPDATE_NOT_FOUND',
  message: 'Update not found',
  statusCode: 404,
};
export const UPDATE_ALREADY_EXISTS = {
  code: 'UPDATE_ALREADY_EXISTS',
  message: 'Update with same version specifications already exists',
  statusCode: 409,
};
export const UPDATE_ONLY_ADMIN_CAN_CREATE = {
  code: 'UPDATE_ONLY_ADMIN_CAN_CREATE',
  message: 'Only admin account can create platform update',
  statusCode: 403,
};
export const UPDATE_BELONGS_OTHER_ACCOUNT = {
  code: 'UPDATE_BELONGS_OTHER_ACCOUNT',
  message: 'Update belongs to other account',
  statusCode: 403,
};
export const UPDATE_CANNOT_DELETE = {
  code: 'UPDATE_CANNOT_DELETE',
  message: 'Update cannot be deleted',
  statusCode: 409,
};
// jiborobot/srv-server src/errors.ts — thrown by @parseCredentials({adminOnly:true}).
export const AUTHORIZED_UNDER_ADMIN = {
  code: 'AUTHORIZED_UNDER_ADMIN',
  message: 'Must be authorized under admin account',
  statusCode: 401,
};

/** Thrown by the catalog for the duplicate-creation conflict; the service maps it to the envelope. */
export class UpdateError extends Error {
  constructor(spec) {
    super(spec.message);
    this.code = spec.code;
    this.statusCode = spec.statusCode;
  }
}

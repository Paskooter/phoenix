// Admin OAuth-client registry face — OauthClients_20171108 (srv-oauth-clients-ws).
//
// Source: jiborobot/srv-oauth-clients-ws@3e546cb78eb160dcd3eaf25173420a35c56f68b5
//   handlers/client.handler.ts, controllers/client.ctrl.ts, schemes/client.ts,
//   errors/client.ts, index.ts.
// Framework: jiborobot/srv-server parseCredentials.ts (adminOnly) / validate.ts.
// Gateway: jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c
//   auth.ctrl.ts — none of the four OauthClients targets is in unauthorizedMethods /
//   unsignedMethods / unactiveMethods, so every call must carry a verified AWS V4
//   signature and the handler's adminOnly gate still applies.
//
// Controller behavior (client.ctrl.ts):
//   create: findOne({clientId}) -> CLIENT_ALREADY_EXISTS 409; if aco && !aco.sourceId
//           then aco.sourceId = clientId; Client.create(clientModel).
//   update: Client.findById(id) -> CLIENT_NOT_FOUND 404; assign every defined field;
//           if aco && !aco.sourceId then aco.sourceId = client.clientId; save() (pre-save
//           hook sets updated = now).
//   remove: Client.findByIdAndRemove(id) — returns null for a missing id without
//           throwing (wire body for that case unknown, recorded in the candidate).
//   listClients: Client.find().
//
// Scheme defaults (schemes/client.ts): aco keepAliveTimeout 500, recoveryTimeout 300,
// version "1.0"; refresh defaults true; created defaults now; pre-save sets updated;
// toJSON transform emits id from _id, aco defaulting to {}, and drops _id.

import { randomBytes } from 'node:crypto';
import { sendAmz, sendAmzEmpty, sendAmzError, sendValidationError } from './loopHttp.js';

export const OAUTH_CLIENTS_ERRORS = Object.freeze({
  CLIENT_NOT_FOUND: { code: 'CLIENT_NOT_FOUND', message: 'Specified client is not found', statusCode: 404 },
  CLIENT_ALREADY_EXISTS: { code: 'CLIENT_ALREADY_EXISTS', message: 'Specified client is already exists', statusCode: 409 },
  AUTHORIZED_UNDER_ADMIN: { code: 'AUTHORIZED_UNDER_ADMIN', message: 'Must be authorized under admin account', statusCode: 401 },
});

const ACO_DEFAULTS = Object.freeze({ keepAliveTimeout: 500, recoveryTimeout: 300, version: '1.0' });

// -- validation helpers (client.handler.ts Joi maps via srv-server validate) ----

function objectValidationMessage(body) {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return '\"value\" must be an object';
  }
  return null;
}

function requiredStringMessage(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return `child \"${field}\" fails because [\"${field}\" is required]`;
  if (typeof body[field] !== 'string') return `child \"${field}\" fails because [\"${field}\" must be a string]`;
  if (body[field].length === 0) return `child \"${field}\" is not allowed to be empty`;
  return null;
}

function optionalStringMessage(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) return null;
  if (typeof body[field] !== 'string') return `child \"${field}\" fails because [\"${field}\" must be a string]`;
  if (body[field].length === 0) return `child \"${field}\" is not allowed to be empty`;
  return null;
}

function optionalBooleanMessage(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field) || body[field] === undefined) return null;
  if (typeof body[field] !== 'boolean') return `child \"${field}\" fails because [\"${field}\" must be a boolean]`;
  return null;
}

/** Source handler's aco: Joi.object(). Returns null (validation error) or an object/undefined. */
function acoFromWire(aco) {
  if (aco === undefined || aco === null) return undefined;
  if (typeof aco !== 'object' || Array.isArray(aco)) return null;
  return { ...aco };
}

// -- scheme transform (schemes/client.ts toJSON) --------------------------------

/** {id, aco:{} default, ...fields}, no _id — matches client.ts toJSON transform. */
export function oauthClientToWire(client) {
  if (!client) return null;
  const { _id, ...fields } = client;
  const wire = { ...fields, id: String(_id) };
  wire.aco = wire.aco || {};
  return wire;
}

// -- controller (client.ctrl.ts) ---------------------------------------------------

/** create: duplicate clientId -> CLIENT_ALREADY_EXISTS; aco.sourceId falls back to clientId. */
function createClientRecord(store, clientModel) {
  const existing = [...store.oauthClients.values()].find((c) => c.clientId === clientModel.clientId);
  if (existing) throw OAUTH_CLIENTS_ERRORS.CLIENT_ALREADY_EXISTS;
  if (clientModel.aco && !clientModel.aco.sourceId) clientModel.aco.sourceId = clientModel.clientId;
  const now = Date.now();
  const row = {
    _id: randomBytes(12).toString('hex'),
    aco: { ...ACO_DEFAULTS, ...(clientModel.aco || {}) },
    clientId: clientModel.clientId,
    created: now,
    updated: now, // scheme pre-save hook sets updated on every save
  };
  for (const key of ['pkce', 'redirectUri', 'refresh', 'secret', 'updatedBy']) {
    if (clientModel[key] !== undefined) row[key] = clientModel[key];
  }
  if (row.refresh === undefined) row.refresh = true;
  store.oauthClients.set(row._id, row);
  store.flush();
  return { ...row };
}

/** update: findById -> CLIENT_NOT_FOUND; assign only defined fields; save. */
function updateClient(store, id, clientModel) {
  const client = store.oauthClients.get(id);
  if (!client) throw OAUTH_CLIENTS_ERRORS.CLIENT_NOT_FOUND;
  for (const prop of Object.keys(clientModel)) {
    if (clientModel[prop] !== undefined) client[prop] = clientModel[prop];
  }
  if (client.aco && !client.aco.sourceId) client.aco.sourceId = client.clientId;
  client.updated = Date.now();
  store.flush();
  return { ...client };
}

/** remove: findByIdAndRemove — returns null for a missing id (no CLIENT_NOT_FOUND throw). */
function removeClient(store, id) {
  const client = store.oauthClients.get(id);
  if (!client) return null;
  store.oauthClients.delete(id);
  store.flush();
  return { ...client };
}

function listClients(store) {
  return [...store.oauthClients.values()];
}

// -- handler (client.handler.ts) ---------------------------------------------------

/**
 * OauthClients_20171108 dispatch. Every operation is @parseCredentials({adminOnly:true})
 * and the gateway requires a signature on every target in this family. In the Phoenix
 * identity model the caller is the verified access-key account; `caller.isAdmin` decides
 * the adminOnly gate (the source x-amz-credentials header is an internal convention and
 * must not become a caller-controlled admin switch).
 */
export function oauthClientsDispatch(store, { req, res, body, op, caller, log }) {
  const method = op.toLowerCase();

  if (method === 'create' || method === 'update' || method === 'remove' || method === 'listclients') {
    // @parseCredentials({adminOnly:true}) throws AUTHORIZED_UNDER_ADMIN for a
    // non-admin before any payload validation runs.
    if (!(caller && caller.isAdmin)) {
      return void sendAmzError(res, OAUTH_CLIENTS_ERRORS.AUTHORIZED_UNDER_ADMIN);
    }
  }

  if (method === 'listclients') return void sendAmz(res, 200, listClients(store).map(oauthClientToWire));

  const objectError = objectValidationMessage(body);
  if (objectError) return void sendValidationError(res, objectError);
  const payload = body === undefined || body === null ? {} : body;

  if (method === 'create') return createOp(store, payload, res);
  if (method === 'update') return updateOp(store, payload, res);
  if (method === 'remove') return removeOp(store, payload, res);

  log.warn('oauthclients: unknown operation', { op });
  return void sendAmzError(res, { code: 'UnknownOperationException', message: `unknown operation ${op}`, statusCode: 400 });
}

function createOp(store, body, res) {
  const aco = acoFromWire(body.aco);
  if (aco === null) return void sendValidationError(res, 'child "aco" fails because ["aco" must be an object]');
  // Joi.validate aborts on the first error (abortEarly defaults true) and walks
  // the keys in schema insertion order, so the first failing validator in the
  // decorator's object order is the wire message.
  const failure = [
    requiredStringMessage(body, 'clientId'),
    optionalBooleanMessage(body, 'pkce'),
    requiredStringMessage(body, 'redirectUri'),
    optionalBooleanMessage(body, 'refresh'),
    optionalStringMessage(body, 'secret'),
    requiredStringMessage(body, 'updatedBy'),
  ].find((message) => message !== null && message !== undefined);
  if (failure) return void sendValidationError(res, failure);
  try {
    const client = createClientRecord(store, {
      aco,
      clientId: body.clientId,
      pkce: body.pkce,
      redirectUri: body.redirectUri,
      refresh: body.refresh,
      secret: body.secret,
      updatedBy: body.updatedBy,
    });
    return void sendAmz(res, 200, oauthClientToWire(client));
  } catch (error) {
    if (error && error.code && error.statusCode) return void sendAmzError(res, error);
    throw error;
  }
}

function updateOp(store, body, res) {
  const aco = acoFromWire(body.aco);
  if (aco === null) return void sendValidationError(res, 'child "aco" fails because ["aco" must be an object]');
  // Joi walks schema keys in insertion order (aco, id, pkce, redirectUri,
  // refresh, secret, updatedBy) and aborts on the first error.
  const failure = [
    requiredStringMessage(body, 'id'),
    optionalBooleanMessage(body, 'pkce'),
    optionalStringMessage(body, 'redirectUri'),
    optionalBooleanMessage(body, 'refresh'),
    optionalStringMessage(body, 'secret'),
    requiredStringMessage(body, 'updatedBy'),
  ].find((message) => message !== null && message !== undefined);
  if (failure) return void sendValidationError(res, failure);
  // Source handler forwards only aco/pkce/redirectUri/refresh/secret/updatedBy —
  // clientId is not updatable through this route.
  try {
    const client = updateClient(store, body.id, {
      aco,
      pkce: body.pkce,
      redirectUri: body.redirectUri,
      refresh: body.refresh,
      secret: body.secret,
      updatedBy: body.updatedBy,
    });
    return void sendAmz(res, 200, oauthClientToWire(client));
  } catch (error) {
    if (error && error.code && error.statusCode) return void sendAmzError(res, error);
    throw error;
  }
}

function removeOp(store, body, res) {
  const idMessage = requiredStringMessage(body, 'id');
  if (idMessage) return void sendValidationError(res, idMessage);
  const client = removeClient(store, body.id);
  // findByIdAndRemove returns null for a missing id and the controller does not throw
  // (CLIENT_NOT_FOUND is only raised by update); the wire body for that case is unknown,
  // so an empty 200 mirrors the unaffected success path.
  if (!client) return void sendAmzEmpty(res, 200);
  return void sendAmz(res, 200, oauthClientToWire(client));
}
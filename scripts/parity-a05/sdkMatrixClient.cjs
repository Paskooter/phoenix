'use strict';

// This file intentionally stays CommonJS and Node-8-compatible.  It is run
// with the extracted original Node 8 runtime against the installed original
// @jibo/jibo-server-client package, so no Phoenix transport helper is involved
// in the target matrix.

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var metadata = JSON.parse(fs.readFileSync(process.env.A05_METADATA, 'utf8'));
var clientRoot = process.env.A05_CLIENT_ROOT;
var OOBE = require(path.join(clientRoot, 'clients/oobe.js'));
var OOBEAdmin = require(path.join(clientRoot, 'clients/oobeadmin.js'));
var rows = [];

function client(Type, endpoint, credentials) {
  return new Type({
    endpoint: endpoint,
    region: 'global',
    credentials: credentials,
    maxRetries: 0,
    httpOptions: { timeout: 10000, connectTimeout: 3000 },
  });
}

function invoke(service, method, params, unauthenticated) {
  var request = unauthenticated
    ? service.makeUnauthenticatedRequest(method, params)
    : service[method](params);
  return new Promise(function (resolve) {
    var settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    request.send(function (error, data) {
      if (error) {
        return finish({
          error: {
            name: error.name,
            code: error.code,
            statusCode: error.statusCode,
            message: error.message,
          },
          data: null,
        });
      }
      finish({ error: null, data: data === undefined ? null : data });
    });
    // The original Request can emit an error event after the callback.  The
    // callback above owns the receipt; this listener prevents an unhandled
    // EventEmitter error while retaining the complete error object there.
    request.on('error', function () {});
  });
}

function pass(face, name, details) {
  rows.push({ face: face, name: name, passed: true, details: details || undefined });
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Retain the complete wire shape in the receipt while keeping issued
// credential/token bytes fixture-only.  Public Account/Loop projections carry
// no secrets and are recorded as returned by the original SDK.
function wire(value) {
  if (Array.isArray(value)) return value.map(wire);
  if (!value || typeof value !== 'object') return value;
  var fields = Object.keys(value).sort();
  if (value.accessKeyId || value.secretAccessKey) {
    return {
      fields: fields,
      credentialHash: hash(String(value.accessKeyId || '') + '\0' + String(value.secretAccessKey || '')),
      serviceMode: value.serviceMode,
    };
  }
  if (value.token) {
    return {
      fields: fields,
      tokenHash: hash(value.token),
      expires: value.expires,
    };
  }
  var out = {};
  fields.forEach(function (field) { out[field] = wire(value[field]); });
  return out;
}

function expectError(face, name, result, code, statusCode) {
  assert(result && result.error, face + ' ' + name + ' unexpectedly succeeded');
  assert.strictEqual(result.error.code, code, face + ' ' + name + ' error code');
  if (statusCode !== undefined) assert.strictEqual(result.error.statusCode, statusCode, face + ' ' + name + ' HTTP status');
  pass(face, name, { error: { code: result.error.code, statusCode: result.error.statusCode, message: result.error.message } });
}

function expectSuccess(face, name, result) {
  assert(result && !result.error, face + ' ' + name + ' failed: ' + JSON.stringify(result && result.error));
  pass(face, name, { statusCode: 200, wire: wire(result.data) });
  return result.data;
}

function runFace(fixture) {
  var face = fixture.face;
  var endpoint = metadata[face + 'Endpoint'];
  var normal = client(OOBE, endpoint, fixture.owner);
  var admin = client(OOBEAdmin, endpoint, fixture.admin);
  var nonAdmin = client(OOBEAdmin, endpoint, fixture.owner);
  var issued = { face: face };

  // Public normal operations: pending, redemption, one-time replay, expiry,
  // live-loop replacement refusal, suspended-loop replacement, and status.
  return invoke(normal, 'getStatus', { token: fixture.setupToken }, true)
    .then(function (result) {
      var data = expectSuccess(face, 'GetStatus pending setup token', result);
      assert.strictEqual(data.complete, false);
      return invoke(normal, 'setupRobot', { token: fixture.setupToken, id: fixture.ordinaryRobotId }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'SetupRobot ordinary', result);
      assert.strictEqual(typeof data.accessKeyId, 'string');
      assert.strictEqual(typeof data.secretAccessKey, 'string');
      assert.strictEqual(!!data.serviceMode, false);
      issued.ordinary = { accessKeyId: data.accessKeyId, secretAccessKey: data.secretAccessKey };
      return invoke(normal, 'getStatus', { token: fixture.setupToken }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'GetStatus used setup token', result);
      assert.strictEqual(data.complete, true);
      return invoke(normal, 'setupRobot', { token: fixture.setupToken, id: fixture.ordinaryRobotId }, true);
    })
    .then(function (result) {
      // Named falsification: if SetupRobot stopped deleting one-time tokens,
      // this replay would succeed and this assertion would fail.
      expectError(face, 'FALSIFY used SetupRobot replay', result, 'TOKEN_NOT_FOUND', 404);
      return invoke(normal, 'getStatus', { token: fixture.expiredToken }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'GetStatus expired token', result);
      assert.strictEqual(data.complete, true);
      return invoke(normal, 'setupRobot', { token: fixture.expiredToken, id: fixture.ordinaryRobotId }, true);
    })
    .then(function (result) {
      expectError(face, 'FALSIFY expired SetupRobot', result, 'TOKEN_EXPIRED', 401);
      return invoke(normal, 'setupRobot', { token: fixture.expiredToken, id: fixture.ordinaryRobotId }, true);
    })
    .then(function (result) {
      // Expiration is a validation result, not deletion; this named replay
      // proves the expired token remains expired in the durable token map.
      expectError(face, 'FALSIFY expired token remains expired', result, 'TOKEN_EXPIRED', 401);
      return invoke(normal, 'setupRobot', { token: fixture.liveToken, id: fixture.ordinaryRobotId + '-wrong' }, true);
    })
    .then(function (result) {
      // Named falsification: a candidate that permits changing a live loop
      // would pass here instead of requiring suspension.
      expectError(face, 'FALSIFY live loop replacement refusal', result, 'LOOP_MUST_BE_SUSPENDED', 409);
      return invoke(normal, 'getStatus', { token: fixture.liveToken }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'GetStatus live-loop refusal preserves token', result);
      assert.strictEqual(data.complete, false);
      return invoke(normal, 'setupRobot', { token: fixture.replacementToken, id: fixture.replacementRobotId }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'SetupRobot suspended-loop replacement', result);
      assert.strictEqual(typeof data.accessKeyId, 'string');
      assert.strictEqual(typeof data.secretAccessKey, 'string');
      assert.strictEqual(!!data.serviceMode, false);
      issued.replacement = { accessKeyId: data.accessKeyId, secretAccessKey: data.secretAccessKey };
      return invoke(normal, 'getStatus', { token: fixture.replacementToken }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'GetStatus used replacement token', result);
      assert.strictEqual(data.complete, true);
      return invoke(normal, 'prepareRobot', {}, false);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'PrepareRobot signed', result);
      assert.strictEqual(typeof data.token, 'string');
      assert.strictEqual(typeof data.expires, 'number');
      assert.ok(isFinite(data.expires));
      assert.ok(data.expires > Date.now());
      issued.restartToken = data.token;
      return invoke(normal, 'reconnectRobot', { token: fixture.reconnectToken, id: fixture.ordinaryRobotId }, false);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'ReconnectRobot signed', result);
      assert.strictEqual(data.result, 'Command accepted');
      return invoke(normal, 'reconnectRobot', { token: fixture.reconnectToken, id: fixture.ordinaryRobotId }, false);
    })
    .then(function (result) {
      // Named falsification: source-simple reconnect still consumes its token;
      // loop/membership checks must not be introduced as a hidden prerequisite.
      expectError(face, 'FALSIFY used ReconnectRobot replay', result, 'TOKEN_NOT_FOUND', 404);
      return invoke(normal, 'getStatus', { token: fixture.reconnectToken }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'GetStatus used reconnect token', result);
      assert.strictEqual(data.complete, true);
      return invoke(nonAdmin, 'getServiceToken', {});
    })
    .then(function (result) {
      // Admin API boundary: ordinary credentials must not mint a service token.
      expectError(face, 'FALSIFY non-admin GetServiceToken', result, 'AUTHORIZED_UNDER_ADMIN', 401);
      return invoke(admin, 'getServiceToken', {});
    })
    .then(function (result) {
      var data = expectSuccess(face, 'GetServiceToken admin', result);
      assert.strictEqual(typeof data.token, 'string');
      assert.strictEqual(typeof data.expires, 'number');
      assert.ok(data.expires > Date.now());
      issued.serviceToken = data.token;
      return invoke(normal, 'setupRobot', { token: data.token, id: fixture.serviceRobotId }, true);
    })
    .then(function (result) {
      var data = expectSuccess(face, 'SetupRobot service mode', result);
      // Named falsification: GetServiceToken must produce the service-mode
      // owner marker that SetupRobot exposes to the original client.
      assert.strictEqual(data.serviceMode, true);
      assert.strictEqual(typeof data.accessKeyId, 'string');
      assert.strictEqual(typeof data.secretAccessKey, 'string');
      issued.service = { accessKeyId: data.accessKeyId, secretAccessKey: data.secretAccessKey };
      return invoke(normal, 'getStatus', { token: issued.serviceToken }, true);
    })
    .then(function (result) {
      // The service token is intentionally consumed above.  Use the known token
      // id rather than relying on SDK output fields after SetupRobot.
      var data = expectSuccess(face, 'GetStatus used service token', result);
      assert.strictEqual(data.complete, true);
      issued.operations = ['PrepareRobot', 'GetStatus', 'SetupRobot', 'ReconnectRobot', 'GetServiceToken'];
      return issued;
    });
}

Promise.resolve()
  .then(function () {
    var faces = [];
    return metadata.fixtures.reduce(function (chain, fixture) {
      return chain.then(function () { return runFace(fixture); }).then(function (face) { faces.push(face); });
    }, Promise.resolve()).then(function () { return faces; });
  })
  .then(function (faces) {
    var result = {
      passed: true,
      phase: metadata.phase,
      runtime: process.version,
      clientVersion: require(path.join(clientRoot, 'package.json')).version,
      candidateRevision: metadata.candidateRevision,
      faces: faces,
      rows: rows,
      checks: rows.length,
    };
    fs.writeFileSync(process.env.A05_RESULT, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ passed: true, phase: metadata.phase, checks: rows.length, runtime: process.version, clientVersion: result.clientVersion }) + '\n');
  })
  .catch(function (error) {
    var result = {
      passed: false,
      phase: metadata.phase,
      runtime: process.version,
      clientVersion: require(path.join(clientRoot, 'package.json')).version,
      candidateRevision: metadata.candidateRevision,
      rows: rows,
      checks: rows.length,
      error: { name: error.name, code: error.code, statusCode: error.statusCode, message: error.message, stack: error.stack },
    };
    try { fs.writeFileSync(process.env.A05_RESULT, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); } catch (writeError) {}
    process.stderr.write((error && error.stack) || String(error));
    process.stderr.write('\n');
    process.exit(1);
  });

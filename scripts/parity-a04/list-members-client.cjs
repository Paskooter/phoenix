'use strict';

// Generated SDK 3.0.110 control.  The server is the candidate Account face;
// the SDK itself is the archived Node 8 client and signer.
var fs = require('fs');
var Loop = require('/client/clients/loop');

var ready = JSON.parse(fs.readFileSync('/review/ready.json', 'utf8'));
var results = [];

function names(value) {
  if (!value) return [];
  try { return Object.getOwnPropertyNames(value).sort(); } catch (_) { return ['<uninspectable>']; }
}

function errorShape(error) {
  if (!error) return null;
  return {
    name: error.name,
    code: error.code,
    statusCode: error.statusCode,
    message: error.message,
    retryable: error.retryable,
    ownPropertyNames: names(error),
  };
}

function client(account) {
  return new Loop({
    endpoint: 'http://127.0.0.1:' + ready.port,
    region: 'global',
    accessKeyId: account.accessKeyId,
    secretAccessKey: account.secretAccessKey,
    maxRetries: 0,
    httpOptions: { timeout: 3000 },
    paramValidation: false,
  });
}

function invokeMethod(sdk, params) {
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve({ error: { name: 'ClientControlTimeout', code: 'CLIENT_CONTROL_TIMEOUT' }, data: null, timedOut: true });
    }, 12000);
    try {
      sdk.listMembers(params, function(error, data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: errorShape(error), data: data === undefined ? null : data, timedOut: false });
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: errorShape(error), data: null, threwSynchronously: true, timedOut: false });
    }
  });
}

function invokeRaw(sdk, body) {
  var request;
  try {
    request = sdk.makeRequest('listMembers', {});
  } catch (error) {
    return Promise.resolve({ error: errorShape(error), data: null, threwSynchronously: true, timedOut: false });
  }
  // `afterBuild` runs after the JSON protocol has populated its default body
  // and before the signer computes the payload hash.  Mutating on `build`
  // races that protocol listener in this generated service and silently
  // restores `{}`.
  request.on('afterBuild', function() {
    request.httpRequest.body = body;
    request.httpRequest.headers['Content-Length'] = Buffer.byteLength(body);
  });
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve({ error: { name: 'ClientControlTimeout', code: 'CLIENT_CONTROL_TIMEOUT' }, data: null, timedOut: true });
    }, 12000);
    try {
      request.send(function(error, data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: errorShape(error), data: data === undefined ? null : data, timedOut: false });
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: errorShape(error), data: null, threwSynchronously: true, timedOut: false });
    }
  });
}

function add(id, actor, kind, input, response) {
  results.push({ id: id, actor: actor, kind: kind, input: input, response: response });
}

async function run() {
  var sdks = {};
  Object.keys(ready.accounts).forEach(function(name) { sdks[name] = client(ready.accounts[name]); });
  add('owner-all', 'owner', 'method', {}, await invokeMethod(sdks.owner, {}));
  add('owner-accepted', 'owner', 'method', { statusList: ['accepted'] }, await invokeMethod(sdks.owner, { statusList: ['accepted'] }));
  add('owner-incoming', 'owner', 'method', { typeList: ['incoming'] }, await invokeMethod(sdks.owner, { typeList: ['incoming'] }));
  add('guest-all', 'guest', 'method', {}, await invokeMethod(sdks.guest, {}));
  add('robot-all', 'robot', 'method', {}, await invokeMethod(sdks.robot, {}));
  add('outsider-all', 'outsider', 'method', {}, await invokeMethod(sdks.outsider, {}));
  add('status-invalid', 'owner', 'method', { statusList: ['bogus'] }, await invokeMethod(sdks.owner, { statusList: ['bogus'] }));
  add('type-invalid', 'owner', 'method', { typeList: 'incoming' }, await invokeMethod(sdks.owner, { typeList: 'incoming' }));
  add('top-null', 'owner', 'raw', 'null', await invokeRaw(sdks.owner, 'null'));
  add('unknown-field', 'owner', 'raw', '{"ignored":true}', await invokeRaw(sdks.owner, '{"ignored":true}'));
  add('empty-filters', 'owner', 'method', { statusList: [], typeList: [] }, await invokeMethod(sdks.owner, { statusList: [], typeList: [] }));
  process.stdout.write(JSON.stringify({
    node: process.version,
    sdkPackage: '3.0.110',
    candidateBase: ready.candidateBase,
    loopId: ready.loopId,
    results: results,
  }, null, 2) + '\n');
}

run().catch(function(error) {
  process.stderr.write((error.stack || error.message) + '\n');
  process.exitCode = 1;
});

#!/usr/bin/env node
/* eslint-disable */
// A-19 Jot conformance client. Runs on node:8.9.4 inside the SDK container.
//
// The model is registered through the SDK's own apiLoader and the client built
// with AWS.Service.defineService, so request construction, the X-Amz-Target
// header and SigV4 signing are the original client's. Nothing here hand-rolls
// an AWS-JSON envelope.
//
// Usage: node client.cjs <sdkDir> <endpoint> <outFile>
// Writes one JSON result document; the runner asserts against it.

var AWS = require(process.argv[2] + '/lib/aws.js');
var fs = require('fs');
var endpoint = process.argv[3];
var outFile = process.argv[4];

var model = JSON.parse(fs.readFileSync(process.argv[2] + '/apis/jot-2016-05-12.min.json', 'utf8'));
AWS.apiLoader.services.jot = {};
AWS.apiLoader.services.jot['2016-05-12'] = model;
var Jot = AWS.Service.defineService('jot', ['2016-05-12']);

// TLS: trust the server's own CA rather than disabling verification, so the
// handshake is actually proven rather than skipped.
var caFile = process.env.A19_CA_FILE;
var httpOptions = {};
if (caFile && fs.existsSync(caFile)) {
  httpOptions.agent = new (require('https').Agent)({ ca: fs.readFileSync(caFile) });
}

function clientFor(accessKeyId) {
  return new Jot({
    endpoint: endpoint,
    region: 'us-east-1',
    apiVersion: '2016-05-12',
    credentials: new AWS.Credentials(accessKeyId, 'secret-' + accessKeyId),
    sslEnabled: endpoint.indexOf('https:') === 0,
    httpOptions: httpOptions,
    maxRetries: 0,
  });
}

var results = { endpoint: endpoint, tls: endpoint.indexOf('https:') === 0, steps: [] };

function record(name, err, data) {
  results.steps.push({
    name: name,
    ok: !err,
    errCode: err ? err.code : null,
    status: err ? err.statusCode : 200,
    data: err ? null : data,
  });
}

// Every step is time-bounded. A step that neither succeeds nor errors would
// otherwise hang the whole run with no output at all, which is exactly what an
// unbounded version of this harness did.
var STEP_TIMEOUT_MS = Number(process.env.A19_STEP_TIMEOUT_MS || 20000);

function step(name, fn) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      process.stderr.write('STEP_TIMEOUT ' + name + '\n');
      record(name, { code: 'STEP_TIMEOUT', statusCode: 0 }, null);
      resolve(null);
    }, STEP_TIMEOUT_MS);
    try {
      fn(function (err, data) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stderr.write('STEP ' + name + ' ' + (err ? 'ERR ' + err.code : 'OK') + '\n');
        record(name, err, data);
        resolve(data);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stderr.write('STEP_THREW ' + name + ' ' + e.message + '\n');
      record(name, { code: 'THREW', statusCode: 0 }, null);
      resolve(null);
    }
  });
}

var MEMBER = process.env.A19_MEMBER;
var ROBOT = process.env.A19_ROBOT;
var OUTSIDER = process.env.A19_OUTSIDER;
var LOOP = process.env.A19_LOOP;
var OTHER_LOOP = process.env.A19_OTHER_LOOP;

var member = clientFor(MEMBER);
var robot = clientFor(ROBOT);
var outsider = clientFor(OUTSIDER);

var createdId = null;

Promise.resolve()
  .then(function () { return step('list-empty', function (cb) { member.listMessages({ loopId: LOOP }, cb); }); })
  .then(function () {
    return step('create', function (cb) {
      member.createMessage({ loopId: LOOP, content: 'a19 conformance', parts: [{ path: 'a19/p1' }], tags: [MEMBER] }, cb);
    });
  })
  .then(function (created) { if (created) createdId = created.id || created._id; })
  .then(function () { return step('list-after-create', function (cb) { member.listMessages({ loopId: LOOP }, cb); }); })
  .then(function () { return step('unread-own-loop', function (cb) { member.numberOfUnreadMessagesInLoops({ loopIds: [LOOP] }, cb); }); })
  .then(function () {
    return step('mark-read-by-id', function (cb) {
      if (!createdId) return cb({ code: 'NO_MESSAGE_ID', statusCode: 0 });
      member.markRead({ ids: [createdId] }, cb);
    });
  })
  .then(function () { return step('mark-loop-read', function (cb) { member.markLoopRead({ loopId: LOOP }, cb); }); })
  .then(function () { return step('unread-after-mark', function (cb) { member.numberOfUnreadMessagesInLoops({ loopIds: [LOOP] }, cb); }); })
  // gates
  .then(function () { return step('outsider-list-refused', function (cb) { outsider.listMessages({ loopId: LOOP }, cb); }); })
  .then(function () {
    return step('outsider-create-refused', function (cb) {
      outsider.createMessage({ loopId: LOOP, content: 'nope', parts: [{ path: 'x' }] }, cb);
    });
  })
  .then(function () {
    return step('non-robot-impersonation-refused', function (cb) {
      member.createMessage({ loopId: LOOP, content: 'imp', parts: [{ path: 'x' }], impersonateAs: OUTSIDER }, cb);
    });
  })
  .then(function () {
    return step('robot-impersonation-allowed', function (cb) {
      robot.createMessage({ loopId: LOOP, content: 'by robot', parts: [{ path: 'x' }], impersonateAs: MEMBER }, cb);
    });
  })
  // cross-loop isolation: the member's own loop must not leak into another loop
  .then(function () { return step('cross-loop-isolation', function (cb) { outsider.listMessages({ loopId: OTHER_LOOP }, cb); }); })
  .then(function () {
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log('A19_CLIENT_DONE ' + results.steps.length);
  })
  .catch(function (e) {
    results.fatal = String(e && e.message).slice(0, 300);
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log('A19_CLIENT_FATAL');
    process.exit(1);
  });

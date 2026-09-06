/*
 * Review-only H-10 source probe. Run this file inside the pinned Node 8.9.4
 * image with the frozen reference mounted at /ref. It emits normalized JWT,
 * BaseService auth, and real HTTP upgrade results; it never starts a product
 * service or uses live credentials.
 */

'use strict';

var fs = require('fs');
var net = require('net');
var crypto = require('crypto');

var fixturePath = process.argv[2];
var outputPath = process.argv[3];
var referenceRoot = process.env.H10_REFERENCE_ROOT || '/ref';
var cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
var jsonwebtoken = require(referenceRoot + '/node_modules/jsonwebtoken');
var BaseService = require(referenceRoot + '/packages/utils/lib/service/BaseService').BaseService;

function base64url(value) {
  var buffer = Buffer.isBuffer(value) ? value : new Buffer(value);
  return buffer.toString('base64').replace(/=/g, '').split('+').join('-').split('/').join('_');
}

function digestFor(algorithm) {
  return algorithm === 'HS256' ? 'sha256' : algorithm === 'HS384' ? 'sha384' : 'sha512';
}

function buildToken(spec) {
  var header = spec.headerJson !== undefined ? spec.headerJson : JSON.stringify(spec.header);
  var payload = spec.payloadJson;
  var input = base64url(header) + '.' + base64url(payload);
  var signature;
  if (spec.signature === 'hmac' || spec.signature === 'hmac-alt') {
    signature = base64url(crypto.createHmac(digestFor(spec.header.alg), cases.secret).update(input).digest());
    if (spec.signature === 'hmac-alt') {
      var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      var index = alphabet.indexOf(signature.charAt(signature.length - 1));
      signature = signature.slice(0, -1) + alphabet.charAt(index + 1);
    }
  } else if (spec.signature === 'empty') {
    signature = '';
  } else {
    signature = spec.signature;
  }
  return input + '.' + signature;
}

var tokens = {};
cases.tokens.forEach(function (spec) {
  tokens[spec.id] = buildToken(spec);
});
tokens.malformed = 'not-a-jwt';

function resolve(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, function (_match, id) {
    return tokens[id] === undefined ? _match : tokens[id];
  });
}

function normalized(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return null;
  if (value instanceof Date) return { type: 'Date', value: value.toISOString() };
  return value;
}

function outcome(fn) {
  try {
    return { ok: true, value: normalized(fn()) };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: error && error.name,
        message: error && error.message,
        constructor: error && error.constructor && error.constructor.name,
      },
    };
  }
}

function verifyToken(token) {
  return jsonwebtoken.verify(token, cases.secret, { clockTimestamp: cases.clockTimestamp });
}

function directResults() {
  var output = {};
  cases.tokens.forEach(function (spec) {
    output[spec.id] = outcome(function () { return verifyToken(tokens[spec.id]); });
  });
  cases.direct.forEach(function (spec) {
    var token;
    if (spec.kind === 'missing') token = undefined;
    else if (spec.kind === 'value') token = spec.value;
    else token = spec.value;
    output[spec.id] = outcome(function () { return verifyToken(token); });
  });
  return output;
}

function authResults() {
  var output = {};
  cases.auth.forEach(function (spec) {
    if (spec.secret === 'missing') delete process.env.ETCO_server_hubTokenSecret;
    else process.env.ETCO_server_hubTokenSecret = cases.secret;
    var headers = {};
    if (spec.authorization !== null) headers.authorization = resolve(spec.authorization);
    output[spec.id] = outcome(function () { return BaseService.checkAuthentication(headers); });
  });
  process.env.ETCO_server_hubTokenSecret = cases.secret;
  return output;
}

function parseResponse(buffer) {
  var text = buffer.toString('latin1');
  var separator = text.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('incomplete upgrade response');
  var head = text.slice(0, separator).split('\r\n');
  var status = head.shift().match(/^HTTP\/1\.1 (\d+) (.*)$/);
  var headers = {};
  head.forEach(function (line) {
    var colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  });
  return {
    status: Number(status[1]),
    reason: status[2],
    headers: headers,
    body: text.slice(separator + 4),
  };
}

function rawUpgrade(port, path, authorization) {
  return new Promise(function (done, reject) {
    var chunks = [];
    var settled = false;
    var socket = net.createConnection({ host: '127.0.0.1', port: port });
    var timer = setTimeout(function () {
      socket.destroy();
      if (!settled) { settled = true; reject(new Error('upgrade response timeout')); }
    }, 2000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) return reject(error);
      try {
        var response = parseResponse(Buffer.concat(chunks));
        socket.destroy();
        done(response);
      }
      catch (parseError) { reject(parseError); }
    }
    socket.on('connect', function () {
      var lines = [
        'GET ' + path + ' HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ];
      if (authorization !== null) lines.push('Authorization: ' + resolve(authorization));
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('data', function (chunk) {
      chunks.push(chunk);
      var bytes = Buffer.concat(chunks);
      var text = bytes.toString('latin1');
      var separator = text.indexOf('\r\n\r\n');
      var length = text.match(/\r\ncontent-length:\s*(\d+)/i);
      if (separator >= 0 && length && bytes.length >= separator + 4 + Number(length[1])) finish();
    });
    socket.on('end', function () { finish(); });
    socket.on('close', function () { finish(); });
    socket.on('error', function (error) { if (!settled && chunks.length === 0) finish(error); });
  });
}

async function upgradeResults() {
  var service = new BaseService('h10');
  service.addSocketHandler('/listen', { handler: { init: function () { return Promise.resolve(); }, handleSocket: function () {} } });
  service.addSocketHandler('/proactive', { handler: { init: function () { return Promise.resolve(); }, handleSocket: function () {} } });
  service.disableAuth = false;
  await service.init(0);
  var port = service.server.address().port;
  var activeSockets = [];
  service.server.on('connection', function (socket) {
    activeSockets.push(socket);
    socket.on('close', function () {
      var index = activeSockets.indexOf(socket);
      if (index >= 0) activeSockets.splice(index, 1);
    });
  });
  var output = {};
  try {
    for (var i = 0; i < cases.upgrades.length; i += 1) {
      var spec = cases.upgrades[i];
      output[spec.id] = await rawUpgrade(port, spec.path, spec.authorization);
    }
  } finally {
    // BaseService@source waits for every HTTP connection in server.close().
    // Rejected WebSocket upgrades can still be in that set when the response
    // has been read, so close the review probe's own sockets before awaiting
    // the source shutdown promise. This affects cleanup only, never results.
    activeSockets.slice().forEach(function (socket) { socket.destroy(); });
    // The pinned BaseService can leave its WebSocketServer close callback
    // pending after rejected upgrades. Start its cleanup, but do not make the
    // review artifact depend on that source quirk; main() exits after the
    // output is durably written below.
    service.close().catch(function () {});
  }
  return output;
}

async function main() {
  process.env.ETCO_server_hubTokenSecret = cases.secret;
  var output = {
    runtime: { node: process.version, source: 'jsonwebtoken@8.1.1 + BaseService', ws: '3.3.3' },
    direct: directResults(),
    auth: authResults(),
    upgrades: await upgradeResults(),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
}

main().then(function () {
  process.exit(0);
}).catch(function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});

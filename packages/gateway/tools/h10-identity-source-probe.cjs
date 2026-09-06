/*
 * Review-only H-10 identity probe. Run inside the pinned Node 8.9.4 image
 * with the frozen original tree mounted at /ref. It invokes the compiled
 * MessagePreProcessor with synthetic socket/message objects only.
 */

'use strict';

var fs = require('fs');
var crypto = require('crypto');

var fixturePath = process.argv[2];
var outputPath = process.argv[3];
var referenceRoot = process.env.H10_REFERENCE_ROOT || '/ref';
var fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
var MessagePreProcessor = require(referenceRoot + '/packages/hub/lib/utils/MessagePreProcessor').MessagePreProcessor;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeError(error) {
  return {
    name: error && error.name,
    message: error && error.message,
    constructor: error && error.constructor && error.constructor.name
  };
}

function outcome(spec) {
  var message = clone(spec.message);
  var auth;
  if (Object.prototype.hasOwnProperty.call(spec, 'auth')) {
    auth = spec.auth === 'undefined' ? undefined : clone(spec.auth);
  } else {
    auth = clone(fixture.auth);
  }
  var socket = {
    auth: auth,
    remoteAddress: fixture.remoteAddress
  };
  try {
    MessagePreProcessor.preProcessMessage({ json: message }, socket);
    return { ok: true, message: message };
  } catch (error) {
    return { ok: false, error: normalizeError(error), message: message };
  }
}

var output = {
  runtime: {
    node: process.version,
    source: 'hub MessagePreProcessor + MessageValidator'
  },
  source: {
    preProcessorSha256: crypto.createHash('sha256').update(fs.readFileSync(referenceRoot + '/packages/hub/lib/utils/MessagePreProcessor.js')).digest('hex'),
    validatorSha256: crypto.createHash('sha256').update(fs.readFileSync(referenceRoot + '/packages/hub/lib/utils/MessageValidator.js')).digest('hex')
  },
  cases: {}
};

fixture.cases.forEach(function (spec) {
  output.cases[spec.id] = outcome(spec);
});
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
process.exit(0);

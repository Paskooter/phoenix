'use strict';

var crypto = require('crypto');

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value, seen) {
  if (value === undefined) return { $type: 'undefined' };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $type: 'number', value: 'NaN' };
    if (value === Infinity) return { $type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { $type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { $type: 'number', value: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (typeof value === 'symbol') return { $type: 'symbol', value: String(value) };
  if (typeof value === 'function') return { $type: 'function', name: value.name || '' };
  if (!value || typeof value !== 'object') return value;
  if (seen.indexOf(value) !== -1) return { $type: 'cycle' };
  var nextSeen = seen.concat([value]);
  if (Array.isArray(value)) return value.map(function (item) { return stable(item, nextSeen); });
  var output = {};
  Object.keys(value).sort().forEach(function (key) { output[key] = stable(value[key], nextSeen); });
  return output;
}

function encode(value) { return stable(value, []); }
function canonical(value) { return JSON.stringify(stable(value, [])); }
function rowHash(value) { return sha(canonical(value)); }

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function argumentsFor(spec) {
  var args = cloneJson(spec.args);
  if (spec.kind === 'depart') {
    args[0].departDT = {
      toString: function () { return spec.args[0].departDT.time; },
    };
  }
  if (spec.kind === 'calendar') {
    args[0].forEach(function (event) {
      if (!event) return;
      var date = event.dateTime;
      event.dateTime = {
        getLocalTime: function () { return { hour: date.hour, minute: date.minute }; },
        toString: function () { return date.time; },
      };
    });
  }
  return args;
}

function errorRecord(error) {
  var name = error && error.name ? String(error.name) : 'Error';
  var message = error && error.message !== undefined ? String(error.message) : String(error);
  var result = { name: name, message: message };
  if (error && error.code !== undefined) result.code = String(error.code);
  return result;
}

function capture(thunk) {
  return Promise.resolve().then(thunk).then(function (value) {
    try { return { status: 'fulfilled', value: encode(value) }; }
    catch (error) { return { status: 'rejected', error: errorRecord(error) }; }
  }, function (error) {
    return { status: 'rejected', error: errorRecord(error) };
  });
}

function mkdirp(dir, fs, path) {
  if (fs.existsSync(dir)) return;
  var parent = path.dirname(dir);
  if (parent !== dir) mkdirp(parent, fs, path);
  try { fs.mkdirSync(dir); } catch (error) { if (!fs.existsSync(dir)) throw error; }
}

module.exports = { sha: sha, stable: stable, encode: encode, canonical: canonical, rowHash: rowHash, argumentsFor: argumentsFor, capture: capture, mkdirp: mkdirp };

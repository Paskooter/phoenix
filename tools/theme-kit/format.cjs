// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2026, pasketti and the Phoenix project.
'use strict';
var VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (plain(v)) return '{' + Object.keys(v).sort().map(function (key) { return JSON.stringify(key) + ':' + canonical(v[key]); }).join(',') + '}';
    return JSON.stringify(v);
}
function parseVersion(v, grammar) {
    var m = typeof v === 'string' ? grammar.exec(v) : null;
    if (!m) fail('invalid_version');
    var parts = [m[1], m[2], m[3], m[4]].map(function (n) { return n === undefined ? null : Number(n); });
    if (parts.some(function (n) { return n !== null && !Number.isSafeInteger(n); })) fail('invalid_version');
    return parts;
}
// SemVer precedence: a test build ranks below its release and dev numbers
// compare numerically, so 13.7.0-dev.2 < 13.7.0-dev.10 < 13.7.0 < 13.7.1.
function precedence(x, y) {
    for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    if (x[3] === y[3]) return 0;
    if (x[3] === null || y[3] === null) return x[3] === null ? 1 : -1;
    return x[3] > y[3] ? 1 : -1;
}
function compareVersion(a, b) { return precedence(parseVersion(a, VERSION), parseVersion(b, VERSION)); }
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
module.exports = { canonical, compareVersion };

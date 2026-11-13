'use strict';
var https = require('https'), http = require('http');
var config = require('./config');
exports.create = function (context) {
    var server = null, timer = null, request = null, response = null, inflight = null;
    var stopped = false, ready = false, sockets = [], starting = null, stopping = null;
    var status = { updated: null, httpStatus: null, bytes: 0, error: null };
    function poll() {
        if (stopped || inflight) return;
        inflight = new Promise(function (resolve) {
            var finished = false, total = 0, deadline = null;
            function finish(error, code) {
                if (finished) return; finished = true;
                if (deadline !== null) context.timers.clearTimeout(deadline);
                deadline = null;
                status = { updated: new Date().toISOString(), httpStatus: code || null,
                    bytes: total, error: error || null };
                request = null; response = null; resolve();
            }
            try {
                deadline = context.timers.setTimeout(function () {
                    var r = request, res = response; finish('request_timeout');
                    if (res) res.destroy(); if (r) r.abort();
                }, 10000);
                request = https.get(config.url, function (res) {
                    response = res;
                    res.on('data', function (chunk) {
                        total += chunk.length;
                        if (total > 65536) {
                            var r = request; finish('response_too_large'); res.destroy(); if (r) r.abort();
                        }
                    });
                    res.on('end', function () { finish(null, res.statusCode); });
                    res.on('error', function () { finish('response_failed'); });
                    res.on('aborted', function () { finish('response_aborted'); });
                    res.on('close', function () { if (!finished) finish('response_closed'); });
                });
                request.on('error', function () { finish('request_failed'); });
                request.on('abort', function () { finish('request_aborted'); });
                request.setTimeout(10000, function () {
                    var r = request; finish('request_timeout'); if (r) r.abort();
                });
            } catch (_) { finish('request_failed'); }
        }).then(function () { inflight = null; });
    }
    return {
        prepareBeforeInit: function () {
            if (!/^https:\/\//.test(config.url) || config.periodMs < 10000 ||
                config.port < 1024 || config.port > 65535) throw new Error('service_config_invalid');
        },
        startAfterInit: function () {
            if (starting) return starting;
            if (stopped) return Promise.reject(new Error('service_stopped'));
            starting = new Promise(function (resolve, reject) {
                server = http.createServer(function (req, res) {
                    if (req.method !== 'GET' || req.url !== '/status') {
                        res.writeHead(404); res.end(); return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify(status));
                });
                server.on('connection', function (socket) {
                    sockets.push(socket);
                    socket.setTimeout(5000, function () { socket.destroy(); });
                    socket.on('close', function () { var n = sockets.indexOf(socket); if (n >= 0) sockets.splice(n, 1); });
                });
                server.on('error', function (error) { ready = false; reject(error); });
                server.listen(config.port, '127.0.0.1', function () {
                    if (stopped) { resolve(); return; }
                    ready = true;
                    timer = context.timers.setInterval(poll, config.periodMs);
                    poll(); resolve();
                });
            });
            return starting;
        },
        registerLaunchers: function () { /* Background-only: no menu entry. */ },
        getSetupState: function () { return { configured: true }; },
        health: function () { return { ok: ready && !stopped }; },
        stop: function () {
            if (stopping) return stopping;
            stopped = true; ready = false;
            if (timer !== null) context.timers.clearInterval(timer);
            timer = null;
            var pending = inflight;
            // Abort while the request still owns its response; events settle poll().
            if (request) request.abort();
            if (response) response.destroy();
            // A pending listen must settle before we can prove the server is closed.
            stopping = Promise.all([pending, Promise.resolve(starting).catch(function () {}).then(function () {
                return new Promise(function (resolve, reject) {
                if (!server || !server.listening) { resolve(); return; }
                server.close(function (error) { if (error) reject(error); else resolve(); });
                sockets.slice().forEach(function (socket) { socket.destroy(); });
                });
            })]).then(function () { server = null; return { resourcesReleased: true }; });
            return stopping;
        },
        removeData: function () { /* This starter stores status only in memory. */ }
    };
};

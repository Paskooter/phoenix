'use strict';
// Offline execution: real loopback HTTP, synthetic HTTPS provider, no remote I/O.
var fs = require('fs'), vm = require('vm'), http = require('http'), timers = require('timers');
var EventEmitter = require('events').EventEmitter;
var file = process.argv[2], app, port, handles = [], source = fs.readFileSync(file, 'utf8');
function track(fn, delay, repeat) {
    var id = repeat ? timers.setInterval(fn, delay) : timers.setTimeout(fn, delay);
    handles.push(id); return id;
}
function clear(id) { timers.clearTimeout(id); timers.clearInterval(id); var i = handles.indexOf(id); if (i >= 0) handles.splice(i, 1); }
var watchdog = timers.setTimeout(function () { process.stderr.write('loopback_timeout\n'); process.exit(1); }, 4000);
function fail(error) {
    process.stderr.write(String(error && error.stack || error) + '\n');
    if (app) app.stop().then(function () { process.exit(1); }, function () { process.exit(1); });
    else process.exit(1);
}
// Obtain an available nonprivileged port without making a network request.
var probe = http.createServer();
probe.listen(0, '127.0.0.1', function () {
    port = probe.address().port;
    probe.close(function () {
        try {
            var mod = { exports: {} };
            vm.runInNewContext(source, { module: mod, exports: mod.exports, Promise: Promise, Date: Date,
                require: function (name) {
                    if (name === 'http') return http;
                    if (name === './config') return { url: 'https://example.com/', periodMs: 60000, port: port };
                    if (name === 'https') return { get: function (url, receive) {
                        var req = new EventEmitter();
                        req.setTimeout = function () {};
                        req.abort = function () { req.emit('abort'); };
                        process.nextTick(function () {
                            var res = new EventEmitter(); res.statusCode = 200;
                            res.destroy = function () { res.emit('close'); };
                            receive(res); res.emit('data', Buffer.from('sample')); res.emit('end');
                        });
                        return req;
                    } };
                    throw new Error('unexpected_module');
                } }, { filename: file });
            app = mod.exports.create({ timers: {
                setInterval: function (fn, ms) { return track(fn, ms, true); },
                setTimeout: function (fn, ms) { return track(fn, ms, false); },
                clearInterval: clear, clearTimeout: clear
            } });
            app.prepareBeforeInit();
            app.startAfterInit().then(function () {
                if (!app.health().ok) throw new Error('unhealthy');
                app.registerLaunchers();
                http.get({ hostname: '127.0.0.1', port: port, path: '/status', agent: false }, function (res) {
                    var bytes = '';
                    res.on('data', function (b) { bytes += b; });
                    res.on('end', function () {
                        try {
                            var value = JSON.parse(bytes);
                            if (value.httpStatus !== 200 || value.bytes !== 6 || value.error !== null) throw new Error('bad_status');
                            app.stop().then(function (result) {
                                if (!result.resourcesReleased || handles.length) throw new Error('cleanup_unconfirmed');
                                var req = http.get({ hostname: '127.0.0.1', port: port, path: '/status', agent: false });
                                req.on('response', function () { fail(new Error('listener_retained')); });
                                req.on('error', function (error) {
                                    if (error.code !== 'ECONNREFUSED') { fail(error); return; }
                                    timers.clearTimeout(watchdog);
                                    process.stdout.write(JSON.stringify({ ok: true, node: process.version,
                                        status: value.httpStatus, bytes: value.bytes, resourcesReleased: true,
                                        listenerClosed: true }) + '\n');
                                });
                            }).catch(fail);
                        } catch (error) { fail(error); }
                    });
                }).on('error', fail);
            }).catch(fail);
        } catch (error) { fail(error); }
    });
});

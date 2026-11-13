'use strict';
// Original example: CommonJS and ES2015 syntax for the robot's Node 6 runtime.
exports.create = function (context) {
    var makeHello = require('./hello');
    var app = require('./app.json');
    var skill = null, started = false, owned = [], attention = null, speech = null, stopping = null;
    var be = context.services.be, Be = context.services.Be;
    function releaseFocus() {
        if (speech) { speech.remove(); speech = null; }
        if (attention) { attention.remove(); attention = null; }
    }
    function open() {
        if (!started) return 'not_installed';
        if (context.services.jibo.face.views.disabled) return 'native_view_unavailable';
        if (attention) return 'native_focus_unavailable';
        attention = context.attention.acquire();
        if (!attention) return 'native_focus_unavailable';
        speech = context.speech.acquire();
        if (!speech) { releaseFocus(); return 'native_focus_unavailable'; }
        try { return be.redirect(new Be.SkillSwitchData(skill, { source: 'native_app' })); }
        catch (error) { releaseFocus(); throw error; }
    }
    return {
        prepareBeforeInit: function () {
            if (be.skills[app.name]) throw new Error('hello_name_in_use');
            skill = makeHello(context, releaseFocus);
            ['exit', 'redirect', 'refresh'].forEach(function (event) {
                owned.push(context.hooks.on(skill, event, function () {
                    if (event === 'exit') be.exit(skill);
                    else be.skillRedirect.apply(be, [skill].concat(Array.prototype.slice.call(arguments)));
                }));
            });
            be.skills[app.name] = skill;
        },
        startAfterInit: function () { if (!skill) throw new Error('hello_not_prepared'); started = true; },
        registerLaunchers: function () {
            owned.push(context.launchers.register({ name: 'Hello world', open: open }));
        },
        getSetupState: function () { return { configured: started }; },
        health: function () { return { ok: started && !!skill }; },
        stop: function () {
            if (stopping) return stopping;
            started = false;
            stopping = new Promise(function (resolve, reject) {
                if (!skill) { resolve({ resourcesReleased: true }); return; }
                skill.destroy(function (error) {
                    if (error) { reject(error); return; }
                    releaseFocus();
                    owned.splice(0).reverse().forEach(function (handle) { handle.remove(); });
                    if (be.skills[app.name] === skill) delete be.skills[app.name];
                    skill = null;
                    resolve({ resourcesReleased: true });
                });
            });
            return stopping;
        },
        removeData: function () { /* This starter writes no saved data. */ }
    };
};

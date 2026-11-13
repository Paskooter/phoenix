'use strict';
var timers = require('timers');
// Native services come from the host, not an npm install in this project.
module.exports = function (context, releaseFocus) {
    var BeSkill = context.services.Be.BeSkill, jibo = context.services.jibo;
    class Hello extends BeSkill {
        constructor(config) {
            super(config);
            this.view = null; this.ready = false; this.generation = 0;
            this.input = require('./voice-input')(jibo.jetstream); this.asking = null; this.unlisten = []; this.closing = null; this.speaking = null;
        }
        say(line) {
            if (!this.ready || this.speaking) return Promise.resolve(false);
            var api = jibo.embodied.speech;
            // Text is fixed, not user-supplied ESML. Respect other speakers.
            var engine = jibo.embodied._embodied.speech;
            if (engine.active || engine.unresolved.size || jibo.tts.isTalking ||
                jibo.embodied.listen.getActiveMode() !== null) return Promise.resolve(false);
            var promise = api.speak(line, { disableAutoRules: true, dispatchComplete: 'TTS' });
            var session = engine.active;
            if (!session) engine.unresolved.forEach(function (item) { session = item; });
            this.speaking = session;
            var self = this;
            return Promise.resolve(promise).then(function (result) { if (self.speaking === session) self.speaking = null; return result === 'SUCCEEDED'; },
                function () { if (self.speaking === session) self.speaking = null; return false; });
        }
        ask() {
            if (this.asking || !this.ready) return;
            var self = this, generation = this.generation;
            this.asking = this.say('Say hello.').then(function (spoken) {
                if (!spoken || !self.ready || self.generation !== generation) return;
                return self.input.listen(function (text) {
                    if (!self.ready || self.generation !== generation) return;
                    self.view.getComponentById('title').text = /\bhello\b/i.test(text) ? 'Hello to you too!' : 'Try saying hello';
                });
            }).then(function () { self.asking = null; }, function () {
                self.asking = null;
                if (self.ready && self.generation === generation) self.view.getComponentById('title').text = 'Tap Listen to try again';
            });
        }
        silence() {
            var mine = this.speaking, engine = jibo.embodied._embodied.speech, foreign = false;
            if (!mine) return Promise.resolve();
            engine.unresolved.forEach(function (session) { if (session !== mine) foreign = true; });
            if (foreign || (engine.active && engine.active !== mine)) {
                // Never stop someone else's utterance or report release falsely.
                return Promise.reject(new Error('hello_speech_busy'));
            }
            this.speaking = null;
            return Promise.resolve(jibo.embodied.speech.stop());
        }
        open() {
            if (this.view) return;
            this.leaving = false;
            var self = this, views = jibo.face.views, generation = ++this.generation;
            function label(id, text, y, size) {
                return { type: 'Label', id: id, text: text, position: { x: 640, y: y },
                    targetAnchor: { x: 0.5, y: 0.5 }, bounds: { width: 420, height: 70 },
                    style: { fontFamily: 'Proxima Nova Soft', fontSize: size, fill: '#FFFFFF', align: 'center' } };
            }
            var view = views.createView('View', {
                viewConfig: { type: 'View', id: 'hello-world', category: 'gui', ignoreSwipeDown: true, transitionStageOnly: true },
                componentConfigs: [label('title', 'Voice demo', 240, 48),
                    { type: 'Button', id: 'hello', assets: [], position: { x: 440, y: 320 },
                        hitArea: { x: 0, y: 0, width: 400, height: 100 },
                        action: { type: views.ActionData.CALLBACK, data: { callback: function () {
                            if (!self.ready || views.currentView !== view || view.inputLocked) return;
                            self.ask();
                        } } } }, label('tap-label', 'Listen', 370, 36),
                    label('hint', 'Swipe down to close', 490, 28)]
            });
            this.view = view; view.viewStateStacked = true;
            view.addAction(views.ActionData.CALLBACK, { callback: function () { self.leave(); } }, true, false, views.GESTURE.SWIPE_DOWN);
            views.changeView({ addView: view, transitionOpen: views.TRANSITION.IN, transitionClose: views.TRANSITION.OUT }, function () {
                if (self.generation !== generation || self.view !== view || self.leaving) return;
                self.ready = true;
                [jibo.jetstream.events.hjHeard, jibo.system.events.touchOn].forEach(function (event) {
                    var leave = function () { self.leave(); };
                    event.on(leave); self.unlisten.push(function () { event.off(leave); });
                });
                self.say('Hello! <break size="0.2"/> Tap Listen to try your voice.');
            }, function () {
                if (self.generation === generation && self.view === view) self.leave();
            }, function () {
                if (self.generation !== generation || self.view !== view || self.leaving) return;
                // A flat rectangle is reliable on the original renderer.
                var paint = new global.PIXI.Graphics();
                paint.beginFill(0x245A65); paint.drawRect(0, 0, 400, 100); paint.endFill();
                view.getComponentById('hello').display.addChild(paint);
            });
        }
        leave() {
            if (!this.view || this.leaving || this.closing) return;
            this.leaving = true; this.ready = false;
            this.exit({ noElementsOfSurprise: true });
        }
        destroy(done) { this.close(done); }
        close(done) {
            if (this.closing) { this.closing.then(function () { done(); }, done); return; }
            var self = this, view = this.view, views = jibo.face.views;
            this.ready = false; this.generation++;
            this.unlisten.splice(0).forEach(function (off) { off(); });
            this.closing = this.input.stop().then(function () { return self.silence(); }).then(function () { return self.asking; }).then(function () {
                return new Promise(function (resolve, reject) {
                    var finished = false, event = views.events.process;
                    // Node timers are used here because host admission closes
                    // before stop(). No new context timer may be admitted then.
                    var timer = timers.setTimeout(function () { finish(new Error('hello_close_timeout')); }, 2500);
                    function finish(error) {
                        if (finished) return; finished = true;
                        timers.clearTimeout(timer); event.off(attempt);
                        if (error) reject(error); else resolve();
                    }
                    function attempt() {
                        if (finished) return;
                        if (!view || view.state === 'destroyed') { finish(); return; }
                        var process = views._viewProcess;
                        if (process && (process.active || (process.processQueue && process.processQueue.length))) return;
                        if (views.currentView !== view) { finish(new Error('hello_view_covered')); return; }
                        views.changeView({ remove: true, transitionClose: views.TRANSITION.NONE }, function () {
                            if (view.state !== 'destroyed') { finish(new Error('hello_view_retained')); return; }
                            finish();
                        }, function () { finish(new Error('hello_view_close_failed')); });
                    }
                    event.on(attempt); attempt();
                });
            }).then(function () { self.view = null; self.closing = null; releaseFocus(); });
            this.closing.then(function () { done(); }, done);
        }
    }
    return new Hello({ assetPack: require('./app.json').name, rootPath: context.appRoot });
};

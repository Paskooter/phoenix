'use strict';
// One owned request. Never cancel another skill's turn.
module.exports = function (jetstream) {
    var generation = 0, work = null, request = null;
    function cancel(r) {
        if (r.status !== 'ACTIVE') return Promise.resolve();
        return Promise.resolve(r.cancel()).then(function (ok) {
            // A local forced completion does not confirm remote cancellation.
            if (ok === false) throw new Error('voice_cancel_unconfirmed');
        });
    }
    return {
        listen: function (answer) {
            if (work) return work;
            var mine = ++generation;
            work = Promise.resolve().then(function () {
                if (mine !== generation) return null;
                return jetstream.startLocalTurn({ nluRules: [], hintPhrases: ['hello'],
                    ignoreGlobalRules: true, rejectIfBusy: true, sosTimeout: 6, maxSpeechTimeout: 8 });
            }).then(function (r) {
                if (!r) return;
                request = r;
                if (mine !== generation) return cancel(r);
                return r.promise.then(function (result) {
                    if (mine !== generation || result.status !== 'SUCCEEDED') return;
                    var asr = result.result && result.result.asr;
                    if (asr && typeof asr.text === 'string') answer(asr.text);
                });
            });
            work = work.then(function () { request = null; work = null; }, function (error) {
                request = null; work = null; throw error;
            });
            return work;
        },
        stop: function () {
            generation++;
            var pending = work;
            return (request ? cancel(request) : Promise.resolve()).then(function () { return pending; });
        }
    };
};

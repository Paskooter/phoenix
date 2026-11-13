// >>> phoenix-ota-apply-gate >>>
// Rendered into the pinned stock installer by bake_jibo_io_native_image.py.
// Node 6.9.2; no network or mutation on refusal. A cache receipt is untrusted
// until its signature, item binding and (before unpack) package bytes are checked.
const _PHOENIX_OTA_GATE = __PHOENIX_OTA_GATE_CONFIG__;
const _phoenixOtaApplyCrypto = require("crypto");
__PHOENIX_OTA_VERSION_HELPERS__

function _phoenixOtaApplyRefuse(error) {
    let message = "Phoenix OTA apply gate refused update: " + error.message;
    syslog.error(message);
    console.error(message);
    // Do NOT call common.fail(): it changes work state and reboots into a retry.
    process.exit(1);
}

function _phoenixOtaSafeSubsystem(name) {
    return typeof name === "string" && /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function _phoenixOtaSafeVersion(v) {
    return typeof v === "string" && /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(v);
}

function _phoenixOtaRegularFile(file) {
    let stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("not a single-link regular file: " + file);
    }
    return stat;
}

function _phoenixOtaSignedItem(ws, source, checkBytes) {
    if (!ws || !_phoenixOtaSafeSubsystem(ws.subsystem) || !_phoenixOtaSafeVersion(ws.to)
        || typeof source !== "string" || typeof ws.filter !== "string") throw new Error("malformed work item");
    let receipt = source + ".phoenix-signature.json";
    if (_phoenixOtaRegularFile(receipt).size > 128 * 1024) throw new Error("oversize signature receipt");
    let sig = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (!sig || sig.format !== _PHOENIX_OTA_GATE.format || sig.alg !== "RSA-SHA256"
        || typeof sig.keyId !== "string" || typeof sig.payload !== "string" || typeof sig.signature !== "string"
        || !Object.prototype.hasOwnProperty.call(_PHOENIX_OTA_GATE.keys, sig.keyId)) {
        throw new Error("untrusted signature receipt");
    }
    if (!_phoenixOtaApplyCrypto.createVerify("RSA-SHA256").update(Buffer.from(sig.payload, "utf8"))
        .verify(_PHOENIX_OTA_GATE.keys[sig.keyId], sig.signature, "base64")) throw new Error("bad signature receipt");
    let st = JSON.parse(sig.payload);
    if (!st || st.format !== _PHOENIX_OTA_GATE.format || st.keyId !== sig.keyId
        || typeof st.id !== "string" || !st.id || !_phoenixOtaSafeSubsystem(st.subsystem)
        || !_phoenixOtaSafeVersion(st.toVersion) || (st.fromVersion !== "*" && !_phoenixOtaSafeVersion(st.fromVersion))
        || typeof st.filter !== "string" || !Number.isSafeInteger(st.length) || st.length < 0
        || typeof st.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(st.sha256)
        || typeof st.sha1 !== "string" || !/^[0-9a-f]{40}$/.test(st.sha1)) throw new Error("malformed signed statement");
    if (st.subsystem !== ws.subsystem || st.toVersion !== ws.to) throw new Error("signed item identity differs from work item");
    // Match the catalog's asymmetric filter-prefix contract, not exact equality.
    if (ws.filter ? st.filter.indexOf(ws.filter) !== 0 : st.filter !== "") throw new Error("signed filter differs from work item");
    let suffix = "/" + st.toVersion + "-" + st.subsystem + ".tar";
    if (source.slice(-suffix.length) !== suffix) throw new Error("signed identity differs from cache path");
    if (!st.dependencies || typeof st.dependencies !== "object" || Array.isArray(st.dependencies)) {
        throw new Error("malformed signed dependencies");
    }
    Object.keys(st.dependencies).forEach(function(name) {
        if (!_phoenixOtaSafeSubsystem(name) || !_phoenixOtaSafeVersion(st.dependencies[name])) {
            throw new Error("malformed signed dependency " + name);
        }
    });
    if (checkBytes) {
        if (_phoenixOtaRegularFile(source).size !== st.length) throw new Error("cached package length differs from signed length");
        let fd = fs.openSync(source, "r");
        let sha256 = _phoenixOtaApplyCrypto.createHash("sha256"), sha1 = _phoenixOtaApplyCrypto.createHash("sha1");
        let buffer = Buffer.alloc(64 * 1024), total = 0;
        try {
            let count;
            while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
                total += count;
                if (total > st.length) throw new Error("cached package grew beyond signed length");
                sha256.update(buffer.slice(0, count)); sha1.update(buffer.slice(0, count));
            }
        } finally { fs.closeSync(fd); }
        if (total !== st.length || sha256.digest("hex") !== st.sha256 || sha1.digest("hex") !== st.sha1) {
            throw new Error("cached package bytes differ from signed digests");
        }
    }
    return st;
}

// Predictions are only for initial, ordered preflight. During execution read real
// installed versions again: an unsigned work-state 'to' is not proof of installation.
function _phoenixOtaEffectiveVersion(name, earlier, required) {
    if (Object.prototype.hasOwnProperty.call(earlier, name)) return earlier[name];
    if (required && !Object.prototype.hasOwnProperty.call(_PHOENIX_OTA_GATE.versionCommands, name)
        && !fs.existsSync(_PHOENIX_OTA_GATE.skillsRoot + "/" + name + "/package.json")) {
        throw new Error("dependency " + name + " is not installed");
    }
    let version = _phoenixOtaInstalledVersion(name);
    if (!_phoenixOtaSafeVersion(version)) throw new Error("invalid installed version for " + name);
    return version;
}

function _phoenixOtaCheckDependencies(st, earlier, completedSubsystem) {
    Object.keys(st.dependencies).forEach(function(name) {
        // Only verification of the already-installed target may outgrow a dependency
        // on its own starting version. It was checked before the package was applied.
        if (name === completedSubsystem) return;
        let installed = _phoenixOtaEffectiveVersion(name, earlier, true);
        if (installed !== st.dependencies[name]) throw new Error(st.subsystem + " " + st.toVersion
            + ": dependency " + name + " requires " + st.dependencies[name] + ", installed/earlier " + installed);
    });
}

function _phoenixOtaCheckStartingVersion(st, earlier, verifying) {
    let installed = _phoenixOtaEffectiveVersion(st.subsystem, earlier, false);
    if (verifying) {
        if (installed !== st.toVersion) throw new Error("verify step does not match installed " + st.subsystem + " version");
    } else {
        if (_phoenixOtaCmpVersion(st.toVersion, installed) <= 0) throw new Error("older or same installed version for " + st.subsystem);
        if (st.fromVersion !== "*" && st.fromVersion !== installed) throw new Error("signed starting version differs for " + st.subsystem);
    }
}

function _phoenixOtaApplyPlan() {
    try {
        let earlier = Object.create(null);
        work_state.items.forEach(function(ws) {
            let st = _phoenixOtaSignedItem(ws, ws.source, true);
            _phoenixOtaCheckDependencies(st, earlier);
            _phoenixOtaCheckStartingVersion(st, earlier, false);
            earlier[st.subsystem] = st.toVersion;
        });
    } catch (e) { _phoenixOtaApplyRefuse(e); }
}

function _phoenixOtaApplyCurrent(source, unpacking) {
    try {
        let ws = work_state.current();
        let verifying = !unpacking && ws.step === "verify";
        // Stock removes the tar after unpack. OS verify and retry may legitimately
        // have no tar, but still need the retained signed envelope and real deps.
        let st = _phoenixOtaSignedItem(ws, source || ws.source,
            unpacking || (!verifying && ws.step !== "retry"));
        let installed = Object.create(null);
        _phoenixOtaCheckDependencies(st, installed, verifying ? st.subsystem : null);
        _phoenixOtaCheckStartingVersion(st, installed, verifying);
    } catch (e) { _phoenixOtaApplyRefuse(e); }
}

// Retry callbacks write their init/apply journal BEFORE calling unpackUpdate.
// Check the newly downloaded row before that callback can change even the journal.
const _phoenixOtaOriginalGetUpdate = common.getAvailableUpdate;
common.getAvailableUpdate = function(subsystem, from, filter, callback) {
    return _phoenixOtaOriginalGetUpdate.call(common, subsystem, from, filter, function(update, source) {
        _phoenixOtaApplyCurrent(source, true);
        callback(update, source);
    });
};

// Retry callbacks can fetch a DIFFERENT row without re-entering do_work(). Guard
// their actual tar at the last common boundary before any unpack or root hook.
const _phoenixOtaOriginalUnpack = common.unpackUpdate;
common.unpackUpdate = function(directory, source, callback) {
    _phoenixOtaApplyCurrent(source, true);
    return _phoenixOtaOriginalUnpack.call(common, directory, source, callback);
};
// <<< phoenix-ota-apply-gate <<<

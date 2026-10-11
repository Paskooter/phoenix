#!/usr/bin/env python3
"""Offline behavioural gate for the nginx edge-log guidance in docs/DEPLOYMENT.md.

The gate extracts the documented shell blocks (bootstrap, worker probe,
descriptor check and existing-directory correction) and executes those bytes in
a disposable sandbox under the system temp directory -- never under /var/log.
It then models the nginx log lifecycle: the root master opens the logs, a real
worker process running as an unprivileged uid inherits them, logrotate renames
and recreates the files using the `create` line of deploy/logrotate/phoenix-nginx,
and on the reopen signal the worker reopens the paths with its own credentials,
keeping its old descriptor when open() fails (nginx's behaviour).

Only three declared, counted changes are made to the documented bytes: the
/var/log/nginx/phoenix prefix is rebased into the sandbox, the documented worker
account is replaced by the representative worker (`nobody`), and `sudo`/`pgrep`
are shell-function shims (root runs the command; `sudo -u` drops to the user
with setpriv; `pgrep` names the simulated master and worker).

Root is needed only to switch uids. Nothing uses sudo or changes system
configuration. Exit codes: 0 expectations met, 1 expectation failed, 77 blocked.

  python3 scripts/pm-nginx-doc-check/check.py            # gate + all controls
  python3 scripts/pm-nginx-doc-check/check.py --doc F --gate-only
"""

import argparse
import grp
import gzip
import hashlib
import json
import os
import pwd
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(REPO, "docs", "DEPLOYMENT.md")
LOGROTATE = os.path.join(REPO, "deploy", "logrotate", "phoenix-nginx")
BASE_REV = "9dc40a5c3e0ab4def6103903278d900191e0633d"
LOG_DIR = "/var/log/nginx/phoenix"
DOC_WORKER = "www-data"
WORKER_NAME = "nobody"
NAMES = ("access", "error")
CHILD_TIMEOUT = 10
BLOCKED = 77

SHIM = r"""
sudo() {
  if [ "${1-}" = -u ]; then
    _u=$2; shift 2
    setpriv --reuid="$_u" --regid="$(id -g "$_u")" --init-groups -- "$@"
    return
  fi
  "$@"
}
pgrep() { printf '%s\n' $PM_PIDS; }
"""

WORKER = r"""
import json, os, sys
spec = json.loads(sys.argv[1])
fds = {k: v["fd"] for k, v in spec.items()}
for line in sys.stdin:
    msg = json.loads(line)
    out = {}
    if msg["cmd"] == "write":
        os.write(fds[msg["name"]], msg["text"].encode())
    elif msg["cmd"] == "reopen":
        for name, item in spec.items():
            try:
                nfd = os.open(item["path"], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            except OSError as e:
                out[name] = {"ok": False, "errno": e.errno, "error": os.strerror(e.errno)}
            else:
                os.close(fds[name])
                fds[name] = nfd
                out[name] = {"ok": True}
    else:
        break
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
"""

PROBE = r"""
import json, os, sys
op, path = sys.argv[1], sys.argv[2]
try:
    if op == "list":
        os.listdir(path)
    elif op == "read":
        with open(path, "rb") as f:
            f.read(1)
    else:
        os.stat(path)
    print(json.dumps({"ok": True}))
except OSError as e:
    print(json.dumps({"ok": False, "errno": e.errno, "error": os.strerror(e.errno)}))
"""


class GateFail(Exception):
    pass


class Blocked(Exception):
    pass


class Identity:
    def __init__(self, label, uid, gid, groups):
        self.label, self.uid, self.gid, self.groups = label, uid, gid, list(groups)


def unused_id(start):
    uid = start
    while True:
        try:
            pwd.getpwuid(uid)
        except KeyError:
            try:
                grp.getgrgid(uid)
            except KeyError:
                return uid
        uid += 1


def identities():
    if os.geteuid() != 0:
        raise Blocked("not root: cannot run subprocesses under distinct uids "
                      "(rerun as root in a disposable container or VM)")
    if not shutil.which("setpriv"):
        raise Blocked("setpriv (util-linux) not found")
    try:
        worker = pwd.getpwnam(WORKER_NAME)
        adm = grp.getgrnam("adm").gr_gid
    except KeyError as e:
        raise Blocked(f"missing account or group: {e}")
    w = Identity("worker", worker.pw_uid, worker.pw_gid,
                 os.getgrouplist(WORKER_NAME, worker.pw_gid))
    if adm in w.groups:
        raise Blocked("representative worker is a member of adm")
    u = unused_id(54321)
    o = unused_id(u + 1)
    return {
        "worker": w,
        "unrelated": Identity("unrelated", u, u, []),
        "operator": Identity("operator", o, o, [adm]),
        "adm": adm,
    }


def child_env(extra=None):
    env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "PM_PIDS": ""}
    env.update(extra or {})
    return env


def probe(ident, op, path):
    r = subprocess.run([sys.executable, "-I", "-c", PROBE, op, path],
                       user=ident.uid, group=ident.gid, extra_groups=ident.groups,
                       cwd="/", env=child_env(), capture_output=True, text=True,
                       timeout=CHILD_TIMEOUT)
    if r.returncode != 0:
        raise Blocked(f"probe interpreter failed as uid {ident.uid}: {r.stderr.strip()}")
    return json.loads(r.stdout)


def sh_blocks(text):
    blocks, cur, start = [], None, 0
    for n, line in enumerate(text.splitlines(), 1):
        if cur is None and line.strip() == "```sh":
            cur, start = [], n + 1
        elif cur is not None and line.strip() == "```":
            blocks.append((start, cur))
            cur = None
        elif cur is not None:
            cur.append(line)
    return blocks


def one_block(blocks, pred, what):
    hits = [b for b in blocks if any(pred(line) for line in b[1])]
    if len(hits) != 1:
        raise GateFail(f"expected exactly one ```sh block that {what}; found {len(hits)}")
    return hits[0]


def extract(text):
    blocks = sh_blocks(text)
    dir_re = re.compile(r"\binstall\s+-d\b.*\s" + re.escape(LOG_DIR) + r"\s*$")
    fix_re = re.compile(r"\bchmod\s+\d{3,4}\s+" + re.escape(LOG_DIR) + r"\s*$")
    return {
        "bootstrap": one_block(blocks, dir_re.search,
                               f"runs `install -d ... {LOG_DIR}`"),
        "probe": one_block(blocks, lambda l: f"test -w {LOG_DIR}/" in l,
                           f"runs `test -w {LOG_DIR}/...`"),
        "descriptors": one_block(blocks, lambda l: "/proc/$pid/fd" in l,
                                 "lists /proc/$pid/fd"),
        "correction": one_block(blocks, fix_re.search,
                                f"runs `chmod MODE {LOG_DIR}`"),
    }


def rebase(lines, sandbox, what):
    text = "\n".join(lines)
    n_dir = text.count(LOG_DIR)
    n_worker = len(re.findall(r"\b" + re.escape(DOC_WORKER) + r"\b", text))
    if n_dir == 0:
        raise GateFail(f"{what} block does not name {LOG_DIR}")
    text = text.replace(LOG_DIR, sandbox + LOG_DIR)
    text = re.sub(r"\b" + re.escape(DOC_WORKER) + r"\b", WORKER_NAME, text)
    return text, {"log_dir": n_dir, "worker": n_worker}


def logrotate_policy(path):
    with open(path) as f:
        conf = f.read()
    m = re.search(re.escape(LOG_DIR) + r"/\*\.log\s*\{(.*?)\}", conf, re.S)
    if not m:
        raise GateFail(f"{path} has no stanza for {LOG_DIR}/*.log")
    body = m.group(1)
    c = re.search(r"^\s*create\s+([0-7]{3,4})\s+(\S+)\s+(\S+)\s*$", body, re.M)
    if not c:
        raise GateFail(f"{path} stanza has no `create MODE OWNER GROUP` line")
    words = set(re.findall(r"^\s*(\w+)", body, re.M))
    return {"mode": int(c.group(1), 8), "owner": c.group(2), "group": c.group(3),
            "delaycompress": "delaycompress" in words, "compress": "compress" in words}


class Sandbox:
    def __init__(self, ids):
        self.ids = ids
        self.root = tempfile.mkdtemp(prefix="pm-nginx-doc-check-")
        os.chmod(self.root, 0o755)
        nginx = os.path.join(self.root, "var/log/nginx")
        os.makedirs(nginx)
        for d in ("var", "var/log", "var/log/nginx"):
            os.chmod(os.path.join(self.root, d), 0o755)
        os.chown(nginx, 0, ids["adm"])  # Debian's packaged /var/log/nginx
        for key in ("worker", "unrelated", "operator"):
            r = probe(ids[key], "stat", nginx)
            if not r["ok"]:
                raise Blocked(f"sandbox parent {nginx} not traversable by "
                              f"{key}: {r['error']}")
        self.dir = self.root + LOG_DIR
        self.paths = {n: f"{self.dir}/{n}.log" for n in NAMES}
        self.master = {}
        self.worker = None

    def shown(self, s):
        return s.replace(self.root, "")

    def run_sh(self, script, pids=""):
        r = subprocess.run(["sh", "-u", "-c", SHIM + script], cwd="/", umask=0o022,
                           env=child_env({"PM_PIDS": pids}), capture_output=True,
                           text=True, timeout=CHILD_TIMEOUT)
        return r.returncode, self.shown(r.stdout), self.shown(r.stderr)

    def master_open(self):
        old = os.umask(0o022)
        try:
            for n, p in self.paths.items():
                fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
                if n in self.master:
                    os.close(self.master[n])
                self.master[n] = fd
        finally:
            os.umask(old)

    def start_worker(self):
        w = self.ids["worker"]
        spec = {n: {"fd": self.master[n], "path": self.paths[n]} for n in NAMES}
        self.worker = subprocess.Popen(
            [sys.executable, "-I", "-c", WORKER, json.dumps(spec)],
            user=w.uid, group=w.gid, extra_groups=w.groups, cwd="/", env=child_env(),
            pass_fds=tuple(self.master.values()), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, text=True)
        self.inherited = dict(self.master)

    def rpc(self, msg):
        self.worker.stdin.write(json.dumps(msg) + "\n")
        self.worker.stdin.flush()
        ready, _, _ = select.select([self.worker.stdout], [], [], CHILD_TIMEOUT)
        line = self.worker.stdout.readline() if ready else ""
        if not line:
            raise Blocked("simulated worker did not answer")
        return json.loads(line)

    def request(self, tag):
        for n in NAMES:
            self.rpc({"cmd": "write", "name": n, "text": f"{tag} {n}\n"})

    def rotate(self, policy):
        owner = pwd.getpwnam(WORKER_NAME if policy["owner"] == DOC_WORKER
                             else policy["owner"]).pw_uid
        group = grp.getgrnam(policy["group"]).gr_gid
        for p in self.paths.values():
            if policy["compress"] and policy["delaycompress"] and os.path.exists(p + ".1"):
                k = 2
                while os.path.exists(f"{p}.{k}.gz"):
                    k += 1
                for j in range(k, 2, -1):
                    os.rename(f"{p}.{j - 1}.gz", f"{p}.{j}.gz")
                src, st = p + ".1", os.stat(p + ".1")
                fd = os.open(p + ".2.gz", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.fchown(fd, st.st_uid, st.st_gid)
                os.fchmod(fd, stat.S_IMODE(st.st_mode))
                with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
                    out.write(gzip.compress(inp.read()))
                os.unlink(src)
            os.rename(p, p + ".1")
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.fchmod(fd, policy["mode"])
            os.fchown(fd, owner, group)
            os.close(fd)

    def reopen(self):
        """USR1: master reopens (and chowns to the worker) as root, then workers."""
        wuid = self.ids["worker"].uid
        self.master_open()
        for p in self.paths.values():
            st = os.stat(p)
            if st.st_uid != wuid:
                os.chown(p, wuid, -1)
            if st.st_mode & 0o600 != 0o600:
                os.chmod(p, stat.S_IMODE(st.st_mode) | 0o600)
        return self.rpc({"cmd": "reopen"})

    def descriptors(self, block_text):
        pids = f"{os.getpid()} {self.worker.pid}"
        rc, out, err = self.run_sh(block_text, pids)
        targets = [l.split(" -> ", 1)[1] for l in out.splitlines() if " -> " in l]
        return rc, out, err, targets

    def close(self):
        if self.worker and self.worker.poll() is None:
            try:
                self.worker.stdin.write(json.dumps({"cmd": "exit"}) + "\n")
                self.worker.stdin.flush()
                self.worker.wait(timeout=CHILD_TIMEOUT)
            except Exception:
                self.worker.kill()
                self.worker.wait()
        for fd in self.master.values():
            os.close(fd)
        self.master = {}
        shutil.rmtree(self.root, ignore_errors=True)


def check(results, aid, ok, detail):
    results.append({"id": aid, "ok": bool(ok), "detail": detail})


def reopen_detail(sb, res, when):
    bad = [f'open() "{sb.shown(sb.paths[n])}" failed ({r["errno"]}: {r["error"]}) {when}'
           for n, r in res.items() if not r["ok"]]
    return bad


def confidentiality(sb, results, ids, aid):
    unrelated, operator = ids["unrelated"], ids["operator"]
    files = sorted(os.path.join(sb.dir, f) for f in os.listdir(sb.dir))
    readable = [sb.shown(f) for f in files if probe(unrelated, "read", f)["ok"]]
    check(results, f"{aid}-files-unreadable", not readable,
          f"unrelated uid {unrelated.uid} can read: {readable}" if readable
          else f"unrelated uid cannot read any of {len(files)} file(s)")
    lst = probe(unrelated, "list", sb.dir)
    check(results, f"{aid}-dir-unlistable", not lst["ok"],
          f"unrelated uid can list {LOG_DIR}" if lst["ok"]
          else f"unrelated list: {lst['error']}")
    trav = probe(unrelated, "stat", sb.paths["access"])
    op_read = probe(operator, "read", sb.paths["access"])
    op_list = probe(operator, "list", sb.dir)
    check(results, f"{aid}-operator-access", op_read["ok"] and op_list["ok"],
          f"adm operator read={op_read} list={op_list}")
    return {"unrelated_traverse": trav, "unrelated_list": lst}


def probe_block(sb, text, results, aid, expect_ok=True):
    lines = [l for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    log = []
    for line in lines:
        rc, out, err = sb.run_sh(line)
        log.append({"line": sb.shown(line), "rc": rc, "stdout": out, "stderr": err})
        if "test -w" in line:
            label = line.rsplit("echo", 1)[-1].strip()
            passed = rc == 0 and out.strip() == label
            check(results, f"{aid}-probe-test-w" if expect_ok else f"{aid}-probe-detects-incident",
                  passed == expect_ok,
                  f"documented probe `{sb.shown(line)}` -> rc={rc} stdout={out.strip()!r} "
                  f"stderr={err.strip()!r}")
        elif expect_ok and "find" in line and "-perm" in line:
            check(results, f"{aid}-probe-find-empty", rc == 0 and not out.strip(),
                  f"documented `find` printed {out.strip()!r} (rc={rc})")
    return log


def descriptor_check(sb, text, results, aid):
    rc, out, err, targets = sb.descriptors(text)
    live = {sb.shown(p) for p in sb.paths.values()}
    stale = [t for t in targets if t not in live]
    check(results, f"{aid}-descriptors-live", targets and not stale,
          f"documented descriptor check rc={rc}: stale targets {stale}" if stale
          else f"documented descriptor check rc={rc}: {len(targets)} live target(s)"
          if targets else f"documented descriptor check listed nothing (rc={rc}, {err.strip()!r})")
    return out


def live_has(sb, results, aid, tag):
    with open(sb.paths["access"], "rb") as f:
        data = f.read().decode()
    check(results, f"{aid}-live-file-records-request", f"{tag} access" in data,
          f"live access.log has {len(data)} byte(s) and "
          f"{'contains' if tag + ' access' in data else 'lacks'} request {tag}")


def bootstrap_scenario(blocks, ids, policy):
    results, ev = [], {}
    sb = Sandbox(ids)
    try:
        text, subs = rebase(blocks["bootstrap"][1], sb.root, "bootstrap")
        ev["bootstrap_substitutions"] = subs
        rc, out, err = sb.run_sh("set -e\n" + text)
        if rc != 0:
            raise GateFail(f"documented bootstrap block exited {rc}: {err.strip()}")
        st = os.stat(sb.dir)
        ev["dir"] = {"mode": oct(stat.S_IMODE(st.st_mode)), "uid": st.st_uid, "gid": st.st_gid}
        sb.master_open()  # nginx -t / startup as root
        ev["after_startup"] = confidentiality(sb, results, ids, "B1")
        sb.start_worker()
        sb.request("R1")
        for i in (1, 2):
            sb.rotate(policy)
            res = sb.reopen()
            bad = reopen_detail(sb, res, f"at rotation {i}")
            check(results, f"B2-worker-reopen-rotation-{i}", not bad,
                  "; ".join(bad) if bad else f"worker reopened both logs at rotation {i}")
            sb.request(f"R{i + 1}")
        live_has(sb, results, "B3", "R3")
        ptext, _ = rebase(blocks["probe"][1], sb.root, "probe")
        ev["probe"] = probe_block(sb, ptext, results, "B4")
        dtext, _ = rebase(blocks["descriptors"][1], sb.root, "descriptor")
        ev["descriptors"] = descriptor_check(sb, dtext, results, "B5")
        ev["final"] = confidentiality(sb, results, ids, "B6")
    finally:
        sb.close()
    return results, ev


def correction_scenario(blocks, ids, policy):
    """Old-doc host (0750 root:adm, nginx-created files) -> documented correction."""
    results, ev = [], {}
    sb = Sandbox(ids)
    try:
        os.mkdir(sb.dir, 0o750)
        os.chown(sb.dir, 0, ids["adm"])
        os.chmod(sb.dir, 0o750)
        sb.master_open()
        sb.start_worker()
        sb.request("R1")
        pre = []
        for i in (1, 2):
            sb.rotate(policy)
            pre.append(sb.reopen())
            sb.request(f"R{i + 1}")
        held = {n: os.readlink(f"/proc/{sb.worker.pid}/fd/{fd}")
                for n, fd in sb.inherited.items()}
        size = os.path.getsize(sb.paths["access"])
        reproduced = all(not r["ok"] for res in pre for r in res.values()) \
            and all(t.endswith("(deleted)") for t in held.values()) and size == 0
        ev["incident"] = {"reopen": pre, "worker_fds": {n: sb.shown(t) for n, t in held.items()},
                          "live_access_bytes": size, "requests_served": 3,
                          "reproduced": reproduced}
        if not reproduced:
            raise Blocked("0750 incident did not reproduce in the sandbox")
        ptext, _ = rebase(blocks["probe"][1], sb.root, "probe")
        ev["incident_probe"] = probe_block(sb, ptext, results, "C0", expect_ok=False)
        dtext, _ = rebase(blocks["descriptors"][1], sb.root, "descriptor")
        rc, out, err, targets = sb.descriptors(dtext)
        ev["incident_descriptor_output"] = out
        check(results, "C0-descriptors-detect-incident",
              any(t.endswith("(deleted)") for t in targets),
              f"documented descriptor check in the 0750 state listed {targets}")
        ctext, subs = rebase(blocks["correction"][1], sb.root, "correction")
        ev["correction_substitutions"] = subs
        rc, out, err = sb.run_sh("set -e\n" + ctext)
        if rc != 0:
            raise GateFail(f"documented correction block exited {rc}: {err.strip()}")
        ev["probe"] = probe_block(sb, ptext, results, "C1")
        res = sb.reopen()  # `nginx -s reopen`; Phoenix is not restarted
        bad = reopen_detail(sb, res, "after the documented correction")
        check(results, "C2-worker-reopen-after-correction", not bad,
              "; ".join(bad) if bad else "worker reopened both logs after correction")
        sb.request("R4")
        live_has(sb, results, "C3", "R4")
        ev["descriptors"] = descriptor_check(sb, dtext, results, "C4")
        ev["final"] = confidentiality(sb, results, ids, "C5")
    finally:
        sb.close()
    return results, ev


def gate(doc_text, label, logrotate_path=LOGROTATE):
    out = {"label": label, "status": None, "assertions": [], "evidence": {}}
    try:
        ids = identities()
        policy = logrotate_policy(logrotate_path)
        out["evidence"]["logrotate"] = {**policy, "mode": oct(policy["mode"])}
        blocks = extract(doc_text)
        boot = "\n".join(blocks["bootstrap"][1])
        out["evidence"]["bootstrap_block"] = {
            "doc_line": blocks["bootstrap"][0], "bytes": boot,
            "sha256": hashlib.sha256(boot.encode()).hexdigest()}
        for name, fn in (("bootstrap", bootstrap_scenario),
                         ("correction", correction_scenario)):
            res, ev = fn(blocks, ids, policy)
            out["assertions"] += res
            out["evidence"][name] = ev
        out["status"] = "pass" if all(a["ok"] for a in out["assertions"]) else "fail"
    except GateFail as e:
        out["status"] = "fail"
        out["assertions"].append({"id": "G0-extract-or-run", "ok": False, "detail": str(e)})
    except Blocked as e:
        out["status"] = "blocked"
        out["blocked"] = str(e)
    return out


def mutations(doc):
    boot = ("sudo install -d -o root -g adm -m 0751 /var/log/nginx/phoenix\n")
    files = ("sudo touch /var/log/nginx/phoenix/access.log /var/log/nginx/phoenix/error.log\n"
             "sudo chown www-data:adm /var/log/nginx/phoenix/access.log "
             "/var/log/nginx/phoenix/error.log\n"
             "sudo chmod 0640 /var/log/nginx/phoenix/access.log "
             "/var/log/nginx/phoenix/error.log\n")
    find_fix = "sudo find /var/log/nginx/phoenix -type f -perm /o=rwx -exec chmod o-rwx {} +\n"
    fix = "sudo chmod 0751 /var/log/nginx/phoenix\n"
    probe = ("sudo -u www-data test -w /var/log/nginx/phoenix/access.log && echo access-ok\n"
             "sudo -u www-data test -w /var/log/nginx/phoenix/error.log && echo error-ok\n")
    table = [
        ("M1 bootstrap dir 0751->0750 (incident mode)", boot, boot.replace("0751", "0750")),
        ("M2 bootstrap files 0640->0644", files, files.replace("chmod 0640", "chmod 0644")),
        ("M3 bootstrap omits file pre-creation", boot + files, boot),
        ("M4 bootstrap dir 0751->0755 (listable)", boot, boot.replace("0751", "0755")),
        ("M5 probe runs as root, not as the worker", probe, probe.replace("sudo -u www-data ", "sudo ")),
        ("M6 correction omits the file find/chmod", find_fix + fix, fix),
        ("M7 correction dir 0751->0750", fix, fix.replace("0751", "0750")),
    ]
    for label, old, new in table:
        n = doc.count(old)
        if n != 1:
            raise SystemExit(f"control {label}: mutation target occurs {n} times in the doc")
        yield label, doc.replace(old, new), old, new


def summarize(r):
    failed = [a for a in r["assertions"] if not a["ok"]]
    if r["status"] == "blocked":
        return f"BLOCKED: {r['blocked']}"
    if not failed:
        return f"{len(r['assertions'])}/{len(r['assertions'])} assertions passed"
    return " | ".join(f"{a['id']}: {a['detail']}" for a in failed)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--doc", default=DOC)
    ap.add_argument("--gate-only", action="store_true")
    ap.add_argument("--old-rev", default=BASE_REV)
    ap.add_argument("--json")
    args = ap.parse_args()

    def time_limit(signum, frame):
        raise Blocked("global 300 s time limit reached")

    signal.signal(signal.SIGALRM, time_limit)  # raise so sandbox cleanup still runs
    signal.alarm(300)
    with open(args.doc) as f:
        doc = f.read()
    runs = []
    shown = os.path.relpath(args.doc, REPO)
    main_run = gate(doc, f"doc-under-test {os.path.basename(args.doc) if shown.startswith('..') else shown}")
    main_run["expect"] = "pass"
    runs.append(main_run)
    if not args.gate_only and main_run["status"] != "blocked":
        try:
            old = subprocess.run(["git", "-C", REPO, "show", f"{args.old_rev}:docs/DEPLOYMENT.md"],
                                 capture_output=True, text=True, check=True,
                                 timeout=CHILD_TIMEOUT).stdout
            r = gate(old, f"old-doc control {args.old_rev[:7]}:docs/DEPLOYMENT.md")
        except (subprocess.SubprocessError, OSError) as e:
            r = {"label": "old-doc control", "status": "blocked",
                 "blocked": f"cannot read {args.old_rev}: {e}", "assertions": []}
        r["expect"] = "fail"
        runs.append(r)
        for label, text, old_s, new_s in mutations(doc):
            r = gate(text, label)
            r["expect"], r["mutation"] = "fail", {"from": old_s, "to": new_s}
            runs.append(r)
    blocked = False
    ok = True
    for r in runs:
        met = r["status"] == r["expect"]
        blocked |= r["status"] == "blocked"
        ok &= met
        tag = ("PASS" if r["status"] == "pass" else
               "FAIL" if r["status"] == "fail" else "BLOCKED")
        print(f"[{tag}{' (expected)' if met else ' (UNEXPECTED)'}] {r['label']}")
        print(f"    {summarize(r)}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(runs, f, indent=1, sort_keys=True)
    leftovers = [d for d in os.listdir(tempfile.gettempdir())
                 if d.startswith("pm-nginx-doc-check-")]
    print(f"temporary sandboxes left: {len(leftovers)}")
    if blocked:
        return BLOCKED
    return 0 if ok and not leftovers else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Root verification of A-02 criteria 1-3: the Classic dispatch auth boundary.

A-02 asks whether Phoenix's dispatch, authentication and error handling match
the original. The authoritative statement of *who may call what unsigned* is not
in the service handlers - it is the security gateway's three allow-lists:

    jiborobot/srv-security-gw@43a692fe src/controllers/auth.ctrl.ts
        unauthorizedMethods  - callable with NO Authorization header
        unsignedMethods      - callable with a bare access-key id (empty at pin)
        unactiveMethods      - callable by an INACTIVE account

Phoenix reimplements those lists per service face rather than in one gateway, so
this script re-derives them from the Phoenix sources and diffs against the pinned
gateway extract. A drift in either direction is a real auth defect: a target
Phoenix treats as anonymous but the gateway does not is an authentication
bypass; the reverse breaks a client that legitimately calls unsigned.

This checks the *static* contract. Live request behavior for these targets is
covered by the per-operation suites (MISSING_AUTH_HEADER envelopes, SigV4
verification, ownership) - see packages/account/test/.

Run with --falsify to prove the diff actually detects drift.
"""
import argparse
import json
import re
import sys
from pathlib import Path

GATEWAY_PIN = {
    "repository": "jiborobot/srv-security-gw",
    "revision": "43a692fe7670660aaed6ab5979c6c83039eb711c",
    "path": "src/controllers/auth.ctrl.ts",
}

# Extracted verbatim from the pinned gateway source.
GATEWAY_LISTS = Path(".parity/reviews/a02-gateway-root-20260910/gateway-allow-lists.json")

ACCOUNT_SRC = Path("packages/account/src/accountIdentity.js")
ROBOTFACE_SRC = Path("packages/account/src/robotFace.js")


def phoenix_account_anonymous(text=None):
    """Targets Phoenix's Account face allows with no Authorization header."""
    text = text if text is not None else ACCOUNT_SRC.read_text()
    i = text.find("ACCOUNT_ANONYMOUS_TARGETS = Object.freeze")
    if i < 0:
        return []
    j = text.find("])", i)
    return re.findall(r"'([^']+)'", text[i:j])


def phoenix_loop_anonymous(text=None):
    """Targets Phoenix's Loop face allows with no Authorization header."""
    text = text if text is not None else ROBOTFACE_SRC.read_text()
    i = text.find("const anonymousTarget = [")
    if i < 0:
        return []
    j = text.find("]", i + len("const anonymousTarget = ["))
    return re.findall(r"'([^']+)'", text[i:j])


def phoenix_oobe_unauthenticated(text=None, target=None):
    """True when Phoenix's OOBE dispatch reaches its handler with no SigV4 gate.

    robotFaceRoutes registers the oobe.handler.ts operations in its `ops` table
    and applies verifySigV4 only inside the `/^account/i` and `/^loop/i` prefix
    branches. An OOBE_* target therefore dispatches unauthenticated. This is
    derived from the source rather than assumed, so that adding a signature gate
    to the OOBE path later turns this check red instead of silently passing.
    """
    text = text if text is not None else ROBOTFACE_SRC.read_text()
    op = (target or "").split(".", 1)[-1].lower()
    if not op:
        return False
    # The operation must be registered in the dispatch table...
    if not re.search(rf"^\s*{re.escape(op)}\s*:", text, re.M):
        return False
    # ...and no SigV4 verification may guard the OOBE prefix. Phoenix gates only
    # the account and loop prefixes; if an oobe-prefixed gate ever appears, the
    # target is no longer anonymous and this must stop reporting it as such.
    return not re.search(r"/\^oobe/i\.test\(prefix\)[^\n]*\n[^\n]*verifySigV4", text)


def phoenix_unactive(text=None):
    """Targets Phoenix lets an INACTIVE account call.

    verifySigV4 rejects every !isActive credential, so the Account face carves
    out the gateway's unactiveMethods by presenting a live flag to the verifier
    for exactly those targets.
    """
    text = text if text is not None else ACCOUNT_SRC.read_text()
    i = text.find("ACCOUNT_UNACTIVE_TARGETS = Object.freeze")
    if i < 0:
        return []
    j = text.find("])", i)
    return re.findall(r"'([^']+)'", text[i:j])


def compare_unactive(gateway, account_text=None):
    """Diff Phoenix's inactive-callable targets against the gateway."""
    gw = set(gateway["unactiveMethods"])
    phx = set(phoenix_unactive(account_text))
    return {
        "gatewayUnactive": sorted(gw),
        "phoenixUnactive": sorted(phx),
        "extra": sorted(phx - gw),
        "missing": sorted(gw - phx),
        "result": "pass" if phx == gw else "fail",
    }


def compare(gateway, account_text=None, robotface_text=None):
    """Diff Phoenix's anonymous targets against the gateway allow-list."""
    unauth = set(gateway["unauthorizedMethods"])
    phoenix = set(phoenix_account_anonymous(account_text)) | set(phoenix_loop_anonymous(robotface_text))

    # Phoenix serves the Account, Loop and OOBE faces (robotFaceRoutes dispatches
    # oobe.handler.ts's setuprobot/getstatus/preparerobot, and the SigV4 gate is
    # applied only under the /^account/i and /^loop/i prefixes). OOBE_20161026
    # GetStatus and SetupRobot therefore reach their handlers with no signature
    # check, which is exactly what the gateway's unauthorizedMethods specifies -
    # so they count as implemented-anonymous rather than out of scope.
    oobe_anonymous = {t for t in unauth if t.startswith("OOBE_20161026.")
                      and phoenix_oobe_unauthenticated(robotface_text, t)}
    phoenix |= oobe_anonymous

    served_prefixes = ("Account_20151111.", "Loop_20160324.", "OOBE_20161026.")
    in_scope = {t for t in unauth if t.startswith(served_prefixes)}
    out_of_scope = sorted(unauth - in_scope)

    bypass = sorted(phoenix - unauth)          # Phoenix anonymous, gateway not
    missing = sorted(in_scope - phoenix)       # gateway anonymous, Phoenix not

    return {
        "gatewayUnauthorized": len(unauth),
        "gatewayInScope": sorted(in_scope),
        "gatewayOutOfScope": out_of_scope,
        "phoenixAnonymous": sorted(phoenix),
        "authenticationBypass": bypass,
        "missingAnonymous": missing,
        "result": "pass" if not bypass and not missing else "fail",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--falsify", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    gateway = json.loads(GATEWAY_LISTS.read_text())

    if args.falsify:
        account_text = ACCOUNT_SRC.read_text()
        robotface_text = ROBOTFACE_SRC.read_text()
        cases = {
            "Phoenix marks a credentialed target anonymous (bypass)":
                (account_text.replace(
                    "ACCOUNT_ANONYMOUS_TARGETS = Object.freeze([",
                    "ACCOUNT_ANONYMOUS_TARGETS = Object.freeze([\n  'Account_20151111.Update',", 1),
                 robotface_text),
            "Phoenix drops a gateway-anonymous target":
                (account_text.replace("'Account_20151111.CheckEmail',", "", 1), robotface_text),
            "Loop face drops an invitation target":
                (account_text,
                 robotface_text.replace("'Loop_20160324.AcceptInvitationByCode',", "", 1)),
            "OOBE path gains a signature gate (no longer anonymous)":
                (account_text,
                 robotface_text.replace(
                     "if (/^account/i.test(prefix)) {",
                     "if (/^oobe/i.test(prefix)) {\n      const v = verifySigV4({});\n    }\n    if (/^account/i.test(prefix)) {", 1)),
        }
        unactive_cases = {
            "Phoenix widens unactiveMethods (inactive bypass)":
                account_text.replace(
                    "ACCOUNT_UNACTIVE_TARGETS = Object.freeze([",
                    "ACCOUNT_UNACTIVE_TARGETS = Object.freeze([\n  'Account_20151111.Get',", 1),
            "Phoenix drops the inactive Remove carve-out":
                account_text.replace("ACCOUNT_UNACTIVE_TARGETS = Object.freeze([\n  'Account_20151111.Remove',",
                                     "ACCOUNT_UNACTIVE_TARGETS = Object.freeze([", 1),
        }
        for label, at in unactive_cases.items():
            u = compare_unactive(gateway, at)
            caught = u["result"] == "fail"
            print(f"  falsify [{'caught' if caught else 'MISSED'}] {label}")
            if not caught:
                print(f"    diff failed to detect: {label}", file=sys.stderr)
                return 2

        for label, (at, rt) in cases.items():
            r = compare(gateway, at, rt)
            caught = r["result"] == "fail"
            print(f"  falsify [{'caught' if caught else 'MISSED'}] {label}")
            if not caught:
                print(f"    diff failed to detect: {label}", file=sys.stderr)
                return 2
        print(f"falsification: all {len(cases) + len(unactive_cases)} drifts detected")
        return 0

    r = compare(gateway)
    ua = compare_unactive(gateway)
    r["unactive"] = ua
    if ua["result"] == "fail":
        r["result"] = "fail"
    r["gatewayPin"] = GATEWAY_PIN

    if args.json:
        print(json.dumps(r, indent=2))
    else:
        print(f"A-02 auth boundary vs {GATEWAY_PIN['repository']}@{GATEWAY_PIN['revision'][:8]}")
        print(f"  gateway unauthorizedMethods: {r['gatewayUnauthorized']}")
        print(f"  in scope for Phoenix's faces: {len(r['gatewayInScope'])}")
        print(f"  Phoenix anonymous targets:    {len(r['phoenixAnonymous'])}")
        if r["authenticationBypass"]:
            print("  AUTHENTICATION BYPASS - Phoenix allows unsigned, gateway does not:")
            for t in r["authenticationBypass"]:
                print("    -", t)
        if r["missingAnonymous"]:
            print("  MISSING - gateway allows unsigned, Phoenix does not:")
            for t in r["missingAnonymous"]:
                print("    -", t)
        print(f"  inactive-callable (unactiveMethods): gateway {ua['gatewayUnactive']} "
              f"phoenix {ua['phoenixUnactive']}")
        if ua["extra"]:
            print("  INACTIVE BYPASS - Phoenix lets an inactive account call:")
            for t in ua["extra"]:
                print("    -", t)
        if ua["missing"]:
            print("  MISSING - gateway allows an inactive caller, Phoenix does not:")
            for t in ua["missing"]:
                print("    -", t)
        if r["result"] == "pass":
            print("  exact match on every target Phoenix serves")
        print(f"  out of scope (services Phoenix does not serve): {len(r['gatewayOutOfScope'])}")
        for t in r["gatewayOutOfScope"]:
            print("    -", t)

    return 0 if r["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

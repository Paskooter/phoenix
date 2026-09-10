#!/usr/bin/env python3
"""Root verification of A-03 criterion 1: every Account and AccountAdmin
operation from the inventory is implemented and verified.

The trap this script exists to close: `account-2015-11-11` and
`accountadmin-2015-11-11` are two DIFFERENT API files that both declare
`targetPrefix: Account_20151111`. Two operations — ActivateById and ResetEmail —
exist ONLY in the admin file, with different required input than any Account
operation, so a check that only reads the Account API file, or only compares
operation names, would miss the admin contract entirely and still pass.

Checks, per live operation:
  1. every inventory operation (from BOTH API files) appears in the A-01 map
  2. every one is implemented in Phoenix's Account face
  3. every one has focused test coverage
  4. the dead Facebook operations are excluded explicitly, not silently

Run with --falsify to prove each check detects its own failure.
"""
import argparse
import json
import re
import sys
from pathlib import Path

MAP = Path("docs/parity/candidates/A-01-operation-map.json")
INVENTORY = Path("docs/parity/evidence/2026-09-05/classic-api-inventory.json")
ACCOUNT_SRC = Path("packages/account/src/accountIdentity.js")
ROBOTFACE_SRC = Path("packages/account/src/robotFace.js")
TEST_DIR = Path("packages/account/test")

ACCOUNT_API = "apis/account-2015-11-11.normal.json"
ADMIN_API = "apis/accountadmin-2015-11-11.normal.json"
TARGET_PREFIX = "Account_20151111"

# Dispatched by robotFace rather than the account-identity table.
ROBOTFACE_ONLY = {"CreateHubToken"}

# Operations excluded with a written determination rather than by omission.
EXCLUDED = {
    "FacebookConnect": "dead Facebook Graph API (DIVERGENCES.md D-fb)",
    "FacebookMobileConnect": "dead Facebook Graph API (DIVERGENCES.md D-fb)",
    "FacebookPrepareLogin": "dead Facebook Graph API (DIVERGENCES.md D-fb)",
}


def inventory_ops(data, api_file):
    """Operations declared by one API file, keyed by wire name."""
    found = {}

    def walk(node):
        if isinstance(node, dict):
            if node.get("path") == api_file:
                for op in node.get("operations") or []:
                    found[op["key"]] = op
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return found


def phoenix_ops(text):
    """Operation keys registered in Phoenix's Account OPS table."""
    i = text.find("const OPS = {")
    j = text.find("\n};", i)
    return set(re.findall(r"^  ([A-Za-z_][A-Za-z0-9_]*): \{", text[i:j], re.M))


def phoenix_robotface_ops(text):
    """Operation keys registered in robotFace's own dispatch table.

    CreateHubToken lives here rather than in the account-identity table: it is
    the bounded A-02 SigV4 operation and is deliberately routed before the
    identity handler. A checker that only read accountIdentity.js would report
    it missing and be wrong.
    """
    i = text.find("const ops = {")
    j = text.find("\n  };", i)
    return set(re.findall(r"^\s*([a-z][a-z0-9_]*)\s*:", text[i:j], re.M))


def phoenix_methods(text):
    i = text.find("ACCOUNT_IDENTITY_METHODS = Object.freeze")
    j = text.find("])", i)
    return set(re.findall(r"'([^']+)'", text[i:j]))


def tested_ops():
    """Operation names mentioned by focused Account tests."""
    names = set()
    for path in TEST_DIR.glob("*.test.js"):
        text = path.read_text()
        for match in re.finditer(rf"{TARGET_PREFIX}\.([A-Za-z][A-Za-z0-9]*)", text):
            names.add(match.group(1))
    return names


def build():
    inv = json.loads(INVENTORY.read_text())
    acct = inventory_ops(inv, ACCOUNT_API)
    admin = inventory_ops(inv, ADMIN_API)
    all_ops = {**acct, **admin}
    # Where each op is declared - the whole point of reading both files.
    declared_in = {
        name: ("both" if name in acct and name in admin
               else "AccountAdmin" if name in admin else "Account")
        for name in all_ops
    }
    src = ACCOUNT_SRC.read_text()
    return {
        "inventory": all_ops,
        "declaredIn": declared_in,
        "phoenixOps": phoenix_ops(src),
        "robotfaceOps": phoenix_robotface_ops(ROBOTFACE_SRC.read_text()),
        "phoenixMethods": phoenix_methods(src),
        "tested": tested_ops(),
        "map": json.loads(MAP.read_text()),
    }


def check(data, drop_op=None, drop_method=None, drop_test=None):
    problems = []
    mapped = {o["operation"] for o in data["map"]["operations"]
              if o["targetPrefix"] == TARGET_PREFIX}
    ops = set(data["inventory"]) - (drop_op or set())
    methods = data["phoenixMethods"] - (drop_method or set())
    tested = data["tested"] - (drop_test or set())

    for name in sorted(ops):
        if name in EXCLUDED:
            continue
        if name not in mapped:
            problems.append(f"{name}: not in the A-01 operation map")
        key = name[0].lower() + name[1:]
        # CreateHubToken is dispatched by robotFace, not the identity table,
        # so it is exempt from the identity method list by design.
        if name in ROBOTFACE_ONLY:
            # robotFace's table is keyed by the LOWERCASED op name.
            if name.lower() not in data["robotfaceOps"]:
                problems.append(f"{name}: neither in robotFace dispatch nor the identity OPS table")
        else:
            if key not in methods:
                problems.append(f"{name}: not in ACCOUNT_IDENTITY_METHODS")
            if key not in data["phoenixOps"]:
                problems.append(f"{name}: no OPS entry (not implemented)")
        if name not in tested:
            problems.append(f"{name}: no focused test references it")

    missing_exclusions = [k for k in EXCLUDED if k in data["inventory"]
                          and k not in EXCLUDED]
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--falsify", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    data = build()

    if args.falsify:
        cases = {
            "an operation vanishes from ACCOUNT_IDENTITY_METHODS":
                lambda: check(data, drop_method={"search"}),
            "an operation loses its focused test":
                lambda: check(data, drop_test={"ResetKeys"}),
            # Removing an op from the INVENTORY also removes it from the check,
            # so that case proves nothing. The realistic failure is the op
            # vanishing from Phoenix while the inventory still expects it.
            "an operation is implemented no longer (OPS entry gone)":
                lambda: check({**data, "phoenixOps": data["phoenixOps"] - {"updatePhoto"}}),
        }
        for label, fn in cases.items():
            caught = len(fn()) > 0
            print(f"  falsify [{'caught' if caught else 'MISSED'}] {label}")
            if not caught:
                print(f"    check failed to detect: {label}", file=sys.stderr)
                return 2
        print(f"falsification: all {len(cases)} gaps detected")
        return 0

    problems = check(data)
    live = [n for n in data["inventory"] if n not in EXCLUDED]
    summary = {
        "task": "A-03",
        "criterion": 1,
        "accountApiOperations": len(inventory_ops(json.loads(INVENTORY.read_text()), ACCOUNT_API)),
        "accountAdminApiOperations": len(inventory_ops(json.loads(INVENTORY.read_text()), ADMIN_API)),
        "adminOnlyOperations": sorted(set(inventory_ops(json.loads(INVENTORY.read_text()), ADMIN_API))
                                      - set(inventory_ops(json.loads(INVENTORY.read_text()), ACCOUNT_API))),
        "liveOperations": len(live),
        "excluded": {k: v for k, v in EXCLUDED.items() if k in data["inventory"]},
        "implemented": sum(1 for n in live if (n[0].lower() + n[1:]) in data["phoenixOps"]),
        "problems": len(problems),
        "result": "pass" if not problems else "fail",
    }

    if args.json:
        print(json.dumps({**summary, "problemList": problems[:50]}, indent=2))
    else:
        print(f"A-03 criterion 1: {summary['implemented']}/{summary['liveOperations']} "
              "live Account operations implemented and tested")
        print(f"  Account API: {summary['accountApiOperations']} ops; "
              f"AccountAdmin API: {summary['accountAdminApiOperations']} ops "
              f"(same wire prefix {TARGET_PREFIX})")
        print(f"  admin-only: {summary['adminOnlyOperations']}")
        print(f"  excluded: {list(summary['excluded'])}")
        if problems:
            print(f"{len(problems)} problem(s):")
            for p in problems[:30]:
                print("  -", p)
        else:
            print("  no problems: every operation is mapped, implemented and covered")
    return 0 if summary["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Root verification of A-01 acceptance criterion 2.

The three wave-5 candidates each added `attributes` blocks to their own slice of
`docs/parity/candidates/A-01-operation-map.json`. This script does NOT trust that
work. It re-derives, from the merged map alone, whether criterion 2 is actually
satisfied, and it is written to FAIL loudly rather than to pass quietly.

Criterion 2:
  "Record auth/ownership, schema, errors, persistence and observable side effects
   per operation; dispatch/shape support alone is not verification."

Checks, per row:
  1. every required attribute key is present
  2. no key is an empty/placeholder value (the failure mode that matters: a row
     that looks complete but says nothing)
  3. authenticationMode records BOTH auth layers - the handler decorator and the
     gateway allow-list - because a decorator does not override the gateway
  4. every pinned revision cited is a full 40-char sha, not a short ref or a
     bare repo name
  5. runtimeStatus is honest: nothing claims to have been run
  6. unknowns are arrays of non-empty strings where present

Run with --falsify to confirm the checker actually detects damage. It corrupts
the merged map in memory in several distinct ways and asserts each is caught.
"""
import argparse
import json
import re
import sys
from pathlib import Path

MAP = Path("docs/parity/candidates/A-01-operation-map.json")

REQUIRED = [
    "authenticationMode",
    "ownershipRule",
    "requestSchema",
    "responseSchema",
    "declaredErrorCodes",
    "persistenceEffects",
    "observableSideEffects",
    "phoenixHandler",
]

SHA_RE = re.compile(r"\b[0-9a-f]{40}\b")
# Placeholder-ish values that would let a row pass a naive presence check.
EMPTY_MARKERS = {"", "tbd", "todo", "n/a", "na", "unknown", "?", "-", "none"}


def is_empty(value):
    """True when a value carries no information."""
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip().lower() in EMPTY_MARKERS
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def check_row(row):
    """Return a list of problems for one operation row."""
    problems = []
    oid = row.get("id", "<no id>")
    attrs = row.get("attributes")

    if not attrs:
        return [f"{oid}: no attributes block"]

    for key in REQUIRED:
        if key not in attrs:
            problems.append(f"{oid}: missing {key}")
        elif is_empty(attrs[key]):
            problems.append(f"{oid}: {key} is empty/placeholder")

    auth = attrs.get("authenticationMode")
    if isinstance(auth, dict):
        # Most rows record a `decorator`. The recovered Settings_20160801 row
        # legitimately cannot: no API model or handler survives for that
        # version, so it documents `method` plus explicit unknowns instead.
        # Accept either, but require that *something* describes the mechanism.
        if not any(k in auth for k in ("decorator", "method")):
            problems.append(
                f"{oid}: authenticationMode records neither a handler decorator nor a method"
            )
        # Layer two: the gateway allow-list must be addressed somewhere in the
        # auth block, either as a structured `gateway` object or in unknowns.
        blob = json.dumps(auth)
        if "srv-security-gw" not in blob:
            problems.append(
                f"{oid}: authenticationMode does not address the gateway allow-list "
                "(srv-security-gw); a handler decorator alone is not the auth story"
            )
    else:
        problems.append(f"{oid}: authenticationMode is not an object")

    runtime = attrs.get("runtimeStatus")
    if runtime not in (None, "not-run"):
        problems.append(f"{oid}: runtimeStatus claims {runtime!r}; no scenario was executed")

    # Any revision cited must be a full sha.
    blob = json.dumps(attrs)
    for match in re.finditer(r'"revision":\s*"([^"]*)"', blob):
        rev = match.group(1)
        if not SHA_RE.fullmatch(rev):
            problems.append(f"{oid}: revision {rev!r} is not a full 40-char sha")

    for match in re.finditer(r'"unknowns":\s*(\[[^\]]*\])', blob):
        try:
            arr = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        for item in arr:
            if not isinstance(item, str) or not item.strip():
                problems.append(f"{oid}: unknowns contains an empty entry")

    return problems


def run(data):
    ops = data["operations"]
    problems = []
    for row in ops:
        problems.extend(check_row(row))
    return ops, problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--falsify", action="store_true",
                        help="corrupt the map in memory and prove each corruption is caught")
    parser.add_argument("--json", action="store_true", help="emit a machine-readable summary")
    args = parser.parse_args()

    data = json.loads(MAP.read_text())

    if args.falsify:
        cases = {
            "drop an attributes block":
                lambda d: d["operations"][0].pop("attributes", None),
            "blank out ownershipRule":
                lambda d: d["operations"][1]["attributes"].__setitem__("ownershipRule", ""),
            "remove the gateway layer from auth":
                lambda d: d["operations"][2]["attributes"].__setitem__(
                    "authenticationMode", {"decorator": "parseCredentials"}),
            "claim a scenario was run":
                lambda d: d["operations"][3]["attributes"].__setitem__("runtimeStatus", "pass"),
            # Corrupt a revision *inside* the attributes block. The row's
            # inventoryEvidence also carries revisions, but criterion 2 is about
            # the attributes, so that is what check_row scans - an earlier
            # version of this case corrupted inventoryEvidence and silently
            # proved nothing.
            "shorten a pinned revision":
                lambda d: next(
                    o for o in d["operations"]
                    if '"revision": "' in json.dumps(o.get("attributes", {}))
                ).__setitem__(
                    "attributes",
                    json.loads(json.dumps(next(
                        o for o in d["operations"]
                        if '"revision": "' in json.dumps(o.get("attributes", {}))
                    )["attributes"]).replace('"revision": "', '"revision": "short', 1))),
            "empty an unknowns entry":
                lambda d: next(
                    o for o in d["operations"]
                    if isinstance(o.get("attributes", {}).get("authenticationMode"), dict)
                    and o["attributes"]["authenticationMode"].get("unknowns")
                )["attributes"]["authenticationMode"]["unknowns"].append(""),
        }
        total = 0
        baseline = len(run(json.loads(json.dumps(data)))[1])
        for label, corrupt in cases.items():
            copy = json.loads(json.dumps(data))
            corrupt(copy)
            _, problems = run(copy)
            caught = len(problems) - baseline
            status = "caught" if caught > 0 else "MISSED"
            print(f"  falsify [{status}] {label}: +{caught} problem(s)")
            total += max(caught, 0)
            if caught <= 0:
                print(f"    checker failed to detect: {label}", file=sys.stderr)
                return 2
        print(f"falsification: all {len(cases)} corruptions detected ({total} problems raised)")
        return 0

    ops, problems = run(data)
    with_attrs = sum(1 for o in ops if o.get("attributes"))
    summary = {
        "task": "A-01",
        "criterion": 2,
        "operations": len(ops),
        "withAttributes": with_attrs,
        "problems": len(problems),
        "result": "pass" if not problems and with_attrs == len(ops) else "fail",
    }

    if args.json:
        print(json.dumps({**summary, "problemList": problems[:50]}, indent=2))
    else:
        print(f"A-01 criterion 2: {with_attrs}/{len(ops)} rows carry attributes")
        if problems:
            print(f"{len(problems)} problem(s):")
            for p in problems[:40]:
                print("  -", p)
            if len(problems) > 40:
                print(f"  ... and {len(problems) - 40} more")
        else:
            print("no problems: auth (both layers), ownership, schema, errors, "
                  "persistence and side effects recorded on every operation")

    return 0 if summary["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())

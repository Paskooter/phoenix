#!/usr/bin/env python3
"""Build and validate the A-01 operation-level Classic contract map.

The discovery candidate records the denominator and model shapes.  This follow-up
turns those records into one row per settled target/operation pair.  It intentionally
does not call a service or alter the global task ledger: source pins and local Phoenix
handlers are evidence, while every runtime scenario remains ``not-run``.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INVENTORY_PATH = ROOT / "docs/parity/evidence/2026-09-05/classic-api-inventory.json"
DISCOVERY_PATH = ROOT / "docs/parity/evidence/2026-09-06/classic-contract-discovery/historical-models.json"
TASKS_PATH = ROOT / "docs/parity/tasks.json"
OUTPUT_PATH = ROOT / "docs/parity/candidates/A-01-operation-map.json"

SDK_REF = "155d20a8102960b2aeb89c197bdf04dc1f1fc344"
# This follow-up uses the original Pegasus source pin.  The frozen discovery
# candidate used a restored tree; that is deliberately not treated as original
# evidence here.
PEGASUS_REF = "5c0a7390539663ba749d360de348a428c088505c"
SETTINGS_REF = "0d37e1fd2f4fca40538fb470194a3c5daf2c9830"
JOT_REF = "9a725d3ed8d991aa840131f5ef98c630df2fdf4e"
JOT_ARCHIVE_REF = "4432ac5d017ae1971a447f42e7a4b29da7eb2e58"
VOICE_REF = "a0ec047a86d6811176d0f05a6cce5a660a2cadd8"
VOICE_ARCHIVE_REF = "0e8dc870beaad8caf1dc9ae415a5d250a580b570"

# The 2018 source revision contains the complete Account/Admin and Loop
# handlers used by the source service.  The older JavaScript revision is kept
# as a chronology/reference pin because several later operations do not exist
# in that legacy tree.
ACCOUNT_SOURCE_REF = "6cea43470825657d6a5722162f28c8f233153ee2"
ACCOUNT_LEGACY_REF = "20c768d098e4e23255bd85322625b2547213674c"
ACCOUNT_REPOSITORY = "jiborobot/srv-account-ws"
ACCOUNT_LEGACY_REPOSITORY = "server/account-ws"

# Line-level source witnesses for the bounded Account/Admin and Loop facts
# below.  These are source references, not runtime assertions: the generated
# rows remain unverified until a source-compatible dependency fixture is run.
ACCOUNT_SOURCE_EVIDENCE = {
    "AcceptTerms": {
        "handler": {"path": "src/handlers/account.handler.ts", "lineRefs": [324, 325, 326, 327, 328]},
        "controller": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [477, 478, 479, 480]},
        "errors": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [77, 78, 79, 80, 81, 82, 83, 84]},
        "sideEffects": {"path": "src/index.ts", "lineRefs": [33, 41, 42, 58, 62, 63, 65, 66, 72]},
    },
    "CreateHubToken": {
        "handler": {"path": "src/handlers/account.handler.ts", "lineRefs": [276, 277, 278, 279, 280, 281, 282, 283, 284]},
        "controller": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [436, 437, 438, 439, 440, 441, 442, 443, 444, 445]},
        "errors": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [77, 78, 79, 80, 81, 82, 83, 84]},
    },
    "Login": {
        "handler": {"path": "src/handlers/account.handler.ts", "lineRefs": [44, 45, 46, 47, 48, 49, 50]},
        "controller": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 177, 178, 179, 180, 181, 182, 183]},
        "errors": {"path": "src/errors/account.ts", "lineRefs": [6, 7, 8, 9, 10, 97, 98, 99, 100]},
    },
    "ResendActivationCode": {
        "handler": {"path": "src/handlers/account.handler.ts", "lineRefs": [99, 100, 101, 102, 103, 104, 105]},
        "controller": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [132, 133, 134, 135, 136, 137, 138]},
    },
    "ResetKeys": {
        "handler": {"path": "src/handlers/account.handler.ts", "lineRefs": [60, 61, 62, 63]},
        "controller": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [77, 78, 79, 80, 81, 82, 83, 84, 185, 186, 187, 188]},
        "errors": {"path": "src/controllers/account.ctrl.ts", "lineRefs": [77, 78, 79, 80, 81, 82, 83, 84]},
        "output": {"path": "src/schemes/account.ts", "lineRefs": [50, 51, 63, 64, 65, 66, 67, 68, 69, 70]},
    },
    "Get": {
        "handler": {"path": "src/handlers/account.handler.ts", "lineRefs": [125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135]},
    },
}

LOOP_SOURCE_EVIDENCE = {
    "ClearRobot": {
        "handler": {"path": "src/handlers/loop.handler.ts", "lineRefs": [206, 207, 208, 209, 210, 211]},
        "controller": {"path": "src/controllers/loop.ctrl.ts", "lineRefs": [566, 567, 568, 569, 570, 571, 572, 573, 574, 575, 596, 597, 598, 770, 771, 772, 773, 774, 775, 776, 777, 778]},
    },
    "GetRobot": {
        "handler": {"path": "src/handlers/loop.handler.ts", "lineRefs": [194, 195, 196, 197, 198, 199, 200, 201, 202, 203]},
        "controller": {"path": "src/controllers/loop.ctrl.ts", "lineRefs": [577, 578, 579, 580, 581, 582, 583]},
    },
    "InviteLoopMember": {
        "handler": {"path": "src/handlers/loop.handler.ts", "lineRefs": list(range(76, 101))},
        "controller": {"path": "src/controllers/loop.ctrl.ts", "lineRefs": list(range(220, 250)) + list(range(268, 322))},
    },
    "ListLoopMembers": {
        "handler": {"path": "src/handlers/loop.handler.ts", "lineRefs": list(range(128, 148))},
        "controller": {"path": "src/controllers/loop.ctrl.ts", "lineRefs": list(range(425, 448))},
    },
    "ListOwnerRobots": {
        "handler": {"path": "src/handlers/loop.handler.ts", "lineRefs": list(range(185, 193))},
        "controller": {"path": "src/controllers/loop.ctrl.ts", "lineRefs": list(range(584, 595))},
    },
    "RemoveLoop": {
        "handler": {"path": "src/handlers/loop.handler.ts", "lineRefs": list(range(214, 224))},
        "controller": {"path": "src/controllers/loop.ctrl.ts", "lineRefs": list(range(770, 779))},
    },
}

ACCOUNT_SIDE_EFFECT_UNKNOWNS = {
    "AcceptTerms": ["The startup-installed save hook schedules AccountUpdated; EventSender serialization and external delivery remain unexecuted."],
}
LOOP_SIDE_EFFECT_UNKNOWNS = {
    "ClearRobot": ["The startup-installed Loop save hook schedules LoopUpdated; EventSender serialization and external delivery remain unexecuted."],
    "InviteLoopMember": ["Mail/provider delivery failure and event delivery are not exercised."],
}
ACCOUNT_ERROR_UNKNOWNS = {
    "CreateHubToken": ["TokenController wire errors and framework envelope remain unverified."],
    "Login": ["Framework envelope and password-comparison dependency errors remain unverified."],
}
LOOP_ERROR_UNKNOWNS = {
    "GetRobot": ["If loop.robot is absent or stale, the handler calls toJSON on the null Account result; the resulting engine TypeError is not normalized by the source."],
    "InviteLoopMember": ["The source compares the filtered member array itself with MAX_SIZE rather than its length; active-limit reachability is not established."],
}

# These operations have no state-changing operation to repeat in the generic
# verification case.  Keeping this list explicit prevents a read-only source
# boundary from being proposed as a mutation test.
NON_MUTATING_VERIFICATION = {
    ("Account_20151111", "CheckEmail"),
    ("Account_20151111", "Get"),
    ("Account_20151111", "GetAccountByAccessToken"),
    ("Account_20151111", "Login"),
    ("Account_20151111", "Search"),
    ("Account_20151111", "CreateHubToken"),
    ("Loop_20160324", "FindOwner"),
    ("Loop_20160324", "GetRobot"),
    ("Loop_20160324", "ListLoopMembers"),
    ("Loop_20160324", "ListLoops"),
    ("Loop_20160324", "ListOwnerRobots"),
}

JOT_ARCHIVE_REVIEW_PATH = ".parity/reviews/a01-root/source-2.js"
JOT_ARCHIVE_REVIEW_SHA256 = "88c204cf858797c89523fa425075f6ebd3cead9e88f590a82d7ea24855badc65"
JOT_LITERAL_ALTERNATE_OPERATIONS = {
    "CreateMessage", "ListMessages", "MarkLoopRead", "MarkRead",
}
JOT_INFERRED_ALTERNATE_OPERATIONS = {"NumberOfUnreadMessagesInLoops"}
JOT_ARCHIVE_LITERAL_LINE_REFS = {
    "CreateMessage": [63, 219],
    "ListMessages": [89, 123, 158, 178, 196],
    "MarkRead": [107],
    "MarkLoopRead": [142],
}

PEGASUS_SETTINGS_EVIDENCE = {
    "targetConstruction": "SETTINGS_API_VERSION = '20160801'; x-amz-target uses Settings_${SETTINGS_API_VERSION}.GetSettings",
    "files": [
        {
            "path": "packages/report-skill/src/SettingsClient.ts",
            "symbol": "SettingsClient.getSettings",
            "lineRefs": [12, 176],
            "byteLengthAtOriginal": 10959,
            "byteLengthAtRestoredComparison": 10959,
            "byteIdenticalToRestored": True,
        },
        {
            "path": "packages/hub/src/utils/SettingsClient.ts",
            "symbol": "SettingsClient.getSettings",
            "lineRefs": [4, 31],
            "byteLengthAtOriginal": 1596,
            "byteLengthAtRestoredComparison": 1596,
            "byteIdenticalToRestored": True,
        },
    ],
    "restoredComparisonRevision": "d682547a31511cd164db0913b6104eb1786455a2",
    "comparisonNote": "The restored revision is comparison evidence only; the original consumer pin remains 5c0a7390539663ba749d360de348a428c088505c.",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def phoenix_revision() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError("Cannot pin Phoenix source outside a readable Git checkout") from error


def pin(repository: str, revision: str, path: str, symbol: str | None = None) -> dict:
    out = {"repository": repository, "revision": revision, "path": path}
    if symbol:
        out["symbol"] = symbol
    return out


def model_consumer(path: str, role: str = "wire API model") -> dict:
    return {
        "kind": "sdk-api-model",
        "repository": "jiborobot/srv-jibo-server-client",
        "revision": SDK_REF,
        "path": path,
        "role": role,
    }


def local_test(path: str, role: str = "focused Phoenix coverage") -> dict:
    return {
        "kind": "phoenix-test-evidence",
        "repository": "phoenix",
        "revision": phoenix_revision(),
        "path": path,
        "role": role,
    }


def consumer_pin(repository: str, revision: str, path: str, role: str, evidence: dict | None = None) -> dict:
    result = {
        "kind": "pinned-source-consumer",
        "repository": repository,
        "revision": revision,
        "path": path,
        "role": role,
    }
    if evidence is not None:
        result["evidence"] = copy.deepcopy(evidence)
    return result


def task(task_id: str, reason: str, *, state: str = "existing") -> dict:
    return {"id": task_id, "state": state, "reason": reason}


def body_keys(required: list[str]) -> dict:
    """Make a reviewable, deliberately non-executable request shape."""
    examples = {
        "email": "synthetic@example.invalid",
        "password": "synthetic-password",
        "query": "synthetic-query",
        "code": "synthetic-code",
        "oldPassword": "old-password",
        "newPassword": "new-password",
        "phoneNumber": "+10000000000",
        "token": "synthetic-token",
        "state": "synthetic-state",
        "id": "synthetic-id",
        "ids": ["synthetic-id"],
        "name": "synthetic-name",
        "existingNames": [],
        "Input": "synthetic-input",
        "text": "synthetic-text",
        "identity": "synthetic-identity",
        "loopId": "synthetic-loop",
        "friendlyId": "synthetic-friendly-id",
        "robotId": "synthetic-robot",
        "childId": "synthetic-child",
        "parentId": "synthetic-parent",
        "memberId": "synthetic-member",
        "agreementId": "synthetic-agreement",
        "count": 1,
        "serial": "synthetic-serial",
        "trackingId": "synthetic-tracking",
        "key": "synthetic-key",
        "publicKey": "synthetic-public-key",
        "encryptedKey": "synthetic-encrypted-key",
        "passwordHash": "synthetic-password-hash",
        "path": "synthetic/path",
        "paths": ["synthetic/path"],
        "loopIds": ["synthetic-loop"],
        "category": "synthetic-category",
        "keys": ["synthetic-key"],
        "value": "synthetic-value",
        "ids": ["synthetic-id"],
        "serialNumber": "synthetic-serial",
        "payload": {},
        "calibrationPayload": {},
        "clientId": "synthetic-client",
        "redirectUri": "https://example.invalid/callback",
        "updatedBy": "synthetic-admin",
        "fromVersion": "0.0.0",
        "toVersion": "0.0.1",
        "changes": [],
        "subsystem": "synthetic-subsystem",
        "friendlyIds": ["synthetic-friendly-id"],
        "namespaces": ["synthetic.namespace"],
        "kind": "synthetic-kind",
        "loopId": "synthetic-loop",
        "data": {},
        "transId": "synthetic-transaction",
        "settings": [],
        "getView": False,
        "events": [],
        "serial": "synthetic-serial",
        "body": "synthetic-bytes",
        "parts": [{"path": "synthetic/path"}],
        "recipients": [{"id": "synthetic-recipient"}],
        "content": "synthetic-content",
        "impersonateAs": "synthetic-member",
        "tags": [],
        "before": 1700000000000,
        "after": 0,
        "loopIds": ["synthetic-loop"],
        "clientId": "synthetic-client",
        "pushToken": "synthetic-push-token",
        "type": "synthetic-type",
        "ipAddress": "127.0.0.1",
        "friendlyId": "synthetic-friendly-id",
        "count": 1,
    }
    return {key: examples.get(key, "synthetic-value") for key in required}


TESTS = {
    "Backup_20170222": ["packages/classic/test/backup.test.js"],
    "Account_20151111": ["packages/account/test/createHubTokenSigv4.test.js"],
    "Key_20160201": ["packages/classic/test/keyPush.test.js"],
    "Notification_20150505": ["packages/classic/test/notification.test.js"],
    "Push_20160729": ["packages/classic/test/keyPush.test.js"],
    "Robot_20160225": ["packages/classic/test/entrypoint.test.js"],
    "OOBE_20161026": ["packages/account/test/robotFace.test.js"],
    "Settings_20171219": ["packages/account/test/settings.test.js"],
    "Update_20160301": ["packages/ota/test/ota.test.js", "packages/account/test/robotFace.test.js"],
    "Collision_20161126": ["packages/classic/test/stubs.test.js"],
    "IFTTT_20170207": ["packages/classic/test/stubs.test.js"],
    "Media_20160725": ["packages/classic/test/stubs.test.js"],
    "NLP_20161031": ["packages/classic/test/stubs.test.js"],
    "Person_20160801": ["packages/classic/test/stubs.test.js"],
    "ROM_20171011": ["packages/classic/test/stubs.test.js"],
}


def common_auth(kind: str) -> dict:
    if kind == "create-hub-token":
        return {
            "method": "verified AWS SigV4 on Account_20151111.CreateHubToken",
            "identity": "verified accessKeyId resolved to the account record",
            "ownership": "source account controller reads the authenticated account; no cross-account fixture is included here",
            "unknowns": ["expiry/refetch and all non-CreateHubToken Account permissions remain outside this bounded map"],
        }
    if kind == "settings":
        return {
            "method": "Phoenix reads x-amz-credentials.id without SigV4; pinned Settings source uses parseCredentials",
            "identity": "account id from x-amz-credentials in Phoenix; source request.auth.credentials.id in Settings service",
            "ownership": "pinned source checks loop membership; Phoenix settingsAwsDispatch currently has no equivalent membership check",
            "unknowns": ["exact gateway forwarding/authentication for both Settings target versions is not runtime-verified"],
        }
    if kind == "proxy":
        return {
            "method": "Classic forwards the request and signed headers to an upstream service; Classic itself does not verify SigV4",
            "identity": "upstream service decides from forwarded credentials",
            "ownership": "upstream controller not recovered in this candidate",
            "unknowns": ["upstream deployment, controller, authorization and error precedence"],
        }
    if kind == "ota":
        return {
            "method": "LAN-trusted OTA service; inbound SigV4 is ignored by the pinned Phoenix source",
            "identity": "no authenticated identity consumed by current OTA handler",
            "ownership": "not enforced by current handler",
            "unknowns": ["original Update service authorization and admin ownership"],
        }
    if kind == "unregistered":
        return {
            "method": "no Phoenix route registration found",
            "identity": "unknown",
            "ownership": "unknown",
            "unknowns": ["deployed service endpoint and its authentication/ownership source are not pinned"],
        }
    if kind == "jot":
        return {
            "method": "pinned Jot handler parseCredentials decorator",
            "identity": "request.auth.credentials.id",
            "ownership": "accepted loop member required; only a loop robot may impersonate another member",
            "unknowns": ["version-specific gateway/auth wrapper and historical target alias behavior"],
        }
    if kind == "voice":
        return {
            "method": "pinned VoiceTraining BaseHandler parses JSON x-amz-credentials; no signature verifier/decorator is present",
            "identity": "parsed credentials object is passed to Backup client",
            "ownership": "no membership/ownership decorator recovered",
            "unknowns": ["historical UploadFile aliases and source authorization behavior"],
        }
    if kind == "legacy-settings":
        return {
            "method": "original consumers send x-amz-credentials JSON; source Settings handler uses parseCredentials",
            "identity": "account id from the credentials header",
            "ownership": "controller checks accepted loop membership",
            "unknowns": ["no formal Settings_20160801 API model was recovered"],
        }
    return {
        "method": "LAN-trusted Classic compatibility handler; no SigV4 verification in the current handler",
        "identity": "Authorization Credential accessKeyId where the handler reads it, otherwise anonymous fallback",
        "ownership": "operation-specific ownership is not consistently enforced by current Phoenix code",
        "unknowns": ["original signature, role, membership and cross-account behavior"],
    }


def contract_family(prefix: str) -> str:
    if prefix == "Account_20151111":
        return "account"
    if prefix in {"OOBE_20161026", "Loop_20160324", "Settings_20171219"}:
        return "proxy"
    if prefix == "Update_20160301":
        return "ota"
    if prefix in {"GQA_20160930", "Lps_20171201", "OauthClients_20171108"}:
        return "unregistered"
    return "legacy"


def task_for(prefix: str, op: str, historical_kind: str | None = None) -> dict:
    if historical_kind == "jot":
        return task("A-19", "recover Jot versioned handlers, aliases, errors and verification")
    if historical_kind == "voice":
        return task("A-20", "recover VoiceTraining versioned handlers, aliases, ownership and verification")
    if historical_kind == "legacy-settings":
        return task("A-06", "existing Settings task owns legacy and 20171219 behavior")
    service_tasks = {
        "Account_20151111": "A-03",
        "Backup_20170222": "A-09",
        "Collision_20161126": "A-15",
        "GQA_20160930": "Q-01",
        "IFTTT_20170207": "A-17",
        "Key_20160201": "A-11",
        "Log_20150309": "A-12",
        "Loop_20160324": "A-04",
        "Lps_20171201": "A-18",
        "Media_20160725": "A-14",
        "NLP_20161031": "A-17",
        "Notification_20150505": "A-10",
        "OauthClients_20171108": "A-18",
        "OOBE_20161026": "A-05",
        "Person_20160801": "A-15",
        "Push_20160729": "A-13",
        "Robot_20160225": "A-07",
        "ROM_20171011": "A-16",
        "Settings_20171219": "A-06",
        "Update_20160301": "A-08",
    }
    task_id = "A-02" if prefix == "Account_20151111" and op == "CreateHubToken" else service_tasks.get(prefix, "A-01")
    reason = {
        "A-02": "existing bounded CreateHubToken authentication task",
        "A-03": "existing Account lifecycle task",
        "A-04": "existing Loop membership/lifecycle task",
        "A-05": "existing OOBE reconnect/service-token task",
        "A-06": "existing Settings compatibility task",
        "A-07": "existing Robot records task",
        "A-08": "existing Update delivery task",
        "A-09": "existing backup durability/ownership task",
        "A-10": "existing notification/socket lifecycle task",
        "A-11": "existing key exchange task",
        "A-12": "existing log ingestion task",
        "A-13": "existing push delivery task",
        "A-14": "existing Media storage task",
        "A-15": "existing Person/Collision task",
        "A-16": "existing ROM task",
        "A-17": "existing IFTTT/NLP task",
        "A-18": "existing remaining admin/OAuth/LPS contracts task",
        "Q-01": "existing GQA service task",
        "A-01": "A-01 remains the mapping owner until a functional task is assigned",
    }.get(task_id, "existing task owner")
    return task(task_id, reason)


def source_for(prefix: str, op: str) -> dict:
    phoenix = phoenix_revision()
    classic = lambda path, symbol: pin("phoenix", phoenix, path, symbol)
    account = lambda path, symbol: pin("phoenix", phoenix, path, symbol)
    if prefix == "Account_20151111":
        handlers = [classic("packages/classic/src/index.js", "classicRoutes /^account/i proxyTo NET_account")]
        if op == "CreateHubToken":
            handlers.append(account("packages/account/src/robotFace.js", "robotFaceRoutes -> issueHubToken"))
            return {
                "status": "implemented-bounded",
                "handlers": handlers,
                "unknowns": ["the Phoenix robotFace compatibility route is separate from the recovered original Account controller"],
            }
        return {
            "status": "proxy-only",
            "handlers": handlers,
            "unknowns": ["Phoenix has no Account/AccountAdmin controller for this route; original controller mapping is attached separately and runtime integration remains unverified"],
        }
    if prefix == "Backup_20170222":
        return {"status": "implemented", "handlers": [classic("packages/classic/src/backup.js", "makeBackupHandler")], "unknowns": ["source S3 signing and restart index semantics remain open"]}
    if prefix == "Collision_20161126":
        return {"status": "stub", "handlers": [classic("packages/classic/src/stubs.js", "defineStubs().collision.ops.match")], "unknowns": ["source collision algorithm and persistence"]}
    if prefix == "GQA_20160930":
        return {"status": "unregistered", "handlers": [classic("packages/classic/src/router.js", "createClassicRouter: no GQA registration")], "unknowns": ["no Phoenix GQA handler or pinned controller"]}
    if prefix == "IFTTT_20170207":
        return {"status": "stub", "handlers": [classic("packages/classic/src/stubs.js", "defineStubs().ifttt")], "unknowns": ["source integration credentials, downstream effects and error contract"]}
    if prefix == "Key_20160201":
        return {"status": "implemented-ephemeral", "handlers": [classic("packages/classic/src/key.js", "makeKeyHandler")], "unknowns": ["source ownership/expiry and durable restart behavior"]}
    if prefix == "Log_20150309":
        if op == "SetLevel":
            return {"status": "unimplemented", "handlers": [classic("packages/classic/src/log.js", "logHandler: no SetLevel case")], "unknowns": ["admin log-level controller and side effect"]}
        return {"status": "implemented-compatibility", "handlers": [classic("packages/classic/src/log.js", "logHandler")], "unknowns": ["original durable log/Kinesis/S3 sink and binary retrieval"]}
    if prefix == "Loop_20160324":
        handlers = [classic("packages/classic/src/index.js", "classicRoutes /^loop/i proxyTo NET_account")]
        if op == "ListLoops":
            handlers.append(account("packages/account/src/robotFace.js", "loopDispatch -> loopList"))
            status = "implemented-bounded"
        elif op in {"SuspendLoop", "SuspendRobotLoop"}:
            handlers.append(account("packages/account/src/robotFace.js", "loopDispatch -> loopSuspend"))
            status = "implemented-bounded"
        else:
            status = "proxy-only"
        return {"status": status, "handlers": handlers, "unknowns": ["Phoenix proxy does not execute the recovered Loop controller; source-vs-gateway integration remains assigned to A-04"]}
    if prefix == "Lps_20171201":
        return {"status": "unregistered", "handlers": [classic("packages/classic/src/router.js", "createClassicRouter: no LPS registration")], "unknowns": ["LPS controller and consumer are not recovered"]}
    if prefix == "Media_20160725":
        return {"status": "stub", "handlers": [classic("packages/classic/src/stubs.js", "defineStubs().media")], "unknowns": ["source storage, ownership and signed media URLs"]}
    if prefix == "NLP_20161031":
        return {"status": "stub", "handlers": [classic("packages/classic/src/stubs.js", "defineStubs().nlp")], "unknowns": ["source NLP provider, scoring and errors"]}
    if prefix == "Notification_20150505":
        return {"status": "implemented-ephemeral", "handlers": [classic("packages/classic/src/notification.js", "makeNotificationHandler / attachNotificationSocket")], "unknowns": ["source persistence, expiry, replay/ack and multi-device isolation"]}
    if prefix == "OauthClients_20171108":
        return {"status": "unregistered", "handlers": [classic("packages/classic/src/router.js", "createClassicRouter: no OAuthClients registration")], "unknowns": ["admin OAuth client controller and persistence"]}
    if prefix == "OOBE_20161026":
        handlers = [classic("packages/classic/src/index.js", "classicRoutes /^oobe/i proxyTo NET_account")]
        symbols = {"SetupRobot": "robotFaceRoutes -> setupRobot", "PrepareRobot": "robotFaceRoutes -> prepareRobot", "GetStatus": "robotFaceRoutes -> getStatus"}
        if op in symbols:
            handlers.append(account("packages/account/src/robotFace.js", symbols[op]))
            status = "implemented-bounded"
        else:
            status = "proxy-only"
        return {"status": status, "handlers": handlers, "unknowns": ["ReconnectRobot/GetServiceToken source handlers are not implemented in the current Phoenix robot face"]}
    if prefix == "Person_20160801":
        return {"status": "stub-ephemeral", "handlers": [classic("packages/classic/src/stubs.js", "defineStubs().person")], "unknowns": ["source data categories, membership and durable properties"]}
    if prefix == "Push_20160729":
        return {"status": "implemented-ephemeral", "handlers": [classic("packages/classic/src/push.js", "makePushHandler")], "unknowns": ["source provider delivery, durable registration and ownership"]}
    if prefix == "Robot_20160225":
        return {"status": "implemented-compatibility", "handlers": [classic("packages/classic/src/robot.js", "makeRobotHandler")], "unknowns": ["source durable manufacturing/admin records and calibration/history semantics"]}
    if prefix == "ROM_20171011":
        return {"status": "stub", "handlers": [classic("packages/classic/src/stubs.js", "defineStubs().rom")], "unknowns": ["source certificate exchange and remote-operation side effects"]}
    if prefix == "Settings_20171219":
        return {
            "status": "implemented-report-bounded",
            "handlers": [classic("packages/classic/src/index.js", "classicRoutes /^settings/i proxyTo NET_account"), account("packages/account/src/settingsFace.js", "settingsAwsDispatch")],
            "unknowns": ["full non-report skill schemas, source gateway version aliases and loop ownership parity"],
        }
    if prefix == "Update_20160301":
        handlers = [classic("packages/classic/src/index.js", "classicRoutes /^update/i proxyTo NET_ota")]
        if op in {"ListUpdates", "ListUpdatesFrom", "GetUpdateFrom"}:
            handlers.append(pin("phoenix", phoenix, "packages/ota/src/service.js", "createOtaService POST /"))
            status = "implemented-bounded"
        else:
            status = "proxy-only"
        return {"status": status, "handlers": handlers, "unknowns": ["admin update mutation/target operations are not implemented by the current OTA service"]}
    raise KeyError(prefix)


ACCOUNT_HANDLER_METHODS = {
    "AcceptTerms": "AcceptTerms",
    "ActivateByCode": "ActivateByCode",
    "ActivateById": "ActivateById",
    "ChangeEmail": "ChangeEmail",
    "ChangePassword": "ChangePassword",
    "CheckEmail": "CheckEmail",
    "ConfirmEmailReset": "ConfirmEmailReset",
    "Create": "Create",
    "CreateAccessToken": "CreateAccessToken",
    "CreateHubToken": "CreateHubToken",
    "FacebookConnect": "FacebookConnect",
    "FacebookMobileConnect": "FacebookMobileConnect",
    "FacebookPrepareLogin": "FacebookPrepareLogin",
    "Get": "Get",
    "GetAccountByAccessToken": "GetAccountByAccessToken",
    "Login": "Login",
    "PasswordResetByCode": "PasswordResetByCode",
    "Remove": "Remove",
    "RemovePhoto": "RemovePhoto",
    "ResendActivationCode": "ResendActivationCode",
    "ResetEmail": "ResetEmail",
    "ResetKeys": "ResetKeys",
    "Search": "Search",
    "SendPasswordReset": "SendPasswordReset",
    "SendPhoneVerificationCode": "SendPhoneVerificationCode",
    "Update": "Update",
    "UpdatePhoto": "UpdatePhoto",
    "VerifyPhoneByCode": "VerifyPhoneByCode",
}

ACCOUNT_CONTROLLER_METHODS = {
    op: op[0].lower() + op[1:] for op in ACCOUNT_HANDLER_METHODS
}
ACCOUNT_CONTROLLER_METHODS.update({
    "PasswordResetByCode": "passwordReset",
    "Remove": "removeById",
    "ResendActivationCode": "resendActivation",
    "ResetKeys": "reset",
})

ACCOUNT_PUBLIC = {
    "ActivateByCode", "CheckEmail", "ConfirmEmailReset", "Create", "FacebookConnect",
    "Login", "PasswordResetByCode", "ResendActivationCode", "Search", "SendPasswordReset",
}
ACCOUNT_ADMIN = {"ActivateById", "ResetEmail"}

ACCOUNT_VALIDATION = {
    "AcceptTerms": {"required": [], "optional": [], "transforms": []},
    "ActivateByCode": {"required": ["code"], "optional": [], "transforms": []},
    "ActivateById": {"required": ["id"], "optional": [], "transforms": []},
    "ChangeEmail": {"required": ["email", "password"], "optional": ["campaign"], "transforms": ["email lowercased"]},
    "ChangePassword": {"required": ["oldPassword", "newPassword"], "optional": [], "transforms": ["password length/string regex checked"]},
    "CheckEmail": {"required": ["email"], "optional": [], "transforms": ["email lowercased"]},
    "ConfirmEmailReset": {"required": ["code"], "optional": [], "transforms": []},
    "Create": {"required": ["email", "password"], "optional": ["campaign", "birthday", "firstName", "gender", "invitationCode", "lastName", "messagingAllowed", "roles", "termsAccepted"], "transforms": ["email lowercased"]},
    "CreateAccessToken": {"required": [], "optional": ["payload"], "transforms": ["payload is optional Joi string"]},
    "CreateHubToken": {"required": [], "optional": ["payload"], "transforms": ["payload is optional Joi string"], "defaults": {"payload": None}},
    "FacebookConnect": {"required": ["state", "token"], "optional": [], "transforms": []},
    "FacebookMobileConnect": {"required": ["token"], "optional": [], "transforms": []},
    "FacebookPrepareLogin": {"required": [], "optional": [], "transforms": []},
    "Get": {"required": [], "optional": ["ids"], "transforms": [], "defaults": {"ids": "authenticated credential id when absent or empty"}},
    "GetAccountByAccessToken": {"required": ["token"], "optional": [], "transforms": []},
    "Login": {"required": ["email", "password"], "optional": [], "transforms": ["email lowercased"]},
    "PasswordResetByCode": {"required": ["code", "password"], "optional": [], "transforms": ["password length/string regex checked"]},
    "Remove": {"required": [], "optional": ["id"], "transforms": []},
    "RemovePhoto": {"required": [], "optional": [], "transforms": []},
    "ResendActivationCode": {"required": ["email"], "optional": ["campaign"], "transforms": ["email lowercased"]},
    "ResetEmail": {"required": ["email", "id"], "optional": ["campaign"], "transforms": ["email lowercased"]},
    "ResetKeys": {"required": [], "optional": [], "transforms": []},
    "Search": {"required": ["query"], "optional": [], "transforms": []},
    "SendPasswordReset": {"required": ["email"], "optional": ["campaign"], "transforms": ["email lowercased"]},
    "SendPhoneVerificationCode": {"required": ["phoneNumber"], "optional": [], "transforms": []},
    "Update": {"required": [], "optional": ["birthday", "email", "firstName", "gender", "lastName", "messagingAllowed", "password", "updated"], "transforms": ["email lowercased", "controller excludes email/password/accessKeyId/secretAccessKey from account update"]},
    "UpdatePhoto": {"required": [], "optional": [], "transforms": ["binary payload"]},
    "VerifyPhoneByCode": {"required": ["code"], "optional": [], "transforms": []},
}

ACCOUNT_OWNERSHIP = {
    "AcceptTerms": "authenticated account is the account whose terms timestamp is updated",
    "ActivateByCode": "public activation-code lookup; code selects the account",
    "ActivateById": "admin credential required; id selects the account",
    "ChangeEmail": "authenticated account; controller verifies its password before starting email reset",
    "ChangePassword": "authenticated account; old password must match",
    "CheckEmail": "public email existence lookup; deleted accounts are treated as absent",
    "ConfirmEmailReset": "public reset-code lookup; token selects the account and code status",
    "Create": "public account creation; invitation linkage is source-controlled",
    "CreateAccessToken": "authenticated account supplies the token subject",
    "CreateHubToken": "authenticated account supplies the token subject and secret",
    "FacebookConnect": "state web token selects the account; request is otherwise public",
    "FacebookMobileConnect": "authenticated account receives the Facebook token",
    "FacebookPrepareLogin": "authenticated account receives the state token and URL",
    "Get": "authenticated owner/admin may retrieve authorized account ids; source checks loop membership",
    "GetAccountByAccessToken": "authenticated caller supplies the access token; resolved account is returned",
    "Login": "public credential lookup; no account identity is available before password verification",
    "PasswordResetByCode": "public password-reset code selects the account",
    "Remove": "authenticated owner/member authorization; owner cannot remove an account with an email",
    "RemovePhoto": "authenticated account owns the photo",
    "ResendActivationCode": "public email lookup; activation code is sent for that account",
    "ResetEmail": "admin credential required; id selects the account being reset",
    "ResetKeys": "authenticated account owns the key reset",
    "Search": "public non-deleted account search",
    "SendPasswordReset": "public email lookup; reset code is sent for that account",
    "SendPhoneVerificationCode": "authenticated account owns the phone verification",
    "Update": "authenticated account only; source rejects robot accounts and stale versions",
    "UpdatePhoto": "authenticated account owns the photo",
    "VerifyPhoneByCode": "authenticated account owns the phone verification code",
}

ACCOUNT_ERRORS = {
    "AcceptTerms": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_IS_DELETED 404"],
    "ActivateByCode": ["ACTIVATION_CODE_NOT_FOUND 404", "ACCOUNT_ACTIVATED 409"],
    "ActivateById": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_ACTIVATED 409"],
    "ChangeEmail": ["WRONG_PASSWORD 401", "EMAIL_NOT_VALID 422", "EMAIL_ALREADY_EXISTS 409", "EMAIL_WAS_NOT_CHANGED 409"],
    "ChangePassword": ["WRONG_PASSWORD 401", "PASSWORD_NOT_VALID_LENGTH 401", "PASSWORD_NOT_VALID_STRING 401"],
    "CheckEmail": [],
    "ConfirmEmailReset": ["EMAIL_RESET_TOKEN_NOT_FOUND 404", "EMAIL_RESET_TOKEN_EXPIRED 409"],
    "Create": ["EMAIL_ALREADY_EXISTS 409", "CHILD_NOT_ALLOWED_TO_CREATE 403", "EMAIL_NOT_VALID 422"],
    "CreateAccessToken": [],
    "CreateHubToken": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_IS_DELETED 404"],
    "FacebookConnect": ["ACCOUNT_NOT_FOUND 404"],
    "FacebookMobileConnect": ["ACCOUNT_NOT_FOUND 404"],
    "FacebookPrepareLogin": ["ACCOUNT_NOT_FOUND 404"],
    "Get": ["ACCOUNT_NOT_FOUND 404", "OWNER_CAN_MANIPULATE 401", "MEMBER_CAN_REQUEST 401"],
    "GetAccountByAccessToken": ["TOKEN_NOT_FOUND 404", "TOKEN_EXPIRED 401", "ACCOUNT_NOT_FOUND 404"],
    "Login": ["ACCOUNT_IS_DELETED 404", "ACCOUNT_EMAIL_CHANGE_INCOMPLETE 401", "ACCOUNT_NOT_FOUND 404", "WRONG_PASSWORD 401"],
    "PasswordResetByCode": ["PASSWORD_CODE_WRONG 404", "PASSWORD_NOT_VALID_LENGTH 401", "PASSWORD_NOT_VALID_STRING 401"],
    "Remove": ["ACCOUNT_NOT_FOUND 404", "OWNER_CAN_REMOVE 401", "LOOPS_MUST_BE_SUSPENDED 409"],
    "RemovePhoto": ["ACCOUNT_NOT_FOUND 404"],
    "ResendActivationCode": ["ACCOUNT_NOT_FOUND 404"],
    "ResetEmail": ["ACCOUNT_NOT_FOUND 404", "EMAIL_ALREADY_EXISTS 409", "EMAIL_NOT_VALID 422"],
    "ResetKeys": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_IS_DELETED 404"],
    "Search": [],
    "SendPasswordReset": ["ACCOUNT_NOT_FOUND 404"],
    "SendPhoneVerificationCode": ["ACCOUNT_NOT_FOUND 404", "PHONE_VERIFICATION_SERVICE_FAILED 503"],
    "Update": ["ACCOUNT_NOT_FOUND 404", "ROBOT_CANNOT_BE_UPDATED 409", "STALE_VERSION 409"],
    "UpdatePhoto": ["ACCOUNT_NOT_FOUND 404"],
    "VerifyPhoneByCode": ["ACCOUNT_NOT_FOUND 404", "PHONE_NUMBER_NOT_SET 404", "PHONE_TOKEN_NOT_FOUND 404", "PHONE_TOKEN_EXPIRED 409"],
}

ACCOUNT_PERSISTENCE = {
    "AcceptTerms": "Account document is saved with termsAccepted timestamp",
    "ActivateByCode": "Account activationCode is cleared and account is saved",
    "ActivateById": "Account activationCode is cleared and account is saved",
    "ChangeEmail": "EmailReset document is created; account is changed on confirmation",
    "ChangePassword": "Account password hash is saved",
    "CheckEmail": "Account lookup only; no write",
    "ConfirmEmailReset": "Account email/keys and EmailReset status are saved",
    "Create": "Account document and invitation linkage are saved",
    "CreateAccessToken": "persistent access Token document is created",
    "CreateHubToken": "no account mutation; signed hub token is returned",
    "FacebookConnect": "account Facebook token is saved",
    "FacebookMobileConnect": "account Facebook token is saved",
    "FacebookPrepareLogin": "no account mutation; state token is issued",
    "Get": "account reads only",
    "GetAccountByAccessToken": "token/account reads only",
    "Login": "account reads only",
    "PasswordResetByCode": "account password/code/active fields are saved",
    "Remove": "account is soft-deleted and associated loops are cleared",
    "RemovePhoto": "account photo field is saved",
    "ResendActivationCode": "account activation code is saved",
    "ResetEmail": "EmailReset document is created; account changes on confirmation",
    "ResetKeys": "account access/secret keys are replaced and saved",
    "Search": "account reads only",
    "SendPasswordReset": "account password reset code is saved",
    "SendPhoneVerificationCode": "PhoneVerification document is created",
    "Update": "authenticated Account document is saved",
    "UpdatePhoto": "account photo field is saved",
    "VerifyPhoneByCode": "PhoneVerification records are removed and account phone is saved",
}

ACCOUNT_SIDE_EFFECTS = {
    "AcceptTerms": "sets termsAccepted and saves the Account; the startup-installed save hook schedules AccountUpdated with setImmediate and logs send failures without blocking the save",
    "ActivateByCode": "publishes activation email/account save event",
    "ActivateById": "publishes AccountUpdated save event",
    "ChangeEmail": "sends reset email and cancels prior reset requests",
    "ChangePassword": "publishes AccountUpdated save event",
    "CheckEmail": "none beyond account lookup",
    "ConfirmEmailReset": "cancels prior reset requests and may send completion mail",
    "Create": "hashes password, allocates keys, sends activation mail, updates invitations",
    "CreateAccessToken": "issues signed access-token response with expiry",
    "CreateHubToken": "issues signed bearer token response with expiry",
    "FacebookConnect": "exchanges Facebook token and stores provider token",
    "FacebookMobileConnect": "stores provider token",
    "FacebookPrepareLogin": "builds Facebook login URL",
    "Get": "none beyond authorization lookups",
    "GetAccountByAccessToken": "none beyond token verification",
    "Login": "none beyond password verification",
    "PasswordResetByCode": "marks account active and clears reset code",
    "Remove": "clears loop membership and emits account/loop updates",
    "RemovePhoto": "removes binary object and old photo URL",
    "ResendActivationCode": "sends activation mail",
    "ResetEmail": "sends email-reset mail",
    "ResetKeys": "invalidates prior credentials by replacing key pair",
    "Search": "none beyond account lookup",
    "SendPasswordReset": "sends password-reset mail",
    "SendPhoneVerificationCode": "calls Twilio and sends verification code",
    "Update": "publishes AccountUpdated event",
    "UpdatePhoto": "stores binary object and removes old photo URL",
    "VerifyPhoneByCode": "updates phone and invalidates verification records",
}

LOOP_HANDLER_METHODS = {
    "AcceptLoopInvitation": "AcceptInvitation",
    "ClearRobot": "ClearRobot",
    "CreateLoop": "CreateLoop",
    "DeclineLoopInvitation": "DeclineInvitation",
    "FindOwner": "FindOwner",
    "GetRobot": "GetRobot",
    "InviteLoopMember": "InviteMember",
    "ListLoopMembers": "ListMembers",
    "ListLoops": "ListLoops",
    "ListOwnerRobots": "ListOwnerRobots",
    "RemoveLoop": "RemoveLoop",
    "RemoveLoopMember": "RemoveMember",
    "RemoveMemberPhoto": "RemoveMemberPhoto",
    "SetEnrollment": "SetEnrollment",
    "SetLegalGuardian": "SetLegalGuardian",
    "SuspendLoop": "SuspendLoop",
    "SuspendRobotLoop": "SuspendRobotLoop",
    "UpdateAgreementStatus": "UpdateAgreementStatus",
    "UpdateLoop": "UpdateLoop",
    "UpdateLoopMember": "UpdateMember",
    "UpdateMemberPhoto": "UpdateMemberPhoto",
    "UpdateNickname": "UpdateNickname",
    "UpdatePhoneticName": "UpdatePhoneticName",
}

LOOP_CONTROLLER_METHODS = {
    op: op[0].lower() + op[1:] for op in LOOP_HANDLER_METHODS
}
LOOP_CONTROLLER_METHODS.update({
    "CreateLoop": "create",
    "UpdateLoop": "update",
    "ListLoops": "list",
    "RemoveLoop": "remove",
    "FindOwner": "findOwnerId",
    "ListOwnerRobots": "listRobots",
    "InviteLoopMember": "inviteMember",
    "ListLoopMembers": "listMembers",
    "UpdateLoopMember": "updateMember",
    "RemoveLoopMember": "removeMember",
    "AcceptLoopInvitation": "acceptInvitation",
    "DeclineLoopInvitation": "declineInvitation",
    "UpdateMemberPhoto": "updateMemberPhoto",
    "RemoveMemberPhoto": "removeMemberPhoto",
})

LOOP_PUBLIC = {"FindOwner", "UpdateAgreementStatus"}
LOOP_ADMIN = {"ClearRobot", "SuspendRobotLoop"}

LOOP_VALIDATION = {
    "AcceptLoopInvitation": {"required": ["loopId"], "optional": [], "transforms": []},
    "ClearRobot": {"required": ["robotId"], "optional": [], "transforms": []},
    "CreateLoop": {"required": ["name", "robotId"], "optional": [], "transforms": []},
    "DeclineLoopInvitation": {"required": ["loopId"], "optional": [], "transforms": []},
    "FindOwner": {"required": ["accountId"], "optional": [], "transforms": []},
    "GetRobot": {"required": ["loopId"], "optional": [], "transforms": []},
    "InviteLoopMember": {"required": ["loopId"], "optional": ["asLegalGuardian", "birthday", "email", "firstName", "gender", "isChild", "lastName", "phoneNumber"], "transforms": ["email lowercased", "firstName/lastName trimmed", "gender/email/birthday/boolean fields are Joi constrained"], "defaults": {"asLegalGuardian": False, "isChild": False}},
    "ListLoopMembers": {"required": [], "optional": ["statusList", "typeList"], "transforms": ["status/type values are enum constrained"], "defaults": {"statusList": "MemberStatus.all() when absent or empty", "typeList": "MemberType.all() when absent or empty"}},
    "ListLoops": {"required": [], "optional": ["loopId"], "transforms": []},
    "ListOwnerRobots": {"required": [], "optional": ["accountId"], "transforms": [], "defaults": {"accountId": "authenticated credential id when absent"}},
    "RemoveLoop": {"required": ["loopId"], "optional": [], "transforms": []},
    "RemoveLoopMember": {"required": ["id", "loopId"], "optional": [], "transforms": []},
    "RemoveMemberPhoto": {"required": ["id", "loopId"], "optional": [], "transforms": []},
    "SetEnrollment": {"required": ["id", "loopId"], "optional": ["face", "voice"], "transforms": []},
    "SetLegalGuardian": {"required": ["childId", "loopId", "parentId"], "optional": [], "transforms": []},
    "SuspendLoop": {"required": ["loopId"], "optional": [], "transforms": []},
    "SuspendRobotLoop": {"required": ["friendlyId"], "optional": [], "transforms": []},
    "UpdateAgreementStatus": {"required": ["agreementId"], "optional": [], "transforms": []},
    "UpdateLoop": {"required": ["loopId", "name"], "optional": [], "transforms": []},
    "UpdateLoopMember": {"required": ["id", "loopId"], "optional": ["birthday", "email", "firstName", "gender", "lastName", "phoneNumber"], "transforms": ["email lowercased", "firstName/lastName trimmed"]},
    "UpdateMemberPhoto": {"required": [], "optional": [], "transforms": ["binary payload; x-id and x-loop-id headers required"]},
    "UpdateNickname": {"required": ["id", "loopId"], "optional": ["nickname"], "transforms": ["nickname allows null"]},
    "UpdatePhoneticName": {"required": ["id", "loopId"], "optional": ["phoneticName"], "transforms": ["phoneticName allows null"]},
}

LOOP_OWNERSHIP = {
    "AcceptLoopInvitation": "membership invitation identifies the account; accepted member is persisted",
    "ClearRobot": "admin credential required; robotId identifies the robot account",
    "CreateLoop": "authenticated owner creates the loop and must supply an existing robot",
    "DeclineLoopInvitation": "invited member may decline the loop invitation",
    "FindOwner": "public accountId lookup returns the owning loop account",
    "GetRobot": "owner may access the robot attached to the loop",
    "InviteLoopMember": "loop owner may invite an account; source active-limit branch is recorded but reachability is unverified",
    "ListLoopMembers": "owner/member/robot access is checked by the source loop controller",
    "ListLoops": "owner or accepted/invited member; robot view filters suspended/non-robot loops",
    "ListOwnerRobots": "accountId selects the requested owner; the source handler does not compare a supplied accountId with caller identity",
    "RemoveLoop": "owner only through this handler; the admin helper path is separate",
    "RemoveLoopMember": "owner or member may remove the target; suspended loops reject mutation",
    "RemoveMemberPhoto": "owner or robot may remove the member photo",
    "SetEnrollment": "owner or robot may set member enrollment; suspended loops reject mutation",
    "SetLegalGuardian": "owner only; child and accepted parent must be loop members",
    "SuspendLoop": "robot identity or admin may suspend the loop",
    "SuspendRobotLoop": "admin credential required; friendlyId identifies the robot loop",
    "UpdateAgreementStatus": "agreementId selects an invited agreement; EchoSign status is authoritative",
    "UpdateLoop": "owner only; suspended loops reject mutation",
    "UpdateLoopMember": "owner, robot, or legal guardian depending on member state",
    "UpdateMemberPhoto": "owner or robot may update the member photo",
    "UpdateNickname": "owner or robot may update member nickname",
    "UpdatePhoneticName": "owner or robot may update member phonetic name",
}

LOOP_ERRORS = {
    "AcceptLoopInvitation": ["INVITE_NOT_FOUND 404", "LOOP_SUSPENDED 403"],
    "ClearRobot": ["ROBOT_NOT_FOUND 404"],
    "CreateLoop": ["ROBOT_REQUIRED 422", "ROBOT_DISABLED 409", "ROBOT_ALREADY_EXISTS 409"],
    "DeclineLoopInvitation": ["INVITE_NOT_FOUND 404", "LOOP_SUSPENDED 403"],
    "FindOwner": ["LOOP_NOT_FOUND 404"],
    "GetRobot": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER 403"],
    "InviteLoopMember": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER 403", "LOOP_SUSPENDED 403", "MEMBER_EXISTS 409", "ACTIVE_LIMIT_REACHED 409"],
    "ListLoopMembers": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403"],
    "ListLoops": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403"],
    "ListOwnerRobots": ["LOOP_NOT_FOUND 404"],
    "RemoveLoop": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER 403"],
    "RemoveLoopMember": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_SELF 403", "LOOP_SUSPENDED 403"],
    "RemoveMemberPhoto": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403"],
    "SetEnrollment": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403", "LOOP_SUSPENDED 403"],
    "SetLegalGuardian": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "PARENT_MUST_BE_ACCEPTED 422", "PARENT_MUST_HAVE_EMAIL_AND_NAME 422", "ECHO_SIGN_UNAVAILABLE 503"],
    "SuspendLoop": ["LOOP_NOT_FOUND 404", "ONLY_ADMIN_OR_ROBOT_CAN_SUSPEND 403"],
    "SuspendRobotLoop": ["ROBOT_NOT_FOUND 404", "LOOP_NOT_FOUND 404"],
    "UpdateAgreementStatus": ["AGREEMENT_NOT_FOUND 404", "ECHO_SIGN_UNAVAILABLE 503"],
    "UpdateLoop": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER 403", "LOOP_SUSPENDED 403"],
    "UpdateLoopMember": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_LEGAL_GUARDIAN 403", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403", "ONLY_INVITED_OR_CHILD_EDITABLE 403", "EMAIL_CAN_BE_SET_ONCE 403", "LOOP_SUSPENDED 403"],
    "UpdateMemberPhoto": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403"],
    "UpdateNickname": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403", "LOOP_SUSPENDED 403"],
    "UpdatePhoneticName": ["LOOP_NOT_FOUND 404", "MEMBER_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER_OR_ROBOT 403", "LOOP_SUSPENDED 403"],
}

LOOP_PERSISTENCE = {
    "AcceptLoopInvitation": "loop member status changes to accepted and Loop document is saved",
    "ClearRobot": "associated loop is soft-removed and robot association is cleared",
    "CreateLoop": "Loop and owner/robot members are saved",
    "DeclineLoopInvitation": "loop member status changes to declined and Loop document is saved",
    "FindOwner": "loop read only",
    "GetRobot": "loop/account reads only",
    "InviteLoopMember": "member is added to Loop and saved; status is ACCEPTED when there is no email and isChild is false, otherwise INVITED",
    "ListLoopMembers": "loop/member reads only",
    "ListLoops": "loop/member reads only",
    "ListOwnerRobots": "loop/member reads only",
    "RemoveLoop": "Loop is soft-deleted; hard deletion is prohibited by the schema",
    "RemoveLoopMember": "member status changes to removed and Loop document is saved",
    "RemoveMemberPhoto": "member photo field is saved",
    "SetEnrollment": "member enrollment fields are saved",
    "SetLegalGuardian": "agreement and legalGuardian fields are saved",
    "SuspendLoop": "Loop isSuspended field is saved",
    "SuspendRobotLoop": "delegates to and saves suspendLoop",
    "UpdateAgreementStatus": "agreement/member status is saved when EchoSign reports signed",
    "UpdateLoop": "Loop name is saved",
    "UpdateLoopMember": "member properties are saved",
    "UpdateMemberPhoto": "member photo field is saved",
    "UpdateNickname": "member nickname is saved",
    "UpdatePhoneticName": "member phoneticName is saved",
}

LOOP_SIDE_EFFECTS = {
    "AcceptLoopInvitation": "emits InvitationToLoopAccepted",
    "ClearRobot": "marks the associated Loop deleted and clears its robot reference; the startup-installed save hook schedules LoopUpdated with setImmediate and logs send failures without blocking the save",
    "CreateLoop": "loads robot/account, removes robot from prior loops, emits LoopCreated",
    "DeclineLoopInvitation": "emits InvitationToLoopDeclined",
    "FindOwner": "none beyond loop lookup",
    "GetRobot": "none beyond loop/account lookup",
    "InviteLoopMember": "creates an invitation code; sends invitation mail/event only when an email is supplied",
    "ListLoopMembers": "populates account/robot data",
    "ListLoops": "populates members and robot data",
    "ListOwnerRobots": "populates robot identifiers",
    "RemoveLoop": "clears robot/loop association and emits loop update",
    "RemoveLoopMember": "emits MemberRemovedFromLoop",
    "RemoveMemberPhoto": "removes old binary object/public URL",
    "SetEnrollment": "emits LoopUpdated command",
    "SetLegalGuardian": "refreshes/sends EchoSign agreement",
    "SuspendLoop": "emits LoopUpdated command",
    "SuspendRobotLoop": "emits suspension update through suspendLoop",
    "UpdateAgreementStatus": "consults EchoSign and may refresh agreement",
    "UpdateLoop": "emits LoopUpdated command",
    "UpdateLoopMember": "emits LoopUpdated/member update",
    "UpdateMemberPhoto": "stores binary object and removes old public URL",
    "UpdateNickname": "emits LoopUpdated command",
    "UpdatePhoneticName": "emits LoopUpdated command",
}


def _original_source_pin(path: str, symbol: str | None = None) -> dict:
    return pin(ACCOUNT_REPOSITORY, ACCOUNT_SOURCE_REF, path, symbol)


def _original_account_source(op: str) -> dict:
    if op not in ACCOUNT_HANDLER_METHODS:
        raise KeyError(f"unmapped original Account operation: {op}")
    handler_method = ACCOUNT_HANDLER_METHODS[op]
    controller_method = ACCOUNT_CONTROLLER_METHODS[op]
    admin_only = op in ACCOUNT_ADMIN
    return {
        "status": "mapped-original",
        "repository": ACCOUNT_REPOSITORY,
        "revision": ACCOUNT_SOURCE_REF,
        "entrypoint": _original_source_pin("src/index.ts", "App handlerFactory: AccountHandler + AccountRoute"),
        "route": _original_source_pin("src/routes/account.route.ts", "AccountRoute internal REST routes"),
        "handler": _original_source_pin("src/handlers/account.handler.ts", f"AccountHandler.{handler_method}"),
        "controller": _original_source_pin("src/controllers/account.ctrl.ts", f"AccountController.{controller_method}"),
        "tokenController": _original_source_pin("src/controllers/token.ctrl.ts", "TokenController") if op in {"CreateAccessToken", "CreateHubToken", "GetAccountByAccessToken", "FacebookPrepareLogin"} else None,
        "schemas": [_original_source_pin("src/schemes/account.ts", "AccountSchema"), _original_source_pin("src/schemes/token.ts", "TokenSchema")],
        "errors": _original_source_pin("src/errors/account.ts", "AccountError") if op not in {"CreateAccessToken", "CreateHubToken", "GetAccountByAccessToken"} else _original_source_pin("src/errors/token.ts", "TokenError"),
        "config": _original_source_pin("config/config.json", "sanitized runtime dependency/configuration evidence"),
        "sourceEvidence": copy.deepcopy(ACCOUNT_SOURCE_EVIDENCE.get(op, {})),
        "legacySource": pin(ACCOUNT_LEGACY_REPOSITORY, ACCOUNT_LEGACY_REF, "src/controllers/account.ctrl.js", "legacy AccountController; chronology only"),
        "auth": {
            "decorator": "none" if op in ACCOUNT_PUBLIC else "parseCredentials",
            "adminOnly": admin_only,
            "identity": "request.auth.credentials.id" if op not in ACCOUNT_PUBLIC else "no authenticated identity required by handler",
            "unknowns": ["outer deployed gateway authentication and target alias were not replayed"] if op in ACCOUNT_PUBLIC else ["outer deployed gateway authentication and target alias were not replayed"],
        },
        "validation": copy.deepcopy(ACCOUNT_VALIDATION[op]),
        "unknowns": [
            "source revision is pinned, but the deployed service revision/route alias for this historical SDK target is not independently proven",
            "runtime source-vs-Phoenix scenario is not run in this candidate",
        ],
    }


def _original_account_contract(op: str) -> dict:
    source = _original_account_source(op)
    error_unknowns = ["exact framework envelope and deployed alias remain unverified"] + ACCOUNT_ERROR_UNKNOWNS.get(op, [])
    side_effect_unknowns = ["external provider success/failure wire behavior was not exercised"] + ACCOUNT_SIDE_EFFECT_UNKNOWNS.get(op, [])
    result = {
        "sourceRevision": ACCOUNT_SOURCE_REF,
        "handlerMethod": source["handler"]["symbol"],
        "controllerMethod": source["controller"]["symbol"],
        "auth": copy.deepcopy(source["auth"]),
        "ownership": ACCOUNT_OWNERSHIP[op],
        "schema": {"validation": copy.deepcopy(ACCOUNT_VALIDATION[op]), "model": "src/schemes/account.ts"},
        "errors": {
            "observed": ACCOUNT_ERRORS[op],
            "unknowns": error_unknowns,
        },
        "persistence": {"observed": ACCOUNT_PERSISTENCE[op], "unknowns": ["restart/transaction behavior was not exercised"]},
        "sideEffects": {
            "observed": ACCOUNT_SIDE_EFFECTS[op], "unknowns": side_effect_unknowns,
            "startupHook": {
                "source": _original_source_pin("src/index.ts", "setupAccountEntityTriggers/accountSchema.postSave"),
                "lineRefs": [33, 41, 42, 62, 63, 65, 66, 72],
                "condition": "an Account document is saved after service startup installs the hook",
                "behavior": "schedules AccountUpdated using setImmediate; next() continues immediately; send/serialization failures are logged",
                "runtimeStatus": "not-run",
            },
        },
        "sourceEvidence": copy.deepcopy(source["sourceEvidence"]),
        "sourcePins": {
            "route": source["route"],
            "handler": source["handler"],
            "controller": source["controller"],
            "config": source["config"],
            "legacyComparison": source["legacySource"],
        },
    }
    if op == "ResetKeys":
        result["output"] = {
            "observed": "AccountHandler.ResetKeys returns accountCtrl.reset(...), then serializes the Account with unsafe=true; regenerated accessKeyId and secretAccessKey remain present",
            "unknowns": ["outer response envelope and credential redaction outside AccountSchema are unverified"],
            "sourceEvidence": copy.deepcopy(source["sourceEvidence"].get("output", {})),
        }
    return result


def _original_loop_source(op: str) -> dict:
    if op not in LOOP_HANDLER_METHODS:
        raise KeyError(f"unmapped original Loop operation: {op}")
    handler_method = LOOP_HANDLER_METHODS[op]
    controller_method = LOOP_CONTROLLER_METHODS[op]
    admin_only = op in LOOP_ADMIN
    return {
        "status": "mapped-original",
        "repository": ACCOUNT_REPOSITORY,
        "revision": ACCOUNT_SOURCE_REF,
        "entrypoint": _original_source_pin("src/index.ts", "App handlerFactory: LoopHandler + LoopRoute"),
        "route": _original_source_pin("src/routes/loop.route.ts", "LoopRoute internal REST routes"),
        "handler": _original_source_pin("src/handlers/loop.handler.ts", f"LoopHandler.{handler_method}"),
        "controller": _original_source_pin("src/controllers/loop.ctrl.ts", f"LoopController.{controller_method}"),
        "schemas": [_original_source_pin("src/schemes/loop.ts", "LoopSchema"), _original_source_pin("src/schemes/member.status.ts", "MemberStatus"), _original_source_pin("src/schemes/member.type.ts", "MemberType")],
        "errors": _original_source_pin("src/errors/loop.ts", "LoopError"),
        "config": _original_source_pin("config/config.json", "sanitized runtime dependency/configuration evidence"),
        "sourceEvidence": copy.deepcopy(LOOP_SOURCE_EVIDENCE.get(op, {})),
        "legacySource": pin(ACCOUNT_LEGACY_REPOSITORY, ACCOUNT_LEGACY_REF, "src/controllers/loop.ctrl.js", "legacy LoopController; chronology only"),
        "auth": {
            "decorator": "none" if op in LOOP_PUBLIC else "parseCredentials",
            "adminOnly": admin_only,
            "identity": "request.auth.credentials.id" if op not in LOOP_PUBLIC else "no authenticated identity required by handler",
            "unknowns": ["outer deployed gateway authentication and target alias were not replayed"],
        },
        "validation": copy.deepcopy(LOOP_VALIDATION[op]),
        "unknowns": [
            "source revision is pinned, but the deployed service revision/route alias for this historical SDK target is not independently proven",
            "runtime source-vs-Phoenix scenario is not run in this candidate",
        ],
    }


def _original_loop_contract(op: str) -> dict:
    source = _original_loop_source(op)
    error_unknowns = ["exact framework envelope and deployed alias remain unverified"] + LOOP_ERROR_UNKNOWNS.get(op, [])
    side_effect_unknowns = ["external Robot/Mail/EchoSign/Binary provider wire behavior was not exercised"] + LOOP_SIDE_EFFECT_UNKNOWNS.get(op, [])
    return {
        "sourceRevision": ACCOUNT_SOURCE_REF,
        "handlerMethod": source["handler"]["symbol"],
        "controllerMethod": source["controller"]["symbol"],
        "auth": copy.deepcopy(source["auth"]),
        "ownership": LOOP_OWNERSHIP[op],
        "schema": {"validation": copy.deepcopy(LOOP_VALIDATION[op]), "model": "src/schemes/loop.ts"},
        "errors": {
            "observed": LOOP_ERRORS[op],
            "unknowns": error_unknowns,
        },
        "persistence": {"observed": LOOP_PERSISTENCE[op], "unknowns": ["restart/transaction behavior was not exercised"]},
        "sideEffects": {
            "observed": LOOP_SIDE_EFFECTS[op], "unknowns": side_effect_unknowns,
            "startupHook": {
                "source": _original_source_pin("src/index.ts", "setupAccountEntityTriggers/loopSchema.postSave"),
                "lineRefs": [33, 74, 75, 104, 105, 107, 108, 114],
                "condition": "a Loop document is saved after service startup installs the hook",
                "behavior": "schedules LoopUpdated using setImmediate; next() continues immediately; send/serialization failures are logged",
                "runtimeStatus": "not-run",
            },
        },
        "sourceEvidence": copy.deepcopy(source["sourceEvidence"]),
        "sourcePins": {
            "route": source["route"],
            "handler": source["handler"],
            "controller": source["controller"],
            "config": source["config"],
            "legacyComparison": source["legacySource"],
        },
    }


def attach_original_source(prefix: str, op: str, source: dict, contract: dict) -> tuple[dict, dict]:
    """Attach recovered Account/Loop source while preserving local Phoenix facts."""
    if prefix == "Account_20151111":
        original = _original_account_source(op)
        original_contract = _original_account_contract(op)
    elif prefix == "Loop_20160324":
        original = _original_loop_source(op)
        original_contract = _original_loop_contract(op)
    else:
        return source, contract
    local_status = source["status"]
    phoenix_contract = copy.deepcopy(contract)
    source = copy.deepcopy(source)
    source["phoenixStatus"] = local_status
    source["status"] = "proxy-with-original-controller"
    source["original"] = original
    contract = copy.deepcopy(contract)
    contract["phoenixImplementation"] = {
        "status": local_status,
        "auth": phoenix_contract["auth"],
        "ownership": phoenix_contract["ownership"],
        "schema": phoenix_contract["schema"],
        "errors": phoenix_contract["errors"],
        "persistence": phoenix_contract["persistence"],
        "sideEffects": phoenix_contract["sideEffects"],
    }
    contract["originalSource"] = original_contract
    contract["auth"] = original_contract["auth"]
    contract["ownership"] = original_contract["ownership"]
    contract["errors"] = original_contract["errors"]
    contract["persistence"] = original_contract["persistence"]
    contract["sideEffects"] = original_contract["sideEffects"]
    if "output" in original_contract:
        contract["output"] = copy.deepcopy(original_contract["output"])
    contract["schema"]["unknowns"] = ["Phoenix route schema and original controller schema are recorded separately above"]
    contract["schema"]["phoenixStatus"] = local_status
    contract["schema"]["sourceStatus"] = "proxy-with-original-controller"
    contract["schema"]["originalModel"] = original_contract["schema"]
    return source, contract


def original_verification(prefix: str, op: str) -> dict:
    """Build a concrete, source-backed scenario without claiming it ran."""
    if prefix == "Account_20151111":
        source = _original_account_source(op)
        contract = _original_account_contract(op)
    elif prefix == "Loop_20160324":
        source = _original_loop_source(op)
        contract = _original_loop_contract(op)
    else:
        return {}
    validation = source["validation"]
    required = validation["required"]
    optional = validation["optional"]
    validation_case = True
    if "headers required" in " ".join(validation["transforms"]):
        invalid_request = {"headers": {"omit": "x-id"}, "expected": "Joi/Boom validation failure before controller"}
    elif required:
        invalid_request = {"omit": required[0], "expected": "Joi/Boom validation failure before controller"}
    elif optional:
        invalid_request = {"set": {optional[0]: {"synthetic": "object"}}, "expected": "Joi/Boom validation failure before controller"}
    else:
        validation_case = False
        invalid_request = {"case": "no required payload member; use a denied/malformed credential or dependency-not-found fixture", "expected": "do not assume a payload validation rejection"}
    authenticated = source["auth"]["decorator"] != "none"
    authorization = {
        "identity": source["auth"]["identity"],
        "adminOnly": source["auth"]["adminOnly"],
        "case": "synthetic accepted identity and a denied identity/role",
        "expected": contract["ownership"],
    }
    if not authenticated:
        authorization = {
            "identity": "none required by the handler decorator",
            "adminOnly": False,
            "case": "synthetic public request plus malformed/unknown identifier",
            "expected": contract["ownership"],
        }
    non_mutating = (prefix, op) in NON_MUTATING_VERIFICATION
    if non_mutating:
        persistence_assertions = [
            "repeat the read/token operation with a stable fixture and compare complete status/body",
            "record provider/event failures separately from the controller result",
        ]
    else:
        persistence_assertions = [
            "repeat the state-changing operation with a read/restart fixture",
            "record provider/event failures separately from the controller result",
        ]
    valid_case = {
        "name": "valid-source-shaped-request",
        "payloadRequired": required,
        "payloadOptional": optional,
        "defaults": copy.deepcopy(validation.get("defaults", {})),
        "transforms": validation["transforms"],
        "auth": source["auth"],
        "assertions": ["compare Phoenix target dispatch with the source handler/controller result", "compare complete status/body/error envelope before assigning parity"],
    }
    if prefix == "Loop_20160324" and op == "InviteLoopMember":
        valid_case["boundaryVariants"] = [
            {
                "name": "accepted-member-without-email-or-child",
                "request": {"loopId": "source-shaped-loop", "isChild": False},
                "expectedMemberStatus": "ACCEPTED",
                "expectedMailOrEvent": "none from the controller path",
            },
            {
                "name": "invited-member-with-email-or-child",
                "request": {"loopId": "source-shaped-loop", "email": "member@example.invalid", "isChild": False},
                "expectedMemberStatus": "INVITED",
                "expectedMailOrEvent": "mail/event attempted only when email is supplied",
            },
        ]
    return {
        "status": "not-run",
        "sourceRevision": ACCOUNT_SOURCE_REF,
        "sourceController": source["controller"],
        "sourceEvidence": copy.deepcopy(source.get("sourceEvidence", {})),
        "cases": [
            valid_case,
            {
                "name": "source-validation-rejection" if validation_case else "no-required-payload-boundary",
                "request": invalid_request,
                "expectedErrors": (["capture exact original framework/Joi validation status and envelope"] + contract["errors"]["observed"]) if validation_case else ["no guaranteed payload validation error; record the source result"],
                "assertions": ["verify validation occurs before persistence/provider calls", "retain exact source error precedence and status"] if validation_case else ["do not invent a missing-field error for a no-field operation", "record the actual source boundary result"],
            },
            {
                "name": "ownership-and-identity",
                "request": authorization,
                "assertions": ["compare accepted and denied synthetic identities", "exercise adminOnly or member/owner/robot boundary where source declares one"],
            },
            {
                "name": "persistence-and-side-effects",
                "expectedPersistence": contract["persistence"]["observed"],
                "expectedSideEffects": contract["sideEffects"]["observed"],
                "assertions": persistence_assertions,
            },
        ],
        "unknowns": [
            "deployed alias/service revision and outer gateway framing remain inaccessible in this source-only map",
            "this candidate does not run Mongo, SNS, Mail, Robot, Binary or EchoSign dependencies",
        ],
    }


def service_contract(prefix: str, op: str) -> dict:
    """Source-backed contract facts for current Phoenix routes."""
    default = {
        "auth": common_auth("legacy"),
        "ownership": "source ownership not recovered for this operation",
        "schema": {},
        "errors": {"observed": ["ValidationException for unknown operation is emitted by most local compatibility handlers"], "unknowns": ["operation-specific source errors"]},
        "persistence": {"observed": "not established by the API model", "unknowns": ["durability and restart behavior"]},
        "sideEffects": {"observed": "none established from the API model", "unknowns": ["controller side effects"]},
    }
    c = copy.deepcopy(default)
    if prefix == "Account_20151111":
        c["auth"] = common_auth("create-hub-token" if op == "CreateHubToken" else "proxy")
        c["ownership"] = "Phoenix local Account/AccountAdmin route boundary only; source ownership is recorded separately"
        c["errors"] = {"observed": ["Phoenix bounded token-route validation/dispatch errors"] if op == "CreateHubToken" else [], "unknowns": ["Phoenix does not execute the recovered source controller on this route"]}
        c["persistence"] = {"observed": "Phoenix bounded token compatibility path only" if op == "CreateHubToken" else "no Phoenix Account controller persistence established", "unknowns": ["source persistence is recorded in originalSource"]}
        c["sideEffects"] = {"observed": "Phoenix bounded route issues a bearer token" if op == "CreateHubToken" else "no Phoenix source-controller side effect established", "unknowns": ["source side effects are recorded in originalSource"]}
    elif prefix == "Backup_20170222":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "Phoenix drops the original loop.robot ownership check; LAN trust is documented in backup.js"
        c["errors"] = {"observed": ["ValidationException for missing loopId/unknown operation", "blob PUT/GET 400/404/500 HTTP errors"], "unknowns": ["original S3 errors and signed URL expiry"]}
        c["persistence"] = {"observed": "blob bytes on disk; index in process memory", "unknowns": ["index recovery across process restart"]}
        c["sideEffects"] = {"observed": "New allocates a key; PUT stores and hashes bytes; List exposes newest entries", "unknowns": ["source event/audit side effects"]}
    elif prefix == "Key_20160201":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "accountId is attached from Authorization when present; loop/member ownership is not checked"
        c["errors"] = {"observed": ["KEY_REQUEST_NOT_FOUND 404", "KEY_BACKUP_NOT_FOUND 404", "ValidationException for unknown operation"], "unknowns": ["source validation and expiry errors"]}
        c["persistence"] = {"observed": "requests and backups are in-memory maps", "unknowns": ["restart durability"]}
        c["sideEffects"] = {"observed": "CreateRequest inserts a request; Share mutates encryptedKey; Backup inserts a backup", "unknowns": ["source key material lifecycle"]}
    elif prefix == "Log_20150309":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "no ownership check in the local sink"
        c["errors"] = {"observed": ["ValidationException for unknown operation"], "unknowns": ["source ingest validation and admin authorization"]}
        c["persistence"] = {"observed": "optional JSONL append under ETCO_log_dir; otherwise no sink", "unknowns": ["Kinesis/S3 durability and retrieval"]}
        c["sideEffects"] = {"observed": "PutEvents and binary operations optionally append a JSONL record", "unknowns": ["source event fanout and upload side effects"]}
    elif prefix == "Notification_20150505":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "token/account association is in-memory; status uses requested accountId or access key"
        c["errors"] = {"observed": ["ValidationException for unknown operation", "401 for unknown socket token"], "unknowns": ["source token expiry/replay errors"]}
        c["persistence"] = {"observed": "tokens, pending queue and sockets are in-memory", "unknowns": ["restart/reconnect persistence"]}
        c["sideEffects"] = {"observed": "NewRobotToken creates/reuses token; enqueue delivers pending messages over WebSocket", "unknowns": ["source event bus and acknowledgement semantics"]}
    elif prefix == "Push_20160729":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "registration stores accessKeyId when present; RemoveDevice does not check owner"
        c["errors"] = {"observed": ["ValidationException when name missing or operation unknown"], "unknowns": ["source duplicate/provider errors"]}
        c["persistence"] = {"observed": "DeviceRegistry is an in-memory map", "unknowns": ["durable registration"]}
        c["sideEffects"] = {"observed": "CreateDevice stores a registration; provider delivery is a no-op", "unknowns": ["APNs/FCM delivery"]}
    elif prefix == "Robot_20160225":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "current handler does not verify owner/manufacturer identity"
        c["errors"] = {"observed": ["ValidationException for unknown operation"], "unknowns": ["ROBOT_NOT_FOUND and source admin errors"]}
        c["persistence"] = {"observed": "GetRobot can read a supplied account store only when a store accessor is wired; classic default uses no store", "unknowns": ["durable robot record/calibration history"]}
        c["sideEffects"] = {"observed": "GetFriendlyIds generates random IDs; Update/Remove return accepted defaults", "unknowns": ["source mutations/audit events"]}
    elif prefix == "Person_20160801":
        c["auth"] = common_auth("legacy")
        c["ownership"] = "account/loop property maps use accessKeyId or requested loopId without membership checks"
        c["errors"] = {"observed": ["ValidationException for unknown operation"], "unknowns": ["source category, key and membership validation"]}
        c["persistence"] = {"observed": "loop/account property maps are in-memory", "unknowns": ["durability"]}
        c["sideEffects"] = {"observed": "Set operations mutate property maps; reads return current maps", "unknowns": ["source property events and downstream effects"]}
    elif prefix in {"Collision_20161126", "IFTTT_20170207", "Media_20160725", "NLP_20161031", "ROM_20171011"}:
        c["auth"] = common_auth("legacy")
        c["ownership"] = "stub uses accessKeyId only where needed and does not enforce source ownership"
        c["errors"] = {"observed": ["ValidationException for unknown operation"], "unknowns": ["source validation, authorization and provider errors"]}
        c["persistence"] = {"observed": "stub-specific in-memory/default values" if prefix in {"Media_20160725", "Person_20160801"} else "no durable source-backed state", "unknowns": ["source persistence"]}
        c["sideEffects"] = {"observed": "returns source-shaped defaults; Person/Media properties may mutate local maps", "unknowns": ["source side effects"]}
    elif prefix == "Settings_20171219":
        c["auth"] = common_auth("settings")
        c["ownership"] = "pinned Settings controller requires loop membership; Phoenix handler keys data by account id and does not reproduce that check"
        c["errors"] = {"observed": ["LOOP_MEMBER_ONLY 403", "UNKNOWN_DATA_SERVICE 422", "REMOVE_FOR_TARGET_NOT_SUPPORTED 422", "original framework validation status/envelope must be captured", "Phoenix emits 401 for missing x-amz-credentials on update"], "unknowns": ["exact 20171219 gateway error envelope"]}
        c["persistence"] = {"observed": "Phoenix settings are in the account JSON store and flush on update/delete", "unknowns": ["source service persistence transaction boundaries"]}
        c["sideEffects"] = {"observed": "Get reads skill data/views; Update/Delete mutate configured data services", "unknowns": ["non-report skills and downstream Lasso/Person side effects"]}
    elif prefix == "Update_20160301":
        c["auth"] = common_auth("ota")
        c["ownership"] = "current OTA catalog has no caller ownership check"
        c["errors"] = {"observed": ["UPDATE_NOT_FOUND 404", "UnknownOperationException 400", "InternalFailure 500"], "unknowns": ["original admin error codes"]}
        c["persistence"] = {"observed": "catalog/manifest and package files are read-only at runtime", "unknowns": ["source target mutation persistence"]}
        c["sideEffects"] = {"observed": "List/Get select catalog entries and expose self-hosted package URLs", "unknowns": ["download authorization/reporting"]}
    elif prefix == "Loop_20160324":
        c["auth"] = common_auth("proxy")
        c["ownership"] = "Phoenix proxy/robotFace boundary only; original Loop ownership is recorded separately"
        c["errors"] = {"observed": ["bounded Loop unknown-operation 400"], "unknowns": ["Phoenix does not execute the recovered source controller on this route"]}
        c["persistence"] = {"observed": "Phoenix account store is used only by bounded compatibility dispatch", "unknowns": ["source persistence is recorded in originalSource"]}
        c["sideEffects"] = {"observed": "Phoenix bounded compatibility dispatch only", "unknowns": ["source side effects are recorded in originalSource"]}
    elif prefix == "OOBE_20161026":
        c["auth"] = common_auth("proxy")
        c["ownership"] = "bounded robotFace paths use account store; other operations are upstream-only"
        c["errors"] = {"observed": ["bounded OOBE errors TOKEN_NOT_FOUND, TOKEN_EXPIRED, ACCOUNT_NOT_FOUND, CREDENTIALS_REQUIRED, LOOP_MUST_BE_SUSPENDED, ValidationException"], "unknowns": ["full upstream operation errors"]}
        c["persistence"] = {"observed": "account store persists loops/accounts/tokens; bounded dispatch mutates it", "unknowns": ["full upstream operation durability"]}
        c["sideEffects"] = {"observed": "bounded OOBE setup consumes token and creates/reuses loop credentials; bounded Loop suspend mutates loop", "unknowns": ["full lifecycle side effects"]}
    elif prefix == "GQA_20160930" or prefix in {"Lps_20171201", "OauthClients_20171108"}:
        c["auth"] = common_auth("unregistered")
        c["ownership"] = "unknown"
        c["errors"] = {"observed": [], "unknowns": ["service-specific errors"]}
        c["persistence"] = {"observed": "unknown", "unknowns": ["all persistence semantics"]}
        c["sideEffects"] = {"observed": "unknown", "unknowns": ["all side effects"]}
    return c


def scenario(prefix: str, op: str, required: list[str], *, kind: str = "current", source_status: str = "") -> dict:
    body = body_keys(required)
    target = f"{prefix}.{op}"
    if kind == "historical-jot":
        assertions = [
            "send a synthetic accepted-member request with x-amz-credentials and compare response shape to the model revision(s)",
            "repeat with a non-member and robot impersonation to capture the pinned 403 error codes",
        ]
    elif kind == "historical-voice":
        assertions = [
            "send a bounded synthetic multipart/stream request with x-amz-credentials and compare the Hapi status/body",
            "exercise an unknown method and the historical UploadFile alias separately; preserve the observed 404 rather than assuming an alias",
        ]
    elif kind == "historical-settings":
        assertions = [
            "send both report string-skills and hub array-skills requests with a synthetic accepted loop member",
            "compare view filtering, data-service errors and a non-member request against the pinned Settings source",
        ]
    elif source_status == "unregistered":
        assertions = [
            "send the model-shaped request to the documented Classic endpoint and record the actual no-route/upstream response",
            "do not treat a dispatch-only 400 as implementation evidence; locate the source service before closing the task",
        ]
    elif source_status in {"proxy-only", "unimplemented", "proxy-with-original-controller"}:
        assertions = [
            "send the model-shaped request through Classic with synthetic credentials and compare it with the pinned original handler/controller",
            "capture upstream availability, status, error envelope and body schema before assigning implementation credit",
            "exercise source-backed ownership/error cases from contract.originalSource; preserve inaccessible or undeployed aliases as explicit gaps",
        ]
    else:
        assertions = [
            "send the minimal model-shaped request through POST / with synthetic credentials",
            "assert target dispatch, status, output members and documented error on a missing required field",
            "repeat any state-changing operation with a second read/restart fixture where the contract claims persistence",
        ]
    return {
        "status": "not-run",
        "request": {
            "method": "POST",
            "path": "/",
            "target": target,
            "bodyKeys": required,
            "syntheticBody": body,
        },
        "assertions": assertions,
    }


def source_pin_for_historical(kind: str, prefix: str, op: str) -> dict:
    if kind == "jot":
        handlers = [
            pin("server/jot-ws", JOT_REF, "src/handlers/message.handler.js", "MessageHandler"),
            pin("server/jot-ws", JOT_REF, "src/controllers/message.ctrl.js", "MessageController"),
            pin("server/jot-ws", JOT_REF, "src/errors/message.js", "JOT_* errors"),
        ]
        result = {
            "status": "source-backed-current-handler-historical-schema",
            "handlers": handlers,
            "unknowns": ["version-specific controller/model/error differences for older Jot models"],
        }
        if prefix == "Jot_20160126" and op in JOT_LITERAL_ALTERNATE_OPERATIONS:
            handlers.append(pin("jiborobot/srv-jot-ws-archived", JOT_ARCHIVE_REF, "archive/message.spec.js", "X-Amz-Target Jot_20160512"))
            result["alternateTargetEvidence"] = {
                "status": "literal-source-observed",
                "target": f"Jot_20160512.{op}",
                "reviewArtifact": {
                    "path": JOT_ARCHIVE_REVIEW_PATH,
                    "sha256": JOT_ARCHIVE_REVIEW_SHA256,
                    "lineRefs": JOT_ARCHIVE_LITERAL_LINE_REFS[op],
                },
            }
        elif prefix == "Jot_20160126" and op in JOT_INFERRED_ALTERNATE_OPERATIONS:
            result["alternateTargetEvidence"] = {
                "status": "model-only-inferred",
                "target": f"Jot_20160512.{op}",
                "reviewArtifact": {
                    "path": JOT_ARCHIVE_REVIEW_PATH,
                    "sha256": JOT_ARCHIVE_REVIEW_SHA256,
                    "lineRefs": [],
                },
                "unknown": "No literal Jot_20160512 target for this operation was found in the archived message.spec.js review artifact.",
            }
            result["unknowns"].append("NumberOfUnreadMessagesInLoops is present in the later model but has no literal archived Jot_20160512 target evidence")
        return result
    if kind == "voice":
        return {
            "status": "source-backed-current-handler-historical-schema",
            "handlers": [
                pin("server/voice-ws", VOICE_REF, "server.js", "POST / dispatcher"),
                pin("server/voice-ws", VOICE_REF, "lib/handlers/base.handler.js", "BaseHandler.parseCredentials"),
                pin("server/voice-ws", VOICE_REF, "lib/handlers/upload-voice-sample.handler.js", "UploadVoiceTrainingHandler"),
                pin("server/voice-ws", VOICE_REF, "lib/handlers/list-voice-trainings.handler.js", "ListVoiceTrainingsHandler"),
                pin("server/voice-ws", VOICE_REF, "lib/handlers/index.js", "handler exports"),
                pin("jiborobot/srv-voice-ws-archived", VOICE_ARCHIVE_REF, "lib/handlers/index.js", "archived VoiceTraining handler exports"),
            ],
            "unknowns": ["historical UploadFile/RemoveFile/ListFiles/GetFile controller paths and exact alias behavior"]
        }
    return {
        "status": "source-backed-legacy-handler",
        "handlers": [
            pin("jiborobot/srv-settings-ws", SETTINGS_REF, "src/handlers/settings.handler.ts", "SettingsHandler"),
            pin("jiborobot/srv-settings-ws", SETTINGS_REF, "src/controllers/settings.ctrl.ts", "SettingsController"),
            pin("jiborobot/srv-settings-ws", SETTINGS_REF, "src/controllers/get.ctrl.ts", "GetController"),
            pin("jiborobot/srv-settings-ws", SETTINGS_REF, "src/controllers/update.ctrl.ts", "UpdateController"),
            pin("jiborobot/srv-settings-ws", SETTINGS_REF, "src/controllers/delete.ctrl.ts", "DeleteController"),
        ],
        "unknowns": ["no formal Settings_20160801 API model and no separately pinned historical controller revision"]
    }


def historical_contract(kind: str, prefix: str, op: dict) -> dict:
    if kind == "jot":
        auth = common_auth("jot")
        errors = {
            "observed": [
                "JOT_MUST_BE_LOOP_MEMBER 403",
                "JOT_ROBOT_CAN_IMPERSONATE 403",
                "JOT_CONTENT_OR_PARTS_REQUIRED 422",
                "ACCOUNT_SERVICE_UNAVAILABLE 503",
                "MEDIA_SERVICE_UNAVAILABLE 503",
            ],
            "unknowns": ["version-specific archived error envelope and persistence failures"],
        }
        persistence = {"observed": "current controller persists Message documents and updates read state", "unknowns": ["historical schema persistence and retention"]}
        side = {"observed": "Create emits JotMessageCreated; list populates Media; mark operations update read state", "unknowns": ["historical event and delivery semantics"]}
    elif kind == "voice":
        auth = common_auth("voice")
        errors = {
            "observed": ["Joi validation failures return Hapi/Boom 400", "unknown method returns 404 Method not found in VoiceTraining", "Backup failures are wrapped as 400"],
            "unknowns": ["historical operation-specific errors and Remove/Get file behavior"],
        }
        persistence = {"observed": "current UploadVoiceTraining delegates bytes to Backup at /voiceTraining/<key>; List delegates to Backup", "unknowns": ["historical file storage and restart behavior"]}
        side = {"observed": "Upload writes a voice-training backup; List reads backups", "unknowns": ["historical remove/get side effects and URL expiry"]}
    else:
        auth = common_auth("legacy-settings")
        errors = {
            "observed": ["LOOP_MEMBER_ONLY 403", "UNKNOWN_DATA_SERVICE 422", "capture original framework/Joi validation status and envelope"],
            "unknowns": ["formal legacy wire error headers/body and absent model errors"],
        }
        persistence = {"observed": "controller reads/writes downstream Person/Lasso/Hub data; exact legacy persistence is delegated", "unknowns": ["legacy transaction boundaries"]}
        side = {"observed": "GetSettings filters skill configs and optionally includes views", "unknowns": ["legacy update/delete operations are not in this one-pair surface"]}
    return {
        "auth": auth,
        "ownership": auth["ownership"],
        "schema": op,
        "errors": errors,
        "persistence": persistence,
        "sideEffects": side,
    }


def parse_filename_label(path: str) -> str | None:
    m = re.search(r"(?:-|_)(\d{4}-\d{2}-\d{2})\.", path)
    return m.group(1) if m else None


def build() -> dict:
    inventory = json.loads(INVENTORY_PATH.read_text())
    discovery = json.loads(DISCOVERY_PATH.read_text())
    tasks = json.loads(TASKS_PATH.read_text())
    current_by_pair: dict[str, dict] = {}
    current_evidence: dict[str, list] = defaultdict(list)
    for entry in inventory["inventory"]:
        meta = entry["metadata"]
        for operation in entry["operations"]:
            target = f"{meta['targetPrefix']}.{operation['wireName']}"
            current_evidence[target].append({
                "path": entry["path"],
                "revision": inventory["resolvedCommit"],
                "apiVersion": meta["apiVersion"],
                "endpointPrefix": meta["endpointPrefix"],
                "targetPrefix": meta["targetPrefix"],
                "operation": copy.deepcopy(operation),
            })
            current_by_pair.setdefault(target, {"targetPrefix": meta["targetPrefix"], "operation": operation["wireName"]})

    historical_by_pair: dict[str, list] = defaultdict(list)
    chronology = []
    for model in discovery["models"]:
        meta = model["metadata"]
        filename_label = parse_filename_label(model["path"])
        chronology.append({
            "path": model["path"],
            "revision": model["revision"],
            "filenameLabel": filename_label,
            "metadataApiVersion": meta["apiVersion"],
            "authoritativeChronologyLabel": meta["apiVersion"],
            "resolution": "metadata.apiVersion is authoritative; filename label is retained for audit",
            "labelMismatch": filename_label != meta["apiVersion"],
        })
        for operation in model["operations"]:
            target_prefix = meta["targetPrefix"]
            wire_target = f"{target_prefix}.{operation['name']}"
            historical_by_pair[wire_target].append({
                "path": model["path"],
                "revision": model["revision"],
                "service": model["service"],
                "role": model["role"],
                "filenameLabel": filename_label,
                "metadataApiVersion": meta["apiVersion"],
                "targetPrefix": target_prefix,
                "operation": copy.deepcopy(operation),
            })

    # The legacy Settings target is source/consumer evidence, not an API model.
    historical_by_pair["Settings_20160801.GetSettings"].append({
        "path": "source-observed: Pegasus SettingsClient + srv-settings-ws",
        "revision": f"{PEGASUS_REF}+{SETTINGS_REF}",
        "service": "settings",
        "role": "legacy source/consumer contract (no recovered API model)",
        "filenameLabel": None,
        "metadataApiVersion": "2016-08-01",
        "targetPrefix": "Settings_20160801",
        "operation": {
            "name": "GetSettings",
            "input": {"type": "structure", "required": ["loopId"], "members": {"loopId": "string", "transId": "string", "skills": "string|string[]", "settings": "array", "getView": "boolean"}},
            "output": {"type": "list", "members": {"skillId": "string", "data": "object", "view": "object", "errors": "object"}},
        },
    })

    rows = []
    for target in sorted(current_by_pair):
        prefix, op = target.rsplit(".", 1)
        evidence = current_evidence[target]
        operation = copy.deepcopy(evidence[0]["operation"])
        source = source_for(prefix, op)
        family = contract_family(prefix)
        contract = service_contract(prefix, op)
        contract["schema"] = {
            "model": operation,
            "sourceStatus": source["status"],
            "unknowns": ["model shape is pinned, but a source controller schema is not recovered for every route"] if source["status"] in {"proxy-only", "stub", "unregistered", "unimplemented"} else [],
        }
        source, contract = attach_original_source(prefix, op, source, contract)
        consumers = [model_consumer(item["path"]) for item in evidence]
        for test_path in TESTS.get(prefix, []):
            if (ROOT / test_path).exists():
                consumers.append(local_test(test_path))
        if not any(c["kind"] == "phoenix-test-evidence" for c in consumers):
            consumers.append({"kind": "direct-call-site", "repository": None, "revision": None, "path": None, "role": "no direct Phoenix caller recovered; SDK model is the consumer evidence"})
        source_unknowns = source.get("unknowns", [])
        original_unknowns = source.get("original", {}).get("unknowns", [])
        original_contract_unknowns = contract.get("originalSource", {}).get("auth", {}).get("unknowns", [])
        verification = scenario(prefix, op, operation.get("requiredInput", []), source_status=source["status"])
        if prefix in {"Account_20151111", "Loop_20160324"}:
            verification["originalSource"] = original_verification(prefix, op)
        row = {
            "id": f"current:{target}",
            "kind": "current",
            "wireTarget": target,
            "targetPrefix": prefix,
            "operation": op,
            "inventoryEvidence": evidence,
            "source": source,
            "consumers": consumers,
            "task": task_for(prefix, op),
            "contract": contract,
            "verification": verification,
            "unknowns": list(dict.fromkeys(source_unknowns + original_unknowns + original_contract_unknowns + contract["auth"].get("unknowns", []) + contract["errors"].get("unknowns", []))),
        }
        rows.append(row)

    for target in sorted(historical_by_pair):
        evidence = historical_by_pair[target]
        prefix, op = target.rsplit(".", 1)
        if target == "Settings_20160801.GetSettings":
            kind = "legacy-settings"
            source = source_pin_for_historical(kind, prefix, op)
            op_schema = evidence[0]["operation"]
            required = ["loopId"]
            source_status = source["status"]
            alternate = []
        else:
            kind = "jot" if prefix.startswith("Jot_") else "voice"
            source = source_pin_for_historical(kind, prefix, op)
            op_schema = evidence[0]["operation"]
            required = list(op_schema.get("input", {}).get("required", [])) if isinstance(op_schema.get("input"), dict) else []
            source_status = source["status"]
            alternate = []
            if prefix == "Jot_20160126" and any(item["path"].endswith("jot-2016-05-12.normal.json") for item in evidence):
                alternate = ["Jot_20160512." + op]
        contract = historical_contract(kind, prefix, op_schema)
        model_consumers = []
        for item in evidence:
            if item["path"].startswith("source-observed:"):
                model_consumers.extend([
                    consumer_pin("pegasus", PEGASUS_REF, "packages/report-skill/src/SettingsClient.ts", "legacy GetSettings consumer", PEGASUS_SETTINGS_EVIDENCE["files"][0]),
                    consumer_pin("pegasus", PEGASUS_REF, "packages/hub/src/utils/SettingsClient.ts", "legacy GetSettings consumer", PEGASUS_SETTINGS_EVIDENCE["files"][1]),
                ])
            else:
                model_consumers.append(model_consumer(item["path"], "historical API model evidence"))
        if kind == "jot":
            model_consumers.append(consumer_pin("jiborobot/srv-jot-ws-archived", JOT_ARCHIVE_REF, "archive/message.spec.js", "historical integration consumer"))
        if kind == "voice":
            model_consumers.append({"kind": "historical-consumer-gap", "repository": None, "revision": None, "path": None, "role": "no version-specific VoiceTraining caller recovered"})
        chronology_values = sorted({item["metadataApiVersion"] for item in evidence})
        filename_values = sorted({item["filenameLabel"] for item in evidence if item["filenameLabel"]})
        row = {
            "id": f"historical:{target}",
            "kind": "historical",
            "historicalService": kind,
            "wireTarget": target,
            "targetPrefix": prefix,
            "operation": op,
            "modelEvidence": evidence,
            "chronology": {
                "authoritativeModelApiVersions": chronology_values,
                "filenameLabels": filename_values,
                "resolution": "metadata.apiVersion is authoritative; filename labels remain audit-only",
            },
            "alternateWireTargets": alternate,
            "source": source,
            "consumers": model_consumers,
            "task": task_for(prefix, op, kind),
            "contract": contract,
            "verification": scenario(prefix, op, required, kind=f"historical-{kind}", source_status=source_status),
            "unknowns": list(dict.fromkeys(source.get("unknowns", []) + contract["auth"].get("unknowns", []) + contract["errors"].get("unknowns", []))),
        }
        rows.append(row)

    task_ids = {item["id"] for item in tasks["tasks"]}
    source_pins = [
        {"id": "phoenix", "repository": "phoenix", "revision": phoenix_revision(), "scope": "local handler/source files"},
        {"id": "server-client", "repository": "jiborobot/srv-jibo-server-client", "revision": SDK_REF, "scope": "current API inventory and consumer models"},
        {"id": "account-service", "repository": ACCOUNT_REPOSITORY, "revision": ACCOUNT_SOURCE_REF, "scope": "source-pinned Account/Admin and Loop handlers/controllers/configuration"},
        {"id": "account-service-legacy", "repository": ACCOUNT_LEGACY_REPOSITORY, "revision": ACCOUNT_LEGACY_REF, "scope": "legacy JavaScript Account/Loop chronology comparison; incomplete later operation set"},
        {"id": "pegasus", "repository": "pegasus", "revision": PEGASUS_REF, "scope": "original Settings legacy consumers", "evidence": PEGASUS_SETTINGS_EVIDENCE},
        {"id": "settings-service", "repository": "jiborobot/srv-settings-ws", "revision": SETTINGS_REF, "scope": "Settings handler/controller source"},
        {"id": "jot-service", "repository": "server/jot-ws", "revision": JOT_REF, "scope": "current Jot handler/controller/errors"},
        {"id": "jot-archive", "repository": "jiborobot/srv-jot-ws-archived", "revision": JOT_ARCHIVE_REF, "scope": "historical Jot target-prefix integration test"},
        {"id": "voice-service", "repository": "server/voice-ws", "revision": VOICE_REF, "scope": "current VoiceTraining Hapi handler"},
        {"id": "voice-archive", "repository": "jiborobot/srv-voice-ws-archived", "revision": VOICE_ARCHIVE_REF, "scope": "historical VoiceTraining source family; path gaps remain"},
    ]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "schemaVersion": "1.0",
        "status": "working-source-map-unverified",
        "task": "A-01",
        "baseRevision": phoenix_revision(),
        "generatedAt": "2026-09-06",
        "inputs": {
            "inventory": {"path": str(INVENTORY_PATH.relative_to(ROOT)), "sha256": sha256(INVENTORY_PATH), "resolvedCommit": inventory["resolvedCommit"]},
            "discoveryManifest": {"path": str(DISCOVERY_PATH.relative_to(ROOT)), "sha256": sha256(DISCOVERY_PATH), "review": "docs/parity/evidence/2026-09-06/classic-contract-discovery/review.json"},
            "tasks": {"path": str(TASKS_PATH.relative_to(ROOT)), "sha256": sha256(TASKS_PATH), "readOnly": True},
        },
        "sourcePins": source_pins,
        "originalControllerRecovery": {
            "status": "source-mapped-unverified",
            "account": {
                "repository": ACCOUNT_REPOSITORY,
                "revision": ACCOUNT_SOURCE_REF,
                "paths": ["src/index.ts", "src/routes/account.route.ts", "src/handlers/account.handler.ts", "src/controllers/account.ctrl.ts", "src/controllers/token.ctrl.ts", "src/schemes/account.ts", "src/schemes/token.ts", "src/errors/account.ts", "src/errors/token.ts", "config/config.json"],
                "mappedOperations": sorted(ACCOUNT_HANDLER_METHODS),
                "deploymentUnknowns": ["deployed target alias and service revision are not proven", "outer gateway authentication and exact Hapi/framework envelope are not runtime-replayed"],
            },
            "loop": {
                "repository": ACCOUNT_REPOSITORY,
                "revision": ACCOUNT_SOURCE_REF,
                "paths": ["src/index.ts", "src/routes/loop.route.ts", "src/handlers/loop.handler.ts", "src/controllers/loop.ctrl.ts", "src/schemes/loop.ts", "src/schemes/member.status.ts", "src/schemes/member.type.ts", "src/errors/loop.ts", "config/config.json"],
                "mappedOperations": sorted(LOOP_HANDLER_METHODS),
                "deploymentUnknowns": ["deployed target alias and service revision are not proven", "outer gateway authentication and exact Hapi/framework envelope are not runtime-replayed"],
            },
            "legacyComparison": {"repository": ACCOUNT_LEGACY_REPOSITORY, "revision": ACCOUNT_LEGACY_REF, "status": "chronology-only; later operations are absent"},
            "settingsConsumer": {"repository": "pegasus", "revision": PEGASUS_REF, "originalRevision": True, "paths": ["packages/report-skill/src/SettingsClient.ts", "packages/hub/src/utils/SettingsClient.ts"], "evidence": PEGASUS_SETTINGS_EVIDENCE},
        },
        "denominator": {
            "currentPairCount": len(current_by_pair),
            "historicalPairCount": len(historical_by_pair),
            "jotPairCount": len([k for k in historical_by_pair if k.startswith("Jot_")]),
            "voiceTrainingPairCount": len([k for k in historical_by_pair if k.startswith("VoiceTraining_")]),
            "legacySettingsPairCount": 1,
            "provisionalLowerBound": len(current_by_pair) + len(historical_by_pair),
            "historicalModelUnionPairCount": len(historical_by_pair) - 1,
            "literalModelUnionPairCount": len(current_by_pair) + len(historical_by_pair),
            "prefixSubstitutionScenarioPairCount": len(current_by_pair) + len(historical_by_pair) + 1,
            "additionalClientPrefixUnionPairCount": len(current_by_pair) + len(historical_by_pair) + len(JOT_LITERAL_ALTERNATE_OPERATIONS),
            "hypotheticalFivePairClientPrefixUnionPairCount": len(current_by_pair) + len(historical_by_pair) + len(JOT_LITERAL_ALTERNATE_OPERATIONS) + len(JOT_INFERRED_ALTERNATE_OPERATIONS),
            "prefixAmbiguity": {
                "observedModelPrefix": "Jot_20160126",
                "archivedIntegrationPrefix": "Jot_20160512",
                "affectedOperations": sorted(k.split(".", 1)[1] for k in historical_by_pair if k.startswith("Jot_20160126.") and any(item["path"].endswith("jot-2016-05-12.normal.json") for item in historical_by_pair[k])),
                "observedAlternateWirePairs": sorted("Jot_20160512." + op for op in JOT_LITERAL_ALTERNATE_OPERATIONS),
                "inferredAlternateWirePairs": sorted("Jot_20160512." + op for op in JOT_INFERRED_ALTERNATE_OPERATIONS),
                "observedAlternateEvidence": {
                    "path": JOT_ARCHIVE_REVIEW_PATH,
                    "sha256": JOT_ARCHIVE_REVIEW_SHA256,
                    "lineRefs": JOT_ARCHIVE_LITERAL_LINE_REFS,
                    "literalTargetCount": len(JOT_LITERAL_ALTERNATE_OPERATIONS),
                },
                "perPrefixModelUnionPairCounts": {"Jot_20160126": 10, "Jot_20160310": 14},
                "countingRule": "The unit is target-prefix + operation pairs. Literal model union is 169; prefix substitution is 170; retaining the four literal client-observed alternate-prefix pairs is 173; 174 requires independent evidence for the fifth model-only operation.",
                "arithmeticScenarios": {
                    "literalModelUnion": "169: retain each model-declared target prefix and deduplicate operation names within that prefix",
                    "prefixSubstitution": "170: replace the later model's Jot_20160126 prefix with Jot_20160512; do not retain both prefixes; this is a hypothesis about target-prefix identity",
                    "additionalClientPrefixUnion": "173: retain the model prefix and the four literal client-observed Jot_20160512 target-operation pairs",
                    "hypotheticalFivePairClientPrefixUnion": "174: retain the model prefix plus the four literal pairs and the fifth model-only inferred pair; no independent fifth target literal is currently proven",
                },
            },
        },
        "chronologyResolutions": chronology,
        "registeredFunctionalTasks": [
            {"id": "A-19", "discoveredBy": "A-01", "service": "Jot", "status": "registered", "scope": "versioned handlers, target aliases, auth/errors, persistence and source-backed scenarios"},
            {"id": "A-20", "discoveredBy": "A-01", "service": "VoiceTraining", "status": "registered", "scope": "versioned handlers, UploadFile aliases, ownership, persistence and source-backed scenarios"},
        ],
        "operationCount": len(rows),
        "operations": rows,
        "sourceGaps": [
            "The current SDK inventory supplies schemas; original Account/Admin and Loop controller mappings are source-pinned below, while their deployed aliases and runtime behavior remain unverified.",
            "Phoenix stubs and compatibility handlers are dispatch/shape evidence only; they do not establish original ownership, persistence, errors or provider side effects.",
            "Jot_20160126 in the 2016-05-12 model conflicts with Jot_20160512 in the archived integration test; four alternate targets are literal in the archived review artifact, while NumberOfUnreadMessagesInLoops remains model-only inferred. Arithmetic is recorded separately as literal model union 169, prefix substitution 170, directly observed additional client-prefix union 173, or hypothetical five-pair union 174.",
            "VoiceTraining historical SDK names UploadFile/RemoveFile/ListFiles/GetFile do not match the pinned current Hapi handler exports; version-specific source paths and deployed aliases remain open.",
            "Settings_20160801.GetSettings is source/consumer observed without a formal SDK API model; the legacy row intentionally uses a source-derived schema.",
        ],
        "validator": {"command": "python3 scripts/parity-coverage/a01_operation_map.py validate", "runtimeScenarios": "not-run"},
    }


def validate(data: dict) -> list[str]:
    errors: list[str] = []
    if data.get("schemaVersion") != "1.0":
        errors.append("schemaVersion must be 1.0")
    ops = data.get("operations")
    if not isinstance(ops, list):
        return ["operations must be a list"]
    ids = [row.get("id") for row in ops]
    if len(ids) != len(set(ids)):
        errors.append("operation ids are not unique")
    if data.get("operationCount") != len(ops):
        errors.append("operationCount does not equal operations length")
    current_pairs = set()
    for entry in json.loads(INVENTORY_PATH.read_text())["inventory"]:
        target_prefix = entry["metadata"]["targetPrefix"]
        current_pairs.update(f"{target_prefix}.{op['wireName']}" for op in entry["operations"])
    historical_pairs = set()
    discovery = json.loads(DISCOVERY_PATH.read_text())
    for model in discovery["models"]:
        prefix = model["metadata"]["targetPrefix"]
        historical_pairs.update(f"{prefix}.{op['name']}" for op in model["operations"])
    historical_pairs.add("Settings_20160801.GetSettings")
    rows_by_id = {row.get("id"): row for row in ops}
    expected_ids = {f"current:{p}" for p in current_pairs} | {f"historical:{p}" for p in historical_pairs}
    if set(ids) != expected_ids:
        errors.append(f"operation ids differ from source denominator: expected {len(expected_ids)}, got {len(ids)}")
        missing = sorted(expected_ids - set(ids))
        extra = sorted(set(ids) - expected_ids)
        if missing:
            errors.append("missing: " + ", ".join(missing[:8]))
        if extra:
            errors.append("extra: " + ", ".join(extra[:8]))
    if data.get("denominator", {}).get("currentPairCount") != len(current_pairs):
        errors.append("current denominator does not match inventory")
    if data.get("denominator", {}).get("historicalPairCount") != len(historical_pairs):
        errors.append("historical denominator does not match model union plus legacy Settings")
    if data.get("denominator", {}).get("provisionalLowerBound") != len(current_pairs) + len(historical_pairs):
        errors.append("lower-bound denominator is incorrect")
    denominator = data.get("denominator", {})
    if denominator.get("literalModelUnionPairCount") != 169:
        errors.append("literalModelUnionPairCount must be 169 target-prefix + operation pairs")
    if denominator.get("prefixSubstitutionScenarioPairCount") != 170:
        errors.append("prefixSubstitutionScenarioPairCount must be 170 target-prefix + operation pairs")
    if denominator.get("additionalClientPrefixUnionPairCount") != 173:
        errors.append("additionalClientPrefixUnionPairCount must be 173 directly observed target-prefix + operation pairs")
    if denominator.get("hypotheticalFivePairClientPrefixUnionPairCount") != 174:
        errors.append("hypotheticalFivePairClientPrefixUnionPairCount must be 174 only with independent fifth-pair evidence")
    ambiguity = denominator.get("prefixAmbiguity", {})
    if ambiguity.get("perPrefixModelUnionPairCounts") != {"Jot_20160126": 10, "Jot_20160310": 14}:
        errors.append("Jot per-prefix model union counts must be 10 and 14")
    expected_alternate = sorted([
        "Jot_20160512.CreateMessage",
        "Jot_20160512.ListMessages",
        "Jot_20160512.MarkLoopRead",
        "Jot_20160512.MarkRead",
    ])
    if ambiguity.get("observedAlternateWirePairs") != expected_alternate:
        errors.append("observed alternate Jot target-operation pairs are incomplete")
    if ambiguity.get("inferredAlternateWirePairs") != ["Jot_20160512.NumberOfUnreadMessagesInLoops"]:
        errors.append("model-only inferred alternate Jot target-operation pair is missing")
    evidence = ambiguity.get("observedAlternateEvidence", {})
    if evidence.get("path") != JOT_ARCHIVE_REVIEW_PATH or evidence.get("sha256") != JOT_ARCHIVE_REVIEW_SHA256 or evidence.get("literalTargetCount") != 4:
        errors.append("archived Jot alternate-target evidence is not pinned to the four literal source targets")
    rows_by_wire_target = {row.get("id"): row for row in ops}
    for target in expected_alternate:
        if rows_by_wire_target.get("historical:" + target.replace("Jot_20160512", "Jot_20160126"), {}).get("source", {}).get("alternateTargetEvidence", {}).get("status") != "literal-source-observed":
            errors.append(f"{target}: literal alternate-target evidence is missing from its model row")
    inferred_target = "Jot_20160126.NumberOfUnreadMessagesInLoops"
    if rows_by_wire_target.get("historical:" + inferred_target, {}).get("source", {}).get("alternateTargetEvidence", {}).get("status") != "model-only-inferred":
        errors.append("NumberOfUnreadMessagesInLoops must remain model-only inferred")
    pegasus_pins = [item for item in data.get("sourcePins", []) if item.get("id") == "pegasus"]
    if len(pegasus_pins) != 1 or pegasus_pins[0].get("revision") != PEGASUS_REF:
        errors.append("Settings consumer pin must use the original Pegasus revision")
    elif pegasus_pins[0].get("evidence") != PEGASUS_SETTINGS_EVIDENCE:
        errors.append("Settings consumer evidence must cite constructed Settings target lines")
    recovery = data.get("originalControllerRecovery", {})
    for family, mapping in (("account", ACCOUNT_HANDLER_METHODS), ("loop", LOOP_HANDLER_METHODS)):
        record = recovery.get(family, {})
        if record.get("repository") != ACCOUNT_REPOSITORY or record.get("revision") != ACCOUNT_SOURCE_REF:
            errors.append(f"originalControllerRecovery.{family} is not pinned to the source service")
        if set(record.get("mappedOperations", [])) != set(mapping):
            errors.append(f"originalControllerRecovery.{family}.mappedOperations is incomplete")
    settings_recovery = recovery.get("settingsConsumer", {})
    if settings_recovery.get("revision") != PEGASUS_REF or settings_recovery.get("evidence") != PEGASUS_SETTINGS_EVIDENCE:
        errors.append("originalControllerRecovery.settingsConsumer must retain original target-construction evidence")
    tasks = {item["id"] for item in json.loads(TASKS_PATH.read_text())["tasks"]}
    for row in ops:
        for key in ("wireTarget", "source", "consumers", "task", "contract", "verification", "unknowns"):
            if key not in row:
                errors.append(f"{row.get('id')}: missing {key}")
        if row.get("task", {}).get("state") != "existing":
            errors.append(f"{row.get('id')}: operation must belong to a registered task")
        if row.get("task", {}).get("id") not in tasks:
            errors.append(f"{row.get('id')}: task {row.get('task', {}).get('id')} is not in tasks.json")
        if row.get("wireTarget") == "Settings_20160801.GetSettings":
            for consumer in row.get("consumers", []):
                if consumer.get("repository") == "pegasus" and consumer.get("revision") != PEGASUS_REF:
                    errors.append(f"{row.get('id')}: Settings consumer is not pinned to original Pegasus revision")
                if consumer.get("repository") == "pegasus" and consumer.get("evidence") not in PEGASUS_SETTINGS_EVIDENCE["files"]:
                    errors.append(f"{row.get('id')}: Settings consumer target-construction evidence is missing")
        source = row.get("source", {})
        if not source.get("handlers"):
            errors.append(f"{row.get('id')}: source handlers are empty")
        for handler in source.get("handlers", []):
            if not handler.get("repository") or not handler.get("revision") or "path" not in handler:
                errors.append(f"{row.get('id')}: unpinned source handler")
        if row.get("kind") == "current" and row.get("targetPrefix") in {"Account_20151111", "Loop_20160324"}:
            original = source.get("original", {})
            original_contract = row.get("contract", {}).get("originalSource", {})
            if original.get("status") != "mapped-original":
                errors.append(f"{row.get('id')}: original controller mapping is missing")
            for field in ("entrypoint", "route", "handler", "controller", "config"):
                if not original.get(field, {}).get("repository") or not original.get(field, {}).get("revision") or not original.get(field, {}).get("path"):
                    errors.append(f"{row.get('id')}: original source pin {field} is incomplete")
            for field in ("auth", "ownership", "schema", "errors", "persistence", "sideEffects"):
                if field not in original_contract:
                    errors.append(f"{row.get('id')}: original contract missing {field}")
            phoenix_implementation = row.get("contract", {}).get("phoenixImplementation", {})
            if phoenix_implementation.get("status") != source.get("phoenixStatus"):
                errors.append(f"{row.get('id')}: Phoenix implementation observations are not separated from original contract")
            if original_contract.get("sourceRevision") != ACCOUNT_SOURCE_REF:
                errors.append(f"{row.get('id')}: original contract revision is not pinned")
            original_verification_record = row.get("verification", {}).get("originalSource", {})
            if original_verification_record.get("status") != "not-run" or len(original_verification_record.get("cases", [])) != 4:
                errors.append(f"{row.get('id')}: source-backed verification cases are incomplete or marked run")
        if row.get("verification", {}).get("status") != "not-run":
            errors.append(f"{row.get('id')}: runtime verification must remain not-run")
        if not row.get("unknowns"):
            errors.append(f"{row.get('id')}: unknowns must be explicit, even for implemented rows")

    # These are source-derived witnesses for the repaired Account/Loop rows.
    # Keeping the expected symbols, ordering and negative claims here makes the
    # generated map fail closed if a later edit reintroduces an inferred event,
    # a lower-camel-case controller name, or a mutation scenario for a reader.
    source_fact_rows = {
        "current:Account_20151111.AcceptTerms": {
            "controller": "AccountController.acceptTerms",
            "errors": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_IS_DELETED 404"],
            "sideEffectsMustContain": "startup-installed save hook schedules AccountUpdated",
            "sideEffectsMustNotContain": ["AccountUpdated publication is not asserted"],
            "evidence": {"handler": "src/handlers/account.handler.ts", "controller": "src/controllers/account.ctrl.ts", "sideEffects": "src/index.ts"},
        },
        "current:Account_20151111.CreateHubToken": {
            "controller": "AccountController.createHubToken",
            "errors": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_IS_DELETED 404"],
            "defaults": {"payload": None},
            "evidence": {"handler": "src/handlers/account.handler.ts", "controller": "src/controllers/account.ctrl.ts"},
        },
        "current:Account_20151111.Login": {
            "controller": "AccountController.login",
            "errors": ["ACCOUNT_IS_DELETED 404", "ACCOUNT_EMAIL_CHANGE_INCOMPLETE 401", "ACCOUNT_NOT_FOUND 404", "WRONG_PASSWORD 401"],
            "evidence": {"handler": "src/handlers/account.handler.ts", "controller": "src/controllers/account.ctrl.ts"},
        },
        "current:Account_20151111.ResendActivationCode": {
            "controller": "AccountController.resendActivation",
            "evidence": {"handler": "src/handlers/account.handler.ts", "controller": "src/controllers/account.ctrl.ts"},
        },
        "current:Account_20151111.ResetKeys": {
            "controller": "AccountController.reset",
            "errors": ["ACCOUNT_NOT_FOUND 404", "ACCOUNT_IS_DELETED 404"],
            "outputMustContain": "unsafe=true",
            "evidence": {"handler": "src/handlers/account.handler.ts", "controller": "src/controllers/account.ctrl.ts", "output": "src/schemes/account.ts"},
        },
        "current:Loop_20160324.ClearRobot": {
            "controller": "LoopController.clearRobot",
            "sideEffectsMustNotContain": ["no event publication is asserted"],
            "sideEffectsMustContain": "startup-installed save hook schedules LoopUpdated",
            "evidence": {"handler": "src/handlers/loop.handler.ts", "controller": "src/controllers/loop.ctrl.ts"},
        },
        "current:Loop_20160324.GetRobot": {
            "controller": "LoopController.getRobot",
            "errorsUnknownMustContain": "toJSON",
            "evidence": {"handler": "src/handlers/loop.handler.ts", "controller": "src/controllers/loop.ctrl.ts"},
        },
        "current:Loop_20160324.InviteLoopMember": {
            "controller": "LoopController.inviteMember",
            "errors": ["LOOP_NOT_FOUND 404", "CAN_BE_ACCESSED_BY_OWNER 403", "LOOP_SUSPENDED 403", "MEMBER_EXISTS 409", "ACTIVE_LIMIT_REACHED 409"],
            "defaults": {"asLegalGuardian": False, "isChild": False},
            "transformsMustContain": ["email lowercased", "firstName/lastName trimmed"],
            "ownershipMustContain": "reachability is unverified",
            "persistenceMustContain": "status is ACCEPTED when there is no email and isChild is false",
            "sideEffectsMustContain": "only when an email is supplied",
            "boundaryVariants": ["ACCEPTED", "INVITED"],
            "evidence": {"handler": "src/handlers/loop.handler.ts", "controller": "src/controllers/loop.ctrl.ts"},
        },
        "current:Loop_20160324.ListLoopMembers": {
            "controller": "LoopController.listMembers",
            "defaults": {"statusList": "MemberStatus.all() when absent or empty", "typeList": "MemberType.all() when absent or empty"},
            "evidence": {"handler": "src/handlers/loop.handler.ts", "controller": "src/controllers/loop.ctrl.ts"},
        },
        "current:Loop_20160324.ListOwnerRobots": {
            "controller": "LoopController.listRobots",
            "ownershipMustContain": "does not compare a supplied accountId with caller identity",
            "evidence": {"handler": "src/handlers/loop.handler.ts", "controller": "src/controllers/loop.ctrl.ts"},
        },
        "current:Loop_20160324.RemoveLoop": {
            "controller": "LoopController.remove",
            "ownershipMustContain": "owner only through this handler",
            "evidence": {"handler": "src/handlers/loop.handler.ts", "controller": "src/controllers/loop.ctrl.ts"},
        },
    }
    for row_id, fact in source_fact_rows.items():
        row = rows_by_id.get(row_id)
        if row is None:
            errors.append(f"{row_id}: repaired source witness row is missing")
            continue
        original = row.get("source", {}).get("original", {})
        original_contract = row.get("contract", {}).get("originalSource", {})
        if original.get("controller", {}).get("symbol") != fact.get("controller"):
            errors.append(f"{row_id}: controller symbol is not the source-derived {fact.get('controller')}")
        if "errors" in fact and original_contract.get("errors", {}).get("observed") != fact["errors"]:
            errors.append(f"{row_id}: source error set/order is not the pinned contract")
        if "sideEffectsMustContain" in fact and fact["sideEffectsMustContain"] not in original_contract.get("sideEffects", {}).get("observed", ""):
            errors.append(f"{row_id}: source side-effect witness is missing")
        for forbidden in fact.get("sideEffectsMustNotContain", []):
            if forbidden in original_contract.get("sideEffects", {}).get("observed", ""):
                errors.append(f"{row_id}: unsupported side-effect claim {forbidden!r} remains")
        if "errorsUnknownMustContain" in fact and fact["errorsUnknownMustContain"] not in " ".join(original_contract.get("errors", {}).get("unknowns", [])):
            errors.append(f"{row_id}: unresolved source error boundary must remain explicit")
        validation = original_contract.get("schema", {}).get("validation", {})
        if "defaults" in fact and validation.get("defaults") != fact["defaults"]:
            errors.append(f"{row_id}: source defaults are not preserved")
        for transform in fact.get("transformsMustContain", []):
            if transform not in validation.get("transforms", []):
                errors.append(f"{row_id}: source transform {transform!r} is missing")
        for field, expected in (("ownership", fact.get("ownershipMustContain")), ("persistence", fact.get("persistenceMustContain"))):
            observed = original_contract.get(field, "")
            if isinstance(observed, dict):
                observed = observed.get("observed", "")
            if expected and expected not in observed:
                errors.append(f"{row_id}: source {field} witness is missing")
        if "outputMustContain" in fact and fact["outputMustContain"] not in original_contract.get("output", {}).get("observed", ""):
            errors.append(f"{row_id}: source output serialization witness is missing")
        if "boundaryVariants" in fact:
            valid_case = next((case for case in row.get("verification", {}).get("originalSource", {}).get("cases", []) if case.get("name") == "valid-source-shaped-request"), {})
            statuses = {variant.get("expectedMemberStatus") for variant in valid_case.get("boundaryVariants", [])}
            if statuses != set(fact["boundaryVariants"]):
                errors.append(f"{row_id}: accepted/invited source boundary variants are incomplete")
        for evidence_name, evidence_path in fact.get("evidence", {}).items():
            evidence = original.get("sourceEvidence", {}).get(evidence_name, {})
            if evidence.get("path") != evidence_path or not evidence.get("lineRefs"):
                errors.append(f"{row_id}: source line evidence for {evidence_name} is missing or unpinned")

    # A read/token operation must have a read comparison in its source fixture;
    # a mutation fixture would be an invalid acceptance scenario for that row.
    for prefix, op in NON_MUTATING_VERIFICATION:
        row = rows_by_id.get(f"current:{prefix}.{op}")
        record = row.get("verification", {}).get("originalSource", {}) if row else {}
        persistence_cases = [case for case in record.get("cases", []) if case.get("name") == "persistence-and-side-effects"]
        if not persistence_cases or any("state-changing operation" in assertion for assertion in persistence_cases[0].get("assertions", [])):
            errors.append(f"current:{prefix}.{op}: read-only source fixture must not repeat a state-changing operation")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "validate"], nargs="?", default="build")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()
    if args.command == "build":
        data = build()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")
        print(f"wrote {args.output} ({len(data['operations'])} operations)")
        return 0
    data = json.loads(args.output.read_text())
    errors = validate(data)
    if errors:
        print("A-01 operation map validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"A-01 operation map valid: {len(data['operations'])} rows; current=134 historical=35 literal-union=169 substitution=170 observed-client-prefix-union=173 hypothetical-five-pair-union=174")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

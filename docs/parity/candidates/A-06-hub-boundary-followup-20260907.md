# A-06 Hub boundary follow-up (unverified)

This candidate records a source differential at the full Settings application boundary. The
expanded matrix ran the pinned `srv-settings-ws` `App.start()`/Hapi path and the Phoenix
internal Settings listener, with each case in a fresh process and a valid request sent after
the first case. The source and candidate Hub/Account edges were controlled loopback HTTP peers;
the public Account AWS face, production registry and deployment authentication were outside
this control.

## Source and candidate

- source: `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`
- source server: `@jibo/server@4.0.12`, Hapi `16.4.1`, Boom `5.1.0`
- source runtime image: `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` (`v8.9.4`)
- expanded baseline candidate: frozen `fc4445efff54f89e9f40fca6bc322acfbd72f236`
- repair candidate: this branch, based directly on `fc4445e`
- candidate workspace: `/home/shell/work/phoenix/.parity/worktrees/a06-hub-error-projection`
- local `@phoenix/*` links resolve into that workspace; no main workspace links are used.

The expanded harness and complete raw outputs are in
`/home/shell/work/phoenix/.parity/reviews/a06-hub-boundary-followup-20260907`. Its batched
source receipt records source-all runner hash `62dfa841ae50736e1def6772f2c7668abc2cda49bab48896cc55bc826e32755b`
and frozen candidate provider hash `ea5823425eb2ece061a423ef793a39d0f287fb1e8fb7c8a1d7f0d4acba3e522f`.

## Expanded frozen-baseline controls

The 17 cases covered object, array and string JSON payloads; Wreck smart JSON MIME matching;
truthy Hub error envelopes; an unbound Hub authority; relative, missing and maximum redirects;
header and body deadline boundaries; and a reset. All 17 source and candidate processes exited
zero and produced the valid second response. Hub, Account and client wire requests, raw headers,
response headers and lifecycle events are retained in every output.

The frozen `fc4445e` comparison was:

- 14/17 exact status plus decoded-body matches;
- 15/17 matches after classifying only the per-run Gateway Time-out log marker as diagnostic;
- 17/17 source and 17/17 candidate follow-up responses;
- 17/17 source and 17/17 candidate process exits zero.

The two machine-field differences were:

1. A truthy Hub error with `statusCode: 500` and `code: HUB_DOWN` produced source outer 500
   body `code: HUB_DOWN`; the frozen candidate omitted that code.
2. A refused Hub connection produced source outer 502 without a low-level `code`; the frozen
   candidate exposed `code: ECONNREFUSED`. The authority port embedded in the diagnostic
   message is independently chosen for each listener.

The reset row has equal status, error and other fields; only its timestamped log-marker text
differs. The following rows were otherwise exact: successful object payload, vendor `+json`
MIME, truthy 422 and string status errors, relative/missing/max redirects, final-header timeout,
and final-body completion. Top-level array/string, `application/x-amz-json-1.1`, `text/plain`
and missing-MIME responses follow the source smart-parser path and become the same generic
outer 500 at this Settings boundary.

## Bounded repair

The repair changes `settingsFace.js` only in the Hub/GetSettings error projection. A code present
in a Boom output payload is preserved even for status 500. A low-level `Error.code` is used only
when there is no Boom output payload, so transport details such as `ECONNREFUSED` do not enter
the source response envelope. The GetSettings generic-500 branch now passes the projected code
through when one is present. Person, Lasso, shared common service and public Account paths are
unchanged.

The focused test `packages/account/test/settingsHubErrorProjection.test.js` covers both branches:
a source-shaped 500 Hub code survives, while a source-shaped transport Boom omits its low-level
code. The full Settings test glob passed 75/75 tests.

Fresh source/candidate full-boundary controls for the repair are in
`/home/shell/work/phoenix/.parity/reviews/a06-hub-error-projection-20260907`:

- vendor `+json` success, valid 422, coded 500, connection refusal and reset;
- 5/5 functional status/machine-field matches after qualifying only the listener-selected
  refusal port and reset marker as diagnostics;
- 3/5 byte-decoded exact matches, with those two dynamic diagnostic differences retained;
- 5/5 source and 5/5 candidate follow-up responses, all process exits zero;
- source batch step and every candidate step have recorded argv, exit, timing, output path and
  output hash in `receipt-batch.json`.

The repair remains unverified pending lead review. Full production registry behavior, live Hub
deployment authentication and any public-face translation remain outside this slice.

The post-commit candidate-only receipt is `receipt-candidate-final.json` in the repair evidence directory. It reruns every candidate case against the retained source outputs after the repair revision is committed; the source side is not rerun or overwritten.

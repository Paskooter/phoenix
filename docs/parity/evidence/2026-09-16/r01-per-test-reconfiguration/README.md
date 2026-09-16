# R-01 — per-test hub reconfiguration, and all three lanes re-run with H07b closed

Date: 2026-09-16
Status: **substitution result.**

Two things changed since the 2026-09-15 lanes: the substituted hub can now be
reconfigured per test file, so the lane covers every file that exercises the
hub instead of four of them; and H07b is closed, so the one divergence those
lanes reported is gone.

## The scope reduction was recorded wrong, and is smaller than recorded

The previous note said four files "bring their own config (lasso,
listen-with-client-nlu, personal-report, proactive)". Two of those four do not
use the hub at all:

```
              startHub   HubServices   hubPort
lasso            0            0           0
personal-report  0            0           0
```

`lasso.test.ts` drives `LassoService` directly and `personal-report.test.ts`
drives the report skill against it. Neither is a hub-substitution case, so
their absence from a *hub* lane is not a scope reduction — they belong to the
skills-service lane. The real gap was **two** files, not four:
`listen-with-client-nlu` and `proactive`.

## How per-test reconfiguration works

The original hub is constructed fresh in every describe's `beforeEach` with
that file's registry. An out-of-process hub is configured once at startup and
cannot follow, which is why the lane previously ran only the files sharing
`TEST_SKILL_CONFIG` — running the others would have compared two differently
configured hubs, which is not a substitution result.

`scripts/parity-r01-substitution/hub-supervisor.mjs` owns the **unmodified**
`packages/gateway/src/index.js` and exposes one control route.
`integration.startHub` posts the registry the test was about to build; the
supervisor writes it in the registry shape the gateway loads and restarts the
gateway on the same port before the describe runs.

It is deliberately not a hot-reload endpoint inside the gateway. Adding a
reconfiguration API to the production hub for the benefit of its own parity
test would change the thing being measured.

Lanes that never reconfigure are untouched: the supervisor starts once from the
registry `setup` generated, and the all-original control never sets
`R01_HUB_EXTERNAL`, so it builds its hub in-process exactly as before.

## Result — all three lanes agree

| stack | passing | failing | files | reconfigures |
| --- | --- | --- | --- | --- |
| all-original (control) | **13** | 2 | 6 | n/a (in-process) |
| Phoenix gateway only | **13** | 2 | 6 | 13 |
| all-Phoenix (gateway + NLU + skills) | **13** | 2 | 6 | 13 |

The two failures are identical on all three, **including the all-original
control**:

```
1) Listen with external agents  A request with a second Dialogflow agent provided
2) Listen with external agents  A request with bad second Dialogflow agent provided
```

They fail on the reference stack too, so they are not substitution differences.

The case the previous lanes diverged on now passes on every lane:

```
✓ Early EOS and ASR hints (including templated ones)   control 826ms · hub 778ms · all-Phoenix 713ms
```

That is H07b closing, observed from the original suite rather than asserted.

## The reconfiguration is load-bearing — falsified

A mechanism that silently did nothing would still show 13/2, because five of
the six files would be unaffected. Withholding `R01_HUB_CONTROL` so
`startHub` skips the post, with the hub left holding the shared
`TEST_SKILL_CONFIG` registry:

```
12 passing
3 failing
3) Listen with client NLU  ClientNLU: Intent router intent 'referenceLiveLongProsper'
   shold pass memo PROSPER to a skill
```

That file's own registry sets `memo: "PROSPER"` for LIVE_AND_PROSPER while
`TEST_SKILL_CONFIG` sets the intent name, and the test asserts the skill
received `SLIM: 'Node1' MEMO: 'PROSPER'`. It fails by name without the
reconfiguration and passes with it, so the mechanism is doing the work the
result depends on.

## Side-effect comparison — whole WS message streams

`compare-traces.mjs` diffs every message the robot client received, not just
the fields the suite asserts. Only per-run identifiers and elapsed times are
normalised.

**Control vs Phoenix gateway: 8 transactions each, 4/8 byte-identical.** All
four differences are in the ASR layer and none is a hub behaviour difference:

| trace | difference |
| --- | --- |
| `livelongandprosper-earlyEOS_live` | confidence `0` → `0.9938` |
| `livelongandprosper` | confidence `0.9737` → `0.9666` |
| `test_audio` | confidence `0.9340` → `0.9507`; text `testing testing 1 2 3` → `testing testing one two three` |
| `test_audio_long` | confidence `0.9544` → `0.9494`; same text difference |

The first is H07c: Google reports `0` on a FAST_EOS interim, Parakeet reports
the decoder's real score. The confidence spread is two different recognizers on
the same audio.

The digit/word difference is real at the transcript level and **measured not to
change anything downstream**. Parsed through the running Phoenix parser, each
pair is identical in intent and in every slot value:

```
testing testing 1 2 3          -> partialRecognition      {RecognizedPhrase: Testing}
testing testing one two three  -> partialRecognition      {RecognizedPhrase: Testing}
set a timer for 5 minutes      -> (clock launch)          {minutes: "5", domain: timer}
set a timer for five minutes   -> (clock launch)          {minutes: "5", domain: timer}
count to 10                    -> requestCountToNumber    {CountNumber: "10"}
count to ten                   -> requestCountToNumber    {CountNumber: "10"}
set the volume to 5            -> volumeQuery             {domain: settings}
set the volume to five         -> volumeQuery             {domain: settings}
```

The grammars normalise number words through their own factories, so both forms
reach the same intent with the same slots. `services/parakeet-asr/app/normalize.py`
exists for this and stays opt-in per request, on the reasoning recorded in its
docstring: rewriting "one" blindly corrupts its pronoun sense for no parity gain.

(One correction to that docstring while checking it: it records
`set the volume to five -> volumeToValue {volumeLevel: '05'}`. The running
parser returns `volumeQuery` for both forms. The *equality* it claims holds;
the example intent name does not.)

**Control vs all-Phoenix: 8 vs 10 transactions**, 4 identical. The two extra
traces are `simulatedASRTest-do_you_like_being_Jibo-agents_someAgent*`: on the
original parser those requests 500 before any message flows, while Phoenix's
NLU answers them, so messages exist to capture. Phoenix doing more than the
reference on the external-agent path is the already-recorded divergence behind
those two failures.

## A defect this lane found in its own teardown

S-06 pins `packages/gateway/resources/skills/` to an exact file list, so the
generated registry must be removed after a run. Teardown was changed from
removing two known filenames to `git checkout` + `git clean -fq`, because the
supervisor writes one manifest per skill id in whatever registry a file
supplies and a file naming a skill other than `example` would leave one behind.

That change was wrong and S-06 caught it immediately:

```
S-06: every hub skill index and manifest file matches the pinned-source digest
skills dir file count
35 !== 33
```

The generated files are **gitignored**, and plain `git clean -f` skips ignored
files. `-x` is what makes it consider them. Teardown now uses `git clean -fqx`
scoped to that path and then runs S-06 itself, printing the dirty state rather
than leaving the failure for an unrelated later run. Verified: 11 files, S-06
4/4 pass.

## Reproduction

```bash
scripts/parity-r01-substitution/run.sh setup
R01_TRACE_DIR=/work/r01-traces/baseline     scripts/parity-r01-substitution/run.sh baseline
R01_TRACE_DIR=/work/r01-traces/hub          scripts/parity-r01-substitution/run.sh hub
R01_TRACE_DIR=/work/r01-traces/all-phoenix  scripts/parity-r01-substitution/run.sh all-phoenix
node scripts/parity-r01-substitution/compare-traces.mjs <traces>/baseline <traces>/hub
scripts/parity-r01-substitution/run.sh teardown
```

Traces are kept privately under the R-01 scratch directory, not in Git.

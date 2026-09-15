# Does the substitution lane actually detect anything?

Date: 2026-09-15

Three lanes all landing near 8 of 9 means nothing if the harness cannot tell a
correct Phoenix from a broken one. It could be silently falling back to the
original stack, or never reaching Phoenix at all. So: break Phoenix on purpose
and check that the lane says so.

## Method

One line in Phoenix's gateway, so the match it reports carries a name no skill
is registered under:

```js
const matchData = { skillID: `${skillID}-MUTANT`, launch: !isUpdate, onRobot };
```

Each step confirms the gateway is **listening** before running the suite, and
the baseline is re-measured on clean code first.

## Result

| run | passing | failing |
| --- | --- | --- |
| baseline (clean code) | **8** | 3 |
| mutated | **5** | **6** |
| restored | **8** | **3** |

The mutation added exactly three failures, and they are exactly the three cases
that assert `match.skillID`:

```
Intent router 'live long and prosper'
Listen with simulated ASR 'live long and prosper' … memo PROSPER
Listen with simulated ASR 'do you like being Jibo' … doesJiboLikeThing
```

Nothing else moved, and restoring the line returned the run to 8 / 3 with the
same three known failures. The lane detects a one-field defect in the
substituted service, in precisely the tests that inspect that field.

## The first attempt at this control was wrong, and how it looked

The first run of this control reported a dramatic result — a crash with zero
passing — and was briefly read as a successful detection. It was not. The
gateway had **exited on startup**:

```
ENOENT: no such file or directory, open '.../resources/skills/skills-r01.json'
```

because the generated registry had been deleted earlier to satisfy S-06. The
mutated run and the restore run both failed for that reason; the mutation never
entered the picture. Two tells were visible and missed: both logs were
byte-identical in size, and the transaction died *before start of speech*, which
a `skillID` string change cannot cause.

The shapes are worth separating, because they are easy to confuse:

| symptom | means |
| --- | --- |
| specific assertions fail, others still pass | the service is running and wrong |
| the transaction dies before SOS, nothing passes | the service is not running at all |

`scripts/parity-r01-substitution/run.sh` now refuses to run any suite against a
service that has not reported a listening line, and writes and removes the
generated registry as a pair, so neither trap can recur silently.

## What this licenses

It licenses reading the lane's results as evidence about Phoenix rather than
about the harness. It does not make R-01 verified: side-effect capture, the
excluded four test files, and H07b are all still open.

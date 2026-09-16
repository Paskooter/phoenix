# earlyEOS is live-correct and will never fire on Moth — because no BE asks for it

Date: 2026-09-16
Status: **scope note on the closed H07b, not a new claim and not a defect.**

The owner reported that Jibo does not cut them off when they say "live long and
prosper". That is accurate, it is not a Phoenix fault, and it will stay true on
this robot no matter what Phoenix does.

## Where earlyEOS comes from

`earlyEOS` is supplied by the robot, inside the LISTEN request's `asrData`. The
hub only reads it:

| | |
| --- | --- |
| reference | `packages/hub/src/listen/ListenTransactionHandler.ts:498` — `config.earlyEOS = asrData.earlyEOS ? ASRUtils.cleanHintsEOS(asrData.earlyEOS) : undefined;` |
| Phoenix | `packages/gateway/src/listenTransaction.js:343` — `config.earlyEOS = asrData.earlyEOS ? cleanHintsEOS(asrData.earlyEOS, false, this.log) : undefined;` |

Same field, same place, same guard. The wire name matches the contract
(`packages/contracts/src/messages.js:77`).

## No BE installed on Moth populates it

`grep -c earlyEOS index.js` over every skill slot on the robot:

| slot | occurrences |
| --- | --- |
| `phoenix-be-11-0-1-parity` (running) | 0 |
| `phoenix-be-11-0-2-parity` | 0 |
| `phoenix-be-11-0-3-parity` | 0 |
| `phoenix-be12-parity` | 0 |
| `@be/be` | 0 |
| `be2` | 0 |
| `hermes-be` | 0 |

`asrData.earlyEOS` is therefore always absent, `config.earlyEOS` is always
`undefined`, and no `fastEOSRegex` is ever built. A spoken phrase cannot be
truncated on this robot. It would not have been truncated against the real
cloud either, for exactly the same reason.

## The machinery itself is verified against the live recognizer

H07b's claim is that Phoenix streams and honours a trigger when one is
requested, and that is measurable without a BE. Driving `ParakeetASRSession`
against the live Parakeet service (`http://192.168.1.252:6972`, api_version
0.2.0) with the original suite's `do_you_like_dogs.raw`:

| earlyEOS | transcript | confidence | finalized |
| --- | --- | --- | --- |
| *(none)* | `do you like dogs` | 0.9197 | 1571 ms (natural EOS) |
| `["you"]` | **`do you`** | 0.9402 | **883 ms**, `annotation: FAST_EOS` |

Interims arrived incrementally (`do you` → `do you like` → `do you like dogs`)
with real per-result confidences from the decoder, not synthetic ones.

## What this means for a live demonstration

Asking Jibo to cut you off mid-sentence is not a demonstration this robot can
give. Demonstrating it needs a skill that puts a phrase in `asrData.earlyEOS`;
none of the installed builds does. Recorded here rather than left as an
apparently-broken feature the owner keeps re-testing.

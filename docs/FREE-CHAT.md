# Free AI chat (offline candidate)

Jibo's existing chit-chat launch can answer through a Phoenix-hosted chat model,
with his normal eye visible. This is **not Agent Mode** and needs no member
computer or agent harness. Short answers are the default; Account and the native
Settings menu offer detailed answers and a **Free AI chat** switch. Off executes
the original chit-chat library/graph without modifying it. Songs, dances and
specific game commands stay on their native/classic paths.

A reply may ask to keep talking. Only after native TTS completes does Jibo open
one ordinary Jetstream local turn. Silence, STOP, head touch, a new global turn,
native handoff, four AI answers or two minutes ends the session. The microphone
has a 3-second opening budget, 9 seconds to begin speaking, 30 seconds of speech
and 10 seconds for recognition. It never reopens a timed-out capture. The model's
boolean requests a follow-up; it does not own the microphone. Saying “more detail”
during an offered follow-up repeats the previous question with the detailed
allowance. A fresh question containing “in detail” also requests that allowance.
Physical behavior is not certified by the offline tests.

## Account and robot API

- `GET /api/free-chat`: human portal session; own preference, allowance and key-present boolean.
- `PUT /api/free-chat`: same-origin human session; `{enabled:boolean, detail:"short"|"detailed"}` (either field).
- `PUT /api/free-chat/key`: same-origin human session; `{key:string|null}`. Null removes it. Never returns the key/ciphertext.
- `POST /api/free-chat/robot/settings`: robot SigV4; `{}` reads, the preference fields above write.
- `POST /api/free-chat/robot/complete`: robot SigV4; `{text, detail?, history?}`. History is at most six text-only user/assistant messages.
- Robot completion returns `{mode:"classic"}` when off; otherwise `{mode:"ai",text,keepTalking,detail}`.

Account verifies the signed raw bytes, not public identity headers or cookies.
The robot must have exactly one current household, whose active human owner is
the billed/limited account. Multiple robots under that owner share the allowance.
The identity/ownership/session version is checked again after asynchronous body
and provider waits. A change of ownership cannot release an old answer.
Classic forwards only these two fixed robot routes to Account, retaining the
signed host/method/path/body and dropping cookies/asserted identities. Node's
HTTP client preserves the signed Host; native fetch did not in the offline test.

Requests are private-parsed (16 KiB, 5 seconds), responses bounded (64 KiB), and
the provider sequence has one 20-second deadline after the first durable reservation (never reset for overflow). Local synchronous durability work is not a bounded network wait. Fixed machine errors
only; no arbitrary upstream body is returned, spoken or passed to application
loggers. No prompt/reply/history is persisted by this chat service. Existing
voice/ASR/History infrastructure and external providers have separate retention
policies; this change does not claim to erase or disable those systems.

## Inference and limits

The owner key tries `google/gemma-4-26b-a4b-it:free` first, then only
`deepseek/deepseek-v4.1-flash` for capacity/unavailability errors or the reserved
free pool's exhaustion. No floating router, provider fallback, tools, tool
history, media, web plugin, browser, search, redirects, client model selection
or arbitrary client endpoint. Free route authentication/policy/invalid-response
failures do not silently enable paid overflow. Provider requests require ZDR,
data-collection denial, parameter support, zero per-request/image charges and
explicit maximum input/output prices. The filters may leave **no eligible free
provider**; they are never weakened to get an answer.

Engineering defaults (not a promised provider allocation):

| Limit | Default |
| --- | ---: |
| Owner-funded provider attempts per account per UTC day | 50 |
| Attempts per account per UTC minute | 4 |
| Owner-funded attempts globally per UTC day | 5,000 |
| All attempts globally per UTC minute | 60 |
| Free owner pool | 900/day, 20/minute |
| In-flight requests | one/account, two globally |
| Global daily spending admission cap | **$5**, one exported constant |
| Account daily spending admission cap | $0.50 |
| Non-resetting lifetime spending fuse | $150 |
| Short / detailed output allowance | 160 / 512 tokens |

An attempted free call and an overflow call consume two requests. Provider free
limits apply to the owner's shared key, not to each member. The chosen allowance
and dollar constants require root's approval before enabling a deployment.

Accounting reuses the inference prototype's exact `agentInference/ledger.js`
(shared implementation, not another storage engine) and its reservation/quota
algorithm and crash tests. Every provider attempt is reserved with synchronous
file fsync, atomic rename and directory fsync **before** dispatch. Failed,
uncertain, cancelled and crashed requests are not refunded. Daily counters reset
at UTC midnight, lifetime spending does not; clock rollback refuses admission.
Missing/corrupt ledgers and another writer fail closed. A crash leaves the lock;
never automatically remove/reclaim it or initialize new state at boot.

For each paid attempt reserve the entire pinned 1,048,576-token context at
$0.05/M input plus 512 output at $0.50/M, rounded up to **52,685 micro-USD**.
The provider request enforces those same ceilings. This deliberately underuses
the budget: the $5 daily limit admits at most 94 paid attempts, even if actual
replies cost less. This admission bound assumes the provider context/price
contract; taxes, other key consumers, provider contract violations and privileged
ledger rollback are outside it. Use a dedicated capped provider key as well.
Multi-process/multi-host operation requires one transactional shared writer,
not separate per-replica ledgers.

## Optional personal key

The account can supply an OpenRouter key in Account. AES-256-GCM encrypts it
with a server-held 32-byte secret, random nonce and the account digest as AAD.
Only ciphertext and key-present status persist; only the provider receives the
plaintext. Removing/replacing it cancels pending work and never resets counters.
The personal key bypasses the shared account/day and owner-dollar allowance,
not safety limits (20 attempts/minute/account, global concurrency/minute,
bounded body/output/session). Phoenix never falls back to the owner's key if a
personal key fails. Free first/DeepSeek overflow and privacy ceilings stay fixed.

Only OpenRouter's OpenAI-compatible API is implemented. Arbitrary compatible
origins are deliberately not accepted from members: supporting another provider
needs an operator allowlist, SSRF/redirect isolation, an explicit model/context/
price/privacy contract and the same mock transport tests. It must never turn
this text-only skill into an agent or a generic proxy.

## Provisioning (root only; not done by the worker)

- `PHOENIX_FREE_CHAT_ENABLED=true` is the default preference, shown in configCatalog.
  An account's explicit ON/OFF choice wins. Account and robot switches use the same data.
- Provision `PHOENIX_FREE_CHAT_API_KEY`, `PHOENIX_FREE_CHAT_ENCRYPTION_KEY` (64 hex
  characters encoding 32 random bytes), and `PHOENIX_FREE_CHAT_LEDGER` outside the release.
  The catalog displays private server settings read-only; no secret is editable
  through a member form except that member's own provider key.
- Initialize **once** with `node scripts/init-free-chat-usage.mjs /private/path/chat-usage.json`.
  It refuses overwrite. Never use the Agent prototype's actual ledger file for chat.
- Without provisioning, the per-account default is still ON but availability is
  false; the console explains it and the OFF choice can still be saved. No cloud
  call is made. The private native candidate reports temporary unavailability;
  it does not claim to be a live release.
- Recover a crashed lock only after proving its exact writer is dead and preserving
  all counters. Back up the encrypted ledger and encryption secret together; losing
  the secret requires members to replace their key, not silently using owner funds.
- Do not deploy or publish robot source. Root must integrate the separate private
  Nimbus/Settings candidate, build from the complete BE tree and run the normal
  release/OTA integrity and full combined-suite gates under existing guardrails.

## Offline verification

Focused suites only; no paid requests, deployment, hardware or posting:

```sh
TMPDIR=/owned/output node --test --test-concurrency=1 \
  packages/account/test/freeChat.test.js \
  packages/account/test/portalAuth.test.js \
  packages/account/test/securityHardening.test.js
CHROME_BIN=/path/to/chrome TMPDIR=/owned/output node --test \
  packages/account/portal/test/free-chat.browser.mjs
```

Private BE has `tools/test/free-chat.test.js`, runnable both on modern Node and
pinned Node 6.5. It drives the actual Nimbus and Settings bundled methods with
synthetic native boundaries. The server suite exercises real Account and Classic
HTTP and a loopback-only provider, including quota/cap/key isolation, private
input errors, cancellation, transfer, restart and real SIGKILL after reservation.
Full release, real provider availability/quality/latency and physical eye/ring/
TTS/microphone/STOP acceptance remain with root.

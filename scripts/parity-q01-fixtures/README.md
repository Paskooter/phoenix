# Q-01 archived fixture lane

Run the independent replay with:

```sh
npm run parity:q01:fixtures
```

`fixtures.json` is an inventory of `jiborobot/srv-gqa-ws` at revision
`ebe1a7d38f511570060c1fbf61bec89d58419b26`, read from the Jibo MCP Gitea
reader. The moved live suite is recorded from `jiboV2/pegasus@dev`:
`packages/integration-tests-ext/src/answer.ts` (11 cases) and `news.ts` (one
sequence case). No web source was used.

The runner checks the 11 archived GQA MIM files and all 77 prompt rows,
replays 28 archived answer rows and all 12 async provider rows, and decodes
the three source fake-provider routes before passing their payloads through
the current Bing, Wikipedia, and Wolfram adapters. It also checks JCP/display
envelopes, metadata, account and attribution persistence, malformed-provider
HTTP error envelopes, default routing, and opt-in provider configuration.

The news closure checks the three source NEWS MIMs and five prompt rows, all
three source route aliases, child/adult speaker selection, the five-headline
sequence, analytics, and empty/error behavior through the current
source-shaped news service.

The integration text files are input corpora without expected output goldens.
The two complete files account for 340 observed rows. The `beta3-4902.txt`
filename is retained as a source label only: Gitea metadata reports 177,307
bytes, while the bounded MCP read observed 69,069 code units and 2,073
nonblank rows ending mid-line at `tha`. The runner does not claim a 4,902-row
replay.

The moved `answer.ts` cases remain live-provider assertions. The moved
`news.ts` sequence has a local source-shaped route/MIM and sequence replay, but
its live AP/vendor execution remains unexecuted because the source file has no
response golden and the lane does not contact the live provider. Personal
Report news assets are not substituted for this source contract.

The runner includes paired omission and value-corruption controls. It rejects
an omitted async row, a modified MIM prompt, and a one-byte-equivalent Bing
thumbnail URL mutation (`%252C` to `%2520`).

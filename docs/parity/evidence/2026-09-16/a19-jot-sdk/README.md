# A-19 Jot SDK acceptance receipt

The twelve-step TLS SDK receipt accepted on 2026-09-16 previously existed only
in ignored `.parity/runs/a19-jot-sdk/receipt.json`. On 2026-10-03 it was preserved
as [receipt.public.json](receipt.public.json) so a fresh checkout can validate
the ledger evidence without relying on private local files.

The public copy retains the original client/model/transport, twelve step
outcomes, push fan-out count, durable-store counts, overall result and errors.
Destination tokens and push payloads are omitted; the original receipt's
SHA-256 and the sanitization details are retained. The original file is untouched.
This is preservation of the historical passing result, not a new SDK run.

Reproduction: `node scripts/parity-a19-jot-sdk/run.mjs --out .parity/runs/a19-jot-sdk`.
The runner uses the archived client and isolated fixture services; it does not
contact a robot. Party-era exclusions are recorded in
[the separate archive review](../a19-party-era/README.md).

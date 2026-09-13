# S-11 SettingsClient HTTP differential

This lane compares the pinned Pegasus `packages/report-skill` `SettingsClient`
with Phoenix using the same 43-case matrix. Direct rows exercise conversion;
runtime rows call `getUserPrefs` or `getSettings` through a local loopback
Settings peer. The peer records the request method, path, all headers (with the
ephemeral host normalized), exact body bytes, parsed body, and status. Error
receipts retain the error name/message/code, stable response headers, status,
and transformed response data.

The source runs in
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`
with Docker `--network none`. The comparator pins the literal 43-ID order and
count, the inventory SHA
`caac62ef04775f8cc02496adc7aaf626a7d33fba0e9cb8d53fd034be6b5e261a`, and the
full canonical matrix semantic SHA
`32739ae87fae1c0928d0acaa6db3ffe2230ac09187df1acacc2655beca39ae80` outside
`matrix.json`; both receipts repeat those pins. The matrix and both runner file
hashes are checked by the comparator. Output encoding preserves `undefined`,
`NaN`, infinities, and empty response bodies.

Run the complete lane from this worktree:

```bash
node scripts/parity-s11-settings-http/run.mjs
```

Use `--reference PATH` for a prepared Pegasus checkout and `--out DIR` for
receipts and logs. The output directory contains `source.json`,
`candidate.json`, `comparison.json`, `source.log`, `candidate.log`, and
`negative-control.log`. The negative-control phase must reject a shrunk row
set, reordered rows, a rewritten converted value, a rewritten error, and a
rewritten request record. Paired falsifiers reauthor both receipts alongside
shrunk/reordered inventories and rewritten mode/HTTP descriptors; the static
matrix semantic hash still rejects those rewritten artifacts.

The matrix covers commute modes `0..3`, negative/fractional/NaN/named-string/
missing values, all seven archived `commute.complete` missing fields, zero and
out-of-range coordinates and work times, malformed/null/undefined settings,
default preferences for no speaker/not-in-loop/child, adult account/loop/
`transId` request bodies and headers, missing credentials, HTTP errors, and
invalid or missing report settings responses.

# Original Account client evidence tools

These source-dependent probes run explicitly with the pinned archive inputs; they are outside Node's automatic `test/` discovery. Use `originalClientCompat.node8-wire.evidence.js` for the current Node 8 wire comparison.

The other three generators and their committed captures preserve historical reviews. Their old redacted JWT, primitive-body, and modern Keep-Alive expectations are superseded. Running them against the corrected implementation can fail; use their original revision to reproduce their historical result. Do not change those captured results to imply they passed against current code.

Normal portable regression coverage remains in `test/createHubTokenSigv4.test.js`; the current source-dependent generator is also run separately before acceptance.

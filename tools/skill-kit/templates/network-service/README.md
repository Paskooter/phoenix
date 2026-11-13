A background HTTPS poller with a loopback-only status service. It fetches example.com
once at startup and every 60 seconds, records HTTP status and byte count in memory, and serves
that bounded summary at http://127.0.0.1:8897/status on Jibo. It does not save response bodies,
credentials or household data. There is no Home tile. Like every skill, it runs with full access.

```sh
node tools/skill-kit/cli.mjs new my-network --template network-service
node tools/skill-kit/cli.mjs check my-network --syntax-node "$NODE_6_5"
node tools/skill-kit/cli.mjs pack my-network --out my-network/out
```

Turn on Allow test builds on Jibo, run install, review permissions and physically tap
Install full-access test. Read the status endpoint from your own existing SSH shell on Jibo.
Edit config.js for your HTTPS endpoint and polling period. If you change port 8897, change
incomingPorts in app.json too. The declaration reserves a collision claim; it does not bind a socket.
Polls never overlap. Responses are capped at 65,536 bytes and requests have a 10-second timeout.
No redirects are followed. TLS verification stays enabled. stop clears the timer, aborts its own
request, destroys its own status connections and awaits the server close. An unavailable remote API
is reported in status, not mistaken for failed host startup. A listener failure rejects startup.
Do not expose a listener on the LAN without authentication, authorization and a privacy review.
See the skill guide's Cookbook and App context pages.

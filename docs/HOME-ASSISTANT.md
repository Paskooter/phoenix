# Home Assistant connector beta

Phoenix lets opted-in Jibos control Home Assistant Assist devices through an outbound authenticated TLS WebSocket. Owners install the standalone [Phoenix integration](https://github.com/Paskooter/phoenix-home-assistant), link selected robots in the console's **Home Assistant** page, and choose entity exposure using Home Assistant's own Assist controls. The integration does not require a public HA URL, port forwarding, an LLM, or a paid remote-access service.

The owner instructions, exact tested phrases, compatibility matrix, troubleshooting, upgrade/removal steps, and beta hardware limitations are maintained in that repository's README and release notes. The first release uses English and the built-in `home_assistant` conversation agent explicitly. Direct light/lamp/switch phrases, brightness, tested colors, and named scene/script phrases are selected before execution. `Ask Home Assistant to…` is the explicit fallback for custom Assist sentences. Arbitrary utterances never probe the executing conversation API. Existing recognized Hue lighting intents redirect for linked robots; Hue setup/delete/help and robots without a binding keep existing routes. Answers inside an active skill remain with that skill unless a new wake phrase begins a global turn.

## Server configuration

Use the authenticated Gateway configuration: `ETCO_hub_disableAuth=false`, `ETCO_hub_accountUrl` pointing to the private Account service, a provisioned Hub signing secret, and the same nonempty `ETCO_account_internalPeerToken` in Account and Gateway. The native launcher and Compose definition pass the peer token to both. An unauthenticated Gateway cannot enable home actions. Do not expose private Account/Hub listeners or `/internal/` routes to the Internet.

The browser links through same-origin `/api/home-assistant` endpoints. Add the dedicated `location = /api/home-assistant/connect` block from `deploy/nginx/phoenix.conf` to the portal's HTTPS virtual host. It must proxy to Account, forward WebSocket Upgrade/Connection headers, disable buffering, and allow the connector's 20-second ping interval. Preserve existing instance pages, branding, analytics, and other proxy locations. All owners use a trusted HTTPS Phoenix origin; HA's local address is never submitted to Phoenix.

Native releases must use `scripts/deploy-native-release.sh <reviewed-commit>`, with the launcher's `PHOENIX_DEPLOY_RUNTIME_DIR`. Require fresh Hub and OTA activity state and a full sixty seconds without new activity as described in [DEPLOYMENT.md](DEPLOYMENT.md). Account connector sockets and heartbeats are separate from Hub voice transactions and do not reset that quiet minute. Actual listen/execute/reply work uses the existing Gateway transaction and admission lifecycle. Do not bypass deployment guards.

## Authentication and storage

Only an authenticated owner can generate a code for their live owned robots. Codes have 80 bits of randomness, expire after ten minutes, work once, and persist only as SHA-256 verifiers. Generating a new code replaces that owner's pending code. A successful exchange returns a random installation credential once; Phoenix stores its verifier plus durable owner/loop/robot bindings. The HA config entry stores that credential locally. Status responses omit credentials and verifiers.

Commands originate from the Gateway's verified robot identity. Account rechecks its account ID, friendly ID, access-key ID, owner, and loop records. Client household IDs, context fields and tracing headers confer no authorization. Removing a robot, deleting an account, suspending a loop, or changing ownership invalidates access; transferring ownership back does not resurrect a revoked credential. Owner disconnect or integration removal revokes the installation. A loop suspension requires relinking after restoration.

The new Account collections are `homeAssistantInstallations` and `homeAssistantCodes`. Existing store files load with empty collections. Writes retain the existing atomic private snapshot behavior. Back up the account store before upgrading; treat it as private even though raw connector credentials are not stored. Downgrading to a server that does not preserve these collections loses the binding on its next write; owners must relink after returning to this release.

## Protocol and reliability

[Protocol version 1](https://github.com/Paskooter/phoenix-home-assistant/blob/main/docs/protocol.md) uses session and request UUIDs, bounded messages, a 7.5-second command deadline, and plain speech results. There is one pending command per robot and at most four per installation. The server sends only on a currently ready connector; it never queues or retries actions after disconnect. Late and duplicate results are ignored. HA persists request-ID tombstones before execution, discards expired work, and never replays commands after reconnect or restart.

A lost result can mean the action already executed. Jibo says he could not confirm it; he does not claim definite failure or run it twice. Partial success is spoken as partial. The integration corrects HA success responses that include currently unavailable targets rather than repeating an inaccurate success statement. Ordinary responses use the existing Jibo skill builder; HA text is escaped for ESML, never interpreted as markup.

## Reproducible validation

```sh
node --test packages/account/test/homeAssistant.test.js packages/gateway/test/homeAssistant.test.js
node scripts/home-assistant/portal-smoke.mjs
# From the separate integration checkout, with its documented test environment:
PHOENIX_SERVER_DIR=/absolute/path/to/phoenix .venv/bin/python -m pytest -q -s
```

The combined tests run a disposable real Home Assistant instance with synthetic lights, switches, scenes and scripts, the real built-in conversation agent, real Account persistence/authentication and Gateway robot envelopes, and an isolated TLS edge. They cover config flow, reauthentication/reconfiguration, reload/unload/removal, exposure, availability/partial success, deduplication, deadlines, reconnect, revocation, forged identity/context, and ordinary routing conflicts. Private physical evidence remains outside Git. A synthetic transcript-to-result latency excludes microphone ASR, Internet transport, and robot TTS; it must not be represented as measured owner latency.

HA-to-Jibo control entities are not part of this beta. There is no new robot OTA bundled with the integration. Native cloud-skill execution must be checked on hardware before claiming a firmware version works.

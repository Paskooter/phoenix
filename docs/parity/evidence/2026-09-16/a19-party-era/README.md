# A-19: the party-era Jot operations are correctly unimplemented

Date: 2026-09-16
Archive: `jiborobot/srv-jot-ws-archived` (pvindex), all 229 commits

## The question

Twelve Jot operations appear in the SDK models but not in Phoenix:

```
CreatePart  UpdateMessage  RemoveMessage  GetMessages
ListIncomingMessages  ListSentMessages  ListInbox  ListSent
MarkDelivered  MarkAllDelivered  MarkSeen  MarkAllSeen
```

A previous note recorded these as "no matching-era handler recovered" and
proposed a permanent exclusion. Before accepting that, the archive was searched
exhaustively — every commit, not just branch tips.

## What the archive actually holds

**Seven have no implementation anywhere.** Verified by cloning the repo and
grepping every one of its 229 commits:

```
CreatePart         0 occurrences
UpdateMessage      0
GetMessages        0
ListInbox          0
MarkAllDelivered   0
MarkAllSeen        0
```

(`ListSent` appears only as a substring of `ListSentMessages`.) They exist only
in SDK `.normal.json` models and Confluence pages. Nothing was ever built.

**Five DO have real source** — and this is where the earlier note was wrong.
`594abf5:lib/handlers/message.handler.js` carries a working dispatch table:

```js
this.handlers = {
  CreateMessage: this.create,
  RemoveMessage: this.remove,
  ListIncomingMessages: this.listIncoming,
  ListSentMessages: this.listSent,
  MarkDelivered: this.markDelivered,
  MarkSeen: this.markSeen
};
```

with a 176-line controller behind it and specs that send the `X-Amz-Target`
literals. So "no implementation exists" was false for these five.

## Why they are still not ported

They belong to a **superseded generation**, and porting them would move Phoenix
away from the reference rather than toward it.

**The service deliberately removed them.** At master HEAD of the same repo the
handler has moved to `src/handlers/message.handler.js` and dispatches:

```js
this.mapping = {
  createMessage, listMessages, markRead, markLoopRead, numberOfUnreadMessagesInLoops
};
```

The `this.handlers` block is gone. The 2016-05-09 loop rewrite replaced it.
Phoenix ports that last generation, which does not implement these operations.

**The data models are incompatible.** The five handlers operate on a schema the
deployed service does not have:

| alpha-era (`594abf5`) | loop-era (deployed, ported) |
| --- | --- |
| `payload` (Mixed) | `content` (String) |
| `recipients[{id,name,type}]` | `loopId` |
| `delivered` / `seen` booleans | `read[]` accounts |
| `attachments[{path,type}]` | `parts[{path,meta}]` |
| `updated` | `seq` |

There is no faithful mapping. "Delivered" and "seen" are per-message booleans
over a recipient list; the loop era has a `read[]` set over loop members and no
recipients at all. Implementing `MarkDelivered` against the loop schema would
mean inventing what delivery means there — a divergence invented by this
project, not a recovery of Jibo's.

## What Phoenix does, measured

```
RemoveMessage  404  {"statusCode":404,"error":"Not Found","message":"Method removeMessage not found."}
MarkSeen       404  {"statusCode":404,"error":"Not Found","message":"Method markSeen not found."}
CreatePart     404  {"statusCode":404,"error":"Not Found","message":"Method createPart not found."}
MarkAllSeen    404  {"statusCode":404,"error":"Not Found","message":"Method markAllSeen not found."}
CreateMessage  401  {"__type":"MISSING_AUTH_HEADER",...}
```

This is the framework's own behaviour: `@jibo/server` resolves the handler in the
POST `/` onRequest extension before credentials or payload validation, so an
unregistered operation is a raw Boom 404 and an implemented one proceeds to the
auth gate. Phoenix reproduces both.

## Disposition

The twelve operations are correctly unimplemented, for two different reasons
that should not be blurred:

* **Seven** were never implemented by anyone. Excluding them invents nothing.
* **Five** were implemented once, for a schema and a service generation that
  Jibo itself replaced. Phoenix matches the surviving generation.

Recorded rather than built. Reversing this would require resurrecting the
pre-loop message collection, which the deployed service did not have.

## Correction to DIVERGENCES A19b

A19b said these "answer 400". Measured, they answer **404** with the framework's
`Method <lowerFirst op> not found.` body. A19b also implied no implementation
was recovered for any of them, which is false for the five above. Both corrected.

## Reproducing

```bash
git clone --bare https://pvindex.org/gitea/jiborobot/srv-jot-ws-archived.git /tmp/a19
cd /tmp/a19
git show 594abf5:lib/handlers/message.handler.js     # the alpha dispatch table
git show HEAD:src/handlers/message.handler.js        # the loop-era replacement
for op in CreatePart UpdateMessage GetMessages ListInbox MarkAllDelivered MarkAllSeen; do
  echo -n "$op: "
  git rev-list --all | while read c; do git grep -l "$op" "$c" -- 2>/dev/null; done | wc -l
done
```

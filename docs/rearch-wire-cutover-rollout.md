# Wire cutover — rollout and rollback (POD-308)

Wire **1** is the pre-rewrite wire: `metadataDelta` (whose covered range,
`fromExclusive`, was OPTIONAL) plus full-list snapshot messages produced by
`funnel.publishComputed`.

Wire **2** is the scoped feed on the wire: `feedDelta` / `feedBootstrap` /
`feedRescope` / `feedResyncRequired`, with the certified range (`fromSeq`,
`seq`) and the retention floor (`minAvailableSeq`) **required** on every frame
that carries rows.

Two things ship together and must not be confused:

| | permanent? | where |
|---|---|---|
| version negotiation + edge adapter registry + min-version telemetry + 426 backstop | **yes** — kept architecture | `packages/protocol/src/edge/` |
| the concrete v1 translation | **no** — one rollout window | `apps/server/src/gateway/legacy-wire-v1-adapter.ts` |

Deleting the first recreates the next PWA rollout's problem. Keeping the second
past its window is the placeholder `scripts/audit-wire-adapters.ts` exists to
stop.

## Rollout order: server, then clients, then daemons

The order follows from one asymmetry: **the server can translate for an old
peer; an old peer cannot translate for a new server.** So the translator has to
be in place before anything speaks the new dialect.

### 1. Server first

Deploy the server carrying wire 2 and `MIN_SUPPORTED_VERSION = 1`.

- Every existing client keeps working untouched. Their `hello` carries no
  `wireVersion`, and **absence means 1** — a pre-cutover build cannot be made to
  send a field it was never compiled with, so its silence is the advertisement.
- Those peers are served by `LegacyWireV1Adapter`, which folds the feed into the
  same `sessionsChanged` / `issuesChanged` / … messages they already parse.
- Nothing has changed for a user at this point. That is the property to check
  before going on.

**Check before step 2**

```sh
bun run audit:wire-adapters      # gate + probe
curl -s localhost:8787/health | jq '.wire'   # window + connected-peer versions
```

### 2. Clients second

Ship the web/PWA build that sends `wireVersion: 2` and understands `feedDelta`.

- A user on a cached build stays on v1 until their service worker updates. They
  are served by the adapter the whole time; there is no flag day.
- Watch `minimum` in the peer-version telemetry. It is a **minimum over live
  connections**, not a histogram, because the question is "is anyone still
  below the floor" and one idle stale tab answers it.

### 3. Daemons third

Daemons are updated with their machines and are the slowest population. They are
last because they are the peers a user cannot refresh.

### 4. Close the window (POD-279 Phase 7 at the latest)

Only when telemetry shows `canRaiseFloorTo(2) === true` sustained across a full
reconnect cycle:

1. Delete `apps/server/src/gateway/legacy-wire-v1-adapter.ts` and its
   registration in `wire-feed-edge.ts`.
2. Raise `MIN_SUPPORTED_VERSION` to 2.
3. Delete the `legacy-wire-v1-adapter` ratchet item and its baseline entry.
4. Delete the v1 message shapes the adapter was the last producer of.

The order of (1) and (2) does not matter; **doing only one of them fails the
gate**, which is the point. Raising the floor with the adapter still present
fails `expired-adapter-still-present`; deleting the adapter without raising the
floor fails `floor-follows-deletion` — a window that advertises v1 with nothing
to serve it is, from the peer's side, indistinguishable from a broken deploy.

## Rollback

**Rolling back the server (any point before step 4).** Redeploy the previous
server build. Wire 1 peers are unaffected — they were being served a v1
translation and now get v1 natively. Wire 2 peers see their socket close and
reconnect; the old server does not understand `wireVersion: 2` in `hello` but
ignores unknown fields, and the client's `feedCursor` is likewise ignored, so
they fall back to the v1 path they still contain. **No durable state is
version-specific**: `feedId`/`epoch`/`seq` live in the database and are
unchanged by a wire rollback, so no replica is invalidated and no re-bootstrap
storm follows.

**Rolling back a client.** Nothing to do. An older client build is a v1 peer and
the adapter serves it.

**After step 4, rollback is no longer free.** The adapter is gone, so a v1 peer
meets 426 and must self-update. That is why step 4 waits on telemetry rather
than on a date.

**If a v1 peer meets an `evict`.** The adapter refuses the frame and the
connection is dropped rather than served a lie — ADR 2 Amendment 1 D14.5:
rendering a revocation as a `remove` would show a revoked share as a deletion
and a later re-grant as a resurrection. If this fires, a scoped principal is
being served on the old wire; the fix is to move that peer to wire 2, never to
soften the refusal.

## What a beyond-window peer sees

`426 Upgrade Required`, with the support window in the body:

```json
{ "status": 426, "reason": "unsupported-version", "offered": 0,
  "support": { "min": 1, "wire": 2 },
  "message": "wire version 0 is too old; this server serves 1–2. Update and reconnect." }
```

The window is in the body so the peer can tell its user something true. A peer
ABOVE the window (a new client against an un-updated server) gets the same
refusal with "too new" — the advice differs, and a single "please update" string
would be wrong in half the cases.

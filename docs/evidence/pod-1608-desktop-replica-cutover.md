# POD-1608 — the desktop selects the kernel replica but reads the legacy store

**This is the blocker.** It explains the empty task board, sessions stuck on
"Starting…", and panels that do not survive a reload — one cause, three faces.

## The measurement that settles it

The operator ran both clients against the SAME server, minutes apart:

| client | result |
|---|---|
| `/mobile` (Expo) | **shows 3 sessions** |
| desktop web | empty board, sessions stuck "Starting…" |

Same server, same feed, same database. The server, the v2 feed and the kernel
replica are healthy — mobile is the end-to-end proof.

Supporting captures from the desktop's own websocket:

    {"type":"feedBootstrap","seq":2753,…}
       entity kinds: repo:1 issueProjection:5 session:8 issue:5
    {"type":"sessionsChanged","sessions":[{"sessionId":"c51ccb8c…","title":"✳ …"}]}

The rows arrive. Nothing renders. Zero console errors.

## Why

    $ curl /version
    {"feedScoping":"per-principal", …}

    packages/client-core/src/replica/feed/mode.ts:111
      if (scoped) return { path: 'kernel', reason: 'legacy-refused-scoped-authority',
                           overridden: true }

At the time of this incident, per-principal scoping forced the desktop onto the
kernel mode while the desktop composition root still read the legacy store. The
subsequent browser and desktop cutovers removed that split; the kernel replica is
now unconditional and the rollout resolver no longer exists.

The observed state was **kernel replica selected, legacy store read** — a state nobody designed,
produced by two changes that are each correct alone — multi-user moving the server
to per-principal scoping, and the then-incomplete client cutover.

Mobile does not have the gap because POD-1241 cut it over already:

    apps/mobile/src/client/MobileClientProvider.tsx:275  createKernelReplica({…})
    "READ PATH (POD-1241): KernelReplica + FeedAuthorityClient over the v2 feed"

## The decision

**Resolution:** the desktop and browser now compose the kernel replica unconditionally;
the legacy mode, flags, and shadow comparison have been retired.

Rejected alternatives, with reasons:

- *Stop advertising per-principal* — unships the multi-user work the epic just
  landed, to preserve a replica being deleted.
- *Narrow the override* — the override is CORRECT; a scoped wire genuinely cannot
  be expressed in legacy v1. The cutover is what is missing.
- *Flip the feature flag* — the flag is rollout posture, not the mechanism, and
  POD-1245 refused exactly this for exactly this reason.

Mobile is the existence proof that the target works against this same feed.

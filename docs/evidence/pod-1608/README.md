# POD-1608 — the task board showed nothing

**One un-armed change row silently discarded the client's whole world.**

The board was not filtering, not querying wrong, and not reading the wrong replica.
A single `userReadPosition` row inside `feedBootstrap` made the entire frame fail
to parse, so the kernel replica received nothing and every surface fed by it —
the task board, the session list — rendered its empty state. No error, no page
error: one console *warning*.

## The two faults, both in current source

**1. The v2 change union's catch-all excluded kinds it had no arm for.**
`UnknownFeedChange` (`packages/protocol/src/messages/feed.ts`) excluded all of
`MetadataEntityKind.options` — the *v1* vocabulary, ten kinds — while `FeedChange`
carried arms for eight. v1 grew `userLayout` and `userReadPosition`
(POD-1350/POD-1380); v2 did not. A row of either kind was therefore refused by the
strict union **and** excluded from the lenient one, failing both arms.

**2. `parseServerMessageLenient` gave the per-element quarantine to wire v1 only.**
It special-cased `metadataDelta`; `feedBootstrap` and `feedDelta` fell through to
the strict `ServerMessage` schema. Because a frame parses as one object, that
single un-armed row took every other row with it — and a bootstrap frame *is* the
client's whole world.

The two compound: fixing either alone leaves the frame dropped.

## Measured, A/B, same server, same minute

Live instance `http://100.113.194.89:18899` (wire 2, `feedScoping: per-principal`),
whose `feedBootstrap` carries `repo:1 issueProjection:6 conversation:1 issue:6
userReadPosition:1 session:9`.

| | dropped frames | IndexedDB `entities` | issue cards |
|---|---|---|---|
| unfixed (server's own dist) | **1** | **0** | **0** |
| fixed (this branch) | **0** | **25** | **2** |

`before-unfixed-board-empty.png` — "Backlog 0 · No tasks." against six issues.
`after-fixed-board-renders.png` — POD-3 and POD-4 rendered.

The un-armed row now **rides along** rather than being quarantined: dropping it
would be an invisible cursor gap, which is the heal-loop ADR 2 D4 forbids. It
appears in the replica (`userLayout:1, userReadPosition:1` above) and the kernel
ignores it, exactly as leniency prescribes.

## It can say NO

Three independent negative controls, because "no error" proves nothing here:

- **Empty store → empty board, for the right reason.** With the fix in, both
  click-test issues archived: **0 cards, but still 0 dropped frames and 25
  entities** in the replica. The board reported zero because there was nothing to
  show, not because it was blind. (Both issues were restored afterwards.)
- **An armed kind with a bad value is still refused.** `repo` with `value: {id: 7}`
  fails `FeedChangeLenient` and `UnknownFeedChange` both — leniency is not a bypass.
- **A structurally broken envelope still throws.** A feed frame certifying no
  range does not parse; the watermark rule is untouched.

## Where the regression test lives

At the layer that broke — the schema and the codec, not the store that never lost
a row:

- `packages/protocol/src/messages/feed.test.ts` — "every kind the wire can carry
  survives the v2 change union", including a guard-on-the-guard that fails if v2
  ever gains every arm and the lenient path stops being exercised by real kinds.
- `packages/protocol/src/messages.test.ts` — "parseServerMessageLenient (wire v2
  feed frames)".

`FEED_CHANGE_KINDS` is now read off `FeedChange.options` itself, so the exclusion
list and the arms are the same fact and cannot drift apart again.

## What this was NOT

Ruled out by measurement, each having been a live hypothesis:

- **Scoped-feed visibility filtering.** The rows are in the bootstrap, addressed
  to this principal.
- **"Kernel replica selected, legacy store read."** `AppShell.tsx` passes
  `kernel.assembly.createReplicaFn` *and* `feed`; the views read the kernel facade.
  The rows land nowhere, not somewhere unread.
- **A board filter defaulting to a repo/machine context that matches nothing.**
  The same board renders both rows once the frame parses.

## A stale bundle was sitting on top of it

The instance was serving a `dist` built three days earlier, whose `FeedChange` had
only five arms and whose `IssueWire` still required the pre-rename `blockedBy`.
That masked the defect underneath and made the first diagnosis contradictory.
Rebuilding removed the noise; the board stayed empty, which is what isolated the
real cause. Two separate hazards came out of it and are filed: **POD-1611** (nothing
gates bundle-vs-server schema skew) and **POD-1612** (the root `build` script does
not build `apps/web`).

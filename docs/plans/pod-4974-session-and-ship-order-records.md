# POD-4974: session and ship-order records without server extras

Spec, 2026-10-01. Status: plan for the operator's approval; no code yet.
Epic: POD-4286 (frontend state-store performance), under POD-4949 (one issue record on the wire).
This is step 8 of `docs/plans/pod-4949-one-issue-record.md`. Read that plan first: the same
rules apply here (§7 compatibility, §8 evidence, §12 landing and models).
Code references are to `integrate/4286-pilot` at `dd0d3a6a6` (after POD-4967 landed), checked line by line. Reader counts
in §3.2 come from a search of that tree and exclude tests.

## 1. Summary

The session record (`SessionMeta`, feed kind `session`) and the ship-order record
(`ShipOrderProjection`, feed kind `shipOrder`) carry values the server computes from
**other** rows: other tables, other users and other orders. ADR 4 forbids three kinds
of these:

- **per-user values on a shared record** (amendment 1, D10): `readAt`, `unread` and
  `snoozedUntil`;
- **joins with other entities** (D7.1 and D7.3): `displayRef` (repo prefix plus issue
  number), `machineName` and `condition` (machine table), and `handoffTarget` (a machine
  name copied in);
- **values computed across many rows on every change** (D7.2 and D7.4): `queueRank`,
  `train` and `waitEstimate` on ship orders.

These cause real defects today, all checked in the code:

1. **Non-admin users never see their own read and snooze state.** The feed is built for
   the earliest admin, so every user receives the admin's values (§3.1).
2. **A machine change re-sends every session on that machine.** Renames and inventory
   changes do it, and so do update-channel changes, which no session shows (§3.1).
3. **Renaming a repo prefix leaves every session's `displayRef` stale** until something
   unrelated touches the session (§3.1).
4. **Every shipping change recomputes every ship order ever stored** and scans every
   ship attempt (§3.3). It then re-sends every queued order in the lane whose rank or
   estimate moved.
5. **The rank shown is not the order the scheduler runs.** The published rank ignores
   native-stack edges that the scheduler uses (§3.3).

This plan moves each value to where ADR 4 puts it, in steps that each ship on their own
and keep released clients working, exactly as POD-4949 does for issues.

**Not everything on the session record is a violation.** `queuedMessageCount` and `offer`
belong to the session itself and are recomputed only for that session. They stay, and
§5 explains why. This corrects the step-8 brief, which listed them with the others.

## 2. Background

- **ADR 4 D7** (`docs/adr/0004-representation-policy.md:290-335`):
  - D7.1: records refer to other entities by id only;
  - D7.2: a change to X recomputes only X's projections, never work that grows with the
    world;
  - D7.3: cross-entity views are built on the client;
  - D7.4: a derived value the client cannot compute becomes its own server-maintained
    entity.
- **ADR 4 amendment 1, D10** (`docs/adr/0004-representation-policy-amendment-1.md:140-163`):
  per-user state is its own record keyed `(userId, entityId)`. It names
  `SessionMeta.readAt` and `snoozedUntil` as the canonical non-compliance (`:150-153`).
- **ADR 4 rule 7** (`0004-representation-policy.md:177-179`) allows live, short-lived
  overlays such as `handoffTarget`, as long as they are documented as live.
- **The session model itself** records the per-user gap as known and unfinished
  (`packages/model/src/entities/session.ts:25-38`). So do the server's facts module
  (`apps/server/src/modules/sessions/facts.ts:49-58`) and a ratchet test that pins
  `SessionMeta.readAt` and `SessionMeta.snoozedUntil` as per-user singletons
  (`packages/model/src/representations/registry.test.ts:240-252`).
- **POD-4967** (step 1 of POD-4949, landed on `integrate/4286-pilot` at `dd0d3a6a6`) added the
  per-user `issueUserState` kind (`packages/protocol/src/messages/sync.ts:251`, visibility at
  `apps/server/src/feed-visibility.ts:273, 381`). The session per-user kind copies it and uses the
  same key function, `userEntityKey` (`packages/model/src/ids/keys.ts:205`).

## 3. The current state

### 3.1 Sessions: where each extra comes from

There is one feed kind, `session`, whose value is the whole `SessionMeta`
(`packages/protocol/src/messages/sync.ts:138`). There is no normalized session record
beside it.

The server builds a session in two stages:

1. `Session.toMeta` (`apps/server/src/modules/sessions/session.ts:1074-1181`);
2. `wireSession` adds the joined values from a per-batch pass
   (`apps/server/src/modules/sessions/view.ts:300-334`).

The pass is built by `buildProjectionPass` (`view.ts:210-246`), **with no principal**, so
it uses the earliest admin (`view.ts:214, 260-265`).

| Field | Comes from | Merged at | When its input changes |
|---|---|---|---|
| `readAt`, `unread` | `session_user_state` table, per user; `unread` = `readAt` null or `lastActiveAt > readAt` | `session.ts:1113, 1116` | one session re-sent, **with the admin's values** |
| `snoozedUntil` | `snoozes` table, per user | `session.ts:1143` | same |
| `displayRef` | the birth issue's `seq` and repo path, plus the repo prefix by path; drafts use the session `cwd` | `view.ts:230-238, 310-318` | **nothing is re-sent on a prefix change**: `setPrefix` publishes only repo rows (`apps/server/src/repo-registry.ts:136-140`) |
| `machineName` | machines table | `view.ts:323` (`toMeta` sets `''` at `session.ts:1121`) | **every session on the machine** is re-sent: `machine.metadataChanged` (`relay.ts:1835-1837`) runs `sessionsChangedForMachine`, which loops over **all** sessions (`repository.ts:476-482`) |
| `condition` | the machine's harness login inventory | `view.ts:308, 324` | same machine fan-out |
| `handoffTarget` | the target machine's **name**, copied | `session.ts:1147` | one session; a rename of the target is not reflected |
| `queuedMessageCount` | a fresh count of the session's server-held queue | `view.ts:239, 305` | one session |
| `offer` | the `offers` table, one per session | `session.ts:1146` | one session |

**Machine metadata events:** inventory changes (`apps/server/src/modules/machines/service.ts:1670`), rename
(`:1711`), update channel (`:1732`, nothing on the session depends on it), revoke
(`:1808`) and enroll (`:1839`).

**Per-user values go to everyone.** The feed filters which rows a user may see, but each
row carries one stored value, projected for the admin:

- `broadcastViewer` and `defaultPrincipal` both resolve to the earliest admin (`view.ts:250-265`);
- the RPC `sessions.list` passes no principal either (`apps/server/src/modules/sessions/queries.ts:91-94`).

When a non-admin marks a session read, the server writes their row and re-sends the
session with the admin's values. The ledger sees no change and drops it, so the user
never sees their own state.

**Server code that reads the extras back off a wired session:**

- the superagent session list (`apps/server/src/modules/superagent/tools.ts:151`, `snoozedUntil`);
- `await-agent` (`apps/server/src/modules/messages/handlers/await-agent.ts:131`, `queuedMessageCount`);
- issue start (`apps/server/src/modules/issues/service/workflow.ts:518`, `machineName`);
- subagent status (`apps/server/src/modules/sessions/read-toolkit.ts:177-182`, `displayRef`).
  Typed refs like `POD-13-A` resolve through `resolveSessionIdentifier`
  (`packages/protocol/src/refs.ts:187`), which also needs `displayRef`;
- the v1 wire adapter, which forwards the whole record (`apps/server/src/gateway/legacy-wire-v1-adapter.ts:277`).
  It is retired with POD-4973's step 7a.

Auto-archive, the janitor and mail eligibility read the source tables, not the record, so
they are unaffected.

### 3.2 Sessions: client readers

These are counts of non-test reader sites, from the client map made for this plan.

| Field | Web | Mobile | client-core | client-graph |
|---|---|---|---|---|
| `displayRef` | 15 | 3 | 3 | typed only; a fallback in `worklist/sidebar.ts:52` |
| `machineName` | 5, three of which already prefer the machine's own name (`apps/web/src/features/terminal/panel-surface.ts:286`, `apps/web/src/features/chat/use-chat-surface.ts:299`) | 1, also preferring it (`apps/mobile/src/components/SessionConversation.tsx:180`) | 0 | 0 |
| `handoffTarget` | 4 | through client-core | 3 (`packages/client-core/src/viewmodels/mission.ts:1796, 1900, 2305-2307`) | 0 |
| `unread` | 6 | 1 | 5 | 2 |
| `readAt` (session) | 0 | 0 | 1 (`packages/client-core/src/viewmodels/slices/worklist/visibility.ts:65-68`) | 2 |
| `snoozedUntil` | 8 | 1 | 4 | 1 |

**Mobile** uses the same store, replica and overlays as web
(`apps/mobile/src/client/hooks.ts:163-190`). Most of its reads go through client-core
view models.

**Optimistic edits.** All of them patch the `sessions` row (`packages/client-core/src/engine/overlay.ts:264-305`):

- snooze set and clear;
- mark read, which paints `readAt` with the **client** clock and `unread: false`;
- mark unread.

`dismissOffer` and `resumeAndSend` (`overlay.ts:306-325, 583-611`) patch `offer` and
`queuedMessageCount`, which stay.

**Offline caches.** Stored rows are not re-parsed on load
(`packages/client-core/src/replica/kernel/facade.ts:470-504`), so old cached rows keep
their old extras. Persisted outbox entries carry a fingerprint of the session row
(`overlay.ts:135-192`) and are re-projected on reload
(`packages/client-core/src/engine/optimism.ts:175-197`).

**What the client can already compute:**

- `unread` is fully derivable once `readAt` arrives per user.
- `machineName` is derivable from the machine list, but that list is a live frame only
  (`packages/protocol/src/messages/host.ts:23-26`). It is not a replica kind and is not
  stored offline.
- `displayRef` is derivable from the repo row (`{id, prefix}`) only if the session names
  its repo and number. Today it names neither: drafts have only a `cwd` path, and the
  birth issue may be invisible to a viewer who sees the session through a later issue.

### 3.3 Ship orders

**How rows are built.** `ShippingService.projectionSpecs` (`apps/server/src/modules/shipping/service.ts:3751-3797`)
runs on every shipping commit, about 20 call sites. Each run:

- reads **all** orders, holds and receipts;
- scans **all** attempts for `turnSamples` (`service.ts:3799-3807`);
- runs `shippingSchedule` over every queued lane (`apps/server/src/modules/shipping/queue.ts:266-330`).

`shippingCommitMany` does all of that once per affected issue
(`apps/server/src/modules/issues/service/crud.ts:255-312`, through
`apps/server/src/modules/shipping/service.ts:741-746`). The ledger then drops rows
that did not change. What reaches the wire is:

- the changed order;
- every queued order in its lane whose rank or train moved;
- after any successful ship, every ranked order in the lane, because its estimate is
  rank times the lane's percentiles.

**Readers:**

- `queueRank` is read only by the web shipping panel
  (`packages/client-core/src/viewmodels/shipping-panel.ts:38-41`). The panel is behind
  the `shipping` feature flag, which is off by default.
- `train` and `waitEstimate` have **no reader** in any client. `waitEstimate` never had
  one: only its introducing commit `eddf2d5ad` mentions it under `apps/` or the client
  packages.
- All three are optional on the wire (`packages/model/src/shipping-projection.ts:81-102`).

**The client cannot compute rank.** The row lacks the inputs:

- the dependency edges;
- the SHAs, policy and validation digest that decide train compatibility (`queue.ts:67-80`).

**Defects found:**

- **The published rank ignores native-stack edges.** The scheduler's tick orders over
  `ordersWithNativeStackEdges` (`service.ts:854`), but the projection uses plain
  `listOrders`.
- **The panel splits lanes differently.** It groups by the raw `destination`
  (`shipping-panel.ts:70-76`), while the server's lane is the canonical destination
  (`queue.ts:54-58`).
- **`train.id` is not a stable identity.** It is a hash of the current members.

## 4. Goals and non-goals

**Goals**

1. A session row carries only the session's own facts. Per-user state lives in a per-user
   kind; names and labels are joined on the client from repo and machine rows.
2. A machine or repo change re-sends one row, never every session.
3. A shipping change recomputes only the lanes it touches. Rank lives in a lane entity
   (D7.4), not on every order row.
4. Every step ships on its own and keeps released clients working, as in POD-4949 §7.

**Non-goals**

- The composer draft and `draftUpdatedAt`. Whether a draft is per-user state is ADR 1's
  call (D10 consequence 4).
- `clientCount` and the static harness flags. They are live, session-local facts.
- The issue record. That is POD-4949 steps 1 to 7.

## 5. Target design

### 5.1 Sessions

| Value | Home after the migration |
|---|---|
| `readAt`, `snoozedUntil` | a new per-user kind `sessionUserState`, keyed `(user, session)` and visible only to its user. It uses POD-4967's shared key fragment and the `per-user-state` visibility class, like `userLayout` (`apps/server/src/feed-visibility.ts:267-273`). |
| `unread` | computed on the client: `readAt` is null, or `lastActiveAt > readAt`. There is an existing helper (`packages/client-core/src/viewmodels/unread.ts:36`), and POD-797 already did this for issues. |
| `displayRef` | computed on the client from the repo row's prefix. The session row gains `refRepoId` (both kinds of ref) and `refSeq` (issue-born refs), the inputs the server already reads at `view.ts:230-238`. A prefix rename then re-sends one repo row. |
| `machineName`, `condition` | computed on the client from a new replicated `machine` kind `{id, name, loggedOutHarnesses}`. It is re-sent once per machine change, never per session. |
| `handoffTarget` | stays a live overlay (rule 7), but as `handoffTargetMachineId`; the client joins the name. |
| `queuedMessageCount` | **stays**: the session's own queue depth, recomputed only for that session (D7.2 holds). |
| `offer` | **stays**: the session's own record (one per session, agent-authored), recomputed only for that session. |

### 5.2 Ship orders

| Value | Home after the migration |
|---|---|
| `train`, `waitEstimate` | **gone**. Nothing reads them. The scheduler keeps computing trains internally for its tick. |
| `queueRank` | a new server-maintained `shipLane` entity (D7.4): `{id, repoId, destination (canonical), trains: [{orderIds}], blockedOrderIds}`. It is updated only for the lanes a commit touches, inside that commit, from the same input the scheduler uses, so it includes native-stack edges. The client reads an order's rank as its train's position in the lane. |

## 6. Steps

Each step is one sub-issue under POD-4949 with its own brief; the substeps are the scope.
The sessions track (S1–S6) and the ship-order track (O1–O4) are independent of each other.

### Sessions

**S1: new homes, additive.** Server and client-core replica only; nothing is removed.

- S1a. The `sessionUserState` kind `{sessionId, readAt, snoozedUntil}`:
  - server publish to the **acting** user on mark read, mark unread, snooze set and
    snooze clear;
  - also on the activity clear, one row per user who had a snooze (`clearAllSnoozes`),
    and on the unread re-arm (`rearmUnreadForAll`);
  - included per principal in the `changesSince` snapshot (a new optional array);
  - registered in the client replica (kinds, facade, contract, bootstrap), as POD-4967
    does for issues.
- S1b. The `machine` kind, published on rename, inventory change, enroll and revoke. It
  sends one row, with no session fan-out.
- S1c. Session rows gain `refRepoId`, `refSeq` and `handoffTargetMachineId`, all
  optional. Two rare events change a ref's repo or number: the seq-collision heal
  (`apps/server/src/store/issues.ts:748-780`) and the repo-id upgrade
  (`assignRepoIdToIssuesUnder`, same file). Both mark the affected sessions dirty in the
  same commit.
- S1d. RPC `sessions.list` and the superagent list use the **caller's** principal. This
  fixes defect 1 for those reads; S1a fixes it on the feed.
- S1e. An update-channel change stops marking sessions dirty, since nothing on a session
  depends on it.

Done when:

- each new kind has server tests, replica tests and a golden fixture;
- a two-principal test shows user B never receives user A's row, and that A's own
  mark-read reaches A;
- the old session row is byte-identical apart from the three new optional fields.

**S2: client-core and web read the new homes.**

- S2a. One client-core module answers `unread`, `readAt`, `snoozedUntil`, `displayRef`,
  machine name, `condition` and the handoff target label from the new rows. It falls
  back to the legacy field **only** while the new row is absent, which happens with an
  older server or before the first sync.
- S2b. All web and client-core readers in §3.2 move to that module, including
  `isSnoozed` and `returnedFromSnooze` callers
  (`packages/model/src/predicates/snooze.ts:27, 37`) and `resolveSessionIdentifier`
  callers on the client.
- S2c. client-graph reads it too. That covers `packages/client-graph/src/shared/schema.ts:685-704, 966-972`,
  `worklist/visible.ts:393-395` and `worklist/sidebar-row.ts:72-78`.
- S2d. A lint rule forbids reading the legacy fields anywhere outside the fallback.

Done when:

- web and client-core view models are identical with the legacy fields stripped and with
  them present, on the corpus and on the operator's data (offline export on ludovico;
  only counts and ids are reported);
- a prefix rename updates every displayed ref with no session re-sent.

**S3: optimistic edits target the per-user kind.**

- S3a. The snooze and read overlays (`overlay.ts:264-305`) are minted on
  `sessionUserState`. Mark read paints `readAt = max(press time, row.lastActiveAt)`, so
  client clock skew cannot leave the session unread. The covering rule judges the
  per-user row, not the derived `unread`.
- S3b. Entries persisted by older builds, whose baseline is a session-row fingerprint,
  still cover and retire after reload.
- S3c. The optimistic spawn placeholder
  (`packages/client-core/src/viewmodels/optimistic-spawn.ts:77-78`) inserts a per-user
  row.

Done when each overlay kind has optimism, rollback, hold-until-truth and
reload-of-persisted-entry tests. Each test must fail when that kind's retargeting is
reverted.

**S4: server readers move to the source.**

- The superagent `snoozedUntil` comes from the caller's per-user row.
- Issue start's machine label comes from the machines service.
- Subagent status and typed-ref resolution use one server helper that computes the ref
  from the source rows, not from the record.

Done when no server code reads these fields off a wired session, except the v1 adapter.

**S5: mobile reads the new homes.**

- Mobile's direct reads move to the S2 module:
  - `displayRef` in `apps/mobile/src/components/MissionDeck.tsx:256, 679` and
    `apps/mobile/src/lib/podium-link.ts:136`;
  - the machine name in `SessionConversation.tsx:180`;
  - `snoozedUntil` in `apps/mobile/src/screens/SessionScreen.tsx:199`.
- The rest already comes through client-core from S2.
- It ships in the same TestFlight release as POD-4972 and shares its adoption check.

**S6: stop sending the extras and delete them.** This is the only one-way step. It runs
with POD-4973's minimum-version bump, never before it.

- S6a. Session rows stop carrying `readAt`, `unread`, `snoozedUntil`, `displayRef`,
  `machineName`, `condition` and `handoffTarget`.
- S6b. Machine events stop marking sessions dirty (`repository.ts:476-482`,
  `relay.ts:1835-1837`). The projection pass stops reading prefixes, overlays and machines
  for the feed.
- S6c. The schema fields, the S2 fallback and its lint exemption are deleted, along with
  the registry ratchet's two `SessionMeta` entries (`registry.test.ts:249-250`) and the
  goldens. The goldens are `packages/protocol/src/messages/wire-golden.json:15, 17, 76`
  and the generated `sync.json`, `feed.json` and `runtime-state.json`.
- S6d. Rows in offline caches written by older builds still load, and their stale fields
  are ignored.

The cost of a machine rename is measured before and after, at the operator's session
count.

### Ship orders

**O1: stop computing and sending `train` and `waitEstimate`.**

- Nothing reads them, and both are optional. Old clients see no difference.
- The full attempt scan leaves the commit path (`service.ts:3799-3807` and the boot copy
  at `relay.ts:527-541`).
- The `shipOrder` registry row (`packages/model/src/representations/registry.ts:718-737`)
  is corrected.

Done when a test proves a commit reads no attempts and the scheduler still claims the
same trains.

**O2: the `shipLane` entity, additive.**

- It is computed per touched lane, inside the commit, from the scheduler's own input (the
  native-stack edges), through a lane-scoped store read.
- Order rows keep `queueRank`, but it now comes from the same per-lane computation. The
  full order scan, and the once-per-issue repeat in `shippingCommitMany`, both go.

Done when:

- commit cost is flat in the number of orders outside the lane (measured at 10, 100 and
  1,000 orders);
- the published rank equals the scheduler's order in a test with native-stack edges.

**O3: the web panel reads lane rows.**

- It groups by the canonical lane and takes rank from the lane row.
- It falls back to `queueRank` while the lane row is absent.

Done when the panel test fails if the panel groups by raw destination.

**O4: order rows stop carrying `queueRank`.**

- An old client with the flag on would show "Waiting" without a number. It never breaks.
- Because the panel is flag-gated, the operator may ship this before POD-4973's bump. The
  default is to ship it with that bump.

### Order

1. Sessions:
   1. S1 can start now: POD-4967 has landed.
   2. Then S2 and S4 in parallel.
   3. S3 after S2.
   4. S5 after S2 and S3.
   5. S6 last, together with POD-4973.
2. Ship orders: O1 now, then O2, then O3, then O4.

## 7. Compatibility rules

These are POD-4949 §7, applied here.

- **Add before remove.** No field is dropped before every supported client reads its
  replacement. Old clients keep the full session row until S6.
- **Silent defaults are the trap.** `readAt` and `unread` have wire defaults
  (`session.ts:426, 433`). If an old client stopped receiving them, it would show every
  session as read **without any error**. This is why S6 waits for the minimum-version
  bump.
- **Offline caches.** A cache from any earlier build loads after every step. A missing
  new kind means "not loaded yet", and the S2 fallback covers it until S6. By S6, every
  supported build has stored per-user rows for weeks.
- **Privacy.** Each per-user row is visible only to its own user, tested with two
  principals in S1. Machine and lane visibility are decisions 1 and 2 in §11.

## 8. Testing and evidence

The rules are POD-4949 §8.

- Every behaviour change has a focused test proven to fail on a planted mistake. Planned
  mistakes include:
  - delivering user A's row to user B;
  - projecting for the default principal;
  - deriving `unread` with `>=`;
  - joining the prefix by path instead of id;
  - dropping the S2 fallback;
  - reverting one overlay kind's retargeting;
  - computing lanes without native-stack edges;
  - grouping by raw destination.
- **Equivalence** (S2, S5): view models are identical with and without the legacy
  fields.
- **Numbers:**
  - S6 reports machine-rename publish cost and session row bytes before and after;
  - O2 reports commit cost against total orders.
- Tests, typecheck and lint run on flatblock, focused lanes only.

## 9. Rollout and rollback

- S1 to S5 and O1 to O3 are additive or client-internal. Each is reverted by reverting
  its commits.
  - O1 removes only unread fields, so a revert restores them.
- **S6** is one-way, gated with POD-4973's bump and the operator's go-ahead.
- **O4** can be reverted. Old clients only lose the number.

## 10. Risks

1. **Everything shows as unread after an upgrade** if per-user rows are missing on a cold
   offline start. The S2 fallback covers this until S6.
2. **Clock skew** in the derived `unread`. S3a's paint rule covers it, and it is tested
   with a client clock behind the server's.
3. **A ref cannot be resolved** if the repo row is not loaded. Repo rows are few and
   visible to every member, and the fallback covers the gap until S6.
4. **Old outbox entries** after S3. S3b tests them.
5. **The lane row reveals other users' order ids** (decision 2).
6. **Mobile adoption is slow**, which delays S6, as for POD-4973. S1 to S5 still fix
   defects 1 to 3 for current clients.

## 11. Decisions for the operator

One at a time; each has a default that the plan assumes.

1. **Who may read a `machine` row?** Default: every member of the instance, like repo
   rows. The session model already says anyone who sees a session may learn its machine
   name (`session.ts:48-52`). The alternative is "may see the machine, or may see a
   session on it", which costs a visibility recompute whenever a session grant changes.
2. **Who may read a `shipLane` row?** Default: anyone who may read at least one order in
   the lane. It carries only order ids and their grouping, which is about what
   `queueRank` reveals today (how many are ahead).
3. **Do `queuedMessageCount` and `offer` stay on the session?** Default: yes (§5.1).
   Moving them out would add two kinds and fix no defect.

## 12. Found along the way, not in these steps

- **`draftUpdatedAt` changes in memory without a publish.** It then rides the next
  unrelated publish (`apps/server/src/modules/sessions/session-state/service.ts:814-829`).
- **Deleting an issue's sessions wires every session** to find that issue's members
  (`apps/server/src/modules/sessions/session-meta-ops.ts:452-456`).

Each becomes a sub-issue under POD-4949 if the operator wants it fixed.

## 13. Models

- **Opus 5.5 high:** S3 (optimism), S6 (one-way removal) and O2 (the lane entity).
- **gpt-6.1 sol max:** S1, S2, S4, S5, O1, O3 and O4.

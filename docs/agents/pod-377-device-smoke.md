# POD-377 device smoke — the steps, and what each one is actually testing

This is the HUMAN GATE from POD-377's acceptance criteria, written out so it can be run
without re-deriving it. The POD-279 fan-out protocol suspends human gates for the autonomous
run (§1), so this is recorded as evidence rather than executed by an agent — nothing here has
been self-certified, and it must not be marked passed by anyone who did not watch a phone do it.

**This gate is now runnable.** POD-1220 landed the caller: `openMobileReplica` in
`apps/mobile/src/client/MobileClientProvider.tsx` opens the SQLite store, calls
`migrateLegacyReplica` before the store answers a read, and hands the engine a replica whose
outbox homes are the SQLite ones.

## What is landed, and WHAT PART OF THE CLIENT IT COVERS

This is the paragraph to read before running pass 2, because the answer is narrower than
"mobile is on SQLite" and the difference changes what step 5 should find.

Landed:

- The adoption gate (`@podium/sync/adapters/legacy-replica` → `adoption.ts`): a pre-multi-user
  on-device replica may be adopted only when attribution is certain.
- The migration runner (`migrate.ts`): read → decide → one commit → retire keys, in that order.
- POD-1220's caller, and with it the OUTBOX on SQLite (`podium-replica.db`).

**Entities, the cursor and transcript windows are still on AsyncStorage, deliberately.** Mobile
is a wire-v1 peer and the kernel replica facade refuses the v1 write-in path by design, so the
v2 read model is POD-1241's scope. What POD-1220 moved is the family ADR 6 D1 forbids from
living on AsyncStorage on any path and D4.3 calls a correctness bug to lose: the queued writes.
The attribution gate governs exactly that family here — entities and the cursor are retired
unconditionally either way — so the outbox is where a refusal is observable.

## Setup

1. Build and install the Expo app on a real device (not the simulator — the lifecycle
   behaviour under test is the OS reclaiming the process, and simulators do not reproduce it
   faithfully).
2. Point it at a dev server with real data in it. A near-empty instance passes every step
   below without exercising anything.

## Pass 1 — the upgrade path (this is the "no stuck clients" requirement)

Run this on a device that **already has an old build's replica on it**. Installing a fresh
build over a clean device tests the easy path and proves nothing about migration.

1. On the OLD build, go offline (airplane mode) and queue work: rename a session, close an
   issue, send a chat message. Confirm they show as pending. **Note what you queued** — you
   are about to check whether it survived.
2. Still offline, install the NEW build over it and launch.
3. **The app must open.** Not "eventually" — the failure this gate exists to catch is a client
   that wedges on a store it cannot read, and on a phone the user cannot clear it themselves.
4. Cold-start paint: the session and issue lists must render from local data while still
   offline. A blank shell here means the replica did not hydrate.
5. Your queued work from step 1 must still be there — either pending, or parked with an
   explanation. It must not have silently vanished. On a single-account server this is the
   ADOPT arm, so expect it PENDING; a notice about work that could not be attributed here
   would mean the evidence arm has stopped matching the server's auth model.
6. Go back online. The queued work drains and the lists converge.
7. Kill the app from the app switcher mid-drain and relaunch. Nothing duplicates, nothing is
   lost.

## Pass 2 — the multi-user pass (cross-user residue)

This pass tests the boundary the adoption gate defends. It needs a build where user identity
exists; on a single-account server, record that and skip to "What to report".

1. Sign in as **user A**. Let the replica populate. Note something identifiable in A's slice —
   a session title only A can see.
2. Queue an offline write as A, then **sign out**.
3. Sign in as **user B** on the same device.
4. **In the UI:** none of A's slice is visible anywhere — lists, search, recents, the tray.
5. **On disk — and note WHICH store holds what, because the obvious query looks clean for the
   wrong reason.** Pull the app container. The database is at
   `Documents/SQLite/podium-replica.db` (expo's `openDatabaseSync` location).

   - `select distinct principal from entities;` **is expected to return nothing.** Entities are
     still on AsyncStorage (see "What is landed"), so an empty table here is the design, not a
     pass. Reporting it as a pass is the specific mistake this bullet exists to prevent.
   - `select principal, mutation_id, json_extract(record,'$.state'), json_extract(record,'$.input') from outbox;`
     is the query that matters. A's entries must not appear under B's principal, and any entry
     the gate refused must be `dead-letter` with `input` NULL — the payload is redacted on the
     discard arm precisely so B cannot read what A typed.
   - Grep the db file for the identifiable string from step 1 — it must not appear.
   - Then check AsyncStorage too, since that is where B's entity slice actually lives: dump the
     app's AsyncStorage and confirm no `podium.replica.*` key holds A's rows. A leak here is
     invisible to every SQL query above.
6. Airplane mode, force-quit, relaunch: **B's cold start offline shows only B's slice.** An
   empty list here is also a failure — it means B never got a scoped bootstrap.
7. Sign back in as A: A's own queued write from step 2 is still theirs, and still recoverable.

## What to report

For each numbered step: pass/fail, and for any failure the device, OS version, and what you
saw instead. Attach the step-5 SQL output — it is the only part of this gate that cannot be
inferred from the UI, and it is the part that would catch a leak the UI happens not to render.

Mark the acceptance criterion passed only when both passes are clean on a real device.

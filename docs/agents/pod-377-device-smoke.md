# POD-377 device smoke — the steps, and what each one is actually testing

This is the HUMAN GATE from POD-377's acceptance criteria, written out so it can be run
without re-deriving it. The POD-279 fan-out protocol suspends human gates for the autonomous
run (§1), so this is recorded as evidence rather than executed by an agent — nothing here has
been self-certified, and it must not be marked passed by anyone who did not watch a phone do it.

**Precondition: this gate cannot be run yet.** It tests mobile running on the SQLite adapter,
and that cutover is not landed — see "What is landed" below. Run it when the cutover lands.

## What is landed, and what this gate still waits on

Landed on `issue/377-2-3d-mobile-cutover-existing-replica-mig`:

- The adoption gate (`@podium/sync/adapters/legacy-replica` → `adoption.ts`): a pre-multi-user
  on-device replica may be adopted only when attribution is certain.
- The migration runner (`migrate.ts`): read → decide → one commit → retire keys, in that order.
- A captured real replica snapshot and the migration driven from it into a real SQLite store,
  including the three kill-mid-migration states.

Not landed: the mobile client itself still constructs `createAsyncStorageReplicaStorage`
(`apps/mobile/src/client/MobileClientProvider.tsx`). Until that is cut over, steps 2–6 below
have nothing to observe.

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
   explanation. It must not have silently vanished.
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
5. **On disk:** pull the app container and inspect `podium-replica.db` directly
   (`sqlite3 podium-replica.db "select distinct principal from entities;"`). A's rows must not
   be present under B's principal, and A's queued input must not be readable in B's outbox.
   Grep the file for the identifiable string from step 1 — it must not appear.
6. Airplane mode, force-quit, relaunch: **B's cold start offline shows only B's slice.** An
   empty list here is also a failure — it means B never got a scoped bootstrap.
7. Sign back in as A: A's own queued write from step 2 is still theirs, and still recoverable.

## What to report

For each numbered step: pass/fail, and for any failure the device, OS version, and what you
saw instead. Attach the step-5 SQL output — it is the only part of this gate that cannot be
inferred from the UI, and it is the part that would catch a leak the UI happens not to render.

Mark the acceptance criterion passed only when both passes are clean on a real device.

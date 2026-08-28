# POD-3068 — Non-blocking recovery-snapshot verifier (findings log)

Append-only. Child of POD-2462.

## Baseline (2026-08-28, branch `issue/3068-non-blocking-snapshot-verifier`, base `fa32cd99d`)

The Ludovico outage was not a restart. The blocking path, read from source:

- `apps/server/src/modules/updates/trpc.ts:493` — `startUpdateOperation` builds its
  context with `{ includeDatabaseSnapshot: true }`.
- `trpc.ts:373` — that option installs `latestDatabaseSnapshot: () => store.latestDatabaseSnapshot()`.
- `apps/server/src/modules/updates/operation.ts:2610` — `planInputFrom` calls
  `context.latestDatabaseSnapshot?.()` **synchronously**, inside the request.
- `apps/server/src/store.ts:439` → `createLatestDatabaseBackupCache(...).latest()` →
  `latestDatabaseBackup(dbPath)` (`migrations/backup.ts:216`).
- `latestDatabaseBackup` calls `usableBackup(path)` for every retained snapshot, and
  `usableBackup` (`backup.ts:53`) does `openDatabase(path, {readOnly:true})` +
  `PRAGMA quick_check` — a full read of each file on the event-loop thread.

Three retained files of ~747 MiB each; `server:trpc` logged `updates.start` at ~79.9 s.
The existing in-process caches (`latestBackupCache`, `createLatestDatabaseBackupCache`)
only make the *second* call cheap; the first one per process still blocks, and it lands
in a request handler.

`pruneBackups` (`backup.ts:191`) has the same defect on the write path: retention decides
what to evict by running `quick_check` over every retained main file.

## Decisions

1. **Child process, not a worker thread.** `PRAGMA quick_check` is a synchronous native
   call; `Worker.terminate()` cannot interrupt one that is mid-scan, so the contract's
   "hard kill for a stuck child" is not satisfiable on a thread. A child process can be
   `SIGKILL`ed. The child is the podium entry re-invoked with `PODIUM_VERIFY_SNAPSHOT`
   set, which works both from a source checkout and from the `bun --compile` binary
   without adding a public CLI subcommand.
2. **Metadata is a small JSON catalogue** written atomically next to the database
   (`<dbPath>.snapshots.json`). Records are keyed by candidate identity
   (path + size + mtime + sidecar identities + schema version), so a late worker result
   for a superseded candidate is rejected instead of overwriting a newer one.
3. **Read paths stat only.** `latestDatabaseSnapshot()` reads the catalogue and `stat`s
   the recorded path; a still-matching `verified` record is returned immediately. Anything
   else returns `undefined` (honest, non-blocking) and queues at most one background
   verifier per instance.
4. **Retention stops opening files.** `pruneBackups` now keeps the newest N by mtime and
   never evicts the record currently serving as the verified fallback; partial and
   unverified files are still left on disk for forensics.

## Implementation

New modules under `apps/server/src/migrations/`:

- `snapshot-catalogue.ts` — the cheap half. Stat-only identity, atomic publication
  of `<dbPath>.snapshots.json`, `verifiedFallback`, `verificationCandidates`,
  `retainSnapshotRecords`. Nothing here opens a snapshot.
- `snapshot-verification.ts` — the expensive half: `quick_check` plus size/mtime/sidecar
  identity plus `__drizzle_migrations` schema identity. A pure function of paths and
  expected facts; it never receives a live SQLite handle.
- `snapshot-verifier-child.ts` — the process entry, gated on `PODIUM_VERIFY_SNAPSHOT`.
- `snapshot-verifier.ts` — the orchestrator: one run per instance, deadline →
  SIGTERM → grace → SIGKILL, correlation-id and identity checks before publication,
  structured phase logs, background queueing of at most one run.

Changed:

- `backup.ts` — `usableBackup`, `latestDatabaseBackup` and `createLatestDatabaseBackupCache`
  are **deleted**. Leaving the blocking scan exported would invite it back onto a request
  path. `pruneBackups(dbPath, activeFallback?)` is now stat-only and never evicts the
  snapshot the verifier currently advertises.
- `store.ts` — `latestDatabaseSnapshot()` is metadata + `stat` and queues at most one
  background verifier; `verifiedSnapshotBeforeUpdate()` stages behind the existing
  `wal_checkpoint(TRUNCATE)` fence and awaits the child. A `SnapshotVerifierDeps`
  constructor seam keeps tests from spawning a real child.
- `updates/operation.ts` — new optional `prepareVerifiedDatabaseSnapshot` context seam,
  preferred by the `server` step when present. `createDatabaseSnapshot` is untouched and
  still works, so existing operation records, contexts and wire contracts are unchanged
  (additive only).
- `scripts/cli.ts` / `scripts/cli-compiled.ts` — answer `PODIUM_VERIFY_SNAPSHOT` before
  the CLI. No public subcommand is added and no argv carries state-dir paths.

## Deferred, deliberately

**Mid-step "preparing a recovery snapshot" progress.** `context.report` goes through the
engine's per-operation chain, which the caller of `ensure()` holds; a report posted from
inside `ensure()` therefore lands AFTER the step outcome and would claim preparation was
running when it had already finished. The negative half of the requirement is met as it
stands — nothing advertises preparation outside the step that actually runs it — and the
step's own detail still names the snapshot path. Making the positive half correct needs a
progress seam that does not queue behind the runner; that is engine work, not verifier work.

## Known-red on this base, not caused by this work

`apps/server/src/migrations/per-user-state-family.test.ts` fails on the branch base
(`fa32cd99d`) with a stale expected-column list: `sessions.conversation_binding` exists in
`schema.ts` (added by an unrelated merge) but not in the test's baseline. This change
touches no schema, migration or session-column code.

## Verification found by building it

Two real defects the tests caught, both worth recording:

1. **The SIGKILL was being cancelled by its own deadline.** `finish()` cleared every
   timer, including the kill grace timer it had just armed — so a child that ignored
   SIGTERM was left running. Settling the parent's promise and killing the child are
   separate concerns now; only the child actually exiting cancels the SIGKILL.
2. **`-shm` cannot be part of a snapshot's identity.** Opening the snapshot read-only —
   which is exactly what verifying it does — rewrites the `-shm` mtime, so every
   verification invalidated the candidate it had just proved (`superseded`, every time,
   end to end). Identity now covers the main file's size and mtime plus the `-wal`
   sidecar's presence and SIZE; `-shm` is derived shared-memory state, not content.

End-to-end proof of the real child process on this branch (source checkout, a real
1.2 MB store):

    { ok: true, path: ".../podium.db.backup-vupdate-0.4.1-to-0.4.2-...",
      schemaVersion: "20260824202715_quota-windows", durationMs: 304 }

## Test evidence

Lanes run at end of task, and each red compared against the branch base in a detached
`fa32cd99d` worktree rather than reported as a bare count:

| Lane | Branch | Base `fa32cd99d` |
| --- | --- | --- |
| `bun run test` (lean gate, incl. workspace typecheck) | 98 passed, 0 failed | — |
| `apps/server test:store` | 1 failed / 383 | 1 failed (same test) |
| `apps/server test:services` | 41 failed / 1808 | 41 failed / 1797 |
| `apps/server test:boundary` | 26 failed / 2235 | 26 failed / 2218 |
| `apps/server test:contracts` | 4 failed / 1228 | 4 failed / 1228 |
| `bun run lint:boundaries` | red, `console-ownership` only | same, pre-existing |

Every red is identical to the base; the branch adds passing tests to each shard.

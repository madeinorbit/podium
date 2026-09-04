# Non-blocking update snapshot verification — design

*Issue: POD-2462 (Unified dev/prod update path). Written 2026-08-28 after measuring the
Ludovico interruption during a Flatblock-only update. This is a server-safety change; it does
not change artifact publication, machine reachability policy, or the native desktop updater.*

## 1. Problem and goal

`updates.start` currently asks the migration backup helper for the latest usable database
snapshot while it is planning an operation. The helper opens every retained backup and runs
SQLite `PRAGMA quick_check` synchronously. On Ludovico, three retained snapshots were about
747 MiB each; the call blocked the server event loop for about 79.9 seconds. The resulting
operation updated only Flatblock, while the web server appeared unavailable. The service did
not restart.

The goal is to retain the recovery guarantee of a verified snapshot without doing large file
work or synchronous SQLite work in the request/event-loop process. Starting a machine update
must be responsive even when the database has many retained backups. A server replacement must
still refuse to restart unless its new recovery snapshot is safely prepared.

## 2. Invariants

1. A request handler never copies a database, opens a retained backup, or runs `quick_check`.
2. An unverified, changed, partial, or failed snapshot is never advertised as a recovery path.
3. The server is not stopped or replaced until the snapshot required by that replacement has
   completed verification.
4. A machine-only operation does not inspect database backups at all.
5. A temporary lack of a verified snapshot is reported honestly and does not make the server
   unavailable; the background verifier may fill the cache later.
6. Verification uses bounded resources: one verifier per instance, a deadline, cancellation,
   and cleanup of its child/process resources.
7. Existing 0.1.0 clients, wire contracts, operation records, and the stable updater remain
   compatible. The snapshot path is optional and old records may omit it.
8. Retention remains finite. A newer published target may supersede an old update, but a
   snapshot record is removed only when it is not the current verified fallback and is outside
   the retention window.

## 3. Proposed lifecycle

### 3.1 Snapshot record

Store a small, atomically-written record in the instance state directory for each staged
snapshot. The record contains:

- snapshot path and instance/database identity;
- byte size, mtime, and a content identity captured after staging;
- schema/migration identity;
- `pending`, `verified`, `invalid`, or `failed` status;
- creation and verification timestamps;
- verifier error/exit/timeout details when applicable.

The record is metadata, not a replacement for the snapshot. A verified marker is published by
atomic rename only after the worker has checked the immutable candidate. A worker result must
include the candidate identity; a late result for an older candidate cannot overwrite a newer
record.

### 3.2 Creation and verification

When a snapshot is needed, the parent performs only the minimal database fence and staging
steps required to obtain a consistent copy. It then starts a verifier child (or an equivalently
killable worker) with explicit paths and expected metadata. The worker opens the staged file,
runs the SQLite checks, and returns a small structured result. The parent writes the record and
publishes the verified marker only on success.

The worker receives no live SQLite handle and does not mutate the source database. A failed or
timed-out worker leaves a clearly named partial/failed record for diagnosis, but never makes it
the fallback. If the snapshot is required before a server replacement, the update step reports
the failure and does not stop or restart the server.

### 3.3 Startup and maintenance

At boot, enumerate snapshot metadata using cheap `stat`/record reads. Do not open every file.
Use the last verified record whose identity still matches the file as the immediate fallback.
Queue at most one background verifier for pending or changed records. If no verified record is
available, the health surface says so; it does not wait for a scan. Reconciliation can invalidate
records for deleted or modified files and enqueue them again.

The same maintenance path handles a snapshot created by an older version that has no record:
it records a pending candidate and verifies it in the worker. This makes upgrades from 0.1.0
safe without requiring an old client or old server to understand the new fields.

### 3.4 `updates.start`

Planning reads a cached verified path, if one exists, and never calls the current
`latestDatabaseBackup` scan. It does not await verification and does not copy a snapshot. The
operation can therefore return its id promptly for a Flatblock-only, daemon-only, or all-offline
plan. The plan carries no snapshot path when no verified record is available.

### 3.5 Actual server replacement

The server-update step, and only that step, requests a fresh snapshot when the replacement
policy requires one. It awaits the worker-backed Promise inside the operation runner. Awaiting a
Promise is safe here because the expensive work is outside the event loop; the runner still
emits progress and allows unrelated health/read requests to be served. On success, the verified
record/path is attached to the operation before handover. On failure, the operation records a
structured preparation error and leaves the old server running.

## 4. Worker contract

The verifier boundary should be a small server-owned module with one implementation used by
startup maintenance and the server-update step. A child process is preferred when SQLite can
hold native resources or must be forcibly killed; a worker thread is acceptable only if its
SQLite bindings and cancellation semantics are proven.

Input:

- instance/state directory, source database path, staged candidate path;
- expected size/mtime/content identity and schema identity;
- absolute deadline and a correlation id.

Output on success:

```ts
{ ok: true, path, identity, size, schemaVersion, verifiedAt }
```

Output on failure is structured (`corrupt`, `missing`, `identity-mismatch`, `timeout`,
`cancelled`, or `worker-exit`) and includes safe diagnostics, exit/signal, and duration. Do not
return tokens, database contents, or arbitrary exception text to a client.

The parent enforces a timeout, sends cancellation, waits briefly for clean exit, then kills a
stuck child and closes its handles. A per-instance admission gate prevents parallel full-file
scans. The event loop handles only child messages and small metadata writes.

## 5. Races, restart, and retention

- Stage into a unique temporary name, fsync as required by the existing backup contract, and
  rename to the final candidate only after the copy is complete.
- Verify the immutable candidate, then atomically publish its verified marker/record.
- Re-stat before accepting the result; a changed or deleted candidate invalidates that result.
- On process restart, pending records are safe to retry and failed/partial records are safe to
  retain for forensics or clean up by the existing retention policy.
- A late worker result is accepted only when its correlation id and identity still match the
  current record.
- Keep the newest verified fallback plus the configured finite history. Never remove the active
  verified fallback merely because a newer update was prepared; remove it only when retention
  says it is no longer needed.

## 6. Compatibility and scope

The existing operation/database fields remain valid. New snapshot metadata is additive and
optional; readers tolerate records written before this change. No API or wire-version bump is
needed. Stable 0.1.0 users still take the existing updater path; this fix changes the server's
internal recovery preparation, not the client shell.

Explicit non-goals:

- changing the Flatblock/offline publication gate;
- making publication wait for every machine;
- changing artifact retention or feed selection;
- adding automatic updates or a second update scheduler;
- trusting an unverified snapshot to make a request fast;
- moving the whole database backup subsystem into the web process.

## 7. Observability

Record structured phase timings for snapshot stage, worker start, verification, publication, and
cleanup. Include candidate count/bytes, outcome, timeout, exit/signal, and correlation id. Add a
small event-loop lag/heartbeat measurement around the update router so a regression is visible.
The update operation should show “preparing recovery snapshot” while the worker runs and the
specific failure if it does not finish.

## 8. Validation plan

The implementation worker should add focused tests for:

1. metadata creation, atomic publication, cache reads, changed/deleted invalidation, and finite
   retention;
2. worker success, corrupt/missing input, timeout, cancellation, child crash, and stale-result
   rejection;
3. restart recovery of pending and failed records;
4. `updates.start` returning while a verifier is deliberately slow, with a concurrent health
   request completing under a bounded threshold;
5. server replacement refusing to stop on verifier failure and recording the verified path on
   success;
6. machine-only and all-offline plans never invoking the verifier.

Run the repository's normal `bun run test` once after the complete implementation. Add the
server/store or integration lane only if the changed files and behavior require it according to
`docs/agents/testing.md`; do not use a live Ludovico or Flatblock run as the proof of this
internal boundary.

## 9. Self-review

I checked this design against the observed 79.9-second stall and the current call chain:
`updates.start` → planning context → `latestDatabaseBackup` → synchronous `quick_check` over
all retained files. It addresses that exact boundary and does not misattribute the outage to a
server restart or Flatblock reconnect.

Rejected alternatives:

- Merely marking the function `async` would still run synchronous SQLite work on the event loop.
- Moving the scan to boot would trade a request outage for a boot outage and still delay health.
- Verifying only the newest file would discard a valid older fallback without an identity proof.
- Async filesystem calls alone do not make SQLite `quick_check` non-blocking.
- Letting a worker open the live database would weaken the consistency fence; the worker gets a
  staged immutable candidate instead.
- Awaiting the worker in the operation runner is acceptable; awaiting a child-backed Promise is
  not the same as blocking the server thread.

The remaining implementation choices are deliberately narrow: child process versus worker
thread, exact record schema, and existing backup-fsync details. They can be selected from the
current backup module without changing the lifecycle or invariants above. The design therefore
gives the worker a testable contract while leaving repository-specific plumbing to code review.

## 10. Implementation handoff

Likely touch points are `apps/server/src/migrations/backup.ts`, the server state/store metadata
layer, and `apps/server/src/modules/updates/{operation,trpc}.ts`, plus focused tests. Start from
the current `dev/mw` branch in an isolated child worktree. Do not chase later `dev/mw` churn,
merge, publish, approve, or alter live services. Mail the parent issue with the commit, one
end-of-task gate, specialized results, and any intentionally deferred choice when the branch is
ready for review.

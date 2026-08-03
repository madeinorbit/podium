# POD-1597 — the boot catch-up fix, measured

Companion to [pod-1597-boot-stall-diagnosis.md](pod-1597-boot-stall-diagnosis.md),
which located the stall. This is the fix and its before/after on the same rig.

## The change

`oplog.appended` carried every issue in one batch and the handler recomputed
delivery eligibility **per change**: for each change, walk every session; for each
session without an explicit `issueId`, resolve its cwd against every issue row.
On the live database that is 1272 × 1172 × 1570, synchronously, inside the
`SessionRegistry` constructor before `serve()`.

Membership is a set operation, so it is now computed once for the whole batch:

- `MessageDeliveryService.onIssuesEligibilityChanged(ids)` — one pass over the
  changed set to queue the issue targets, one pass over sessions to decide which
  session principals to re-queue. `onIssueEligibilityChanged(id)` remains, as the
  single-id call into the same code.
- `relay.ts` collects the issue ids out of an `oplog.appended` batch and makes one
  call instead of one per change.

**What is published is unchanged; only how many times it is recomputed.** The
per-change form fired a session when its resolution named the changed issue on
either side, or when it had drifted — and the first fire updated
`sessionIssueTargets`, so every later change in the same batch re-derived the same
answer and re-queued the same coalescing key. The loose `previous !== next`
comparison (`undefined !== null` is true, so a session resolving to no issue is
queued and `countPending` drops it) is deliberately preserved: tightening it would
change WHO is recomputed.

Plus one operator-visible line: the boot catch-up now warns with its row count and
duration when it exceeds 2 s, so a slow one reads as work rather than a hang.

## Before / after — same box, same rig, same database copy

**ludovico, 8 cores, 2026-08-03.** The box was shared with this epic's fan-out
throughout; the 1-minute load average at the start of each run is stated beside it.
Rig exactly as in the diagnosis: a `sqlite3 .backup` snapshot of the live install
(214 MB, 1579 issues, 1176 sessions, 5414 messages, 20 001 retained change rows, of
which only **326** issues still have a retained upsert baseline), copied fresh per
run into a private `PODIUM_STATE_DIR`, driving `startServer({port: 0})` to a served
`GET /health`. 21 migrations pending on every run.

| Run | Build | Load at start | Time to first served HTTP answer |
|---|---|---|---|
| before-1 | this branch, fix reverted | 5.5 | **661.6 s** |
| fixed-1 | this branch | 8.6 | **14.9 s** |
| fixed-2 | this branch | 25.9 | **22.0 s** |

Runs are interleaved A/B/A against the same binary and the same snapshot; the fix
was unapplied and reapplied in place (`git apply -R` / `git apply`) so nothing but
those two files differed.

For scale, from the diagnosis on the same rig: **main boots the same copy in
286.7 s** (it carries the same storm — 1250-odd issues re-stage on any boot once
retention has evicted their baselines). This branch is now ~13–19× faster than main
on that database, not merely back to parity.

## The catch-up still happens

It is proved by the log the boot writes, not by the absence of an error. Before the
run, the copy has a retained upsert baseline for 326 of 1579 issues. After the
14.9 s boot:

    sqlite> select count(distinct entity_id) from changes where entity='issue' and op='upsert';
    1579

All 1579 issues were published — the same set the 661.6 s boot published, in 14.9 s.

Two named unit tests hold the line
(`apps/server/src/modules/messages/service.test.ts`):

- *delivers the same mail for a batched issue recompute as for per-change calls* —
  drives both forms over the same fixture and compares what was actually sent.
- *resolves session membership once per session for a whole issue batch* — bounds
  membership resolutions by the session count. Verified to fire: restoring the
  per-change body inside the batch entry point fails it at 61 resolutions against a
  bound of 4.

## What is NOT in this change

The listener still opens **after** the catch-up. Deferring it behind a readiness
signal is a bigger change than it looks, because `Authority.bootstrap()` builds a
connecting client's world out of the change log (`latestChangeStates()`) — serving
before the catch-up completes would hand that client a world missing the ~1250
issues whose rows had aged out. That is the half-built view, so the deferral needs
a readiness gate on the feed attach path (hold or honestly refuse a client
bootstrap until catch-up completes) and a yielding reconcile, or it trades a
refused connection for a silently wrong one. At 15–22 s the remaining boot no
longer justifies that risk on its own; it is worth doing when a bigger install
makes it matter again.

## Gates

    bun run typecheck
     Tasks:    23 successful, 23 total
    Cached:    20 cached, 23 total
      Time:    17.245s

    bun --bun vitest run --config vitest.unit.config.ts --pool=forks apps/server/src
     Test Files  263 passed (263)
          Tests  3912 passed | 1 skipped (3913)
       Duration  219.90s

The FULL unit lane (`bun run test:unit`, 724 files) is 5 files / 6 tests red on this
branch, and they are **integration's, not this change's**: `scripts/audit-durable-classes`
(`message_reads` undeclared, `session-mint.ts` unaccounted), `scripts/audit-god-objects`
(`issues/service/workflow.ts` at 1319 lines against a 1300 budget),
`packages/runtime/src/session-mint`, `apps/cli/src/operator-client`,
`apps/daemon/src/unknown-op-reply`. Every file those checks name is byte-identical
to integration `47368203` under `git diff 473682032 HEAD -- <them>`, and this commit
touches none of them. A sixth worker died of SIGILL mid-file on a box at load 20–25.

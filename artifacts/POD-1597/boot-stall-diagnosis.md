# POD-1597 — where the ~9-minute boot goes

**Measured 2026-08-03 on ludovico** (8 cores, load average 16–33 throughout — the box
was shared with this epic's fan-out; every number below is therefore an upper bound of
the same order, not a quiet-box figure). Rewrite tree: `issue/1597-…` at `4045b2d2b`
(integration). Main: `2aaea6439`.

Database: `sqlite3 ~/.podium/podium.db ".backup"` snapshot of the live install —
214 MB, 1570 issues, 1172 sessions, 5406 messages, 30 drizzle migrations applied.
Each run starts from a byte-identical copy of that snapshot in a private
`PODIUM_STATE_DIR`, and drives `startServer({port: 0})` to its first served
`GET /health`.

## The numbers

| Run | Build | Database | Time to first HTTP answer |
|---|---|---|---|
| 1 | rewrite | fresh copy (21 migrations pending) | **667.9 s** |
| 2 | rewrite | same directory, second boot | **24.6 s** |
| 3 | main | fresh copy (no migrations pending) | **286.7 s** |

Boot phases on the 667.9 s run:

| Phase | Cumulative |
|---|---|
| 21 drizzle migrations applied | 1.1 s |
| whole `SessionStore` ctor (migrations + every per-boot heal) | 5.7 s |
| `SessionRegistry` ctor up to `issues.boot()` | 8.5 s |
| **`issues.boot()`** | **8.5 s → 597.2 s** |
| rest of registry + app wiring + `listen()` | 667.9 s |

Inside `issues.boot()`:

| Step | Duration |
|---|---|
| `store.init()` (hydrate 1570 rows) | 0.06 s |
| session totalization loop | 0.4 s |
| `reapLeakedDrafts()` | 5.2 s |
| **`ledger.reconcile('issue', allWire())`** | **649.1 s** |
| `reconcile('issueProjection' / 'issueDep')`, `publishRepos()` | 1.1 s |

Inside that one call (`Authority.reconcile`, 1570 specs → 1272 staged rows):

| Step | Duration |
|---|---|
| `stage()` (JSON + detection keys) | 0.09 s |
| `append()` (16 batched INSERTs) | 0.40 s |
| baseline fold | 0.13 s |
| **`broadcast()` → subscriber #1 (`WriteFunnel`)** | **573.1 s** |

## The mechanism

`WriteFunnel`'s Authority subscription emits one `oplog.appended` with all 1272 issue
changes (`apps/server/src/modules/funnel.ts:123`). The registry's handler
(`apps/server/src/relay.ts:1176`) loops **per change** and calls
`messagesSvc.onIssueEligibilityChanged(id)`. That method
(`apps/server/src/modules/messages/service.ts:473`) iterates **every session**, and for
each session without an explicit `issueId` calls `issues.issueForCwd(cwd)`
(`apps/server/src/modules/issues/service/reads.ts:576`), which **scans every issue row**.

    1272 issue changes × 1172 sessions × up to 1570 issue rows

That is the 573 seconds. Nothing is hung and nothing is waiting on I/O: 100 % CPU,
RSS ~1 GB, no DB writes during the window.

## Why it fires at all — and why it is not only an upgrade cost

`reconcile` only stages issues whose wire payload differs from the change-log baseline,
and that baseline is seeded from the **retained** change log (newest 20 000 rows /
3 days). On the live database the log has already aged out most issues:

    issues: 1570        issues with a retained upsert baseline: 316

So ~1250 issues stage on *any* boot of that database — which is exactly why **main
takes 286.7 s with no migrations to apply**. The upgrade makes it slightly worse
(all 1570 wire payloads change, so 1272 stage instead of ~1254) and the rewrite's
per-change handler is ~2× main's, but **the storm is pre-existing, not a rewrite
regression**.

The fast second boot (24.6 s) is not a fix: it is fast only because the previous boot
just re-appended all 1570 issue rows at the head of the log. Retention will evict them
again as conversation/session traffic accumulates, and the next boot pays the full cost
again. The live database above *is* that steady state.

## Can it serve while it works?

Not today. `issues.boot()` runs synchronously inside the `SessionRegistry` constructor,
which runs inside `startServer` before `serve()` is called, so the port is simply not
open: a browser shows a connection error and a systemd watchdog concludes the unit
failed to start. There is no page and no progress output.

Structurally it could: the reconcile is a *catch-up publish* into the change log. No
client can read it until one connects, so opening the listener first and running the
reconcile behind a readiness signal would change a 9-minute connection refusal into a
9-minute "catching up" — and fixing the quadratic would remove most of the 9 minutes.

## Recommended fixes (in order of value)

1. **Kill the quadratic.** `onIssueEligibilityChanged` should not rescan every session
   per change, and `issueForCwd` should not rescan every issue per session. Either
   coalesce the batch (one pass over sessions for the whole `oplog.appended` batch
   instead of one pass per change), or index sessions by resolved issue / cwd. This
   alone should take the 573 s to seconds.
2. **Open the listener before the boot reconcile**, behind a readiness signal, so a
   slow catch-up is a visible degraded state rather than a dead port.
3. **Report progress.** A boot step that can take minutes on real data should say so on
   stdout with a count and a rate.

## Reproducing

    sqlite3 ~/.podium/podium.db ".backup /tmp/pristine.db"
    mkdir /tmp/rehearsal && cp /tmp/pristine.db /tmp/rehearsal/podium.db
    cp ~/.podium/{config.json,repos.json,instance.json} /tmp/rehearsal/
    PODIUM_STATE_DIR=/tmp/rehearsal bun --conditions=@podium/source ./boot-probe.ts

where `boot-probe.ts` awaits `startServer({port: 0, host: '127.0.0.1'})` and then fetches
`/health`. Note that bun block-buffers stdout to a file, so a probe must tee its marks
through `appendFileSync` to be observable during the stall, and the probe file must live
**inside** the worktree or bun resolves `@podium/server` to a different checkout.

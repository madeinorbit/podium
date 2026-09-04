# Flatblock's seven-minute update (POD-3170)

Flatblock took about seven minutes to finish an update that succeeded. Two of them happened on
2026-08-31 and both are recorded here. The work Flatblock actually did took thirteen seconds; the
rest was a delivery the coordinator destroyed and nothing noticed.

Every timestamp below is UTC, taken from Ludovico's `podium.service` journal, Flatblock's
`podium-daemon.service` journal, and the persisted `operations` rows. Nothing here is inferred from
a hypothesis — where a number could not be read out of a log it was measured directly, and that is
said each time.

## The two updates

| | `op_4ca629cd` (dev.30 → dev.31) | `op_7b7fc07a` (dev.32 → dev.33) |
| --- | --- | --- |
| Operation created | 09:38:15.636 | 09:54:08.553 |
| Canary round (a Mac) | 09:38:15.658 | 09:54:08.573 |
| **Widen round grants Flatblock *and* Ludovico** | **09:38:27.982** | **09:54:17.058** |
| Ludovico's parent completes its own swap | 09:38:30.831 | 09:54:19.764 |
| Ludovico reports `restarting` — the server dies | 09:38:31.062 | 09:54:19.897 |
| Successor server accepting connections | ~09:38:53 | ~09:54:32 |
| Flatblock's daemon reattaches, still on the old version | (same shape) | 09:54:30.068 |
| **Nothing at all is recorded about Flatblock** | **09:38:31 → 09:45:07** | **09:54:30 → 10:00:51** |
| Wave re-grants Flatblock | 09:45:07.166 | 10:00:51.241 |
| Flatblock's install directory swapped | — | 10:01:04.767 |
| Flatblock's daemon up on the new version | 09:45:19 (approx.) | 10:01:07.616 |
| Operation finished | 09:45:19.615 | 10:01:09.738 |

Both operations record `"attempts": 5` on their `machines` step.

## What the intervals are

| Interval | `op_4ca629cd` | `op_7b7fc07a` |
| --- | --- | --- |
| Total, grant to Flatblock converged | 411 s | 411 s |
| First grant → re-grant, with nothing recorded | **399.2 s** | **394.2 s** |
| Re-grant → Flatblock running the new version | 12.4 s | 16.4 s |
| Re-grant → install directory swapped | — | 13.5 s |

The dead interval is 96 % of the first update and 96 % of the second. Everything else — proposal,
grant, artifact selection, download, verification, extraction, swap, handover, systemd restart,
successor readiness, WebSocket reconnect, version convergence and the completion acknowledgement —
fits inside the thirteen seconds at the end.

## What it is not

These were checked before anything was changed, because each is a plausible reading of "an update
took minutes".

**Not download throughput.** Measured from Flatblock against the same artifact route and the same
grant token: `63 306 574` bytes in `4.277 s`, `14.8 MB/s`. Two orders of magnitude away from
explaining 394 s.

**Not the database backup or a migration safety check.** `op_7b7fc07a` names
`podium.db.backup-vdrizzle-85-2026-08-26T14-22-49-193Z` — a snapshot five days older than the
operation — and both releases carry `releaseHadMigrations: false`. Flatblock's own newest database
backup is from 2026-08-30, not from either update.

**Not extraction, verification or the swap.** Ludovico's install directory carries the tarball's
own mtimes, so the only durable extraction evidence is `~/.local/share`'s directory mtime, which
moved at 10:01:04.767 — 13.5 s after the re-grant that produced it, downloading included.

**Not retry backoff on Flatblock.** Flatblock's journal has no line at all between its daemon
starting at 09:45:19 and its successor starting at 10:01:07 — sixteen minutes covering both the
dev.32 window and the whole dead interval. There is no retry loop visible because there is no
logging on that path whatsoever (see "What could not be attributed").

**Not parent supervision.** Flatblock's daemon reports `supervised: false, underParent: false`; it
is a plain systemd unit. Its stop-to-start gap is the unit's own `RestartSec`, 3 seconds.

## The cause

`decideWave` sorts eligible machines by id and grants the first `concurrency` of them. It has no
notion that one of those machines is the host running the coordinator. On this fleet
`c2ba…` (Flatblock) sorts before `dabf…` (Ludovico), so `issueGrants` sent Flatblock's grant over
its socket and then handed Ludovico's to the local participant in the same loop.

Ludovico is the coordinator. Applying its own grant means:

- the WebSocket Flatblock's grant went out on closes,
- the HTTPS artifact route Flatblock is downloading *from* stops answering,
- `UpdatesService.pendingGrants` — which is in-memory — is gone with the process.

The swap completed 2.8 s after the grant went out, against a download that needs 4.3 s. Flatblock
came back attached to the successor at 09:54:30.068 reporting `current` at its **old** version, with
no grant recorded on either side of the link. `onStatus` drops a report whose `grantId` the server
cannot place, and the successor could not place any of them.

That leaves the operation's `machines` step waiting on a machine nothing is driving. Its silence
budget is `DEFAULT_DOWNLOAD_TIMEOUT_MS + machineSilenceMarginMs` — seven minutes — and only when it
expires does `ensure()` re-issue grants and tick the wave again. That tick is the 10:00:51 line.

POD-2741 already found one shape of this ("After a self-handover the successor therefore has no
pending grant for the coordinator that just converged … only the step's silence deadline is left —
about seven minutes"). Its guard fires when a place is `pending` and nothing is in flight. It does
not fire here, because the machine reports `current` — at the wrong version — rather than `pending`.
The guard is downstream of the problem. This is upstream of it.

## The fix

The coordinator goes last. `decideWave` holds the machine flagged `coordinator` with a new
`coordinator-last` exclusion while any *other* machine is eligible or in flight, and the composition
root in `relay.ts` sets that flag on `machines.hostMachineId`.

It cannot deadlock. Only a machine that could be granted right now holds the coordinator back, and
every permanent way of not converging — offline, a verdict a human must clear, a release with no
bytes for that platform, a source checkout — is already an ineligibility. A fleet whose only machine
is the coordinator is never held at all.

It does not weaken any safety property. The canary gate, the trust root, the platform and delivery
predicates, the signature check, the pending-grant marker, the health gate and rollback are all
untouched. It moves the canary somewhere strictly better: a bundle proved on a remote machine is
proved without risking the server that has to watch the proof.

## What could not be attributed, and now can

Building this timeline needed a hand-run `curl` and a directory mtime because three things were
never written down.

1. **A grant leaving the server.** Only the coordinator's own grant was logged, on *receipt*, in
   `local-participant.ts`. `update grant issued` now records every grant at the instant it is sent,
   with the machine, the grant id, both versions and whether the machine is the coordinator.

2. **A machine's phases.** They existed only in the live panel, so after an update finished there was
   no answer to "how long did that machine spend downloading?". `update machine phase` records each
   transition — not each heartbeat — with `sinceGrantMs` measured from the instant above.

3. **Anything at all on the machine doing the work.** `applyGrant` had no logging, so a delivery that
   died with its socket left no trace on either end. It now writes `update grant accepted`,
   `update artifact verified` (with `downloadMs` and the byte count), `update bundle swapped`,
   `update restarting into successor` (with the total) and `update grant failed` — to the host's own
   log, which survives the link, the grant and the process being replaced.

`update status dropped` is the fourth: a report the server cannot place is still dropped, but no
longer silently. That line is what would have named this in minutes instead of hours.

# POD-3258 — timer single-flight ledger

One row per `setInterval` / recurring-timer site in non-test server code, by symbol:
the category, the model chosen, and the commit that applied it. This is the B-prep
ledger row set the execution method's §2 asks for (`docs/internal/pod-3221-execution-method.md`),
for spec §2.5 item 8 (`docs/internal/pod-3221-spec.md`).

Enumeration: `grep -rn setInterval apps/server/src --include=*.ts`, excluding `*.test.ts`
and `test-support/`. 20 sites. Every one is classified below; none is unaccounted for.

## A. Reaches the store — guard added by this issue

All eleven take the **skip** model, not coalescing. Each is a backstop or a heartbeat over
durable state, so a dropped tick re-reads the same subject one interval later; queuing a
second pass would buy nothing and would keep a slow pass's backlog growing. Where the
coalescing model *is* the right contract it already exists in the codebase — see D.

| # | Site (symbol) | Category (spec §2.5) | Hazard once the store awaits | Model | Fence |
|---|---|---|---|---|---|
| 1 | `DeliveryScheduler.sweep` — `modules/messages/scheduler.ts` | timer, read-decide-write, multi-page | The fence was `retryBackstopTimer`, which is **null for the whole of every page body** and set only in the gap between pages. It answered "is a page scheduled", not "is a pass running". | skip | `retryPassStartedAt !== null` (the pass stamp already maintained) |
| 2 | `ApprovalService.sweepStalledExecutions` — `modules/approvals/service.ts` | timer, read-decide-write over in-memory `stallClock` | The bottom-of-pass reconcile deletes every id not in *its* `live` set, so an overlapping pass drops the clock entries the first just seeded and restarts the deadline. | skip | `sweepingStalled` |
| 3 | `AutomationScheduler.tick` — `modules/automations/scheduler.ts` | timer → store read + spawn write | Two passes read the pre-spawn snapshot and both spawn the same occurrence; the occurrence run id that prevents it is written too late. | skip | `ticking` |
| 4 | `IssueAutoArchive.sweep` — `modules/issues/auto-archive.ts` | timer, select-then-write | Both passes select the same read+done issues and archive each twice, doubling the ledger entries a person sees. | skip | `sweeping` |
| 5 | `IssueSessionLifecycle.sweepClosedIssues` — `modules/issue-session-lifecycle.ts` | timer, async **today** | **Already exposed, not merely exposed after the flip.** It awaits `stopClosedIssueNow` per issue inside the loop, so on any slow boot the startup pass is still in the loop when the first periodic tick fires. | skip | `sweepingClosedIssues` |
| 6 | `SessionRepository.flushActivity` — `modules/sessions/repository.ts` | timer, in-memory mirror + store write | `clearActivityDirty()` runs *after* `persist`, so the dirty flag fences only while the pair is one turn. An overlapping flush writes the row twice for one counter advance. | skip | `flushingActivity` |
| 7 | `SessionInbox.sweepQueuedInputs` — `modules/sessions/inbox.ts` | timer, enumeration + fenced fan-out | The fan-out into `drain` is already single-flight per session, so no row can double-deliver. What is unfenced is the `sessionsWithPending` store read itself. | skip (outer) | `sweepingQueuedInputs` |
| 8 | `SuperagentService.reapStaleTurns` — `modules/superagent/service.ts` | timer, read-decide-write | `dispatchedTurnIds` and the finish are both written by `finishPendingTurn`, so an overlapping reap sees the turn still pending and reports it lost to a caller already told. | skip | `reaping` |
| 9 | `StewardService.tick` — `steward.ts` | timer, read-decide-write over one durable cursor | The cursor is advanced only after deliveries are durable (deliberately). Two polls therefore both read the pre-advance cursor and handle the same window. Handlers are idempotent, so this is duplicated work rather than corruption — and the timer and the janitor drive the same instance. | skip | `ticking` |
| 10 | `ShippingService.tick` — `modules/shipping/service.ts` | timer, async today | `admissionsInFlight` and `inFlight` fence the *admission*, not the pass that decides it, and the recovery, the order read and the schedule build all await before the first admission. | skip | `ticking` |
| 11 | resource-lease renew tick — `modules/shipping/service.ts` (`acquireResources`) | timer → lock service (durable rows) | Fires every ttl/3, so a renew slower than a third of the TTL meets the next tick. Two renews race on `lease.lost` / `lease.expiresAt`; the loser's stale verdict overwrites the winner's. | skip, per lease | `lease.renewing` |

## B. Reaches the store — already guarded before this issue

These are the models the eleven above were copied from. No change made.

| Site | Model | Fence |
|---|---|---|
| `IssueGitWatch.sweep` — `modules/issues/git-watch.ts` | skip | `sweeping` |
| `QuotaSampler.sampleNow` — `modules/quota-history/service.ts` | share the in-flight promise | `inFlight` |
| `EventLogRetention.pruneNow` — `modules/events/retention.ts` | **coalesce** — overlapping triggers share one flight and fold into at most one follow-up pass | `pruneFlight` + `pruneRerunRequested` |
| `SessionInbox.drain` — `modules/sessions/inbox.ts` | skip, keyed per session | `activeDrains` |

## C. Does not reach the store — no guard needed

| Site | What the callback does |
|---|---|
| `gateway/daemon-socket.ts` inventory settle | sends an `inventoryRequest` frame over the socket |
| `gateway/plane-liveness.ts` heartbeat | sweeps socket liveness; no persistence |
| `modules/messaging/service.ts` typing refresh | `adapter.sendTyping` only |
| `modules/updates/dev-bundle.ts` lock renew | renews a filesystem `DevBundleLock`, and is **already serialised** by its own promise chain (`renewal = renewal.then(...)`) |
| `server.ts` attribution window | resets in-memory query/task attribution counters |

## D. Noted, out of scope, no guard added

`DeliveryScheduler.reconcile` (`modules/messages/scheduler.ts`) is a chained-`setTimeout`
pager over the store with no in-flight fence of its own. It is **not** timer-driven: it is
called once at boot, from `relay.ts`. A second concurrent `reconcile()` would fork two
walks, but nothing calls it that way. Recorded here so the flip's reviewer sees it was
looked at rather than missed.

## Evidence

One unit test per guarded callback, each proving the overlapping tick is skipped. The probe
re-enters the callback from inside the pass — through a fake-timer advance, or through an
injected dependency the body calls — because that is the only way to produce a genuine
overlap while the body is still synchronous, and it is the same window an awaited store call
will open. Every guard was mutation-checked by deleting its fence line and re-running its
test; results are in the issue's handoff.

## A trap worth recording, for whoever writes the next guard test

Three of the eleven tests passed on their first version **and passed with the fence deleted**.
All three were vacuous for a fake-timer reason:

- `AutomationScheduler` and `IssueAutoArchive` arm their interval only *after* the boot
  one-shot's pass returns. Re-entering from inside that first pass fires nothing, because
  there is no interval yet. The fix is to advance past the boot delay first, then re-enter
  from inside a pass the interval drives.
- The shipping resource lease's tick was an anonymous `setInterval` closure. Fake timers will
  not re-fire an interval that is currently executing, so no nested advance can produce an
  overlap there at all — the test could only ever pass. The fix was to extract the tick into
  a named method (`renewResourceLeaseTick`), the same extraction the other guarded passes
  took, and drive it directly.

The general lesson: a single-flight test that never actually produced a second entry is
indistinguishable from a passing one. Delete the fence and re-run before believing any of them.

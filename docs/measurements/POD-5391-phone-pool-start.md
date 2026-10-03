# Phone pool warm start (POD-5391)

**Verdict.** The reported warm start (4,004 ms pilot OFF vs 8,369 ms ON, POD-5171 at `ff0b3ce1fd`) was a harness artifact. None of its "warm" launches was warm. With launches that really resume from the saved replica, opening a session settles at **689 ms OFF vs 1,727 ms ON** on POD-5171's session-reader tree and **697 vs 676 ms** on `integrate/4286-pilot`. On both trees the pilot's cost is the **pool build at attach**, about 0.5 s of main-thread work. On POD-5171's tree the session screen waits for it, and its mention-issue reader adds about 0.2 s.

## Why the POD-5171 warm arms were not warm

The sized fixture's bootstrap holds 11,305 rows. Committing them to IndexedDB takes about 5 s (one `entities,meta` readwrite transaction, observed at 4,874 ms). POD-5171's harness left each launch within about 2 s of it becoming visible. Every navigation aborted the uncommitted write, so:

- no launch ever found a saved cursor: every launch fetched `/sync/bootstrap` again (no `/sync/delta` request was made at all);
- each launch's `indexedDB.open` waited behind the previous launch's aborted write: 2.2 s, 2.8 s, 5.7 s, 5.3 s, 8.1 s, 10.0 s, 12.3 s in successive launches. Past the store's 8 s open timeout, the app shows **STORAGE UNAVAILABLE**;
- the arms ran in a fixed order (cold OFF, cold ON, warm OFF, warm ON), so the warm ON arm always ran last, behind the largest backlog.

Control: the same harness without the sized corpus resumed with `/sync/delta` on every launch, with 1–16 ms opens. With the sized corpus and a durable barrier (below), every measured launch resumed with a delta and opened in 1–4 ms.

**Product note (not a pilot cost):** a phone that is closed within about 5 s of its first sized bootstrap loses the whole download and re-bootstraps at the next start, behind a slow IndexedDB open. Observed: the settings screen already showed cursor 776 while the next launch still re-bootstrapped, so the displayed cursor is not proof of durability.

## Measurement contract

- Harness: `tests/e2e/browser/expo-mobile-pool-start-profile.browser.e2e.ts` (opt-in `PODIUM_PHONE_PROFILE=1`), helpers in `_phone-profile.ts`, offline analyzer `tests/e2e/phone-profile-analyze.ts`.
- Production phone web export (`expo export -p web` with the build's flags, plus `--source-maps external` for attribution only), Pixel 7 Chromium 148.0.7778.96, flatblock, under `bench:flatblock`. The isolated harness server provides the data; POD-5171's protocol-valid sized bootstrap clones it to 6,100 issues and 5,200 sessions (11,305 rows).
- **Warm** = a fresh document launch of `/mobile/session/:id` whose predecessor committed its cursor. The harness proves the commit with a readonly IndexedDB transaction over `entities` and `meta`, which queues behind every earlier overlapping readwrite. It also asserts zero bootstrap fetches for every measured launch. The pilot is latched by the previous launch; the settings screen's "This launch: on/off" is asserted before each toggle.
- **settledMs** = navigation start → "Session actions", a textbox and the session title present in the DOM (in-page MutationObserver) + two animation frames. **busyUntilMs** = end of the last >50 ms long task up to 5 s after settling (or settledMs).
- Order: OFF, ON, ON, OFF, OFF, ON (balanced), then the same order traced. Timed samples carry no tracing. Traced samples carry a Chromium trace with V8 CPU samples (`disabled-by-default-v8.cpu_profiler`, which survives the navigation). The analyzer charges each sample's interval to its source-mapped stack over navigationStart → settled + 3 s, on the session document's main thread. Sampled estimates, not call counts. Inclusive rows overlap and must not be added.

## Results

| Tree | Arm | settledMs (3 timed) | median | busyUntilMs median | traced settledMs median | heap after |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `integrate/4286-pilot` `b13000babb` | OFF | 648 / 697 / 751 | **697** | 829 | 1,116 | 45 MB |
| | ON | 790 / 676 / 637 | **676** | **1,373** | 1,059 | 65 MB |
| POD-5171 `191805df65` (WIP) | OFF | 619 / 689 / 710 | **689** | 794 | 1,229 | 45 MB |
| | ON | 1,695 / 1,727 / 2,146 | **1,727** | 1,727 | 2,292 | 80 MB |

Harness commits: `4f9a017716`–`f4f0dbb43c` on `b13000babb`; the same three harness files on `191805df65`. n=3 per arm, one SHA per tree, box load 4–7: a signal, not a gate.

## Where the pilot-ON time goes (traced, mean of 3)

Integration branch. The screen does not wait for the pool, so this runs after paint as one 355–412 ms long task, then a smaller task:

| Cost | ON ms | What |
| --- | ---: | --- |
| **Pool build at attach** | 332 | `pool-host.ts:113` → `createRuntimeWorklistPool` → `createWorklistPool` → `pool.apply` initial `reseed` of all 11,305 rows in one `runInAction` |
| ↳ resident index | 132 | `residency.place` / `keepCold` / `register` for every row |
| ↳ relations | 75–108 | `relations.changed` / `relink` |
| ↳ row-source enumerate + snapshot | 78 | `row-source.ts` `enumerate`, `snapshot` |
| ↳ sidebar roster | 33 | `sidebar-roster.flush` / `sync` |
| **Second row delivery after attach** | 161 | `row-source` microtask `flush` → `measureWorklistPoolDelivery` → `pool.apply` (ingest, `keepCold`, roster sync): the first-live session read-state revisit, see below |
| Hydration (IndexedDB open + read) | ≈0 | same in both arms (`indexeddb/store.ts` 67 vs 89 ms) |
| Render | +28 | `SessionScreen` (legacy `useIssue` re-read after attach) |
| GC | +33 | |

By file, inclusive ON−OFF: `pool.ts` 431, `residency.ts` 284, `row-source.ts` 258, `relations.ts` 162, `sidebar-perf.ts` (delivery) 161, `enumerate.ts` 156, `tables.ts` 94, `sidebar-roster.ts` 91. Self time is spread out: no single hot leaf. `residency.ts` 133, `relations.ts` 106, MobX 58, `row-source.ts` 54 ms self.

POD-5171's tree, where the session screen reads the pool and its paint waits for attach. The same build is larger (more summaries declared): `createRuntimeWorklistPool` 436 ms, post-attach delivery 235 ms, `sidebar-roster` 200 ms. In addition:

| Cost | ON ms | What |
| --- | ---: | --- |
| Session-context mention reader | 141–185 | `use-session-context.ts:103` → `chatMentionIssues(pool)` builds the mention list over every issue summary (`chat-context.ts:19`, `chatIssue`) |
| ↳ summary materialization | 313 incl. | `residency.summary` / `schema.coldFlatUntil` (171) for cold rows read by that list |
| Projection refresh | 206 | `runtime-pool.ts` `refreshProjection` reactions for the screen's readers |

## Ranked shared costs

1. **Pool build at attach (initial reseed)**: 330–440 ms in one long task, mostly resident index placement and relations for every replica row. Every pilot-ON phone start pays this; any screen that waits for the pool shows it.
2. **A second large row delivery right after attach**: 160–235 ms through the same ingest/residency/roster path as the reseed. Source: on a resumed cache, the kernel facade's first `posture: live` re-addresses every session once (`client-core/src/replica/kernel/facade.ts:674`, POD-5114). Until then, sessions with no personal read-state row are LOADING; afterwards that absence is authoritative, so `sessionView` flips `unread` (false → true when there is activity) and the read cursor (LOADING → MISSING). `unread`/`readAt` are residency keep fields (`SESSION_KEEP_FIELDS`) and declared summary fields, so this is a real value change for every session without a personal row (all 5,200 synthetic sessions), not a redundant re-delivery. Only a persisted "personal rows complete at this cursor" marker in the replica store would let a warm start compute final values at attach and skip it.
3. **Readers that scan all summaries** (POD-5171's mention list): 140–185 ms plus summary materialization.
4. Heap: +20 MB (integration) to +35 MB (POD-5171) for 11k rows.

## Work-list row tap and live updates (integration branch)

`tests/e2e/browser/expo-mobile-pool-actions-profile.browser.e2e.ts`, same export, corpus, durable barrier and balanced order. One warm `/mobile/work` launch per sample (zero bootstrap fetches asserted), settled for 3 s. Then: 20 server-side title updates of one visible started issue, each awaited until its row label changes, with main-thread task time from CDP `Performance.TaskDuration` (POD-5172's measure, including the harness's own evaluate calls in both arms). Then a trusted press on another started issue's row: input → end of the first main-renderer Paint after the mission screen's DOM appears (POD-4977's `paintOf`). Box load was 8.8–9.0 during this capture, from other work on flatblock while the lease was held.

| Arm | task ms per update (3 timed) | median | row tap input→Paint ms (3 timed) | median | traced tap median |
| --- | --- | ---: | --- | ---: | ---: |
| OFF | 72.8 / 73.5 / 73.3 | **73.3** | 101.0 / 82.1 / 67.2 | **82.1** | 101.5 |
| ON | 14.8 / 15.7 / 16.7 | **15.7** | 167.7 / 133.0 / 165.8 | **165.8** | 146.4 |

- **Live updates: the pilot is about 4.7× cheaper.** OFF re-renders through the legacy hooks: React 1,460 ms and `issue-view-cache` 445 ms per 20 updates, traced. ON spends about 35 ms in React and about 21 ms in the pool's delivery path. POD-5172's 9–15% increase came from its development inbox fixture and does not reproduce on the production work screen (InboxScreen has no production route).
- **Row tap: ON is slower, but not because of pool code.** The extra 35–55 ms (traced) is `MissionScreen` calling the legacy `useIssues()` (`hooks.ts:178` → `useAllIssueViewModels` → `issue-view-cache.modelsFor` / `deriveIssueViewsSnapshot`, 32 ms), which derives view models for all 6,100 issues. With the pilot OFF the legacy work list has already filled that cache; with it ON the work list reads the pool, so the not-yet-migrated mission screen derives everything cold on the tap. This mixed-mode cost goes away when the mission screen stops calling `useIssues()` or moves to the pool.

## Shared costs across the three cases

1. **Pool build at attach**: 330–440 ms in one long task on every pilot-ON start (initial reseed: resident index placement and relations for every row), plus a second large delivery of 160–235 ms. The only pool-code cost in the three cases, and the largest.
2. Mixed-mode legacy readers on screens not yet on the pool (MissionScreen `useIssues()`), which run cold once the pool replaces the legacy screens that used to warm their caches: 30–55 ms per tap.
3. Not a pool cost: live updates are cheaper with the pilot ON.

Raw traces (DevTools-loadable), per-sample JSON and the analyzer output are attached to POD-5391.

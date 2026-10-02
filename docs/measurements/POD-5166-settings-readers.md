# Settings and setup pool readers

2026-10-02. Branch base: `integrate/4286-pilot` at `63aa99e972`. Final runtime candidate measured: `ca071d79f9`. The coordinator allocated web settings/setup, excluding the version guard, and explicitly cleared the settings source/attachment seams and the app-level Machines selector. Mobile settings is separately tracked in **POD-5225**, blocked on POD-4976; it does not block this web deliverable.

The enabled settings/setup readers execute **zero legacy selectors, slice derivations and preference reads** in the synthetic Chromium proof. Differential comparisons have zero differences and pending loads on the synthetic corpus and the ludovico-only operator replay. The startup switch remains **OFF by default**. This is reader correctness evidence, not a general performance improvement: the isolated enabled fixture also pays for constructing the shared pool and uses more heap and rebuild time.

## Reader contract

Enable with `?mobxSettings=1` at page startup. Add `mobxSettingsCheck=1` to install the on-demand `window.__settingsCheck()` comparison. The choice is latched once; navigation, later initialization and principal changes do not relatch it. Reload without the override to return to the fallback.

`settings-schema.ts` declares machine/repository rows, their resident catalog, the settings-tab window, and the setup-session summary before any reads. There are no new relations. The first catalog demand returns `LOADING` and batches machine, repository and tab loading in one microtask. A loaded missing row returns `undefined`. Unchanged fields do not wake their readers.

Every screen projection reads through `pool.row`. Setup summaries declare only session id, cwd, activity time, agent kind, headless/resume/status and source order. Existing session-id enumeration supplies identity; no new index of unloaded sessions or full session mirror is retained. Temporary summary results preserve resume deduplication, literal repository path-prefix usage and default-agent ties across hot/cold residency. Observed computations suspend when their consumers unmount.

The provider attaches these sources and demanded preferences to its existing single pool, runtime, replica, UI-state port and outbox. API calls and writes keep their existing owner. Scoped setup hooks use the same preference entity while the shared hook's owner retains its independent migration. Repo-scan controllers mount after their saved preference seed loads. Disposal releases source subscriptions, queued loads and owned references; principal replacement builds its new pool through the existing provider boundary.

Baseline evidence is in [the parent inventory](POD-5082-legacy-reader-inventory.md), Settings and activation/setup rows: `SettingsView.tsx:260`, accounts `:71/:220/:378`, updates `:111`, notifications `:223`, `ColdStartComposer.tsx:169` and the activation/setup rows. The indirect `app/MachinesPanel.tsx:157` selector was included by explicit coordinator allocation.

## Flatblock correctness

All tests, lint, typechecks and Chromium work ran sequentially in `~/podium-test-5166`, with its copied checkout-local `.toolchain`, pinned Bun 1.4.2 and frozen checkout-local dependency graph. No full suite or whole test lane ran.

- The exact 21-file settings/setup selection executed 252 tests: initially 240 passed and 12 failed. Four new failures were corrected: absent-row loading behavior, account fixture selector-closure caching and two onboarding machine-capability fixture failures. The affected three files then passed all 19 tests.
- The remaining eight failures reproduce on unchanged base `63aa99e972`: seven obsolete setup expectations tracked in **POD-5224**, and the updates development-version label assertion tracked in **POD-5124**. No product behavior was changed to satisfy those assertions.
- The folded first-task fix and existing handoff checks executed 35 tests in four exact files. Its new fixture was completed to remove swallowed MobX reaction errors; the affected new check then passed cleanly. The existing 30 handoff checks and four settings-pool checks were green.
- Final cached graph/web typecheck: **16 successful tasks, 14 cache hits**. Focused lint on the six changed graph/source/diagnostic files is green after the folded fix.

Seven new unit checks caught planted faults: default-ON startup, relatching on navigation, catalog never completing its load, reversed hot/cold session order, wrong settings tab, leaked owner subscription, and a stale first-task count. Each plant ran through `bun run test:file -- <exact file>` and failed at its assertion; source bytes were copied aside and restored. The corresponding restored checks are green.

The coordinator folded **POD-5233** into this issue because its existing `hasFirstTask` getter violated the pool lint fence. Its separate commit carries both issue trailers. The getter now reads two scalar counts maintained at issue publication deltas and hydration through resident rows or declared cold summaries. It preserves the predicate: archived and draft issues count, truthy deletion stamps do not, an empty deletion stamp counts, and a needed missing summary produces `LOADING` with the existing batched load. It retains only transient ids for the current delta/batch, with no persistent historical issue index. Only the two explicitly allocated implementation assertions in the handoff test changed.

## Real Chromium evidence

`settings.browser.tsx` mounts the actual SettingsView and ColdStartComposer on the existing provider. The corpus has 5,600 synthetic issues and 5,016 session rows (5,014 issue sessions plus two guests). It uses three machines and one registered repository, with no backend, daemon or operator data. Each arm gets a fresh page. The before arm has the settings switch OFF; the after arm has it ON, with every other pool screen OFF.

`settings-proof.ts` drives 200 session publications, 20 alternating sound/tab updates, the actual lazy Machines mount plus five publications, a real notification-sound toggle, and a principal rebuild. The toggle changes the existing UI writer and repaints. One owned Vite PID is stopped on exit. Timing samples alone take `bench:flatblock`.

| Workload | Legacy selectors, before → after | Legacy derivations | Legacy preference reads |
| --- | ---: | ---: | ---: |
| Session activity | 802 → **0** | 804 → **0** | 3 → **0** |
| Preferences and tabs | 100 → **0** | 110 → **0** | 20 → **0** |
| Machines mount and activity | 29 → **0** | 31 → **0** | 3 → **0** |

The restored after arm compares **5,022 positions, zero differences, zero pending**; after principal replacement it compares **5,021 positions, zero differences, zero pending**. The one-position change is the demanded preference set after the replacement. There are no provider or browser errors.

Both browser checks have red controls. Reintroducing the catalog fallback produces 201 legacy selectors/derivations and fails the zero-reader assertion. Reintroducing the original Machines selector fails its mount/activity assertion. The proof resets counters before navigation and waits for the actual Machines heading and row; a composer machine label cannot stand in for the lazy panel having mounted.

Final leased sample, at `ca071d79f9`:

| Observation | Before | After |
| --- | ---: | ---: |
| Activity main-thread task time | 605.88 ms | 552.92 ms |
| Activity script time | 17.84 ms | 20.23 ms |
| Activity React commit time | 15.20 ms | 5.10 ms |
| Preferences main-thread task time | 314.42 ms | 297.28 ms |
| Preferences script time | 153.74 ms | 176.44 ms |
| Preferences React commit time | 97.10 ms | 104.50 ms |
| Toggle to observed paint | 456 ms | 328 ms |
| Principal rebuild to observed readiness | 192 ms | 868 ms |
| JS heap after preferences | 39,977,364 bytes | 135,900,720 bytes |

These are single development-mode samples. Toggle/rebuild wall time includes automation and two animation-frame waits. Heap snapshots were not forced through GC and do not establish retained memory. The enabled arm constructs the general pool while the before arm has no pool, so these numbers do not isolate the incremental cost of settings on an already-running pool. **POD-5234** proposes that retained-memory and startup attribution work; it remains unclaimed.

## Ludovico-only replay

`settings-replay.ts` refuses to run on another host. It reads the existing authenticated sessions, machines, registered repositories and layout on ludovico, without restarting the operator runtime, mutating operator data or exporting records. Repository replay covers saved registered roots, not live worktree discovery. Device preferences are covered by the synthetic browser/UI-owner checks.

The clean replay compares **5,137 positions: zero differences, zero pending**, using 5,105 session records, six machines and 35 registered roots. Planting a stale tab after loading produces **one difference, zero pending**, at section 2. Only counts and numeric positions are retained in the logs; paths, names, values, credentials and operator records do not leave the host.

## Rollout and retirement

The experiment is ready for web review and integration with its default-OFF switch. No operator default-ON date has been recorded. **POD-5230** proposes deleting the temporary fallback about one week after the operator makes the screen default ON, coordinated with POD-5174's pipeline retirement. It remains Proposed and unclaimed. Mobile settings/diagnostics continues separately in POD-5225 after its attachment dependency is available.

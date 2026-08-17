# Updater wave three — independent review

**Issue:** POD-2166 · **Epic:** POD-2087 · **Reviewed at:** `e6ccec64d`, range `a2bec522e..HEAD`
on `issue/2166-wave-three-integration-review` (identical content to `worktree-updater-spec`).
**Date:** 2026-08-16.

## Scope

| Commit(s) | Subject | Graded against |
| --- | --- | --- |
| `ed9a21024` | the update as one durable operation (the cutover) | `2026-08-14-updater-update-operation-choreography.md` |
| `14ef3ccca` | five operation-engine defects, and the surface tested | wave-two D1/D3/D4/D5/D7 |
| `02c570c0c` | one shared release resolve per channel | wave-two D9 |
| `4b451e0fd`, `4f36adf52`, `50d62d84d`, `3334221cb` | the panel and the toolbar indicator | `2026-08-14-updater-operation-panel.md` |
| `057c7960b`, `9cc3e1ea8` | the all-in-one close-out and the remote-origin grants | `2026-08-14-updater-desktop-shell-integration.md`, wave-two D6 |
| `8ebfe680a`, `640c3067a`, `1bce1ec37`, `e6ccec64d` | progress heartbeats | `2026-08-14-updater-progress-heartbeats.md` |

Spec: `docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`.
Previous review: `docs/reviews/2026-08-16-updater-wave-two-review.md`.

## What I ran

| Check | Command | Result |
| --- | --- | --- |
| server test shard roster | `bun scripts/server-test-shards.ts` | **refused** — see **D4**. This is the lane's own exhaustiveness gate and it is the reason no server suite was run: `@podium/server#test` cannot start. |

**Nothing else was executed.** The `updater-heavy-lane` lock — which this issue's brief makes
mandatory for any heavy command — was held continuously by POD-2105 and renewed past its
expiry, with POD-2103 queued ahead of me, for the whole of this review. I did not run suites
outside it and I did not steal it. So every finding below is derived from reading, except **D4**,
which is quoted from the one command above; the shard refusal happens to be the cheapest and
most decisive thing in the range, and it does not need the lane.

Where a claim would have been settled by a probe rather than by reading, it says so in
"What I could NOT verify". Two of them — **D1**'s multi-machine silence and **D3**'s
post-cancel tick — are the ones I would run first when the lane frees up.

---

# Confirmed defects

## D1 — The `machines` step measures silence across the WHOLE wave, so the per-machine deadline POD-2101 deleted was not replaced, and a machine that dies is never named

**`apps/server/src/modules/updates/operation.ts:1204-1222`** (`createUpdateFleetBridge.onFleetChanged`),
wired at **`apps/server/src/relay.ts:2086-2087`** and **`relay.ts:2308-2314`**, against
**`apps/server/src/modules/operations/engine.ts:248`** (`armDeadline` after every accepted report)
and **`transitions.ts:104-116`** (`deadlineDue` reads the step's single `lastProgressAt`).

POD-2101 deleted `grantExpired` — a **per-machine** deadline — and named the `machines` step's
budget as its replacement. But a step has one `lastProgressAt`, and `onFleetChanged` stamps it
on *any* fleet event: every `machine.connected`, every `machine.disconnected`, and every
`updateStatus` frame from **any machine on any channel**, whether or not that machine is one of
this step's places. `projectMachines` filters the step's *content* to `step.places`
(`operation.ts:969`); nothing filters whether the event should count as this step's heartbeat.

So the replacement is not per-machine and is not equivalent:

- **The silence clock does not start until the entire wave is quiet.** With `concurrency: 3`
  (`relay.ts:492`) and the wave chaining machine-to-machine (`service.ts:474`, `onStatus` →
  `tick`), the healthy machines' 2-second heartbeats (`PROGRESS_REPORT_INTERVAL_MS`) hold the
  step's deadline open for the whole wave. The "one automatic retry" a stalled machine is
  promised (`operation.ts:933-947`) cannot be issued while any other machine is talking.
- **When the deadline finally does fire, it fails the operation with an error that names no
  machine.** `onDeadline` writes `{ code: 'stalled', message: 'No progress for 600s. Podium
  retried once.' }` (`engine.ts:877-886`) with no `places`. The kind has
  `machine-unreachable` with `places` for exactly this, and `classifyMachineFailure`
  (`operation.ts:203-223`) still has a branch for `GRANT_TIMED_OUT_DETAIL` — but nothing
  reaches it any more, because the only writer of that detail is now
  `releaseInFlightGrants`, which runs *after* the operation is already terminal
  (`relay.ts:2059-2072`). §7's promise — "`places` names the machines a failure is ABOUT, so
  the panel can say *vmi has local edits* rather than *a machine failed*" — is not kept on the
  single most likely machine failure.

**Failure scenario.** Three source machines are granted at once. `vmi3407763`'s `git fetch`
hangs against a dead route; its daemon stays connected and reports nothing further. The other
two converge normally over twelve minutes, each frame re-arming the step's ten-minute silence
budget. They finish; the wave has nothing left to grant. Only now does silence begin. Ten
minutes later the step stalls and `reissueGrants` re-grants `vmi` — twenty-two minutes after it
died, and only because the healthy machines happened to stop. Ten minutes after that the
operation fails with *"The update stopped making progress. Podium retried once."* The operator
is not told which machine, and the panel's own step line names the wrong one (see **D5**).

**Test coverage.** `operation.test.ts:1252-1290` ("a silent grant, with nobody watching") proves
the mechanism with **one** machine in the wave, which is the only fleet size where step-silence
and machine-silence coincide. There is no two-machine case anywhere in the suite.

## D2 — A browser watching an all-in-one update is told the shared steps are done and offered a Reload that changes nothing

**`apps/web/src/features/updates/operation-view.ts:718-741`** with
**`apps/web/src/features/updates/use-update-state.ts:529-532`** (`behind`).

The all-in-one plan is zero steps and one required `desktop-install` ask
(`operation.ts:345-357`), so the engine settles it straight into `waiting`
(`engine.ts:626-635`). `computeView`'s `waiting` branch then reads:

```ts
const mine = (operation.awaiting ?? []).some(
  (ask) => ask.surface === undefined || ask.surface === input.surface,
)
const primary = mine || input.local.behind ? localAction(input) : undefined
```

For a browser tab, `mine` is false — the ask's surface is `desktop-all-in-one`. But `behind` is
`operationTarget !== localVersion`, and in the all-in-one flow the server has not updated yet,
so **every** browser tab is behind by construction. `localAction` then falls through
`canInstallDesktop` (no bridge) to `canReload` and returns **Reload**.

The panel therefore renders, in a browser, for an update whose only outstanding work is a
desktop install on someone else's machine:

- title `Podium 0.4.4 is ready here`
- subtitle `The shared steps are done. This page is the last one.`
- primary `Reload` (`Reloads this page, about 2 seconds; your sessions keep running.`)

All three are false. No step ran, the page is not the last one, and reloading fetches the same
old bundle from the same un-updated server. The `waiting-elsewhere` branch below — which exists
precisely for this and says *"Podium 0.4.4 is finishing elsewhere · Finish this in Podium
Desktop on that machine"* — is **unreachable in the all-in-one case**, because it requires
`behind` to be false and the local surface cannot be current until the install it is waiting for
has happened.

This contradicts the server-side comment that motivates the design
(`operation.ts:341-343`): *"A browser looking at the same server renders that honestly and
cannot act on it (P5)."* It renders it dishonestly and offers an action.

`||` should be `&&`-guarded by the ask's ownership: a surface that is behind but is *not* the
one being asked belongs in `waiting-elsewhere`.

## D3 — Cancelling or failing an update does not stop the wave: `rollout.authorized` is never cleared, and `fleet()` still auto-continues

**`apps/server/src/modules/updates/service.ts:588-628`** (`fleet()`'s
`channelsReadyToContinue` → `tick`) with **`service.ts:491-508`** (`markAuthorized`, called on
every `machines` ensure at `operation.ts:949`). Nothing clears `authorized` on a terminal
operation: `relay.ts:2055-2072` publishes queued targets and releases in-flight grants, and
`freshRollout()` is only reached from `setTarget` on a version change (`service.ts:249`) and
`unavailable` (`service.ts:190`).

`machinesRunner` argues cancel is safe because *"the wave is re-planned from scratch on every
tick, so no further machine is selected once the operation is gone"* (`operation.ts:899-908`).
That is true of the operation's own ticks and false of the service's: `fleet()` ticks by itself
whenever a machine's directory version proves the target while `rollout.authorized` holds, and
after a cancel it still holds.

**Failure scenario.** Four machines, `concurrency: 3`. The user cancels while `alpha` is
`restarting` and `beta`/`gamma` are downloading. `releaseInFlightGrants` marks the three
`stuck`. `alpha`'s daemon completes its swap anyway (crash-safe by design, and a sent grant is
not recalled) and reconnects at the target. The next `fleet()` read — the Settings page, the
panel's idle poll, anything — sees `alpha.version === target`, finds its `stuck` state, sets
`canaryHealthy`, adds the channel to `channelsReadyToContinue`, and **grants `delta`**. A
machine is updated after the user cancelled the update, with no operation, no deadline and no
panel watching it. The same holds after a `failed` operation.

The auto-continue predates this wave (it is the "1 of N and waits for a second Apply" fix), but
§3.2's cancel semantics are new and the property the runner claims is not true as wired.

## D4 — The `@podium/server` test lane refuses to run: `operations/trpc.test.ts` is not in the shard roster

**`apps/server/test-shards.json`**, against **`scripts/server-test-shards.ts`**
(`unitLaneTestFiles` / `verify`).

The manifest is derived, not written, and the default invocation of the generator — *"what
`@podium/server#test` runs: the exhaustiveness refusal"* — compares the roster against every
`.test.ts` under `apps/server` that `unitTestExclude` does not remove. `14ef3ccca` added
`apps/server/src/modules/operations/trpc.test.ts` without regenerating, and that file matches no
exclusion, so the partition is incomplete. Run on this checkout:

```
$ bun scripts/server-test-shards.ts
server test shards refused: the shard roster does not describe this checkout.

  [unowned] apps/server/src/modules/operations/trpc.test.ts is collected by the unit lane but no shard runs it

Regenerate with:
  bun scripts/server-test-shards.ts --write
```

This is the *only* failure — every other apps/server test file is accounted for, and the other
fifteen unlisted files are the `*e2e*` / `*.integration.*` / named heavy suites the exclusion
list removes on purpose.

**Failure scenario.** `@podium/server#test` exits 1 before running a single test, so the server
lane on this branch is red for a reason unrelated to any code in it — and the suite that closes
wave-two's G1 (*"`operations.active` / `history` / `cancel` have no tests at all"*) is the one
that is missing. The refusal is doing exactly its job: this is a one-command fix
(`bun scripts/server-test-shards.ts --write`), not a design problem. It is listed here because
a landing that says "the server lane is green" cannot currently be true.

## D5 — The panel names a finished machine as the one that is moving, because it filters on a place state the server never writes

**`apps/web/src/features/updates/operation-view.ts:248-255`** (`interestingPlace`).

```ts
const moving = places.find(
  (place) => place.state !== undefined && place.state !== 'done' && place.state !== 'pending',
)
const remaining = places.find((place) => place.state !== 'done')
```

The update kind's place vocabulary is the convergence vocabulary plus two words:
`projectMachines` (`operation.ts:961-1028`) emits `current`, `restarting`, `offline`, `pending`,
or the raw `WaveMachine.state` (`granted`/`downloading`/`rejected`/`stuck`).
`reconcileUpdateOperation` (`operation.ts:554-584`) emits the same set. **`done` is never
written by anything.** So both filters exclude a word that does not occur, and a machine that
has *finished* (`current`) matches "moving" as readily as one that is downloading.

**Failure scenario.** Places are `[alpha current 100%, beta downloading 62%]`. `substatusFor`
produces `1 of 2 · alpha current 100%` and keeps producing it for the whole of beta's download —
the step line names the machine that is done and never mentions the one the user is waiting
for. §6.2's worked example is *"vmi3407763 downloading 62%"*; the code cannot produce it
whenever an earlier place has already converged. It compounds **D1**: on the timeout failure
this is the only place a machine is named at all, and the machine it names is a healthy one.

The fix is one word (`'current'`, or better: exclude the terminal-ish set the kind actually
writes) — but note the frozen-contract argument in this file's header says step *ids* are never
switched on; place *states* are the kind's open vocabulary and this filter is switching on them,
so whatever is chosen should be justified as "the kind's vocabulary, read where the kind writes
it".

## D6 — An offline machine masks its own terminal verdict, so a dirty checkout degrades into a nameless stall

**`apps/server/src/modules/updates/operation.ts:1007-1009`**:

```ts
state: !machine.online ? 'offline' : resting ? 'pending' : machine.state,
```

The offline test runs **before** the machine's reported state is consulted, so a machine that
reported `rejected` or `stuck` and then dropped its connection projects as `offline`.
`settleMachines` (`operation.ts:1041-1043`) only fails on `TERMINAL_STATES` (`rejected`,
`stuck`), and `offline` is not one, so the wave stops seeing the failure it was already told
about. The same ordering is in `reconcileUpdateOperation` (`operation.ts:566-570`), where it
bites on **every** adoption: no daemon is connected when `adoptOnBoot` runs (it is awaited
before `serveNative`, `server.ts:557-620`), so every unfinished place is rewritten to `offline`
and a machine that had already reported a verdict loses it.

**Failure scenario.** `vmi` reports `stuck` with `dirty-working-tree`. The operator restarts the
daemon there to look at the checkout. The disconnect flips the place to `offline`; the operation
no longer fails with `machine-dirty-checkout` ("has local edits that prevent a safe update.
Commit or stash them there") and instead waits out ten minutes of silence and fails with
`stalled`. The one sentence that would have told the operator what to do is discarded by a
transport event.

## D7 — The `web` step's watcher never stops, and polls the served stamp off disk forever

**`apps/server/src/modules/updates/operation.ts:1123-1148`** (`webRunner`) with
**`operation.ts:769-801`** (`watch`).

`watch` has two exits: `opts.until?.() === true`, and `poll()` returning a patch. The `prepare`
runner supplies `until` (`operation.ts:851`). The `web` runner supplies **neither** — its `poll`
returns `undefined` until the served digest matches the expected one or the publisher reports a
failure, and `tick` re-schedules itself every `watchIntervalMs` (500 ms by default) otherwise.

The reachable trigger is the step's own `totalMs`. Because the heartbeat comes *from* the
watcher, the 2-minute `silenceMs` can never fire while the watcher lives, so a rebuild that
outruns `totalMs` (15 min, `operation.ts:749`) is what fails the step — and the watcher it
leaves behind has, by construction, not stopped. Cancel cannot produce this (`webRunner` is
`reversible: false`), which is the only reason the exposure is one path rather than several.

After that failure the watcher keeps running for the life of the process: a 2 Hz
`servedWebSourceDigest(desktopWebDir())` read (`server.ts:598`) plus a `context.report` that
`recordProgress` discards on the terminal operation (`engine.ts:219-220`). Every re-entry of the
step — the stall retry at `engine.ts:923`, an adoption — starts another, and none of them can be
stopped, including by `engine.stop()`: these timers belong to the kind, not the engine, and
`stop()` sweeps only `this.timers` and `this.budgetTimers` (`engine.ts:441-447`). Giving `web`
the same `until` guard `prepare` already has closes it.

---

# Judgements the brief asked for

## The 90-second download deadline POD-2101 refused (target 3) — the right call, on a premise that is not true

The refusal is recorded at `operation.ts:704-711`: a daemon predating `percent` reports
`downloading` once and then works in silence for up to its own `DEFAULT_DOWNLOAD_TIMEOUT_MS`
(5 min, `update-delivery.ts:68`), so a 90-second step deadline would stall and re-grant it
mid-transfer, forever. That reasoning is correct and the arithmetic checks out: the chosen
`silenceMs` is `GIT_CONVERGENCE_BUDGET_MS + 2 min` = 10 min, which clears both the 5-minute
download timeout and the 8-minute git budget, and `operation.test.ts:1140-1178` asserts the
nesting rather than leaving it to whoever edits a constant next. Ninety seconds is indeed the
wrong number for a deadline that fails a machine.

What the argument assumes — and what the surrounding text says outright ("the margin between a
daemon's longest silence and the step giving up on **it**") — is that this budget is a bound on
one machine's silence. It is not; see **D1**. The call is sound; the thing it was choosing
between was mis-specified. A per-place `lastProgressAt` (the place carries `percent` already)
would let the same 10-minute number mean what the comment says it means.

## Adoption across the coordinator restart (target 4) — sound on the path the plan drills, with one untested gap

The three drills in `operation.test.ts:843-971` are real: a successor engine over the same
store, reality supplied from the far side, `server` → `done` at the target and
`server-did-not-reach-target` otherwise, and the all-in-one ask answered (and, correctly, *not*
answered) from the successor's own version. `reconcileUpdateOperation` never trusts memory, and
`resumeStalled` (`engine.ts:371-378`) plus the contained adoption loop (`engine.ts:296-349`)
close wave-two's D1 and D3 at the seam that matters. `server.ts:557-620` awaits it before
`serveNative`, which is the ordering the spec asks for.

The gap is the `machines` step specifically. `adoptOnBoot` runs **before the daemon gateway
listens**, so `updates.fleet()` reports every machine `online: false`. The runner therefore
calls `markAuthorized` + `tick` against an empty eligible set and grants nobody, and nothing
re-drives it when the daemons reconnect a few seconds later: `machine.connected` reaches only
`updateFleetBridge.onFleetChanged` (`relay.ts:2086`), which records progress and re-arms the
deadline but never re-enters `ensure()`. `fleet()`'s own auto-tick fires only for a machine that
is *already at the target*. So a coordinator restart taken mid-wave resumes the operation but
not the wave: the step sits `running` with zero grants until its ten-minute silence budget
stalls it, and the stall retry is what finally issues the first grant. `operation.test.ts:888`
covers this case with the machine already converged before adoption, so the empty-fleet window
is not exercised.

I have not filed this separately — it is the same missing edge as **D1** (nothing re-drives the
`machines` step on a fleet event) and the fix is likely shared.

## Do the runners hand work off? (target 1) — yes, all four, but nothing holds them to it

- `prepare` (`operation.ts:822-881`) calls `requestDestBundle()` without awaiting, registers a
  watcher and returns `running`. The module-level `preparing` map is what makes a re-entered
  `ensure()` reuse the in-flight build instead of starting a second one, which is precisely the
  second harm wave-two's D2 named.
- `machines` (`operation.ts:899-954`) is `async` but contains no `await`; `markAuthorized` and
  `tick` are synchronous.
- `server` (`operation.ts:1074-1095`) requests the restart and returns `running`.
- `web` (`operation.ts:1104-1151`) fires `requestWebRebuild?.()` and watches.

So wave-two's D2 is closed **for this kind** and `updates.converge`'s `whenSettled`
(`updates/trpc.ts:462`) is safe on that basis. The engine-side mechanism is unchanged, though:
`invokeWithin` still drops the losing `ensure()` and `onDeadline` still starts another
(`engine.ts:923`), and the only thing standing between a future kind and two concurrent installs
is the paragraph at `engine.ts:541-545`. See **S1**.

## Wave two's nine defects

| # | Wave-two defect | Status |
| --- | --- | --- |
| D1 | adopted `stalled` step never touched again | **Fixed** — `resumeStalled` (`engine.ts:371`), plus `onDeadline`'s no-runner path now fails instead of returning (`engine.ts:900-909`). Six tests, `engine.test.ts:864-997`. |
| D2 | inline runner failed by its silence budget, two copies running | **Fixed for the `update` kind** by construction (all four runners hand off; `preparing` de-duplicates the pack). The engine mechanism is unchanged and unguarded — **S1**. |
| D3 | `adoptOnBoot` has no error handling | **Fixed** — `adoptRow` + `abandonSafely` + the guarded `store.active()` sweep, and the `require` after driving is gone (`engine.ts:343-348`). Five tests, `engine.test.ts:999-1118`. |
| D4 | `stop()` misses `invokeWithin`'s timer; `failListen` skips `stop()` | **Fixed** — `budgetTimers` + a `stopped` fence checked in `enqueue`, `driveLocked` and `onDeadline`; `failListen` calls `engine.stop()` before `store.close()` (`server.ts:874`). |
| D5 | `waiting` has no expiry | **Fixed** — `DEFAULT_WAITING_GRACE_MS` + `armWaitingGrace`/`expireWaiting`, re-armed on adoption. Eight tests. But see **S4**: expiring a zero-step all-in-one plan to `done` records an update that did not happen. |
| D6 | remote origin cannot `listen`, so no progress events | **Fixed** — `core:event:allow-listen`/`allow-unlisten` on both `update-bridge` and `transfer-update-bridge` (`main.rs:342-345`, `main.rs:663-665`), with a source-scrape gate that can fail (`tauri-conf.test.ts:110-121`). Still unbuilt here — see "Could not verify". |
| D7 | a background drive that throws leaves the operation running | **Fixed** — `containDriveFailure` on both un-awaited sites (`engine.ts:200`, `engine.ts:813`). Three tests. |
| D8 | `UpdateErrorCode::RestartFailed` unreachable | **Half fixed, and not where it was reported.** The *code string* now has a producer — the page synthesises it when `installUpdate` resolves, which can only mean the shell installed and did not restart (`use-update-state.ts:610-626`). The **Rust variant** still has exactly one construction site, `updater.rs:687`, inside `#[cfg(test)]`, so `every_error_code_has_a_stable_safe_shape` still proves the shape of a value nothing produces. |
| D9 | forced-check coalescing guards `checkNow` only against itself | **Fixed** — the in-flight map moved onto `refreshTarget` itself with an identity-checked `finally` (`service.ts:288-303`), so all six production callers share one resolve per channel. |

Wave-two's G4 ("`onChanged` is never wired") is also closed: `relay.ts:2044-2072` supplies it,
and it is now load-bearing — it is what publishes queued targets and releases in-flight grants.

---

# Suggestions

**S1 — Make "a runner must hand off" checkable.** The property that closes D2 is currently four
correct implementations and a comment. A kind whose `ensure()` awaits its own work will be
failed by its *silence* budget at 2× that budget with two copies running, and nothing will say
so. A cheap guard: have `invokeWithin` record how long `ensure()` took and log (or fail the
step) when a runner returns `running` after more than a small fraction of its silence budget.

**S2 — `core:event:allow-listen` grants the remote origin every event, not one.** The capability
model here is an explicit allow-list, and the bridge needs exactly `podium://update-progress`.
If Tauri 2.11's event scope supports naming events, name it; if not, the widening is worth a
sentence in the capability comment so the next reader knows it was considered.

**S3 — The panel opens itself on every load while an update is merely available.**
`updates-context.tsx:115` opens whenever `view.state !== 'none'`, and `collapsed` is per-tab
state that is deliberately not persisted. So an *offer* — indicator `idle-dot`, nothing
happening — pops the panel open in every new tab and after every reload until it is hidden
again. §6.1's argument against an ambient "everything is fine" dot applies at least as strongly
to an ambient panel. I could not find the intended behaviour stated in the plan.

**S4 — The `waiting` grace turns a zero-step all-in-one plan into a `done` operation that did
nothing.** `expireWaiting` completes because "the shared steps all succeeded"
(`engine.ts:666-672`) — true for a plan with steps, vacuous for the all-in-one plan, whose
*only* content is the ask. After ten minutes with the lid shut, history records a successful
update that was never installed, and the panel's `done` branch shows "Podium is on 0.4.4
everywhere". A kind-supplied `waitingGraceMs` outcome (`expired` → `failed`, or a distinct
`awaiting` note) would keep the record honest; the hook (`waitingGraceMs`) already exists.

**S5 — Every fleet event writes the whole operation row.** `onFleetChanged` → `recordProgress`
persists unconditionally, with no diff against what is already stored, so an unrelated machine
connecting rewrites and re-announces the operation. Retention keeps this cheap today; a
short-circuit when the projected places and progress are unchanged would also fix half of
**D1**.

**S6 — `updates.retry` searches only the last 100 rows of history** (`updates/trpc.ts:414`)
while retention keeps 20 per kind (`store.ts:79`), so the `NOT_FOUND` branch is unreachable for
any operation the store still has. Harmless, but the limit and the retention should agree or the
lookup should be by id.

**S7 — wave-two's S5 is still open.** `engine.active()` with no group answers
`store.active()[0]` (`engine.ts:401`). The web client passes `group: 'lifecycle'`
(`operations-client.ts:60`), so nothing is wrong today; the ambiguity is still on the procedure
for the next caller.

---

# What I could NOT verify

- **No test suite was run**, for the reason given under "What I ran": the mandatory heavy-lane
  lock never came free. So I cannot say the operations, updates, protocol or web updates suites
  are green at `e6ccec64d` — only that the server lane cannot currently start (**D4**). Reading
  the suites shows dense, falsifiable coverage of the wave-two fixes (`engine.test.ts:864-1376`
  in particular); that is a judgement about the tests, not a run of them.
- **`operation.test.ts`'s multi-machine gap is a gap in the tests, not a proven runtime failure.**
  **D1** is derived from `onFleetChanged`'s unconditional `recordProgress` and `armDeadline`'s
  single per-step timer. A two-machine probe under a fake clock would settle it in one run.
- **No Rust was compiled or run.** `apps/desktop/src-tauri/target` does not exist and the volume
  is at 98 %; the brief forbids builds. The D6 fix is graded from the source and from Tauri's
  ACL model, and the `tauri-conf.test.ts` gate proves the *strings* are present, not that
  `core:event:allow-listen` is a valid identifier in 2.11.3 or that the grant works. One
  `cargo`-capable check would settle it.
- **No live drive.** The progress-heartbeat plan's second acceptance line — *"a live dev-source
  update drive shows percent advancing in `operations.active` (curl the endpoint mid-download)"*
  — needs a running server and a real download. I did not run one, so `percent` reaching the
  panel is verified only through the unit path (`operation.test.ts:1291-1318`).
- **`verify-update.sh` was not executed.** The new `update-ownership` marker makes both arms able
  to say INCONCLUSIVE rather than pass silently, which is the right shape; whether the AppImage
  path writes it is a runtime fact I did not observe.
- **D3's `fleet()` auto-continue after a cancel** is derived by reading `fleet()`,
  `markAuthorized` and `planWave`. I did not build a probe that cancels an operation and then
  reads the fleet, so the *reachability* of the tick is argued, not demonstrated.
- **The `apps/web` typecheck redness (POD-2109)** is ignored as agreed in wave two.
- Files owned by live siblings — `apps/web/src/features/settings` (POD-2103) and the reconciler
  (POD-2105) — were read only where they bear on this scope, and edited nowhere.

---

# Grading summary

**`2026-08-14-updater-update-operation-choreography.md`** — every acceptance line is met under
test: the kill-and-adopt drill both ways (`operation.test.ts:876`, `:882`), two concurrent
starts yielding one id (`:602`), and a mid-operation publication queued rather than applied
(`:988`, `:1003`). The cutover itself is the strongest piece of this wave: the legacy
`converge` endpoint is a projection of the operation rather than a fourth opinion, and the
`whenSettled` it leans on is honest because every runner really does hand off. What the plan
does not ask for, and what is missing, is the fleet event that re-drives a step — **D1** and the
adoption gap above are both that one hole.

**`2026-08-14-updater-operation-panel.md`** — the grep-level acceptance is clean
(`waitForWebIdentity`, `waitForCompatibleWebBuild` and the client-side done/total math are gone
from `apps/web`), the checklist is built from whatever steps arrive, and the error taxonomy
degrades correctly on an unknown code. Two of the epic's literal complaints are not closed:
"no second dialog after the server restart" holds, but "one linear flow" does not for a browser
watching an all-in-one update (**D2**), and "progress shows liveness" names the wrong machine
whenever an earlier one has finished (**D4**).

**`2026-08-14-updater-progress-heartbeats.md`** — acceptance line 1 (a silent grant ages with
nothing polling) is proven, and proven the hard way, with a fake clock and no reader. Line 3
(old daemons still converge) is the reasoning behind the 90-second refusal and it is right.
Line 2 (a live drive) is unverified here. The daemon half is clean: `decideProgressReport` is
pure and table-tested, the percentage is absent rather than zero when the length is unknown, a
superseded grant goes quiet, and the wire additions are optional in both directions with the
golden recaptured.

**`14ef3ccca`** — five wave-two defects closed at the mechanism rather than at the symptom, each
with tests that can fail. This is the best-tested commit in the range.

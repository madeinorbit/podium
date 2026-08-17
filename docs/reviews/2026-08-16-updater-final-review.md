# Updater epic — final integration review

**Issue:** POD-2184 · **Epic:** POD-2087 · **Reviewed at:** `69e537719`, range
`e6ccec64d..HEAD` on `issue/2184-final-integration-review` (content-identical to
`worktree-updater-spec`). **Date:** 2026-08-16.

Spec: `docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`.
Prior reviews: `2026-08-16-updater-wave-one-review.md`,
`…-wave-two-review.md`, `…-wave-three-review.md`.

This is the last independent read before the epic is proposed for merge. It has two
jobs: grade what landed since the wave-three review point, and grade the epic against
its own spec.

## What I ran

Base proven first: `git merge-base --is-ancestor worktree-updater-spec HEAD` → `BASE-OK`.
This worktree had no `node_modules`; I hardlink-copied POD-2175's after confirming the
`bun.lock` blobs are the same object (`b7e5677cf`) — 9.6 s, no measurable disk. Every
`@podium/*` link resolves inside this worktree (`readlink -f node_modules/@podium/protocol`
→ this checkout), and each vitest header below names this worktree as its root, so the
greens describe this branch and not `main`.

| Check | Command | Result |
| --- | --- | --- |
| server: updates module | `vitest run --project node src/modules/updates/{operation,reconciler,service}.test.ts` | **175 passed / 3 files** |
| server: operations framework | `vitest run --project node src/modules/operations/` | **130 passed / 5 files** |
| web: updates + settings | `(cd apps/web && vitest run src/features/updates src/features/settings)` | **298 passed / 21 files** |
| protocol / runtime / cli | `vitest run --project node packages/protocol/src/operation packages/runtime/src/update-delivery.test.ts apps/cli/src/podium-update.test.ts` | **98 passed / 3 files** |
| shard roster (wave-three D4) | `bun scripts/server-test-shards.ts` | **exit 0** — 324 unit files across 5 shards, no unowned file |

All runs pinned to `PODIUM_TEST_WORKERS=1`. No heavy lane was held across the session;
these are focused runs, which the protocol exempts. No build, no `cargo`, no server.

Note for anyone repeating this: `vitest --root apps/web` from the repo root fails at
startup (`Cannot find module '/@fs/…/test-hermetic-env.ts'`) because the flag overrides
the config root and with it the fs allow-list. Run web suites with the working directory
set to `apps/web`. This is a lane ergonomics trap, not a defect in the code under review.

---

# Confirmed defects

## F1 — A grant issued by the standing reconciler has no deadline and nothing ever releases it, so one sleeping laptop wedges background convergence for the life of the process

**`apps/server/src/modules/updates/reconciler.ts:274-283`** (the `pump` doc's boundedness
claim) and **`reconciler.ts:318-326`** (`outstandingStillRunning`), against
**`apps/server/src/modules/updates/service.ts:96-99`** and
**`service.ts:787-808`** (`releaseInFlightGrants`), whose only production caller is
**`apps/server/src/relay.ts:2097`**.

`pump()` grants one machine and then refuses to consider anyone else until that grant
reaches an outcome. Its justification is written down:

> Bounded by construction: the service ages a grant into `stuck` after its own deadline,
> so an outstanding one cannot hold the queue indefinitely.

That is no longer true of this system. `service.ts:96-99` records the deletion in the
service's own words — *"This service used to hold a ten-minute deadline that aged a silent
grant into `stuck` … the operation owns that authority now"* — and POD-2101 removed it. The
replacement is the operation's step deadline, and the reconciler runs **only when no
operation is active** (`decideReconciliation` refuses with `operation-active`,
`reconciler.ts:122`). `releaseInFlightGrants`, the other way an in-flight grant can end,
is reached from exactly one place: the engine's terminal `onChanged` at `relay.ts:2097`.
A reconciler grant is by construction outside every one of those.

So the reconciler is the one granter in the system with no timeout at all.

**Failure scenario.** A laptop that was asleep during last night's update is `deferred`;
the operation finished `done` hours ago. The lid opens at 09:02, the daemon reconnects,
`onMachineConnected` enqueues it, `consider` grants it, `outstanding = 'laptop'`. At 09:03
the lid closes again mid-download. No `updateStatus` arrives, ever. `machineStates` keeps
the machine `downloading`; on the next reconnect it is still behind, so `project()`
(`service.ts:673-711`) leaves the convergence record standing. From here:

- `outstandingStillRunning()` returns true forever, so **every other deferred machine in
  the queue is never considered again** — the VPS that came back at 09:10, the desktop at
  10:00, all of them sit in `queue` behind a machine that will never answer. The standing
  reconciliation, whose entire job is §3.6, is dead until the process restarts.
- `later()` re-arms every 5 s forever (`reconciler.ts:334-342`), so the wedge also costs a
  permanent 0.2 Hz `fleet()` projection over the whole machine directory.
- `UpdatesService.operationActive(channel)` (`service.ts:413-421`) answers true for as
  long as that machine is `IN_FLIGHT`, and its own doc says the scheduled refresh asks
  before re-resolving — so **that channel's daily target refresh is suppressed
  permanently** too. §9.2's "the cadence is part of the contract" quietly stops.

The population this hits is precisely the population the reconciler exists for: machines
that sleep. A first operation started later does repair it — `releaseInFlightGrants` runs
at *its* terminal transition — but that operation will itself stall on the same machine
first, because `planWave` skips a machine it believes is mid-grant.

**Test coverage.** `reconciler.test.ts` has twelve cases and none of them leaves a grant
outstanding: `converges reconnecting machines one at a time, spaced` drives the machine to
the target between grants. The wedge is unreachable from the suite as written.

The fix is a timeout the reconciler owns (it already injects `schedule` and `spacingMs`,
so it can age its own outstanding grant), or a per-grant deadline restored to the service
for the no-operation case. Either way the comment quoted above should stop asserting a
mechanism that was deleted.

## F2 — The all-in-one operation completes as `done` ten minutes after being ignored, recording an update that never happened

**`apps/server/src/modules/operations/engine.ts:793-804`** (`expireWaiting`) with
**`engine.ts:779`** (`def.waitingGraceMs ?? DEFAULT_WAITING_GRACE_MS`, ten minutes at
`engine.ts:112`), against **`apps/server/src/modules/updates/operation.ts:326-386`** (the
all-in-one plan) and `updateOperationKind()` at **`operation.ts:1327-1345`**, which does
not set `waitingGraceMs`.

This is wave-three's **S4**, unfixed. I am promoting it from suggestion to defect, for two
reasons the earlier review did not have in front of it: §19 now exists and does **not**
record this as one of the deliberate departures, and the Settings history surface
(`ca06444e6`) has since shipped, so the wrong answer is now durably displayed to an
operator rather than being a transient panel state.

`expireWaiting`'s justification — *"The shared steps all succeeded, so the operation is
`done`"* — is true of a plan with steps and vacuous for the all-in-one plan, whose entire
content is one required `desktop-install` ask and **zero steps** (`operation.ts:376`
returns `{ steps: [], … }`). Nothing succeeded, because nothing was attempted here.

**Failure scenario.** A user on the all-in-one desktop app sees the panel, does not click,
and closes the window. Ten minutes later the grace fires. `expireWaiting` finishes the
operation `done`. The shell was never asked to install and did not; the app is still on
0.4.3. Settings → Updates now lists *"0.4.4 · succeeded · 10 m"* against a machine that
never took the update, the panel's `done` branch says "Podium is on 0.4.4 everywhere", and
§3.7's answer to *"did last night's update finish?"* is a lie. On the next check the offer
reappears, which is the only reason anyone would notice.

The hook to fix it already exists and is already tested generically
(`engine.test.ts:1233`, *"honours the grace the kind names"*). What the kind needs is
either a `waitingGraceMs` outcome that fails or abandons rather than completes, or a plan
that does not reach `waiting` with nothing behind it.

## F3 — A deferred machine admitted mid-wave is never granted by the admission itself, so it waits out the step's silence budget and spends the operation's one stall

**`apps/server/src/modules/operations/engine.ts:273-299`** (`admitDeferred`) with
**`apps/server/src/modules/updates/operation.ts:1400-1416`** (the bridge's early `return`).

`admitDeferred` applies the patch, persists, and calls `armDeadline`. It does **not** call
`driveLocked`, and the bridge `return`s immediately after it. Grants are issued in exactly
one place — `machinesRunner.ensure` (`operation.ts:988-989`, `markAuthorized` + `tick`) —
and nothing on the admission path re-enters it. The newly admitted place is written
`state: 'pending'` (`operation.ts:1498`), so it also cannot trigger the `reensure`
offline→online edge added by POD-2167 (`operation.ts:1436-1448`), which keys on a place
that was `offline` in the *previous* projection; a place that has just arrived from
`deferred` was in no projection at all.

**Failure scenario.** A two-machine plan: `vmi` core, `laptop` deferred. `vmi` converges
and its reconnect is what continues the wave. Thirty seconds later the laptop wakes.
`admissibleDeferredPlaces` admits it, the step now reads `1 of 2`, and the panel names it.
Nothing grants it: the wave has no further directory proof to continue from
(`service.ts:647-660` only continues a channel whose canary was just proved), the
reconciler is paused because the operation is active (`reconciler.ts:122`), and the runner
is not re-entered. The step's places carry no clocks (`current` and `pending` are both
outside `AWAITED_PLACE_STATES`, `operation.ts:1009`), so silence falls back to the step's
own `lastProgressAt` — stamped by the admission — and **ten minutes later** the step
stalls. The stall retry finally calls `ensure()`, which grants the laptop. The user
watched a "stalled" step for ten minutes for no reason, and the operation has now spent
its one permitted stall (`engine.ts:1004`, `stalls >= 1` fails), so any genuine silence
from the laptop fails the whole update immediately rather than retrying it.

**Test coverage.** `operation.test.ts:1256` (*"admits a deferred machine that reconnects
while the wave is still running"*) asserts the place appears and
`progress { done: 0, total: 2 }`. It does not assert that anything was granted, which is
the half that is missing. The adjacent case at `:1285` asserts the negative and is sound.

One line in `admitDeferred` (drive after the patch, exactly as `settleAsk` does at
`engine.ts:480`) closes it.

## F4 — `UpdateErrorCode::RestartFailed` still has no production construction site

**`apps/desktop/src-tauri/src/updater.rs:80-85`** (`restart_failed`), whose only caller is
**`updater.rs:660`**, inside the `#[cfg(test)]` module that opens at **`updater.rs:532`**.

Unchanged from wave-three's **D8**, which called it "half fixed". It is worth re-stating
in a final review because the shape gate
(`every_error_code_has_a_stable_safe_shape`, `updater.rs:652`) reads as coverage of the
taxonomy and is not: it proves the serialized shape of a value the shipped binary never
constructs. §7's contract is met on the TypeScript side — the page synthesises the code
when `installUpdate` resolves without a restart (`use-update-state.ts:610-626`) — so this
is a dead branch rather than a missing user-facing sentence, and I grade it low.

The honest options are to give the Rust side the producer §5 implies (the shell's restart
request failing) or to delete the variant and let the page own the code.

---

# Wave three's seven defects, re-checked at the mechanism

| # | Wave-three defect | Verdict |
| --- | --- | --- |
| D1 | step-wide silence clock; timeout names nobody | **Fixed at the mechanism.** `StepPlace.lastProgressAt` (`protocol/operation.ts:86-101 and :135`), `silentSince` takes the *oldest* stamp (`transitions.ts:99-114`), `deadlineBreach` carries the breaching place ids (`transitions.ts:190-215`), and the kind turns them into a named failure via the new `describeStall` hook (`kinds.ts:106-121`, `operation.ts:1161-1176`). The kind stamps only what it is genuinely waiting on (`AWAITED_PLACE_STATES = granted/downloading/offline`, `operation.ts:1009`), and — the part that matters most — `clockPlace` (`operation.ts:1024-1031`) treats **a change in what the machine is doing** as progress, not the arrival of a frame, so a download frozen at 62 % ages. Clocks restart on entry and on retry only (`engine.ts:726-741`, `:1046-1060`), which are the two cases that would otherwise mis-fire. Six new tests, including the two-machine case the old suite could not express (`operation.test.ts`, *"stalls on the silent one while the other is still talking"*, *"fails naming the machine that stopped, and not the one that was fine"*, *"gives the retry its own window"*, *"does not start a clock on a machine whose turn has not come"*). |
| D2 | browser told the shared steps are done, offered a dead Reload | **Fixed at the mechanism.** `selfServes = behind && elsewhere.length === 0` (`operation-view.ts:757-779`) — staleness earns a button only when nobody else is being asked, so the `waiting-elsewhere` branch is now reachable in the all-in-one case. The comment names the P5 rule it is enforcing. |
| D3 | cancel did not stop the wave; `rollout.authorized` never cleared | **Fixed at the mechanism, twice over.** `withdrawAuthorization()` (`service.ts:543-549`) runs **first** on every terminal outcome (`relay.ts:2075-2086`), before `releaseInFlightGrants`, because that release is itself a `fleet()` read. POD-2180 then removed the underlying hazard rather than only ordering around it: `project()` is the projection alone and `fleet()` is the projection plus the one continuation a read may perform (`service.ts:647-711`), and **every** path that grants or cleans up — `tick`, `authorizeMachine`, `reissueGrants`, `abandonWait`, `releaseInFlightGrants` — now reads the projection. This also closed a defect wave three did not find: `tick()` was planning against a snapshot taken before the grants the same read had just issued, and handed out every widened grant twice (`service.test.ts`, *"the widening step hands out each grant twice"*). |
| D4 | `@podium/server` test lane refused to start | **Fixed**, and then fixed again for the reconciler suite (`e5294c303`, `95af0634b`), with the protocol updated to say so (`4f758831e`). `bun scripts/server-test-shards.ts` exits 0 here. |
| D5 | panel named a finished machine as the one moving | **Fixed at the mechanism.** `interestingPlace` now names the kind's actual vocabulary and its source, splits it into converged / resting / verdict, treats an unknown word as movement rather than ranking it below `pending`, and falls back to the verdict place so a stalled step names the machine that said why (`operation-view.ts:275-291`). |
| D6 | offline masked a machine's own terminal verdict | **Fixed at the mechanism, in both projections.** `reconcileUpdateOperation` checks `TERMINAL_STATES` before reachability (`operation.ts:590-596`) and `projectMachines` holds the persisted verdict while the machine is unreachable *and still behind*, with the target-version proof always allowed to overrule it (`operation.ts:1073-1081`). Fixing only the reconcile half would have been undone by the next projection, and the comment says so. |
| D7 | `web` watcher never stopped | **Fixed at the mechanism.** `engine.watching()` (`engine.ts:489-510`) is the fence, `webRunner` supplies it as `until` (`operation.ts:1306`), and it is wired on **both** context builders — the tRPC one (`updates/trpc.ts:218`) and, importantly, the boot one used by adoption (`server.ts:581-600` → `updateOperationContext`). I checked that specifically: the guard reads `!(context.stepActive?.(…) ?? true)`, so a context missing the hook would never stop, and no such context exists. |

Wave three's two open judgements are also closed. The **adoption gap** it declined to file
separately — nothing re-drove the `machines` step when daemons reconnected after
`adoptOnBoot`, so a mid-wave restart resumed the operation but not the wave — is fixed by
`engine.reensure` (`engine.ts:301-338`), keyed on the offline→online *transition* so a
machine that stays down costs one re-entry rather than one per event, with a test that
names the case (*"re-drives the wave when the daemons reconnect, instead of waiting out
the stall"*). The **90-second refusal** stands, and the premise wave three said was untrue
is now true: the budget really is per-machine.

Suggestions S1, S2, S3, S6 and S7 are unchanged. See below.

---

# The epic against its spec

## §2 — the eight first principles

| | Principle | Verdict |
| --- | --- | --- |
| **P1** | An update is a noun | **Delivered.** `operations` table, id, plan, terminal outcome, `retryOf`, history. Nothing is inferred. **One exception**, and it is F2: an operation can reach `done` having done nothing, so the noun is honest about its identity but not always about its outcome. |
| **P2** | One writer of truth | **Delivered.** `projectMachines` is explicitly "the ONE computation" and the three competing sources §1.2 names are gone — the wave-three grep-level acceptance (`waitForWebIdentity`, `waitForCompatibleWebBuild`, client-side done/total) stays clean at this tip. |
| **P3** | Survives its own medicine | **Delivered, and this is the strongest part of the epic.** `adoptOnBoot` is awaited before the gateway binds, reconciles from observed reality rather than memory, and cannot abort boot (`engine.ts:381-434`). Three adoption drills plus the mid-wave case and the all-in-one-from-the-far-side case. The two things that used to survive a restart wrongly — a lost verdict (D6) and a wave that resumed without restarting (the adoption gap) — are both fixed here. |
| **P4** | Liveness is part of the contract | **Delivered.** Timer-driven deadlines, per-place silence, `stalled` as a visible state, one retry, and a nesting test that pins the budgets against each other rather than leaving them to whoever edits a constant. The one gap is F1: the *reconciler's* grants sit outside this contract entirely. |
| **P5** | Local actions are local | **Delivered.** D2 was the last hole; supervised daemons are excluded at plan time and re-checked at admission (`operation.ts:1477`). |
| **P6** | Single-flight with a queue | **Delivered.** Exclusion group, `ALREADY_RUNNING` returning the active operation, `nextTarget` queued and re-offered on termination, with tests for concurrent starts and for a mid-operation publication. |
| **P7** | Errors speak user, carry engineer | **Delivered on the paths that produce errors.** The taxonomy is table-tested, degrades on an unknown code, and — new this wave — the most likely fleet failure finally arrives named rather than as a nameless `stalled`. Partial only in that F4 leaves one code with no producer, and F2 means the worst outcome is not an error at all. |
| **P8** | Frozen contract | **Delivered and enforced.** `packages/protocol/src/operation/operation.test.ts` is a real conformance suite: unknown fields preserved through a store round-trip, unknown fields *nested inside a step and a place*, an unknown kind, an unknown place-state vocabulary, absent-is-not-an-error per key, and retyping refused. The new `lastProgressAt` was added the additive way. The panel's own reader honours it too — an unknown place state counts as movement rather than being ranked below `pending` (`operation-view.ts:270-291`). |

## §8 — the hard cases

"Untested" below means the mechanism is present and I could follow it, but nothing in the
suites exercises it and I did not drive it. It is not a euphemism for "broken".

| Case | Verdict |
| --- | --- |
| Server restarts mid-update | **Handled, tested.** `operation.test.ts` — adopts mid-wave and finishes the wave; resumes and completes at the target. |
| Client reloads mid-update | **Handled, untested end-to-end.** The panel re-fetches `operations.active` and renders by id; there is no test that reloads a client. Needs the unrun lane (POD-2157). |
| Web bundle replaced mid-update | **Handled, tested at the contract.** P8's conformance suite is exactly this case, proven at the protocol layer rather than by swapping a bundle. The bundle swap itself is untested and blocked by POD-2176/POD-2178. |
| A new version lands mid-update | **Handled, tested.** Queued as `nextTarget`, never mutates the wave, published as an offer on termination; four cases including "lets the same version gain its packed artifact mid-operation". |
| Two tabs / two users click Update | **Handled, tested.** *"gives two concurrent starts one operation"*. |
| A machine is offline during the wave | **Handled, tested — with F3 on the mid-wave-wake path.** Deferred at plan time, admitted if it wakes while the step runs, left deferred if it wakes after. The admission is tested; the *granting* of an admitted machine is not, and F3 is what is missing. |
| Update fails half-applied | **Handled, tested at the plan level.** `updates.retry` builds the remainder from the failed operation's own places and links `retryOf`. The mixed-fleet wire window is inherited from POD-1670 and untested here. |
| Server comes back on the wrong version | **Handled, tested.** *"fails with server-did-not-reach-target when the successor is not"*. |
| Download hangs with no error | **Handled, tested, and materially better than at wave three.** Per-place silence, timer deadline, visible `stalled`, one retry, typed failure that now names the machine. Two-machine coverage exists. |
| Browser user vs someone's native app | **Handled, tested.** Supervised exclusion at plan and at admission; D2 closed the last case where a browser was offered a native action. |
| All-in-one: who updates the server inside the app? | **Handled on the success path, tested; broken on the ignored path.** Adoption answers the ask from the successor's own version, and correctly does *not* answer it when the shell came back on the old version. But if nobody clicks, F2 completes the operation as a success. |
| Hidden dialog | **Handled, tested at unit level.** Collapse-to-indicator, one Hide verb (a test fails on a later/dismiss/ok button), a new situation uncollapses. §6.1's "never unreachable" holds. |
| Update offered while viewing through an old bundle | **Cannot be verified here, and not for a code reason.** The offer is served state, so by construction an old bundle can render it — but POD-2176 means the Settings pane cannot render in any built bundle at main or here, and POD-2178 owns the eager-bundle budget. This is the one hard case whose whole subject is the built artifact, and there is no built artifact to look at. |
| Cancel mid-update | **Handled, tested.** Cancel allowed while the wave is in flight, refused from the server swap onward, consent withdrawn on termination, and the reconciler deliberately does *not* sweep after a cancel (`reconciler.ts:217-221`) — which is the subtlest correct decision in this file. |
| Fleet on mixed channels | **Half handled, untested.** The plan scopes places to the operation's channel correctly (`operation.ts:406`, `channelOf` is now the single answer). But the operation's channel is hardcoded `'dev'` at *both* composition roots (`server.ts:585`, `updates/trpc.ts:234`) and `updates.start` takes no channel, so a stable-pinned fleet gets no operation at all — `planInputFrom` throws "no dev update target is published" (`operation.ts:1516`). Stable machines converge only through the standing reconciler, silently, with no panel. This is inherited behaviour ("the dev authority is what the global panel has always converged") and not a regression, but the spec row promises more than is built. |

## §19 — the five recorded departures

| Departure | Judgement |
| --- | --- |
| **Runners hand off; they do not report inline** | **Justified; the spec was wrong.** §3.3's phrasing would deadlock: `recordProgress` queues behind the `ensure()` that calls it, so the silence budget becomes a hard ceiling and `invokeWithin` drops the loser while a second copy runs. The reasoning is on the type where it would be violated (`engine.ts:648-652`). Still enforced by four correct implementations and a comment — wave-three's S1, below. |
| **Silence is per place, not per step** | **Justified, and the spec should be amended rather than defended.** §3.1's payload puts `lastProgressAt` on the step, and wave-three D1 is the proof that a single clock is the wrong quantity for a step acting on many places. The implementation kept the framework free of convergence vocabulary — presence of a stamp *is* the kind's claim — which is a better answer than either the spec's or the obvious fix. |
| **No 90-second download deadline** | **Justified.** The spec never named 90 s; the plan did, and it would stall and re-grant every daemon predating percent reporting — daemons this same design requires to keep converging. The chosen 10 min clears both the 5-minute download timeout and the 8-minute git budget, and the nesting is asserted rather than assumed. |
| **`start()` does not await the drive** | **Justified.** Awaiting ties a click's response time to the first runner, which is the five-silent-minutes symptom §1.3 exists to kill. |
| **Terminal outcomes withdraw authorization first** | **Correct, but this is not a departure.** Nothing in the spec said otherwise; it is a defect fix (wave-three D3) recorded in the wrong section. Worth moving, because §19.2 is where a future reader looks for *decisions taken against the design*, and putting a bug fix there dilutes the four that really are. |

**Two departures §19 does not record, and should.** (a) The `waiting` grace completes an
all-in-one plan that did nothing — F2 — which is a departure from §3.5's "waiting only
holds the operation open for asks that gate correctness" *and* from §6.2.4's meaning of
"Done". (b) The operation channel is `'dev'`-only, which is a departure from §8's
mixed-channel row. Both are decisions the code has made; neither is written down.

---

# Suggestions

**S1 (carried, wave-three S1) — make "a runner must hand off" checkable.** Unchanged. The
property is four correct implementations and a paragraph at `engine.ts:648-652`. A cheap
guard: have `invokeWithin` note how long `ensure()` took and complain when a runner returns
`running` after a meaningful fraction of its silence budget.

**S2 (carried) — `core:event:allow-listen` grants the remote origin every event.** Unchanged.

**S3 (carried) — the panel opens itself on every load while an update is merely available.**
Unchanged: `open = view.state !== 'none' && !collapsed` (`updates-context.tsx:115`) with
`collapsed` per-tab and unpersisted (`:84`). An offer — indicator `idle-dot`, nothing
happening — pops the panel in every new tab and after every reload. The uncollapse-on-new-
situation logic (`:93-98`) is right and is not what I am pointing at.

**S6 (carried) — `updates.retry` searches the last 100 history rows** (`updates/trpc.ts:435`)
while retention keeps 20, so the `NOT_FOUND` branch is unreachable for anything the store
still holds. Harmless; the two numbers should agree or the lookup should be by id.

**S7 (carried) — `engine.active()` with no group answers `store.active()[0]`**
(`engine.ts:485-487`). Nothing is wrong today; the ambiguity is still on the procedure.

**S8 (new) — the reconciler's `attempts` map is never swept.** `attemptKey` is
`machineId@version` (`reconciler.ts:170`) and entries are deleted only when a machine is
observed `at-target` (`:364`). A machine removed from the fleet, or one that never reaches
a target that is later superseded, leaves its counter behind for the life of the process.
Small, and worth a line only because F1 is in the same file.

**S9 (new) — an operation ending sweeps machines on *other* channels.**
`onOperationSettled` enqueues the whole fleet (`reconciler.ts:219`) and `decideReconciliation`
resolves each machine's own channel and target, so finishing a `dev` update is what triggers
convergence of `stable`-pinned machines to their `stable` target. §9.1 arguably licenses it
(those machines would converge on their next reconnect anyway), but the *trigger* is an
event with nothing to do with them. Worth a sentence in the file either way, since the
file's whole discipline is naming why each trigger is allowed.

---

# What I could NOT verify, and why

- **Nothing was built and nothing was driven.** No `bun run build`, no `cargo`, no running
  server, no browser. The box is at 3.5 GB free on a 99 %-full volume with ~3 GB of 23 GB
  memory available, and the protocol reserves builds for the coordinator. So the
  end-to-end lane and every real-app acceptance line remain unrun (POD-2157), the Settings
  pane's rendering in a built bundle remains unverifiable (POD-2176), and the eager bundle
  budget is POD-2178's to close. I read POD-2178 and edited nothing under `apps/web`.
- **No Rust was compiled.** F4 and the D6 capability strings from wave two are graded from
  source and from `tauri-conf.test.ts`, which proves the strings are present, not that
  `core:event:allow-listen` is a valid identifier in the Tauri version that ships. The
  `554d21277` author says a cold `cargo check` burned 0.8 GB of a 3.4 GB margin in 60 s
  without finishing; I did not repeat it. CI remains the authority for the Rust build.
- **F1 and F3 are derived by reading, not by a probe.** For F1 I traced every caller of
  `releaseInFlightGrants` and `abandonWait` (`grep` across `apps/server/src`, excluding
  tests: one production caller, `relay.ts:2097`) and confirmed the service no longer holds
  a grant deadline from its own doc comment. For F3 I confirmed `admitDeferred` does not
  drive and that no other path grants during a running step. Both would be settled in one
  run each by a fake-clock unit test; I did not add one, because my brief makes the review
  document my only writable file.
- **`verify-update.sh` was not executed** and the AppImage arm's `update-ownership` marker
  is unobserved, as in wave three.
- **The broad shared lanes were not run**, so I offer no A/B failure-set comparison. The
  `apps/web` typecheck redness (POD-2109) is pre-existing on main and ignored by agreement;
  I did not run a typecheck at all, since nothing in this review depends on one.
- **Files owned by live siblings** were read where they bear on this scope and edited
  nowhere.

---

# Verdict

The seven wave-three defects are fixed at the mechanism, not moved. In three cases the fix
went deeper than the defect: D1 produced a general per-place liveness contract that the
framework can carry without learning a convergence word; D3's ordering fix was followed by
POD-2180 removing the hazard the ordering was working around, which turned up a double-grant
nobody had reported; and D7's watcher fence was wired on the adoption path as well as the
obvious one. The suites are green on this branch and the lane that would not start now
starts.

Against the spec, seven of the eight first principles are delivered and the eighth (P7) is
delivered everywhere an error is actually produced. Eleven of the fourteen hard cases are
handled with tests, one is handled but untestable here for artifact reasons, one is half
handled, and one — all-in-one when nobody clicks — is where F2 sits. Four of the five
recorded departures are justified and the fifth is a fix filed in the wrong section; two
real departures are unrecorded.

F1 is the one I would not merge without. It is a permanent wedge in the subsystem §3.6
promises, it hits the exact machines that subsystem exists for, its own code asserts a
guarantee that another commit in this epic deleted, and no test can currently reach it. F2
and F3 are both real and both cheap — a `waitingGraceMs` outcome and a drive after the
admission patch. F4 is a dead branch and can wait.

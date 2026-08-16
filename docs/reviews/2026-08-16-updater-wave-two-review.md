# Updater wave two — independent review

**Issue:** POD-2144 · **Epic:** POD-2087 · **Reviewed at:** `70c177a2b`, range `a2bec522e..HEAD`
on `issue/2144-framework-and-desktop-review` (identical content to `worktree-updater-spec`).
**Date:** 2026-08-16.

## Scope

| Commit | Subject | Plan graded against |
| --- | --- | --- |
| `01f5a2dc8`…`7e89d9119` | the operation contract, store, engine, kinds, trpc, migration | `2026-08-14-updater-operations-framework.md` |
| `802b2c6c7` | three operation-engine defects from the pre-landing review | (same) |
| `17c50d642` | desktop updater bridge internals | `2026-08-16-updater-desktop-bridge-internals.md` |
| `f6da2c1a0` | supervised replacement daemons + fail-closed verifier arm | (desktop plan, §Testing) |
| `d6f9f70d2` | host wire-golden recapture | — |
| `70c177a2b` | coalesce forced checks, reject leading-zero SemVer | — |

Spec: `docs/internal/superpowers/specs/2026-08-14-update-operations-design.md`.

## What I ran

| Suite | Command | Result |
| --- | --- | --- |
| operations + updates service | `bun --bun vitest run apps/server/src/modules/operations apps/server/src/modules/updates/service.test.ts` | **130 passed / 5 files** |
| operation contract | `bun --bun vitest run packages/protocol/src/operation` | **36 passed** |
| CLI update helpers (integration lane) | `bun --bun vitest run --config vitest.integration.config.ts apps/cli/src/podium-update.test.ts` | **52 passed** |
| `audit:router-mutations` | | **green** |
| `audit:expand-only` | | red — 2 findings, both in `20260812145728` and `20260812175034`, **pre-existing**; the new `20260816092917_operations-table` migration is clean |
| `audit:durable-classes`, `audit:god-objects` | | red at 22 and several findings respectively; **none name any file in this scope** (`operations/engine.ts` appears in zero findings) |

I also ran seven throwaway probe suites against the real engine and store (fake clock,
in-memory SQLite, real drizzle migrations) to decide the questions reading alone could not
settle. Each probe's output is quoted with the finding it proves. The probe files were
deleted; `git status` is clean.

**Not run: `cargo test`.** `apps/desktop/src-tauri/target` does not exist, `~/.cargo` holds
980 MB (registry, no build cache), and the volume has 4.6 GB free at 98 % use. A cold Tauri
debug build does not fit and is not cheap. Every Rust finding below is from reading; the two
that depend on toolchain behaviour are marked as such. This matches the desktop plan's own
instruction to say so rather than imply a run.

**Ignored as agreed:** the `apps/web` typecheck redness (POD-2109).

---

# Confirmed defects

## D1 — An operation adopted with a `stalled` step is never touched again, and holds its exclusion group forever

**`apps/server/src/modules/operations/engine.ts:370`** (`if (step.state === 'stalled') return`),
reached from **`engine.ts:255-279`** (`adoptOnBoot`).

`driveLocked` refuses to act on a `stalled` step with the comment *"A stalled step is waiting
on its own retry or its deadline, not on us."* That is true inside one process. It is false
after a restart: the retry belonged to the dead process, and `adoptOnBoot` arms no timer —
it calls `persist` then `drive` (`engine.ts:274-275`) and nothing else. So the step is
waiting on a retry that will never happen and a deadline that was never armed.

Proven directly. Seeded one row with `state: 'running'`, `steps: [{ id: 'first', state:
'stalled', stalls: 1 }]`, ran `adoptOnBoot`, then advanced the fake clock ten minutes:

```
ensure calls after adoption: 0
timers armed:               0
column state:               running
group still held:           op_seed
```

**Failure scenario.** The `update` kind's plan contains a step that restarts this server —
that is the whole premise of §3.4. A step goes silent, `onDeadline` persists `stalled`
(`engine.ts:670-677`), and the process dies before the retry's `persist` at `engine.ts:689`.
That window is a normal event here, not an exotic one: the process being killed is the
process being updated. The successor boots, adopts, and does nothing. `activeByGroup`
returns the row forever, so every subsequent `updates.start` answers `alreadyRunning`, and
`operations.cancel` — the only escape — is unreachable because no panel ships yet. Podium
can no longer update itself, on a machine whose updater is the thing that is broken. The
repair is manual SQL on the `operations` table.

Note the same shape at **`engine.ts:679-680`**: when `onDeadline` finds no runner it
`return`s and leaves the step `stalled` with no timer, where `driveLocked` in the identical
situation fails the operation (`engine.ts:373-379`). The two paths disagree about what an
unrunnable step means.

## D2 — A runner that does its work inline is failed by its *silence* budget at 2× that budget, with two copies of its work still running

**`engine.ts:427-455`** (`invokeWithin`) with **`engine.ts:642-713`** (`onDeadline`).

`802b2c6c7` correctly identified that a runner which never returns had no bound, and raced
`ensure()` against `deadlineDue(step, budget, now)`. The bound is real. But a step's
`silenceMs` is documented as *heartbeat staleness* and `totalMs` as *wall clock*
(`kinds.ts:62-68`), and on the inline path the first now silently means the second: a
runner cannot refresh its own heartbeat, because `recordProgress` enqueues behind the very
`ensure()` call it is reporting on (`engine.ts:184`, `engine.ts:335-343`). The engine's own
comment at `engine.ts:421-425` states this constraint, but nothing enforces it and the
failure is silent.

Proven. A `download` step with `{ silenceMs: 30_000, totalMs: 600_000 }` whose `ensure()`
works inline and calls `recordProgress` from within itself, driven through five simulated
minutes one second at a time:

```
ensure attempts:        2
heartbeats attempted:   2
ensure() ever finished: false
operation state:        failed
error:                  {"code":"stalled","message":"No progress for 30s. Podium retried once."}
```

**Failure scenario.** The `update` kind ships a step that downloads and installs a bundle.
Written the obvious way — do the work, report progress as chunks land — it dies at 60 s of a
10-minute allowance, and the user is told "no progress for 30 s" about a download that was
progressing the whole time. The second harm is worse than the first: `invokeWithin` drops
the losing `ensure()` and `onDeadline` starts another (`engine.ts:693`), so at the moment of
failure **two concurrent installs are running against the same target directory** with
nothing watching either. The comment at `engine.ts:415-419` argues nothing is owed to a
dropped call because `ensure()` is idempotent; idempotence makes a *re-run* safe, not two
*simultaneous* runs. `totalMs` is unreachable on this path, so the budget the kind author
thinks they set is not the budget that fires.

## D3 — `adoptOnBoot` contains no error handling, so one kind's bad `reconcile` fails server startup and strands every other operation

**`engine.ts:269-272`** (`await realityFor(row)`, `await reconcile(...)`) and
**`engine.ts:276`** (`this.require(row.id)`), awaited un-caught at **`apps/server/src/server.ts:458`**.

`invoke()` at `engine.ts:457-480` goes to deliberate trouble to make a throwing `ensure()`
"a failed step, not a crashed server". Adoption gets no such treatment: `realityFor`,
`reconcile` and `require` all throw straight out of the loop.

Proven. Two live rows in different groups, kind's `reconcile` throws:

```
adoptOnBoot threw: reality lookup exploded
op_a state:        running   (never adopted)
op_b state:        running   (never reached — the loop aborted)
```

**Failure scenario.** The `update` kind's `reconcile` compares the operation against
observable reality — this server's version, the served web stamp, the machine directory. Any
of those can throw: a machine row with a shape this binary does not expect, a version string
it cannot parse, a store read that fails. When it does, `startServer` rejects at line 458 and
**the server does not boot at all** — before it binds, before it serves. The server that
cannot boot is the one that has to apply the update that fixes it, which is precisely the
failure mode §3.4 exists to prevent. `abandon()` already implements the right policy for "an
operation this binary cannot drive"; it is simply not reachable from a throw.

`this.require(row.id)` at `engine.ts:276` is a second, narrower instance: it throws when the
row cannot be read after driving, and `finish()` sweeps retention (`engine.ts:534`), so an
adopted operation old enough to fall outside its kind's newest twenty finished rows is
deleted and then required.

## D4 — `engine.stop()` does not stop the timer that `802b2c6c7` introduced, so the shutdown fix does not close the hole the same commit opened

**`engine.ts:328-331`** (`stop()` clears only `this.timers`) versus **`engine.ts:438-454`**
(`invokeWithin`'s budget timer, which is never registered in `this.timers`). Wired at
**`server.ts:1057`**, ahead of `store.close()` at **`server.ts:1069`**.

Proven. Engine with a hanging runner; call `stop()`, then advance the clock:

```
timers in engine.timers before stop:        1
timers still pending in the CLOCK after stop(): 1
store writes after stop() + clock advance:  2
```

**Failure scenario.** Shutdown runs while a runner is in flight — the normal case, since the
runner may be the thing restarting the server. `operations.stopTimers` clears the deadline
map, `store.close()` runs, and the still-armed budget timer then resolves `OVERDUE` into
`onDeadline`, which calls `store.get` and `store.update` against a closed database. The
throw lands in the chain's `.catch(() => undefined)` at `engine.ts:340`, so it is silent.

Two aggravating facts:

- **`whenSettled` is documented as the tool for exactly this** — *"shutdown wants it before
  closing the database"* (`engine.ts:314-316`) — and shutdown never calls it. `stop()` alone
  cannot make the claim true, because `802b2c6c7` also removed the `await` in `start()`, so
  a drive can be in flight with nothing holding it.
- **A second close path skips `stop()` entirely.** `failListen` at **`server.ts:813-819`**
  calls `store.close()` on a listen failure without touching the engine. `adoptOnBoot` has
  already run by then (line 458) and may have armed deadlines and left drives running. A
  port-in-use start — a routine outcome with a stale backend on `:18787` — takes this path.

`shutdown-wiring.test.ts` asserts the string `'operations.stopTimers'` appears before
`'store.close'` in `server.ts`. That is true and it is not the property anyone wanted; it
cannot see either of the two gaps above.

## D5 — `waiting` has no expiry, so an unreachable surface holds the exclusion group forever

**`engine.ts:501-510`** (`settle`) — when a required ask is outstanding it calls
`this.disarm(operation.id)` and persists `waiting`. No timer is armed and no other code path
ever revisits the operation. `settleAsk` (`engine.ts:285-298`) is the only exit besides
`cancel`.

The spec disagrees, in two places:

- §3.2's state diagram (spec line 168): `waiting └──► done (asks satisfied / **expired**)`.
- §3.5 (spec lines 240-243): an operation in `waiting` *"completes after a short grace"*.

Neither a grace nor an expiry exists. (The voluntary-ask case is implemented as *completes
immediately*, which is stricter than the spec and harmless; the `required` case is the gap.)

**Failure scenario.** The all-in-one flow creates an operation `waiting` on "Podium Desktop
on `macbook` to install and restart" (spec §3.5, §5). The laptop's lid stays shut for a
week. `lifecycle` is held for that week: no further update can start, `operations.active`
keeps serving a stale operation, and the only escape is `operations.cancel` — which no
surface exposes yet. The framework exists to end silent unbounded waits; this is one,
wearing a different state name.

## D6 — The progress event cannot be received on a remote origin: the plan's Capabilities task was not done

**`apps/desktop/src-tauri/src/main.rs:646-650`** (`update-bridge`) and
**`main.rs:337-342`** (`transfer-update-bridge`) enumerate exactly three permissions —
`allow-claim-update-ownership`, `allow-check-update`, `allow-install-update`. Neither grants
`core:event:allow-listen`. **`apps/desktop/src-tauri/capabilities/default.json`** does grant
it (via `core:default`) but declares no `remote` block, so it applies to local origins only.
`git diff a2bec522e..HEAD -- apps/desktop/src-tauri/permissions apps/desktop/src-tauri/capabilities`
is **empty**.

The plan's task list says, verbatim: *"**Capabilities.** If the new event needs a permission,
extend the existing `update-bridge` capability (`main.rs:644-662`) and the autogenerated
permission files — including the remote-origin and post-transfer regrant paths, which
already exist and must keep working."* That task is unstarted.

**Failure scenario.** In remote mode — a shell pointed at another host's server, which is the
mode the plan itself calls out (*"the page may be remote or older than this shell"*) — the
page calls `listen('podium://update-progress')`. That goes through `plugin:event|listen`,
which is ACL-gated; the remote origin's capability set does not include it, so the
subscription is denied and the install shows the same static spinner the plan set out to
remove. The same applies after a server transfer, via `transfer-update-bridge`.

**Verification status:** derived from the Tauri v2 ACL model (`core:default` includes
`core:event:default`, which grants `allow-listen`; remote-origin capabilities are explicit
allow-lists). Not confirmed by a build — see "What I ran". Worth one `cargo`-capable check
before acting, but the diff being empty against an explicit plan task stands on its own.

## D7 — A background drive that throws leaves the operation `running` forever, and nothing anywhere learns of it

**`engine.ts:166`** (`void this.drive(operation.id)`), with the chain's blanket
`.catch(() => undefined)` at **`engine.ts:335-343`**.

Before `802b2c6c7`, `start()` awaited the drive, so a throw reached the tRPC caller as a 500.
Now the only handler is the chain's swallow.

Proven. `store.update` made to throw on its second call (the persist inside `beginStep`):

```
start returned:                      true
row state after the swallowed throw: running
first step state:                    running
```

The caller is told the operation started. It never advances, and because the throw landed
before `armDeadline`, no timer was ever set — so no deadline will notice either. The operation
and its exclusion group are wedged with no error, no log line, and no `onChanged` announcement.

Note this compounds with **G4** below: `onChanged` is never wired in production, so even a
*successful* drive announces nothing.

## D8 — `UpdateErrorCode::RestartFailed` is unreachable; the taxonomy advertises a state the page will never see

**`apps/desktop/src-tauri/src/updater.rs:27, 80-85`** define it. Repo-wide, the only
construction site is **`updater.rs:678` — inside `#[cfg(test)]`**. `install_update`'s success
path is `app.restart()` at **`updater.rs:471`**, which diverges (`-> !`), so there is no
statement after it that could return this code.

The plan's acceptance is *"every failure path returns a typed code"*, and the test
`every_error_code_has_a_stable_safe_shape` (`updater.rs:670-697`) checks that all seven
serialize to a stable kebab-case `code` with a path-free, token-free message. It proves the
shape of seven values. It cannot see that one of them has no producer, so it reads as
coverage of a contract that is one member wider than reality. POD-2104 will write a handler
for a code it can never receive.

## D9 — The forced-check coalescing guards `checkNow` only against itself

**`apps/server/src/modules/updates/service.ts:282-293`** (`refreshTargetForCheck`) is
`private` and called from exactly one place, `checkNow` at line 275. Five other production
call sites go straight to `refreshTarget` and bypass the in-flight map:

- `server.ts:432-433` — the two boot refreshes
- `server.ts:439` — the periodic `startTargetRefresh` tick
- `modules/instance/trpc.ts:46`
- `modules/fleet/handlers.ts:86` and `:99`

**Failure scenario.** A user clicks "Check now" while the periodic refresh tick is mid-flight.
Two `resolveTarget` calls hit the release feed, and — worse than the duplicate request — both
end in `setTarget` (`service.ts:246`) with **last-writer-wins by completion order, not
request order**. A slow boot resolve that started first can land after the fresh forced
resolve and overwrite a newer target with a staler one. The commit message scopes itself
honestly ("coalesce concurrent forced checks"), so this is the un-closed half rather than a
broken fix; the dedup belongs on `refreshTarget` itself.

*(Owned by POD-2098 — read only, not edited.)*

---

# Verified as sound

Recording these because they were named as review targets and the answer is "it holds":

- **Single-flight survives an unparseable payload (target 4).** `activeByGroup`
  (`store.ts:143-148`) decides from the `exclusion_group` and `state` **columns**, and
  `toRow`'s `parseStored` failure only nulls `row.operation`. Probed with a payload carrying
  a state from a future binary: `parseOperation` → `null`, column state `running`, second
  `start` → `{"started":false,"alreadyRunning":"op_junk"}`. The column/payload split in
  `store.ts:9-17` is the right design and it works.
- **Single-flight holds across the async `plan()` window (target 1, partly).** The re-check
  at `engine.ts:136` and the `insert` at `:155` share one synchronous block with no `await`
  between them. On a single-threaded single-writer server that is airtight, and
  `engine.test.ts:239` tests the interleaving. Two concurrent `start()` calls cannot both
  insert.
- **The frozen-contract law holds in both directions (target 3).** `.passthrough()` on every
  object, `store.update` writing the object whole (`store.ts:100-109`), and `applyStepPatch`
  spreading rather than rebuilding (`transitions.ts:63-77`) mean an unknown field survives a
  patch that does not name it — at operation, step and place level. `operation.test.ts`
  exercises absence of each optional field individually, retyping of nine fields, unknown
  fields nested in a step and a place, and a kind with uninterpretable `details`;
  `engine.test.ts:779` proves survival across a real SQLite round trip and a progress write.
  The "replace, don't merge" decision on `progress`/`places` is argued in
  `transitions.ts:42-49` and I agree with it: a stale `bytesPerSecond` under a live percentage
  is worse than an absent one.
- **`abandon()` does not rewrite bytes it could not read** (`engine.ts:543-555`,
  `store.markTerminal`), with a test at `engine.test.ts:762`. Correct and unusually careful.
- **`recordProgress` on a reported failure now fails the operation** (`engine.ts:200-209`) —
  fix 1 of `802b2c6c7` holds, and the bug did not move: `skipped` still advances the plan,
  `stalled` still recovers, and `engine.test.ts:316-352` covers all three plus group release.
- **The leading-zero SemVer rejection** (`apps/cli/src/podium-update.ts:86-94`) is correct
  per semver §9/§11 and fails closed — an unorderable version means "not newer"
  (`podium-update.ts:174`), so the blast radius of a malformed manifest is an install that
  stays put. Eight boundary cases, including both sides and both the core and prerelease
  positions.
- **The new migration is expand-only.** `20260816092917_operations-table` is a bare
  `CREATE TABLE` plus two indexes; the two `audit:expand-only` findings are both older
  migrations. The plan's acceptance sentence ("expand-only gate green") cannot be satisfied
  today for reasons unrelated to this work.
- **`f6da2c1a0`'s verifier arm is genuinely armed.** ARM A reports INCONCLUSIVE unless
  `corrupt-feed.log` shows the artifact was actually fetched, and `serve-update-feed.ts:44`
  does log `[feed] artifact request` to stderr, which the arm captures. The fresh, un-seeded
  state dir means an ABSENT `running-version` is a detectable failure rather than a pass.
  This is the right way to build an assertion that can say no.
- **`d6f9f70d2`'s golden recapture is additive.** One field appears in the parse tree and in
  the encoded string; nothing changed in place; only the `host` family was recaptured, which
  is the correct call given the other five are drift owned by someone else.

---

# Coverage and acceptance gaps

**G1 — `operations.active` / `history` / `cancel` have no tests at all, and the plan's second
acceptance line is unverified.** There is no `trpc.test.ts` under `modules/operations/`. The
acceptance reads *"`operations.active` serves a payload that the conformance parser
accepts"*; nothing asserts it. Worse, `trpc.ts:27` deliberately bypasses the parser
(`JSON.parse(row.payload)`), so the served bytes and `parseOperation` have **no** shared
test point. Repo-wide, `parseOperation` has exactly one non-test consumer — `store.ts:70` —
against a plan that asked for *"one shared `parseOperation()` used by every consumer"*. One
test that feeds the `active` procedure's return value through `parseOperation` would close
this.

**G2 — `should_install_native_update`'s first parameter has no production producer.** Its
only call site passes a literal `true` (`updater.rs:514`), so the function is `confirmed`
with extra steps, and the third assertion in `native_fallback_honors_confirm_and_decline`
(`updater.rs:728`) exercises an input no caller can supply. The plan asked to *"extend the
existing `should_show_native_dialog` tests to cover the confirm/decline outcomes"*; what
landed tests a two-input boolean AND, not the confirm→install→restart path or the
title-reset-on-failure path at `updater.rs:525-527`. Those are unbuildable locally and so are
CI-only — which is fine, but they should be named as such rather than represented by a
tautology.

**G3 — `verify-update.sh` is coupled to the page *not* claiming ownership.** Both arms drive
the install through `check_and_prompt_update`, which only runs when
`should_show_native_dialog` is true. That holds today because `apps/web` is untouched and no
bundle calls `claimUpdateOwnership`. The moment POD-2104 lands the page-side claim, both arms
stop exercising anything and ARM A silently degrades to INCONCLUSIVE → `RESULT_RC=3`. The
drill needs a way to suppress the page claim (an env the shell honours, or a
`PODIUM_UPDATE_FORCE_NATIVE`) before that lands, or it will read as a regression caused by
the panel.

**G4 — `onChanged` is never wired.** `createOperations({ store: this.store.operations })` at
`relay.ts:2029` passes no `onChanged`, so `announce()` (`engine.ts:733-736`) is a no-op in
production and every `this.announce(...)` in the engine is dead. Reasonable as a deferral to
the panel issue, but it means "persisted before anything observable happens" is currently
"persisted, and nothing observes". Worth an explicit deferred note so POD-2102 does not
assume the push exists.

**G5 — No Rust was compiled or executed.** Stated here so no reader infers otherwise. CI is
the proof for every `#[cfg(test)]` assertion in `updater.rs` and `main.rs`, and macOS
production-signed verification remains the release-time item the desktop plan already
records.

---

# Suggestions

**S1 — `operations.active` is a full table scan plus a double parse, on a polled endpoint.**
`store.active()` (`store.ts:158-163`) is `SELECT *` with no `WHERE` and no `LIMIT`, running
`parseOperation` (a zod parse) over every row's payload, and `trpc.ts:27` then throws the
parsed object away and `JSON.parse`es the payload a second time. Retention bounds this to
~20 rows per kind, so it is not urgent — but a `WHERE state NOT IN (...)`-shaped prefilter or
a lazy `operation` getter would keep it honest as kinds accumulate. `activeByGroup` runs
twice per `start` with the same cost.

**S2 — `channel_from_name` returns `download-failed` for an invalid channel**
(`updater.rs:170`), as do the endpoint-parse and builder failures in `updater_for_channel`
(`updater.rs:200, 207`). None of those is a download. The page will offer a retry that cannot
succeed. The taxonomy has room for one more additive code.

**S3 — `install_update` has no single-flight.** `check_update` clears the pending slot
(`updater.rs:389-395`) and `install_update` takes it (`:443`), so two concurrent invocations
either race to `no-pending-update` or — if both carry a `channel` argument — both re-check and
both run `download_and_install` against the same target. The server side got single-flight as
a first-class concern; the desktop bridge did not.

**S4 — `install_update` never resolves on success.** `app.restart()` diverges, so the bridge
promise the page awaits is dropped when the process dies. That is fine but undocumented, and
POD-2104 needs to know not to write `await installUpdate(); setState('done')`.

**S5 — `active()` with no `group` returns an arbitrary live operation.** `engine.ts:302`
answers `store.active()[0]` — the newest live operation of *any* group. Once `update` and a
server move coexist, a caller that omits `group` gets whichever started last. Either require
the group or name the ambiguity on the procedure.

**S6 — Give `StepDeadlines` a default, or refuse a step without one.** A step whose kind
declares no budget arms nothing and can run forever (`engine.ts:602-606` returns `undefined`,
`armDeadline` no-ops) — probed and confirmed. `engine.test.ts:543` documents this as intended,
but it means a kind author's omission produces exactly the silent hang the framework exists
to end. A registry-time check, or a conservative default, would make the omission loud.

---

# Grading summary

**`2026-08-14-updater-operations-framework.md`** — every task on the list is present and the
code is unusually well argued. Acceptance line 1 ("started, heartbeated, stalled, retried,
failed, canceled, adopted after a simulated restart — all under test") is met, with a real
successor engine over the same store. Acceptance line 2 ("`operations.active` serves a payload
the conformance parser accepts") is **not tested** (G1). Acceptance line 3 splits: no file
under `modules/updates/` changed in the framework commits, and the migration is additive, but
the expand-only gate is red at the base for unrelated reasons (S/G note above). Against the
spec, §3.5's expiry is missing (D5). Against correctness, D1–D4 and D7 are live.

**`2026-08-16-updater-desktop-bridge-internals.md`** — progress events, typed errors, one
channel authority and a real native fallback all landed, and `apps/web` is untouched as
required (`git diff --stat` names no `apps/web` file). The Capabilities task did not land
(D6), which undercuts acceptance line 1 on the remote origin. Acceptance lines 2 and 3 are
met by construction but unverified — no build, no drill run in this session.

**`802b2c6c7`'s three fixes** — fix 1 (reported failure) holds cleanly and the bug did not
move. Fix 2 (runner budget) bounds the hang but introduces D2. Fix 3 (`start` no longer
awaits) is the right model and is what the spec asks for, but it removed the last observer of
a failed drive (D7) and left the shutdown story incomplete (D4). The fourth finding the
commit declined to change — replace-not-merge on `progress`/`places` — was declined for the
right reason and is now covered by transition tests.

**`70c177a2b`** — the SemVer fix is correct and well-tested. The coalescing fix is correct
within its stated scope and half of the race remains (D9).

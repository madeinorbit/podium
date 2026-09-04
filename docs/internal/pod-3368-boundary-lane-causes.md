# The server boundary lane's 67 failures, grouped by cause

POD-3368. Diagnosis of `@podium/server:test:boundary`, the shard that every delta gate in the
POD-3221 epic has been subtracting by hand.

## What was run, and against what

| | |
|---|---|
| Lane | `apps/server` → `vitest.boundary.config.ts` (manifest shard `boundary`, 119 files) |
| Measured HEAD | `fd52e0ba9` on `issue/3368-bug-boundary-lane-causes-never-grouped` |
| Baseline COMMIT | `7b0d7924c` (`origin/dev/mw` at the time of the run) |
| `PODIUM_TEST_WORKERS` | **SET, to `1`** — inherited from the session environment, not exported by me |
| Files collected | **119 of 119 named in `test-shards.json`** — nothing was excluded |
| Result, HEAD | 67 failed, 2290 passed, 1 skipped (2358) |
| Result, baseline | 67 failed, 2272 passed, 1 skipped (2340) |

The baseline arm is a detached worktree at `7b0d7924c` with its own `bun install`, running the same
config. Both arms produced a machine-readable failure list; the gate below is a set difference on
failing test NAMES, not on counts.

## How many of the 67 are ours: TWO

**2 of 67 are the epic's. 65 are not.** That split is measured, not argued: it is the set
difference below, computed on failing test NAMES between HEAD and baseline `7b0d7924c`. Every one
of the other 65 fails on the baseline arm too.

The 65 break down as 61 with a named introducing commit that `git merge-base --is-ancestor` places
on `origin/dev/mw`, and 4 (causes 12–15) whose introducing commit I did not isolate — but those 4
are still demonstrably not ours, because they appear in the baseline arm's failure set.

The two that are ours are causes 16 and 17, both from `72d2b4718` (POD-3259). The coordinator
verified this independently: `apps/server/src/issues.test.ts` runs 309 passed / 0 failed at
`72d2b4718^` and 2 failed / 307 passed at the tip.

**They are owned by POD-3373**, which is already started — not by POD-3259 (closed) and not by
POD-3330 (that is the SESSION half of the draft model; these are the ISSUE half). Nobody should fix
them ahead of POD-3373 reporting whether they share a root with POD-3330.

## The gate: the count is stable, the SET is not

```
head: 67   base: 67

ONLY ON HEAD (introduced by the epic)
  + apps/server/src/issues.test.ts >> IssueService assistant applySuggestion moves the stage and clears the suggestion
  + apps/server/src/issues.test.ts >> new agent after worktree free (POD-580) start attaches the preserved branch (worktreeAddExisting) and spawns a new agent

ONLY ON BASE (fixed by the epic)
  - apps/server/src/causal-observation-gate.test.ts >> causal session observation gate restores one snapshot, emits only live edges, and survives restart idempotently
  - apps/server/src/event-log.test.ts >> SessionRegistry session.phase events skips the prev-undefined seed and logs only real phase transitions
```

**Two failures the epic introduced were masked by two the epic fixed.** The number 67 did not move,
which is exactly the arrangement this issue was filed to break. Anyone subtracting 67 by hand over
the last two days has been subtracting two live regressions along with the inherited red.

Both new failures come from **`72d2b4718`** (POD-3259, 2026-09-03). `git merge-base --is-ancestor
72d2b4718 origin/dev/mw` exits **non-zero** — it is on the epic integration branch only. These were
mailed to POD-3221 and sent to the coordinator session before this report was finished.

## The 17 causes

Every "ancestor" column is the exit status of `git merge-base --is-ancestor <commit> origin/dev/mw`
against baseline `7b0d7924c`.

| # | Cause | Introduced by | Ancestor of `origin/dev/mw` | Tests | Wrong thing |
|---|---|---|---|---|---|
| 1 | Attaching a daemon hides its persisted inventory until the live socket reports one | `e0ffb0df0` POD-2631, 2026-08-25 | yes | 26 | test |
| 2 | `requestedDriverId` column absent from the `row()` fixture | `574e26660` POD-3102, 2026-08-30 | yes | 9 | test — **fixed here** |
| 3 | The superagent default seeder writes a PERSONAL settings row; the tests write the INSTANCE tier | `0f3b49482` POD-1313, 2026-08-18 | yes | 14 | test |
| 4 | `attachDaemon`/`detachDaemon` take a transport object, not a bare send function | `1f988ab94` POD-2956, 2026-08-27 | yes | 1 | test |
| 5 | `attachDaemon` gained a third `caps` argument | `0e407e808` POD-3239, 2026-09-02 | yes | 2 | test |
| 6 | Legacy decode yields a `Buffer`; the assertion compares constructors — **never green since written** | `c607ca868` 2026-08-27 | yes | 1 | test — **fixed here** |
| 7 | The server-driven interrupt refuses unless the session is in phase `working` | `1ab8fc15a` POD-3098, 2026-08-29 | yes | 2 | test |
| 8 | Worktree removal verifies the git worktree registry and refuses a repo root | `1b5f59f7a` 2026-08-23 | yes | 2 | test |
| 9 | Hosting repos requires structural daemon eligibility | `4bbed7eaa` POD-2700, 2026-08-24 | yes | 1 | test |
| 10 | `listEventsSince` gained a second argument | `7fc1de4a0` 2026-08-27 | yes | 1 | test |
| 11 | Oracle tag ratchet drift — untagged characterizations added | `577eb857a`, `13cc8bf20` (2026-08-22); `057755c77`, `e957dd892` (2026-08-31) | yes (all four) | 2 | test |
| 12 | Machine rows with `ownerUserId: null` are invisible to the capability-scoped projection | **not isolated** | — | 1 | test |
| 13 | Spawn placement resolves to the host machine and reports `unreachable` | **not isolated** | — | 1 | test (probably) |
| 14 | `resurrectSession` returns a pending promise that never settles | **not isolated** | — | 1 | **code, suspected** |
| 15 | Mail cutover e2e awaits a delivery that never arrives (20s timeout) | **not isolated** | — | 1 | not determined |
| 16 | `applySuggestion` clears the suggestion on a draft that `update()` then discards | `72d2b4718` POD-3259, 2026-09-03 | **NO** | 1 | **code — user-visible** |
| 17 | New `expectedRevision` precondition makes `issues.start` throw | `72d2b4718` POD-3259, 2026-09-03 | **NO** | 1 | **code — user-visible** |

26+9+14+1+2+1+2+2+1+1+2+1+1+1+1+1+1 = **67**.

Three causes (12, 13, 15) and part of 14 could not be pinned to a commit. I am not calling those
"pre-existing": they are absent from the head-only set above, so they are not the epic's, but I did
not isolate what introduced them and the sub-issues say so.

---

## Cause 1 — inventory is hidden until the live daemon reports (26 tests)

`MachineService.attachDaemon` adds the machine to `inventoryPending` and `listMachines()` then omits
`inventory` for it:

```ts
// modules/machines/service.ts, attachDaemon
this.inventoryPending.add(machineId)
// …listMachines()
...(m.inventory && !this.inventoryPending.has(m.id) ? { inventory: m.inventory } : {}),
```

A persisted inventory describes the *previous* connection, so hiding it is deliberate and right.
The 26 fixtures write an inventory into the store with `setMachineInventory`, attach a daemon, and
never send an `inventoryReport` — so `harnessRejection` returns `inventory-unavailable` and every
spawn-shaped call throws `machine 'X' is still probing whether <agent> is installed`.

**Proven, not read.** Adding `recordInventory` after `attachDaemon` in the `browser-open.test.ts`
fixture took that file from **5 failed to 5 passed**.

**Verdict: the tests are wrong.** No user impact — a real daemon answers the `inventoryRequest` the
server sends, and `awaitInventory` waits for it. This is a fixture that stopped modelling a daemon.

Accounted for: `browser-open` ×5, `relay.machines` ×13, `relay.model-effort` ×3,
`superagent-concierge` ×2, `router.machines` ×1, `superagent` ×1, `relay.test` ×1.

## Cause 2 — `requestedDriverId` missing from the store fixture (9 tests) — FIXED

POD-3102 added `requestedDriverId` to the persisted session row projection
(`store/sessions.ts:240`) without touching `store.test.ts`. All nine failures are
`expected [ { id: 'id-1', …(41) } ] to deeply equal [ { id: 'id-1', …(40) } ]`, and the sole
difference is `+ "requestedDriverId": null`.

Every expectation is built from one `row()` helper, so this is a single small edit and it is applied
in this commit — `store.test.ts` goes from **9 failed to 60 passed**.

## Cause 3 — the seeder writes a personal row, the tests write the instance tier (14 tests)

POD-1313 made a fresh install pick a harness the machine actually has, seeding `roles.superagent`
from `SUPERAGENT_HARNESS_PRIORITY` (`['codex', 'grok', 'claude-code']`) on the first inventory
report. `superagent-headless.test.ts` reports every builtin harness installed, so the seeder plants
codex. The resolved settings read:

```
roles.superagent = {"accountId":"native:codex","model":"gpt-5.6-luna","effort":"max","harness":"codex"}
```

and every assertion expecting `claude-code` / `high` fails.

The second half is why the tests cannot fix themselves by writing settings: the seeder writes the
**personal** tier (`setSettingsFor`), while the test helper writes the **instance** tier
(`setSettings`), which a personal row shadows. Probing this printed both at once:

```
personal = {"accountId":"native:codex", …}       ← what the service reads
instance = {"accountId":"native:claude-code", …} ← what the test wrote
```

**Proven.** Pre-seeding the personal row and pointing the helper at `setSettingsFor` took the file
from **14 failed to 1**, and the last one fails by the same mechanism through an inline
`setSettings` call at line 1438.

**Verdict: the tests are wrong** — they use the instance-tier writer for a personal-tier setting.
No product code calls `setSettings`.

## Cause 6 — an assertion that has never once run green (1 test)

`peer-handshake.test.ts` "keeps an old daemon on one canonical legacy decode":

```ts
expect(batch.bytes).toEqual(Uint8Array.of(0x00, 0xff))   // Buffer[0,255] vs Uint8Array[0,255]
```

`decodeLegacyOutput` has returned `Buffer.from(...)` since `5a702d6f5`, and the assertion was
written one commit later in `c607ca868` — *against that same code*. The bytes have always been
right; the constructors have never matched. **This assertion has never passed since the day it was
written**, and the two lines after it —

```ts
expect(routeFrame).not.toHaveBeenCalled()
expect(ws.terminate).not.toHaveBeenCalled()
```

— have therefore never run. That is the same shape as POD-2708's dark escape guard: a real
assertion made invisible by an unrelated failure earlier in the same test.

**I checked whether the dark assertions actually hold.** Comparing the bytes instead of the
constructors makes the test pass in full: a legacy frame is not also routed as a binary frame, and
the connection is not terminated. **The code is correct; only the assertion was wrong.** No security
or data-loss defect. Fixed in this commit, because it is one small edit and it un-darkens two real
checks.

## Cause 7 — the Stop button tests went dark on 2026-08-29 (2 tests)

`relay.test.ts` "the stop button on a session with no terminal [POD-2792]" asserts that a
contract-driven session gets a `runtimeInterruptRequest` and never a typed Ctrl-C. No request is
emitted at all, so both tests fail on `expect(request).toBeDefined()`.

POD-3098 (`1ab8fc15a`) added a guard ahead of `contractInterrupt`:

```ts
if (this.deps.serverDriven?.(session) === true) {
  if (session.agentState?.phase !== 'working') return { ok: false, reason: … }
  return this.contractInterrupt(session, input)
}
```

That commit updated `inbox.test.ts` but not these two, whose fixtures never drive the session into
`working`.

**Proven.** Routing one `agentState` frame with `phase: 'working'` into the fixture makes **both
tests pass**. The Stop behaviour they were written to protect is intact — but it has not been
checked here for six days.

## Causes 16 and 17 — the epic's own two, in detail

Both from `72d2b4718` (POD-3259), which replaced `rowOrThrow` with `draftOrThrow` across the issue
mutation paths and added an `expectedRevision` precondition to `upsertIssue`.

**16 — `applySuggestion` (user-visible).** The method clears `suggestedStage` and `suggestedReason`
on its draft, then delegates the stage move to `update()`, which cuts its *own* draft from the
committed row and never sees the cleared fields. The comment above the delegation still says
"update() persists the cleared suggestion fields along with the stage" — true under the shared-row
model, false under the draft model. A user who applies a suggested stage gets the stage move and
keeps the suggestion, with its reason, showing in the sidebar.

**17 — `issues.start` (user-visible).** `StaleIssueRevisionError: expected revision 2, found 3`,
thrown from `upsertIssue` under `workflow.ts` `start()`. The precondition is new in the same commit;
the interleaving it detects is real, and under the old model the write silently overwrote. The
regression is that a path which used to succeed now throws. It rolls back rather than corrupting,
which is why I continued rather than stopping — but it is a write refusal in a core path.
The coordinator has sharpened this: the user-visible effect is that starting an agent on such an
issue **fails outright**. That is worse than a lost write in one respect — it is total rather than
silent. The precondition is doing exactly what it was added to do; the question POD-3373 has to
answer is why two revisions diverge on that path, not how to stop the guard firing.

## The remaining four (12, 13, 14, 15)

| Test | What I established |
|---|---|
| `relay-agent-relay` "routes a capability-scoped re-probe" | The fixture upserts its machines with `ownerUserId: null`; `visibleMachinesFor` filters on `canSeeMachine`, so the row is invisible and `machines.reprobe` refuses with `no visible machine with id 'm1'`. **Proven**: giving the fixture machines an owner takes the file from 2 failures to 1. Fixture-only; production rows always carry an owner. |
| `relay-agent-relay` "same-issue child spawn" | `placementDecision` returns `unreachable` because `machines.hasDaemon(hostMachineId)` is false for the fixture's injected store. Attaching a host daemon does not fix it — a second fixture gap sits behind it. |
| `relay.test` "hands a live busy Grok ledger send to exit recovery" | 20s timeout on `await resurrectSession(...)`. `resurrectSession` returns `this.pendingResurrections.get(sessionId)` when an entry exists; an earlier recovery registered one that never settles. This is also the source of the run's single unhandled rejection (`Cannot use a closed database`, from `store/interactions.ts` running after the store closed). **Suspected code**, not a stale test — the sub-issue says so. |
| `modules/messages/cutover` "delivers an issue-addressed send to the live agent" | 20s timeout awaiting a delivery. Not diagnosed further. |

## What changed in this commit

Two single-edit fixes, both listed in the commit message, together removing 10 failures:

- `apps/server/src/store.test.ts` — one field in the `row()` fixture (cause 2, −9).
- `apps/server/src/gateway/peer-handshake.test.ts` — compare bytes rather than constructors
  (cause 6, −1), after verifying the two assertions it unblocks pass.

Nothing else in the lane was touched. Every other cause is filed as a sub-issue under POD-3221 with
the diagnosis in its brief. Causes 16 and 17 were filed as POD-3381 before the coordinator ruled on
ownership; **POD-3373 owns them** and POD-3381 has been marked a duplicate of it.

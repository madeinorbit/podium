# Host resource lifecycle policy — recommendation

**Issue:** POD-554 · **Input:** POD-526 host-load diagnosis (`.artifacts/POD-526/host-load-diagnosis.md`)
**Status:** design only — no implementation in this pass.
**Date:** 2026-08-07

---

## 0. The one-sentence answer

Podium releases three different resources — **process**, **worktree**, **branch** — and today
exactly one event releases any of them (`stop`, which an operator must type). The fix is not one
trigger; it is **three triggers, ordered by how reversible the release is**, with issue stage used
only to *prioritise* candidates and never to *authorise* a teardown.

| resource | what it costs | how reversible | recommended release |
|---|---|---|---|
| **process** (agent CLI, abduco, daemon observers, FDs) | CPU, load, journal bandwidth — the "server is falling apart" cost | **fully** — `hibernateSession` keeps row + transcript + resume ref + worktree; one click resumes | automatic, on pressure, aggressively |
| **worktree** (disk checkout, git registry, node_modules) | disk, git op cost, anchor for zombie cwds | **nearly** — `ensureWorktree` recreates it from the branch; only *uncommitted* work is lost, and a dirty tree refuses | automatic on `archived`, plus a janitor sweep for the tail |
| **branch** (the work itself) | ~nothing on the host | **not** | stays manual `cleanup` (closed + merged + clean). Unchanged. |

The operator's hard constraint is satisfied structurally: nothing in this design ever deletes a
branch automatically, and freeing a *checkout* of an unmerged branch loses nothing — merge-pending
work lives on the branch, not in the directory.

---

## 1. What the code actually does today

Mapped from source, because two of the diagnosis's conclusions are wrong in ways that change the fix.

### 1.1 Issue stages and the closed/archived split

`packages/model/src/entities/issue-vocabulary.ts:40` — stages are ordered:
`proposed → backlog → planning → in_progress → review → done`.

Three *independent* terminal-ish facts sit beside them:

- `isIssueClosed(row) = stage === 'done' || closedReason != null`
  (`packages/model/src/predicates/issue-stage.ts:18`) — an **agent-writable claim**.
- `archived: boolean` — a **shared column**, set manually, by the cascade, or by the read-gated sweep.
- `deletedAt` — tombstone, operator-only.

### 1.2 What close does — and does not do

`apps/server/src/modules/issues/service/crud.ts:494`. On a closed-predicate flip:
emits `issue.closed`, stamps `closedAt`, retires standing offers, emits `issue.ready` for unblocked
dependents, and runs `archiveClosedSubtree` — which archives *children* that are themselves closed,
read, and have no live session.

**Close does nothing to the issue's own sessions and nothing to its worktree.** That is the whole
zombie mechanism: 37 non-archived done issues, ~97 done-stage worktrees, ~19 live sessions on done
issues.

### 1.3 What archive does — and the TODO seam

`crud.ts:516` → `attention.ts:498 cascadeArchiveSessions` → `setSessionArchived` →
`session-wiring.ts:204 onArchived` → `session-teardown.ts:107 parkArchivedSession`:
process killed, status → `hibernated` (or `exited` with no resume ref), `stopReason: 'parent'`.

**So archive already reaps processes.** What it does not do is written in the code, verbatim, at
`apps/server/src/modules/issues/service/attention.ts:484`:

```
// TODO(#127 seam): worktree cleanup hooks here. Auto-archive is where future
// worktree/branch teardown for a finished issue will attach (see epic #101).
// Deliberately NOT implemented now — archiving is purely a UI-declutter today.
```

That seam is the single highest-value change in this document. ~82 of the ~100 leftover worktrees
belonged to **already-archived** issues — issues whose processes Podium *had* already killed.

The auto-archive sweep (`attention.ts:389 sweepAutoArchive`, and the fenced janitor twin
`tryAutoArchiveObserved`) archives an issue that is closed **and** top-level **and** read by the
broadcast viewer **and** whose read is ≥ 7 days old **and** has no post-read activity. It runs as a
janitor *proposal* the server revalidates — the correct architecture, already built.

### 1.4 The session teardown table (already excellent — do not redesign it)

`apps/server/src/modules/sessions/session-teardown.ts:8`:

| operation | process | worktree | branch | transcript | row | resume ref |
|---|---|---|---|---|---|---|
| `hibernateSession` | killed | **kept** | kept | kept | kept | **required** — refuses without one |
| `stopSession` | killed | **freed when safe** | kept | kept | kept | kept |
| `stopIssue` | all killed | freed | kept | kept | kept | kept |
| `killSession` | killed | — | — | kept | **tombstoned** | — |

`stopSession` refuses on a dirty tree without `--force`, and only frees when
`liveSessionsUsingWorktree` returns empty — including sessions bound to a *different* issue that
happen to run in that path. `freeWorktreeKeepBranch` ([spec:SP-9904], `workflow.ts:501`) is
per-machine routed and idempotent. **The primitives are all correct and all present. Nothing calls
them automatically.**

### 1.5 Auto-hibernation — the diagnosis is half wrong here

`apps/server/src/modules/hosts/service.ts:139 maybeAutoHibernate`, run on every inbound
`hostMetrics` sample (every 5 s, `host-runtime.ts:57`).

> The diagnosis says hibernation is "effectively inert" because `memoryPct: 80` never trips.
> **That is not right.** [spec:SP-c29e] already added a *count* pressure path that runs
> **independently of memory** (`service.ts:178`): if idle-live sessions on a machine exceed
> `maxIdleSessions`, it hibernates them on a token bucket (4 burst, +1/15 s). The memory gate
> being dead does not disable it.

So why did the fleet still not converge? Three real reasons, and they are the actual bugs:

**(a) The target is 30.** `maxIdleSessions: 30` (`preferences.ts:222`) tolerates precisely the fleet
size that killed the box. The count gate was firing correctly at a target nobody would choose
deliberately.

**(b) Uninstrumented sessions are invisible to the whole mechanism.** `idleLiveSessions`
(`service.ts:240`) counts a session only if `agentState.phase ∈ {idle, ended, needs_user}`. A
harness whose observer is unsupported "gets NO observation — its phase stays `unknown`"
(`session-observers.ts:1200`). **Shell sessions have no manifest at all.** A `phase: 'unknown'`
session is therefore *never counted toward the cap* and *never eligible for hibernation, under any
pressure source*. The diagnosis's own cull list contains `POD-92 | shell | old terminal | done since
Jul 21` — a session that by construction no policy could ever reap. Any agent CLI whose hooks failed
to install lands in the same hole silently.

**(c) There is no CPU signal on the wire at all.** `HostMetricsWire`
(`packages/model/src/entities/machine.ts:186`) carries `hostname`, `sampledAt`, `memory{total,
available, swapTotal, swapFree}`, `idleCapUnmet`. The daemon samples only `/proc/meminfo`
(`apps/daemon/src/host-metrics.ts:35`). **Load average is never sampled, never sent, and cannot be
read by the server.** Item 4 of the brief ("hibernate on load, not only memory") is blocked on a
wire field, not on policy.

One diagnosis worry I can retire: *"several done sessions still get fresh `last_output_at`, so
idle-minute logic may never see them as idle."* `effectiveIdleSinceMs` (`service.ts:288`) is
`max(lastActiveAt, lastResumedAt, lastInputAt)` — output is **not** in it. Output is checked
separately against a 60-second quiet window (`OUTPUT_QUIET_MS`). Background TUI chatter delays a park
by a minute, not forever.

### 1.6 Worktree lifecycle

Create is automatic (`workflow.ts:326`, on start/claim). Removal has exactly two doors:

- `freeWorktreeKeepBranch` — called **only** from `stopSession` / `stopIssue`.
- `cleanup` — requires closed **and** `isMergedInto(parentBranch)` **and** clean; deletes worktree
  *and* branch, both non-forcing so git itself is the last guard.

No sweep. No archive hook. No inventory. Nothing counts what is on disk.

---

## 2. Recommended policy

### T1 — Process release: pressure-driven, stage-*ordered*, never stage-*gated*

Keep the existing candidate machinery exactly as it is (it is careful and correct: resume ref
required, mid-work refused, `needs_user` protected, 60 s output quiet, durable terminal proof
revalidated). Change three things:

1. **Retune the target.** `maxIdleSessions` default `30 → 8`. One line, no schema change.
   On the POD-526 snapshot this alone converges the 19-zombie bucket in ~12 minutes.

2. **Sort candidates by lifecycle, not only by age.** `eligibleCandidates` currently sorts purely by
   `effectiveIdleSinceMs`. Add a primary key:

   ```
   0  session on a closed issue (stage=done or closedReason set)
   1  session with no issue at all
   2  session on an open issue
   ```
   then idle-age within each tier.

   **This is the whole answer to "archive vs done".** `done` becomes an *ordering* input and never a
   *decision* input. A done session is still parked only if it independently passes every safety
   gate it passes today. An agent that marked done and kept writing keeps `lastOutputAtMs` fresh and
   is protected by the same 60 s quiet window that protects an in-progress agent — the claim of
   doneness buys it no less protection than before, it only loses its place in the queue. Nothing
   about "done means waiting for merge" is violated: hibernation keeps the branch, the worktree, the
   transcript and the resume ref. There is nothing to lose.

3. **Close the `unknown`-phase hole** (§1.5b). Two sub-decisions:
   - **Count** `phase === 'unknown'` sessions toward `maxIdleSessions` once they have been quiet
     (no input, no output) for `max(idleMinutes, 4h)` — a long window because the absence of a phase
     signal means we genuinely do not know, and the cost of being wrong is killing a working agent.
   - **Do not hibernate them by that route** if they lack a resume ref (the call would refuse
     anyway). Shells specifically: `stopSession` parks a shell as `exited`, which is inspectable and
     correct. Recommend a separate, explicit `idleShellHours` policy (default `null` = off) rather
     than folding shells into the agent cap.

   Ship the *counting* change with a log line before the *acting* change. A cap that suddenly sees
   twice as many sessions will hibernate aggressively on first deploy.

**Deliberately NOT recommended:** a `issue.closed → stop sessions` event hook. It is the obvious
design and it is the one the operator vetoed, correctly. `done` is agent-writable and semantically
overloaded ("waiting for merge", "waiting for review"), and `stopSession` *frees the worktree* —
which would yank the checkout out from under an agent still writing to it. If a close-anchored
signal is wanted later, the safe shape is a **grace clock**, not an event: on `issue.closed`, stamp
`closedAt` (already done) and let T1's tier-0 ordering plus the normal idle gates do the work. That
is exactly what item 2 above gives you, with no new trigger at all.

### T2 — Worktree release on archive (the TODO seam)

On `archived: false → true` (manual, cascade, or the 7-day read-gated sweep), after
`cascadeArchiveSessions`, call `freeWorktreeKeepBranch(row.id, systemPrincipal('archive'))`.

Preconditions — all already implemented inside that method or trivially available:

- **no `force`, ever.** A dirty tree refuses and stays on disk. Report it, never discard it.
- `liveSessionsUsingWorktree(path) === []` — naturally satisfied because the cascade just parked
  them, but check anyway: a session from *another* issue may be sitting in that path.
- Route through `row.machineId` (already the method's behaviour).
- Branch is kept unconditionally. **Unmerged is not a refusal** — this is the merge-pending case and
  it is safe: the branch holds the work, `ensureWorktree` recreates the checkout on resume.
- Emits `issue.worktree_freed` + an audit comment (already the method's behaviour).

Why archive and not close: archive is either an explicit operator act, or the sweep's
*closed + operator-has-read-it + 7 days quiet + no activity since*. That is the strongest
"the human has seen this and moved on" signal the system has, and it is the one the operator asked
for. On the POD-526 snapshot this reclaims ~82 worktrees with zero policy risk.

### T3 — Worktree GC sweep for the tail

Archive-triggered release does not reach *done-but-never-archived* work: 37 such issues, ~97
done-stage worktrees, and the sweep only ever touches **top-level** issues (`row.parentId` gate in
`sweepAutoArchive`), so every sub-issue worktree is permanently out of its reach.

Add a janitor jobKind `worktree-gc` alongside `issue-auto-archive` / `session-auto-archive`
(`packages/protocol/src/maintenance.ts:267`). The propose/revalidate architecture already exists and
already handles exactly this class of "SQLite observation is only a proposal" problem.

**Candidate predicate** (janitor proposes; server revalidates every clause at apply time):

```
worktreePath != null
  AND isClosed(row)                       -- done or closedReason
  AND !deletedAt
  AND no live/starting/reconnecting session using the path (any issue)
  AND working tree clean                  -- re-read at apply time, never cached
  AND closedAt older than settings.worktreeGc.afterDays
```

**Action:** `freeWorktreeKeepBranch` without force. Branch untouched.

**Default mode: `propose`, not `auto`.** New setting:

```ts
worktreeGc: {
  mode: 'off' | 'propose' | 'auto'   // default 'propose'
  afterDays: number                  // default 14
}
```

`propose` surfaces "97 worktrees · 34 GiB reclaimable" in the host-pressure panel (§4) with one
button. `auto` applies it. This is the diagnosis's "janitor proposal list: 99 worktrees reclaimable"
ask, and shipping propose-first means the first run is inspectable rather than a 97-directory
surprise.

### T4 — Branch deletion: unchanged

`cleanup` stays exactly as it is: explicit, closed + merged + clean, non-forcing git ops. No
automation, no sweep, no proposal. This is the irreversible rung and it should stay behind a person.

### T5 — Pressure sources beyond memory (brief item 4)

Blocked on a wire field, so it is its own PR:

1. **Daemon**: add `os.loadavg()` + `os.cpus().length` to the 5 s sample.
2. **Wire**: extend `HostMetricsWire` with
   `load: { one: number; five: number; fifteen: number; cpuCount: number } | undefined`
   (optional — a daemon predating the field must keep parsing, and macOS loadavg has different
   semantics but is still directionally right).
3. **Policy**: add to `HibernationPolicy`:
   ```ts
   loadPerCore: z.number().min(0.5).max(8).nullable().default(1.5)   // null = off
   ```
4. **Service**: a `loadReady` branch in `maybeAutoHibernate`, structurally identical to the existing
   `memoryReady` branch — same cooldown map, same candidate pool, same safety gates, same
   one-park-per-sample discipline. The method already reads as "N independent pressure sources over
   one candidate pool"; this is the third source, not a redesign.

Threshold reasoning: `load1 / cpuCount ≥ 1.5` means the run queue is half again the core count —
every request is already waiting. On the POD-526 box (load 14–18 on 8 cores = 1.75–2.25×) it fires
immediately; at healthy idle it never does. Use `load1`, not `load5`: `load5` on a box that has been
pinned for a day stays high long after the fleet drains and would over-park during recovery.

**Explicitly not recommended:** a hard max-live-sessions cap. That is machine concurrency control
(out of scope per the brief, separate issue) and it belongs at *spawn* time, not at reap time. A
reap-time cap fights the operator; a spawn-time cap tells them no.

---

## 3. Edge cases

| case | behaviour under this policy | why it is safe |
|---|---|---|
| Agent marks `done`, keeps writing | Not parked. `lastOutputAtMs` stays fresh → fails the 60 s output-quiet gate; `lastInputAt`/`lastActiveAt` fail the `idleMinutes` gate. Tier-0 ordering only moves it up the queue it is not in. | The operator's constraint, enforced by gates that already exist |
| `done` = "waiting for merge / human review" | Session hibernates (reversible); worktree survives until *archive*; branch survives forever | Merge-pending work lives on the branch. Nothing merge-related is on the host after a park. |
| Unmerged branch on an archived issue | Worktree freed, **branch kept**, `issue.worktree_freed` comment records it | `ensureWorktree` recreates from branch on resume; `cleanup` still refuses to delete an unmerged branch |
| Dirty worktree | **Refuses, always.** No `force` on any automatic path. Counted and surfaced as "held by uncommitted changes". | Uncommitted work is the one thing that has no other copy |
| Session on issue A living in issue B's worktree | `liveSessionsUsingWorktree` checks the *path*, not the issue id — already correct | Existing behaviour, verified |
| `phase: 'unknown'` / shell sessions | Counted after a long quiet window; hibernation still refuses without a resume ref; shells park as `exited` via an explicit opt-in policy | Today they are invisible to every policy — the silent hole |
| `needs_user` session | Counted as fleet load, **never eligible for parking** (existing) | Parking an agent waiting on a human answer destroys the interaction. Surface the count instead — the fix is human. |
| No resume ref | `hibernateSession` refuses (would become a kill). Under sustained pressure these accumulate. | Surface as "N sessions cannot be parked". Never auto-kill. |
| Unarchive after worktree freed | Sessions are **not** resurrected (documented, unchanged). Resume must call `ensureWorktree`. | **Verify this path is wired from the web resume button before shipping T2** — it is the one regression risk in the whole design |
| Archived parent with open children | `archiveClosedSubtree` archives only closed children; open work is skipped and reported via `issue.cascade_skipped` | Existing behaviour |
| Multi-machine | Every gate is already per-machine (cooldown map, token bucket, candidate scope). Worktree ops route by `row.machineId`. | Existing behaviour, verified |
| Janitor proposes, state changes before apply | Server revalidates *every* clause inside the mutation; a worktree freed in between returns `precondition`, not an error | Existing propose/revalidate contract |
| First deploy of the `unknown`-counting change | Cap suddenly sees ~2× the sessions → burst park | Ship counting + log first, acting second. Token bucket (4 + 1/15 s) bounds the burst either way. |

---

## 4. Phased PR plan

Ordered by value-per-risk. Each is independently shippable and independently revertible.

| # | PR | Touches | Risk | Reclaims (POD-526 snapshot) |
|---|---|---|---|---|
| **1** | `maxIdleSessions` default 30 → 8; lifecycle tier in `eligibleCandidates` sort | `preferences.ts` (1 line), `hosts/service.ts` (~10 lines) | very low — no new trigger, no schema | the 19 zombie sessions, in ~12 min |
| **2** | Archive → `freeWorktreeKeepBranch` (the `attention.ts:484` seam) | `attention.ts`, `issues/service/index.ts` port | low — reuses a guarded, tested method; no force | ~82 worktrees |
| **3** | Load signal: daemon `loadavg` → `HostMetricsWire.load` → `HibernationPolicy.loadPerCore` → `loadReady` branch + settings row | `host-metrics.ts`, `machine.ts`, `preferences.ts`, `hosts/service.ts`, `settings/sections/hibernation.tsx` | medium — new wire field (optional, back-compatible) and a new pressure source | brief item 4; prevents recurrence |
| **4** | `unknown`-phase counting (log-only), then acting | `hosts/service.ts` | medium — ship in two steps | the invisible tail (shells, hook-less agents) |
| **5** | Janitor `worktree-gc` jobKind + `worktreeGc` settings, `propose` default | `protocol/maintenance.ts`, `janitor.ts`, `maintenance/service.ts`, `workflow.ts` | medium — new job, but on the existing fenced propose/revalidate rails | ~97 done-but-unarchived worktrees |
| **6** | Host-pressure readout (see `host-pressure-topbar.md`) + LoadPanel "Reclaimable" section + settings deep-links | `HostIndicators.tsx`, `LoadPanel.tsx`, `styles.css`, `HostMemoryView.tsx` | low — read-only UI | brief item 5 |

**Prerequisite for PR 2:** confirm the web resume button calls `ensureWorktree` for an issue whose
`worktreePath` is null but `branch` is set. If it does not, that is a blocking sub-issue.

PRs 1 and 2 together address the entire POD-526 incident. PRs 3–5 prevent recurrence. PR 6 makes it
visible.

---

## 5. Out of scope (confirmed, per brief)

- **Machine concurrency caps** — spawn-time admission control, separate issue. §2/T5 explains why it
  must not be folded into the reap path.
- **Server timerfd/FD audit** — ~366 timerfds against ~11 sockets is a real anomaly; nothing here
  addresses it, and it should not block this work.
- **Pruning the live host** — ops already handled it.
- **Transcript retention** (884 MiB) — noted in the diagnosis, not in this brief. Worth its own
  issue; it is disk, not the load problem.

---

## 6. Code index

| what | where |
|---|---|
| Stage vocabulary | `packages/model/src/entities/issue-vocabulary.ts:40` |
| Closed predicate | `packages/model/src/predicates/issue-stage.ts:18` |
| Close side effects | `apps/server/src/modules/issues/service/crud.ts:494` |
| Archive → session cascade | `crud.ts:516` → `attention.ts:498` |
| **The worktree TODO seam** | `apps/server/src/modules/issues/service/attention.ts:484` |
| Read-gated auto-archive sweep | `attention.ts:389`, fenced twin at `attention.ts:422` |
| Session teardown survival table | `apps/server/src/modules/sessions/session-teardown.ts:8` |
| `stopSession` / `stopIssue` | `session-teardown.ts:186` / `:339` |
| `hibernateSession` | `session-teardown.ts:434` |
| Auto-hibernate pressure gates | `apps/server/src/modules/hosts/service.ts:139` |
| Idle-live set / eligibility / idle clock | `hosts/service.ts:240` / `:249` / `:288` |
| Hibernation policy schema | `packages/model/src/settings/preferences.ts:216` |
| `HostMetricsWire` | `packages/model/src/entities/machine.ts:186` |
| Daemon memory sampler (no CPU) | `apps/daemon/src/host-metrics.ts:35`, pushed at `host-runtime.ts:370` |
| `freeWorktreeKeepBranch` / `ensureWorktree` / `cleanup` | `apps/server/src/modules/issues/service/workflow.ts:501` / `:604` / `:681` |
| Janitor jobKinds | `packages/protocol/src/maintenance.ts:235–299` |
| Propose/revalidate authority | `apps/server/src/modules/maintenance/service.ts` |
| Unobserved harness → `phase: 'unknown'` | `apps/daemon/src/session-observers.ts:1198` |
| Top bar / instrument well | `apps/web/src/app/TopBar.tsx:116`, `features/machines/HostIndicators.tsx:180` |
| Load popover | `apps/web/src/features/machines/LoadPanel.tsx` |
| Status strip (fleet count + skyline) | `apps/web/src/app/StatusStrip.tsx`, `AgentConcurrencyHistory.tsx` |

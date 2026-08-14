# Plan — POD-2046 Synchronous git on the daemon's main loop

Analysis: issue artifact `pod2046-daemon-sync-git.md` (read it back with
`podium issue artifact 2046 --get 1`). Discovered sibling: POD-2048 (server-side,
separate). Base: `b32432733`.

## Problem

The daemon runs git with `spawnSync` on its only event loop. `runGit`
(`apps/daemon/src/host-runtime.ts:302`) is wired at `:381` into the grant runner
and reaches `convergeViaGit` (`packages/runtime/src/update-delivery-git.ts:69`),
which issues four blocking commands: `status --porcelain --untracked-files=all`,
`rev-parse HEAD`, `fetch --all --prune`, `checkout --detach <sha>`.
`fetchArtifact` is `async`, but `convergeViaGit` is a plain synchronous function
called inside it, so the `await` yields nothing.

The bound is a shared budget, `GIT_CONVERGENCE_BUDGET_MS = 8 * 60_000`
(`update-delivery-git.ts:33`), sized to fail before the server's ten-minute
silence deadline. It bounds how long the freeze lasts, not whether it happens.

While blocked, everything the daemon owns stops: PTY output (`OutputScheduler`
flushes on `setTimeout`, `output-scheduler.ts:32`), the server link, hook ingest
and the agent relay (`host-runtime.ts:231`, `:267`). The existing code says so
twice — `host-runtime.ts:290` ("this thread is blocked, so an abort signal
cannot be observed") and `grant-apply.ts:126` ("a synchronous git checkout runs
to its own timeout").

Git delivery is source-checkouts only (`deliveryCaps`, `build-report.ts:44`), so
this is the dev-machine path — the boxes that run agent fleets.

## The one decision this plan rests on

**Await the child process; do not move work to a thread.**

Git is already a subprocess. The loop blocks solely because we chose to wait
synchronously. There is no CPU-bound JS to relocate, so a worker thread, a job
queue, or a thread pool would all add a hop and a failure mode while fixing
nothing that `await` does not.

This is already the house style in the same daemon: `workspace-package.ts:14`
and `handoff-package.ts:24` both run git through `promisify(execFile)`. The
update path is the outlier, not the precedent.

**Do not** introduce: a git worker, a serialisation queue for git, a retry
loop, or a second timeout mechanism. If the work appears to need one, stop and
raise it rather than building it.

### Verified prerequisite

The port depends on Bun honouring `timeout` and `signal` on async `execFile`.
Measured on Bun 1.3.14, this host:

```
timeout honoured after 616 ms; killed= true signal= SIGKILL
signal  honoured after 403 ms; name= AbortError
loop ticks during both waits: 20   (0 would mean the loop was blocked)
```

No capability is lost in the port, and cancellation is gained. Re-run this
probe if the Bun version moves before the work lands.

## Scope

In scope — three sync child-process call sites on the daemon loop, all on the
update path:

1. `apps/daemon/src/host-runtime.ts:302` — `spawnSync('git', …)`, budgeted.
2. `apps/daemon/src/update-install.ts:20` — `execFileSync('tar', ['-xzf', …])`
   in `swapHeadlessBundle`, **no timeout**. This is the *installed*-daemon
   delivery path, so a git-only fix leaves those daemons unfixed.
3. `apps/daemon/src/connection-state.ts:263` — `spawnSync(process.execPath,
   ['update'])` in `handleProtocolMismatch`, **no timeout at all**. The
   least-bounded of the three.

Out of scope:

- Server-side sync git in `apps/server/src/modules/updates/dev-bundle.ts` —
  POD-2048, ships separately.
- Boot-time sync git (`build-report.ts:41` → `source-version.ts:5`;
  `logging.ts:114`, memoised once per process). Both run before the daemon
  serves anything. They cost boot latency, not loop availability. Leave them.
- The budget's value, the convergence step sequence, and the refusal semantics
  of `convergeViaGit`. Behaviour is preserved exactly; only its colour changes.

## Phase 1 — make the git runner async

### 1a. `packages/runtime/src/update-delivery-git.ts`

- `GitRun` returns `Promise<{ status: number | null; stdout: string }>`.
- `withGitBudget` keeps its shape. It computes `remaining` *before* delegating
  and never inspects the result, so the only edit is the return type; the
  spent-budget short-circuit becomes `Promise.resolve({ status:
  GIT_TIMED_OUT_STATUS, stdout: '' })`.
- `convergeViaGit` becomes `async` and `await`s each step. Control flow is
  already a linear sequence of guarded steps — every `deps.run(...)` gains an
  `await` and nothing else moves. The argument validation and every
  `status`/`stdout` check stay byte-identical.
- Update the module docstring: the paragraph at `:22` justifying the shared
  budget by "Git delivery is SYNCHRONOUS" needs rewriting. The budget survives
  the change and is still correct — three steps must not out-live the server's
  deadline — but the *reason* is no longer "we cannot observe a cancellation".

### 1b. `packages/runtime/src/update-delivery.ts`

- `const result = await convergeViaGit(...)` at `:98`. `fetchArtifact` is
  already `async`; no signature moves.
- Extend `DeliveryDeps.git` (`:31`) so the runner can receive the abort:
  pass `deps.signal` through to `convergeViaGit`'s deps, or — simpler, and
  preferred — leave `DeliveryDeps` untouched and have the *daemon* close over
  the signal when it builds the runner (see 1c). Prefer the second: it keeps
  the runtime package ignorant of who owns the abort.

### 1c. `apps/daemon/src/host-runtime.ts`

- Replace `spawnSync` with `promisify(execFile)`:
  `{ timeout, killSignal: 'SIGKILL', signal, encoding: 'utf8' }`. Map the
  rejection back to the same `{ status, stdout }` shape the callers already
  branch on — a timeout kill must still surface as `GIT_TIMED_OUT_STATUS`, and
  an abort must surface distinguishably (see the open question below).
- `runGit` currently takes `(command, args, timeoutMs)`. Give it the grant's
  `AbortSignal` too. `host-runtime.ts:381` builds the deps inside the
  `fetchArtifact` call that already receives `signal`, so the signal is in
  scope at the wiring site — thread it into `withGitBudget(runGit)` there.
- **Pass an explicit `env`.** `runGit` passes none today. Per
  `packages/pty/src/abduco.ts:290` [spec:SP-3f93], Bun's *sync* spawns reuse
  the process-start environment and ignore later `process.env` mutations; the
  async ones read the live map. Moving to async silently changes which
  environment git sees. Pass `{ ...process.env }` explicitly so the change is
  a decision, not a side effect.
- Delete the "cannot be cancelled" paragraph at `:290` and replace it with what
  is now true: the abort kills the child, and the budget remains the bound on a
  hung `git fetch` against an unreachable remote.

### 1d. `apps/daemon/src/grant-apply.ts`

- The docstring at `:126` says cancellation is "bounded by what the delivery can
  honour — a network download aborts, a synchronous git checkout runs to its own
  timeout". Once 1c lands, git aborts too. Rewrite the clause.
- `applyGrant` needs no structural change: `deps.fetchArtifact(asset,
  plan.delivery, signal)` at `:99` already carries the signal, and the
  `if (signal?.aborted) return` guard at `:102` still holds. The signal simply
  reaches deeper than it used to.

## Phase 2 — the two unbounded siblings

### 2a. `apps/daemon/src/update-install.ts`

- `swapHeadlessBundle` becomes `async`; `execFileSync('tar', …)` becomes an
  awaited `execFile` **with a timeout** — it has none today.
- `grant-apply.ts:104` already does `await deps.swap(artifact.bytes)`, so the
  caller is unchanged. Check the `GrantApplyDeps.swap` type allows a promise.
- The rename/rollback sequence around the extract stays synchronous. Those are
  `renameSync` calls on one filesystem, chosen for atomicity; leave them. Only
  the `tar` extract — the one call that can take seconds and has no bound —
  moves.

### 2b. `apps/daemon/src/connection-state.ts`

- `handleProtocolMismatch` is a `void` callback on the socket path. Making the
  spawn async makes the function async, which changes its call sites. Trace
  every caller before editing; if a caller cannot await, launch the update and
  let the existing `decidePostUpdate(result.status)` branch run in the
  continuation rather than converting the whole chain.
- Give it a timeout. A `podium update` that never returns currently wedges the
  daemon permanently with no alarm.
- This one is the most likely to grow: if the async conversion reaches beyond
  `connection-state.ts`, stop and split it into its own sub-issue rather than
  widening this branch.

## Tests

Existing, must be ported (mechanical — the injected runners return values where
they now return promises):

- `apps/cli/src/delivery-git.test.ts` (194 lines) — its `runner()` helper and
  every `it()` callback become async. Assertions on call order and refusal
  reasons are unchanged and are the regression net for Phase 1a.
- `apps/cli/src/delivery.test.ts` — `fetchArtifact` callers; check the git
  overload's fixtures.
- `apps/daemon/src/grant-apply.test.ts` — already uses `vi.fn(async …)`; the
  `swap` fake may need to become async for 2a.

New, and the reason for the change:

- **The property that actually regressed**: a timer fires while a git step is
  in flight. Inject a `GitRun` that resolves on a `setTimeout`, start a
  convergence, and assert an independent timer ran before it resolved. Under
  the current code this is impossible; under the fix it must hold. Without this
  test the change is unfalsifiable from the unit lane.
- **Abort mid-step**: abort the signal while a step is in flight and assert the
  convergence rejects/refuses promptly rather than after the budget. This is
  the new capability; it needs a test or it will rot.
- **Budget still bounds**: a runner that never resolves must still fail
  `timed-out` on the budget. Guards against "made it async and lost the bound".

## Gate

`bun run test` is the end-of-task gate (AGENTS.md). The daemon/PTY process
behaviour trigger also applies, so run the integration lane once, sequentially —
not stacked.

Beyond the unit lane, gate on a **comparison**, not a bare green. The daemon
already runs the POD-600 loop-metrics probe with the stall classifier
(`packages/runtime/src/loop-metrics.ts`, `loop-stall.ts`, wired via
`host-runtime.ts:134` and `loop-attribution.ts`). A sync git fetch is exactly
the shape it reports: a very long tick classified `busy`, not `starved`. So
there is an instrument here that can say *no*.

- **Before** — drive a git delivery against an unreachable remote on a source
  daemon; the probe should log a long `busy` tick spanning the convergence.
- **After** — same scenario: no long tick, and the convergence still fails with
  `timed-out` on the budget.

Record both readings with the SHA each was taken at. A green after-run alone
proves nothing here: it is consistent with the delivery never having run.

## Risks

1. **The daemon is now live while the checkout is rewritten under it.**
   Today the freeze makes `git checkout --detach` accidentally atomic from the
   daemon's own point of view — it cannot read a half-changed tree because it
   cannot read anything. After the fix it can. The live server runs the main
   checkout's working tree, so this is a real change in exposure, not a
   theoretical one. The convergence ends in a restart regardless, which limits
   the window, but this needs an explicit decision before Phase 1 lands rather
   than discovery afterwards. **Raise it; do not assume it is benign.**
2. **Reentrancy.** Control messages will now be processed during a convergence.
   `createGrantRunner` already serialises grants (a repeat is ignored, a newer
   one aborts and awaits the old), so the update path itself is covered. Audit
   whether any *other* handler assumes no update is in flight.
3. **Environment delta** — covered in 1c; the fix is to pass `env` explicitly.
4. **Bun behaviour drift** — the timeout/signal probe above is version-specific.
   Re-run it if Bun moves.
5. **Scope creep in 2b** — bounded by the "split it out" instruction above.

## Order of work

Phase 1 is coherent and shippable on its own; Phase 2 is two independent edits
that can land in the same branch or follow. Do 1a → 1b → 1c → 1d in that order:
each step compiles against the previous one, and the type change in 1a is what
forces the rest, so the compiler enumerates the work rather than a grep.

Do not run tests between steps. Implement the complete change, then gate once.

# POD-2021 — Terminal driver behind contract (W3)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§3 all, §9 phase 2 daemon half). Prereq: POD-2019's contract package is on the
> integration branch before you start (it is a blocking dep — verify with `podium issue show 2019`).

## Objective

Today's PTY stack drives sessions **through the contract** when a flag is on, with zero
change when it is off. This is an ADAPTER exercise: wrap the existing daemon machinery into
a `RuntimeDriver`, produce honest receipts and causally-enveloped events, and pass the
conformance suite with the terminal family's declared exemptions. Do NOT rewrite any
mechanism; every heuristic keeps living where it lives — you are giving it one doorway.

## Architecture constraint (read first)

`packages/agent-runtime` cannot import daemon app code. So the split is:
- **In the package** (`packages/agent-runtime/src/drivers/terminal/`): only what is
  app-independent — receipt state machines, event-envelope assembly helpers, types.
- **In the daemon** (`apps/daemon/src/runtime/terminal-driver.ts` + `runtime/registry.ts`):
  the concrete `RuntimeDriver` implementation, composing daemon internals
  (`control/session.ts`, `session-observers.ts`, `binding-store.ts`, hook-ingest,
  composer-sync, handoff-package). The daemon registers drivers in a small registry at
  bootstrap (`instance-bootstrap.ts` / `host-runtime.ts`), keyed by `DriverId`.
This mirrors how the frame-handler pattern already works; if you find the boundary lint
disagrees, fix the manifest deliberately (like POD-2019 did), don't smuggle imports.

## Implementation order

### 1. Driver skeleton + flag
- `apps/daemon/src/runtime/terminal-driver.ts` implementing `RuntimeDriver` for every
  harness kind whose manifest declares `runtime.terminal` (all five + shell-as-degenerate).
- Flag: `PODIUM_RUNTIME_CONTRACT=1` env on the daemon (read once at bootstrap; also accept a
  per-spawn field on the spawn frame so single sessions can be flagged). Flag off ⇒ nothing
  below is reachable; the legacy paths are untouched.

### 2. Lifecycle verbs (wrap, don't move)
- `create/resume` → the existing spawn path (`control/session.ts` `handleSpawn` machinery,
  launch-file materialization, instrumentation env). `adopt` → the existing reattach path
  (`handleReattach` + binding-store rebind). `hibernate/stop/kill` → the existing teardown
  paths the server already triggers (the daemon side of the survival table).
- `binding` → project from `binding-store.ts` state. `snapshot()` → the bootstrap-snapshot
  fold the observers already produce on reattach (one snapshot, per reattachment-design).
- `export()` → wrap `handoff-package.ts` — note `transcriptForExport` is module-private
  (~:326): export it or go through the exported handoff-handler surface. `health()` → per-session memory attribution that
  `memory-breakdown.ts` already computes.

### 3. send() with honest receipts — the heart of this item, and its true cost (reviewed)
**Reality check first:** the injection mechanics are SERVER-side, not daemon-side.
`apps/server/src/modules/sessions/inbox.ts` owns all of it — `typeText` paste-bracket + 90ms
CR (`SUBMIT_CR_DELAY_MS`), `scheduleSubmitVerify` echo retries, the `READY_FLOOR/QUIET/MAX`
tick loop, the DB-backed durable queue, ESC interrupt, raw-first-turn, and the
AskUserQuestion digit script. The daemon only writes base64 `input` frames
(`control/session.ts:792`). So this step is an **extract-and-port, not a wrap** — the plan
says so openly, and it is the largest chunk of the item:
- **Extract the injection/receipt state machine** into
  `packages/agent-runtime/src/drivers/terminal/injection.ts` as a pure state machine over
  ports (`write(bytes)`, `transcriptUserTurns()`, `hookAccept(signal)`, clock) — constants
  moved **verbatim** from `inbox.ts` (no re-tuning). The daemon driver composes it with real
  ports. **The server's `inbox.ts` copy remains authoritative for the flag-off path until W4
  retires it** — duplication for one phase is deliberate and ends in W4.
- **Split of delivery modes across the wire:** `queue` is completed SERVER-side — the
  durable FIFO is a server DB table (`deps.queue` / `SessionInbox.drain`), so the server's
  runtime pass-through answers `queued(position)` from it directly and never forwards.
  `when-ready` / `interrupt` forward to the daemon driver, which runs the extracted state
  machine and returns the receipt.
- **Accept proof, in priority order:** (a) hook-anchored — Claude's `UserPromptSubmit` with
  `claudePromptHookFingerprint` (exported at
  `packages/harness/src/agent-state/claude-code.ts:929`); keep the harness import
  DAEMON-side and inject the fingerprint fn into the package state machine as a port (the
  boundary manifest restricts harness consumers — do NOT widen it for this); (b) transcript
  echo (the ported submit-verify) ⇒ `accepted`; (c) window closes ⇒ **`unverified`** —
  never converted to `refused`, never extra retries.
- `refused` cases are exactly today's two: session-not-running, and `needs_user` without
  post-ESC (inbox.ts ~713–716). There is no lease-based refusal today — do not invent one.
- delivery `steer` ⇒ `queue` + `deliveredAs: 'queue'`.
- `interrupt()` ⇒ ESC; the fence arrives (or doesn't) as the provider-confirmed terminal
  event through the observers. Receipt = "requested".
- `answer()` for menu asks stays THIN in W3: delegate to the existing server-side digit path;
  the full port of the ask-menu drive belongs to W2 integration, not here.

### 4. events(), state(), transcript, draft, attach
- `events()` — adapt what `session-observers.ts` already emits (normalized
  `AgentStateEvent`s, transcript tail items, binding transitions, exit) into `RuntimeEvent`s.
  The causal envelope fields come from the observation checkpoint material that already
  exists (observer generation, turn epoch, provider cursor — see
  `packages/protocol/src/messages/runtime-state.ts` and the acceptance gating in the server's
  sessions module). Provenance: the bootstrap snapshot maps to `bootstrap`, live tail to
  `live` — do not invent values.
- `state()` — project the existing reducer output (`AgentRuntimeState`) + observed
  model/effort/context%/color from the transcript runtime reader.
- `transcript.history(range)` — wrap the cursor-anchored slice reads
  (`apps/daemon/src/control/transcripts.ts`).
- `draft` — wrap composer-sync's scrape (read) and the daemon draft doc publish; `set()` is
  `Declared` unsupported for now (injection is a later phase — declare, don't build).
- `attach()` — engine endpoint returning the existing frames path reference (no new
  transport; the endpoint is a typed description of what already happens).
- `interactions()`/`answer()` — thin: surface the `needs_user` asks the state channel
  already carries as PendingInteractions (hook-sourced where hook data exists,
  classifier-sourced otherwise), answer by delegating to the existing digit/menu path. If
  POD-2020 has landed its aggregate by the time you get here, emit into it; if not, keep the
  driver-local list conformant and note the wiring as a follow-up subissue of POD-1761.

### 5. Wire exposure
New daemon frames named in the existing FLAT camelCase convention (`runtimeSend`,
`runtimeAnswer`, `runtimeInterrupt`, `runtimeEvents` — both registries are compile-total
over flat type strings; dotted names fight the mapped types). Complete touch-point list so
you don't discover it by compile error: `packages/protocol` message defs +
`messages/message-class.ts` classification + `DAEMON_PLANE_CLASS` +
`DAEMON_FRAME_PORTS` (server `gateway/daemon-frame-routing.ts`) + `CONTROL_HANDLERS`
(daemon `control/registry.ts`). Also: `apps/daemon/package.json` must declare
`@podium/agent-runtime` (`declared-deps` lint), and the per-spawn flag rides `SpawnControl`
in protocol — the SERVER builds that frame, so add the field + pass-through there too.
W3 ships the daemon side + the minimal server pass-through (incl. the server-side `queued`
completion from step 3); W4 migrates the real callers.

### 6. Conformance + gates
- Run `runConformance(makeTerminalDriver, { exemptions: TERMINAL_PERMITTED_FAILURES })`
  (factory signature per POD-2019; define `TERMINAL_PERMITTED_FAILURES` in
  `drivers/terminal/` — it doesn't exist yet, this item creates it). **Which lane proves
  which receipt:** the e2e harness (`tests/e2e/serve-harness.ts`) runs a keyecho jig, not
  real Claude — no hooks fire there. So: hook-anchored `accepted` is proven at the
  fixture level (the harness agent-state fixture corpus feeding the injected hook port);
  the flag-on e2e lane proves echo-based `accepted` and `unverified`.
- Flag OFF: the full existing daemon/server suites pass unmodified — run the daemon and
  sessions/messages suites to prove it.
- Flag ON: an e2e Claude session spawn→send(receipt)→state→transcript→hibernate→resume
  through the contract.

## Out of scope
Server-caller migration (W4). Interactions aggregate design (W2). Any new attach transport.
Draft injection. Any timing-constant changes. Any opencode/codex work.

## Acceptance checklist
- [ ] Flag off ⇒ `bun scripts/typecheck.ts` + existing daemon/sessions/messages suites green, unmodified.
- [ ] Flag on ⇒ conformance green with only the declared terminal exemptions.
- [ ] Receipts: hook-anchored accept demonstrated on Claude fixture; `unverified` produced when
      echo is withheld; steer reports `deliveredAs: 'queue'`.
- [ ] `adopt()` after a daemon restart reproduces exactly one bootstrap snapshot and zero
      retroactive live events (the reattachment-design core assertion).

## Pitfalls
- The single biggest failure mode is *rewriting instead of wrapping*. If a step feels like it
  needs new mechanics, stop and re-read the existing code — it exists (this stack is 19k
  lines of survived edge cases).
- Don't stamp `at` with observation time — event time only (the codebase is strict on this).
- `unverified` is a feature, not an error: no retry loops beyond today's bounded ones.
- Respect reattach concurrency gates (`reattach-gates.ts`) — adoption storms are real.

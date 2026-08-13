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
- `export()` → wrap `handoff-package.ts` (`transcriptForExport` + workspace pieces as the
  existing handoff export does). `health()` → per-session memory attribution that
  `memory-breakdown.ts` already computes.

### 3. send() with honest receipts — the heart of this item
Wrap the existing injection mechanics (currently server-side `inbox.ts` `typeText` drives
via frames; the daemon executes the PTY writes). For W3, implement the receipt logic
daemon-side behind a new frame family (see step 5) so W4 can migrate server callers onto it:
- delivery `when-ready` / `queue` / `interrupt`: reuse the exact timing/queue mechanics that
  exist (paste-bracket + CR, ready-floor/quiet windows, ESC for interrupt-delivery). Do not
  re-tune any constant.
- **Accept proof, in priority order:** (a) hook-anchored — for Claude, a `UserPromptSubmit`
  hook arriving after injection with a prompt fingerprint correlating to the sent text
  (`claudePromptHookFingerprint` exists in `packages/harness/src/agent-state/claude-code.ts`
  — reuse it) ⇒ `accepted` with the new turnEpoch; (b) `submitVerification`-style transcript
  echo (the user-turn-count/echo check `inbox.ts` does today) ⇒ `accepted`; (c) window
  closes with neither ⇒ **`unverified`** — return it; never re-send `\r` beyond the existing
  bounded retries, and never convert timeout into `refused`.
- `refused` only for the cases the code already refuses (needs_user without post-ESC, lease
  held). `queued` returns durable position from the existing queue.
- delivery `steer` ⇒ perform `queue` and set `deliveredAs: 'queue'` on the receipt.
- `interrupt()` ⇒ ESC via existing path; the FENCE is not emitted by you — it arrives (or
  doesn't) as the provider-confirmed terminal event through the observers. Receipt =
  "requested".

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
New daemon frame family `runtime.*` (send/answer/interrupt/state/events-subscribe …)
following the existing frame-handler registry conventions, routed like other families in the
server's `gateway/daemon-frame-routing.ts`. W3 only needs the daemon side + the minimal
server-side pass-through used by tests; W4 migrates the real callers.

### 6. Conformance + gates
- Run `runConformance(terminalDriver, { exemptions: TERMINAL_PERMITTED_FAILURES })` in the
  e2e harness (`tests/e2e/serve-harness.ts` and the harness fixtures) against a real Claude
  session where CI allows; where it doesn't, against the recorded fixture corpus the
  agent-state tests already use.
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

# Agent Runtime implementation plan (POD-1761 epic)

Spec: `docs/2026-08-07-agent-runtime-architecture.html` (rev 9, review-hardened — in this branch).
Read the spec **before** starting any work item; each item below names the spec sections it implements.

## Goal and non-goals

**End goal of this epic:** an opencode **server-family driver** (`opencode serve` + HTTP/SSE client)
that can be switched in per-session behind a flag, running against a new **primitive surface**
(`packages/agent-runtime`) that the existing PTY/terminal stack has already been wrapped behind —
so switching a session from terminal driving to server driving changes a driver id, not a feature.

**Minimum landed outcome:** the new surface + the terminal wrap (nothing user-visible changes,
or improves) + one working server driver (opencode).

**Stretch (in priority order, only after the minimum lands):** Codex app-server driver;
Grok headless feasibility investigation.

**Explicit non-goals for this epic:**
- **No telemetry/measurement work.** The spec's telemetry gate and memory instrumentation are
  deferred by the operator's decision. Do not build metrics, do not block on their absence.
- **No merge to `main`.** Everything lands on the epic integration branch
  `issue/1761-agent-runtime` only. The operator tests from that branch before anything
  goes further.
- No embedded (Claude SDK) driver rework, no attach v2 (client-terminal spawning), no cloud,
  no tui-handover, no interaction *suppression* policy engine beyond what phase items say.
- No UI redesign. Client changes are limited to what the flag-switched opencode session needs
  to be usable (chat send/receive, state badge, interactions answering via existing surfaces).

## Decisions already made (do not relitigate)

- **opencode is the first server driver** (pilot: simplest protocol — OpenAPI 3.1 + SSE — and it
  is the intended host for background executors on non-Claude/Codex models). Codex is second.
- Driver families are named `server` / `embedded` / `terminal` (spec §2).
- `send` has four outcomes: accepted / queued / refused / **unverified** (terminal only); terminal
  receipts are hook-anchored where hooks exist (spec §3 Turns).
- `interrupt()` *requests* a fence; fences only on provider confirmation.
- The surface is tiered **core** vs **extended** (spec §3); this epic implements the core plus
  the extended pieces the terminal wrap already has for free.
- Process-per-session, dedicated servers only; opencode loopback ports REQUIRE a per-session
  random secret; Codex will use per-session unix sockets 0600 (spec §6 security bullet).
- The conformance suite names what the terminal family may fail (unverified sends,
  at-least-once classifier interactions).

## Integration workflow (every agent on this epic)

- Branch from `issue/1761-agent-runtime` (your subissue's worktree is created off it by
  `podium issue start`). Never touch `main`.
- Land by merging **ff-only into `issue/1761-agent-runtime`**: prefer
  `podium issue action <your-id> merge`; manual path = `podium merge-lock acquire --wait`,
  rebase onto the integration branch, ff-only merge, `podium merge-lock release` immediately.
- Commits on the integration branch carry a `Podium-Issue: POD-<your id>` trailer.
- Gates before merging: `bun scripts/typecheck.ts` and the test suites your change touches
  (`bun scripts/test.ts --filter …`). Do not re-run the world.
- **There is no human in your loop.** Never use AskUserQuestion, never post an offer expecting
  a human, never wait for confirmation. Make the call, record it in a `podium issue comment`,
  proceed. If genuinely blocked by another subissue's missing work, mail the coordinator
  (`podium issue mail send 1761 --body "…"`), set your issue blocked via dep-add, and stop cleanly.
- Discovered follow-up work: **subissues of POD-1761 only** (`podium issue create
  --parent-id 1761 …`). Never top-level issues. The coordinator triages them.
- Keep your issue's stage current (`in_progress` while working, `review` when your merge is in,
  then `close` after the reviewer pass — see review loop below).

## Work items (= subissues), scope and acceptance

Sized so one agent can hold each in its head: one architectural concern per item, with the
context that concern needs and no more.

### W1 — Agent-runtime contract package  *(spec §3 all, §2 families)*

**Scope.** New `packages/agent-runtime`: the complete typed surface as **types + zod schemas +
in-memory reference machinery**, no real driver yet.
- `src/contract.ts`: `RuntimeDriver`, `AgentSessionHandle`, `DriverFamily`, `SessionSpec`
  (incl. instruction channel, mcpServers, model policy), `TurnInput`/`TurnReceipt` (four
  outcomes incl. `unverified`, `deliveredAs` downgrade reporting), `RuntimeEvent` union
  (turn/item/state/interaction/process/workspace/open-url) with the causal envelope fields
  (`at`, `provenance`, `cursor`, `observerGeneration`, `turnEpoch`), `PendingInteraction`
  (kinds incl. `recovery`; `source`; `answerable`), `AttachEndpoint` (engine/client + reserved
  variants), `SessionBinding`, `SessionSnapshot`, `SessionArchive`, `DriverCapabilities` using
  the existing `Declared<T>` pattern from `@podium/harness`, failure vocabulary
  (refusals, `TurnFailed` reasons, process events), core-vs-extended tier annotation.
- Wire schemas: new `runtime` message family in `packages/protocol` under the versioned
  envelope (mirror how existing families are organized).
- `AgentManifest` gains the `runtime` axis (`server?`/`embedded?`/`terminal` +
  `select(ctx)`) in `packages/harness/src/manifest.ts` — declarations only; all five manifests
  get `terminal` (existing behavior) and opencode/codex get `server` specs (launch argv +
  transport shape only, no client).
- **Conformance suite skeleton** in `packages/agent-runtime/test/conformance/`: a
  driver-parameterized corpus (send outcomes, interaction lifecycle, interrupt fence request,
  snapshot→adopt round-trip, causality under restart, connect-without-secret refusal stub)
  plus the per-family permitted-failures table from the spec. Runs green against a bundled
  `FakeDriver`.
- Boundary manifest: amend `scripts/check-boundaries.ts`/architecture manifest deliberately so
  `agent-runtime` may import `@podium/harness` + `@podium/pty` and is importable by the daemon
  (a metadata-only entrypoint for the server, following the `@podium/harness/metadata` pattern).

**Acceptance.** Typecheck green; conformance suite green on FakeDriver; boundary lint green with
the amendment recorded in the manifest, not an allowlist hack. No behavior change anywhere.

### W2 — PendingInteraction server backbone  *(spec §4)*

**Scope.** Server-side interactions aggregate, fed by what exists today.
- New vertical slice `apps/server/src/modules/interactions/` (router/service/repo/events, the
  house module shape): durable PendingInteraction rows, asked/answered/expired lifecycle,
  `answer` verb (idempotent, typed already-answered/expired errors), escalation deadline field
  (no policy engine yet — a per-session default answer table is enough: e.g. recovery →
  full-resume per spec §4).
- **This item designs the per-kind payload/answer schemas** (the spec's named phase-1
  deliverable): permission (tool, input summary, always-allow offered), question (options,
  multi-select, other-index, preview layout), plan-approval, elicitation, login, recovery.
  Normalize from the two sources available today: Claude hook channel
  (`PermissionRequest`, Stop-with-question verdicts — see
  `packages/harness/src/agent-state/claude-code.ts`) and the screen-classifier verdicts.
  Mark `source`, treat classifier-sourced as at-least-once (dedupe by fingerprint,
  best-effort).
- Answering routes through the existing mechanisms (`answerAskUserQuestion` digit path,
  `apps/server/src/modules/superagent/answer-delivery.ts`) — wrap, don't rewrite.
- Wire: durable-synced through the funnel so web/mobile/CLI see them; a minimal
  `podium interactions list|answer` CLI subcommand for headless answering.

**Acceptance.** A Claude session hitting a permission prompt or AskUserQuestion produces a
durable PendingInteraction visible via CLI; answering it via the CLI drives the native menu;
answering twice returns the typed error; unit + characterization tests. Existing UI behavior
unchanged (the old paths still work; the aggregate observes).

### W3 — Terminal driver behind the contract  *(spec §3, §9 phase 2 — daemon half)*

**Scope.** Implement `drivers/terminal` in `packages/agent-runtime` as an **adapter over
today's daemon stack** — wrap, do not rewrite:
- `create/resume/adopt` delegate to the existing spawn/reattach paths
  (`apps/daemon/src/control/session.ts`, `session-observers.ts`, binding-store).
- `send()` wraps the `typeText`/`queueText`/`sendTextWhenReady` mechanics and produces honest
  receipts: hook-anchored accept on Claude (`UserPromptSubmit` → accepted), submit-verification
  otherwise, `unverified` when the window closes without proof. `deliveredAs` reports
  steer→queue downgrades. `interrupt()` = ESC + fence-on-provider-confirmation only.
- `events()` adapts the existing observer/reducer output (`AgentStateEvent`, transcript tail
  items, hook ingest) into `RuntimeEvent`s with the causal envelope — reuse the
  reattachment-design checkpoint material as the cursor.
- `state()`, `transcript.history` (wrap the transcript slice reads), `snapshot()`, `export()`
  (wrap `handoff-package.ts`), `hibernate/stop/kill` (wrap the survival-table paths),
  `attach()` (engine endpoint = today's frames path), `draft` (wrap composer-sync read +
  daemon draft doc).
- Daemon session control gains a **flag-gated parallel path**: sessions with
  `PODIUM_RUNTIME_CONTRACT=1` (or a settings flag) are driven through the driver; default
  stays the legacy path. Both paths share the same underlying machinery, so behavior is
  identical by construction where the flag is off.
- Wire the driver into the conformance suite; record which properties the terminal family
  declines per the spec's permitted-failures list.

**Acceptance.** Conformance suite green (with the declared terminal exemptions) against a real
Claude session in the e2e harness; flag off = zero diff in existing test suites; flag on = a
Claude session drives end-to-end (spawn, send with receipts, state, transcript, hibernate,
resume) through the contract.

### W4 — Write-path receipt migration  *(spec §9 phase 2 — server half)*

**Scope.** Migrate the server-side send callers to contract receipts, caller by caller,
behind the same flag. The ~29 call sites cluster into: `modules/messages` (service, scheduler,
handlers), `steward.ts`, `modules/superagent/tools.ts` + `service.ts` send paths,
`modules/automations/service.ts`, `session-revival`/`lifecycle`/`inbox`. For each cluster:
flip from ready-poll heuristics to receipt semantics, re-baseline its characterization tests,
keep the legacy path compiling until the flag flips. `unverified` handling policy: mail/steward
treat it as "delivered, unconfirmed" (surface in the ledger, no blind retry); chat surfaces it
as today's optimistic bubble with reconcile-on-echo.

**Acceptance.** With the flag on, the messages/steward/superagent characterization suites pass
re-baselined; with the flag off, unchanged suites pass unmodified. No caller consults
`agentState.phase` for delivery decisions anymore when flagged — receipts only.

### W5 — opencode server driver  *(spec §2, §3, §6; §9 phase 3 — THE GOAL)*

**Scope.** `drivers/opencode-server` in `packages/agent-runtime`:
- Process: spawn `opencode serve` per session under the existing systemd-scope machinery
  (reuse `packages/pty`'s `systemd-run --user --scope` path for a non-PTY child), loopback
  port with **mandatory per-session random secret** via opencode's server-password env,
  secret in spawn env never argv, state in the instance dir. Connect-without-secret must be
  refused (conformance test).
- Client: typed OpenAPI client (generate or hand-write the ~10 endpoints needed: create
  session, send message/prompt_async, abort, messages, permissions reply, SSE `/event`) +
  SSE consumer → `RuntimeEvent`s. Cursor = session id + event offset.
- Mapping: turns → receipts (protocol ack = accepted); `permission.updated`-family +
  question events → PendingInteractions (W2 aggregate) answered via the REST reply
  (`once`/`always`/`reject`); items → `TranscriptItem` (reuse
  `packages/transcript/src/opencode.ts` mappers where they fit); state → the normalized
  `AgentStateEvent` vocabulary + shared reducer; interrupt → abort; resume → server restart
  + `--session <id>`; export = the opencode sqlite rows for the session (bound scope:
  document if full fidelity needs more).
- Selection: manifest `select()` + a per-spawn override so the operator can start an opencode
  session on the server driver explicitly (settings flag or spawn option) while default stays
  terminal.
- Version pin: record the opencode version range the driver speaks; refuse outside it with a
  machine diagnostic (the codex-hooks gate pattern); add recorded-fixture tests for the
  protocol shapes used.

**Acceptance.** Conformance suite green with no terminal-family exemptions (server family
must not need them). An opencode session spawned with the server driver: chat send/receive
works from the web UI, state badge tracks working/idle, a permission ask surfaces as a
PendingInteraction and is answerable from CLI/UI, interrupt works, hibernate/resume works
(kill server process, keep session id, restart + resume), all on the integration branch.

### W6 — Codex app-server driver  *(stretch; spec §3 churn section)*

Same shape as W5 on `codex app-server`: JSON-RPC over a per-session unix socket (0600),
initialize handshake with `optOutNotificationMethods` for watch levels, `turn/start`/
`turn/steer`/`turn/interrupt`, server→client approval requests → PendingInteractions,
thread resume/fork, version pinned with fixtures. Prereq reading: the W5 driver. ChatGPT
subscription auth rides `~/.codex/auth.json` untouched.

### W7 — Grok headless feasibility  *(stretch; investigation, timeboxed)*

Investigate whether grok's CLI offers any server/persistent-headless mode beyond
`--single`-style one-shots (check its docs/`--help`/release notes). Deliverable is a short
markdown report in `docs/agents/` + a recommendation (server driver possible / resume-exec
embedded-style driver / stays terminal-only), NOT an implementation. Timebox: one session.

## Dependency graph

```
W1 (contract package) ──┬─→ W2 (interactions backbone) ─┐
                        ├─→ W3 (terminal driver) ───────┼─→ W5 (opencode driver) ─→ W6 (codex, stretch)
                        │        └─→ W4 (receipt migration)
W7 (grok feasibility) — independent, any time
```

W4 is NOT a prerequisite for W5 (the opencode driver produces receipts whether or not the
legacy callers consume them), so W5 starts when W2 + W3 land.

## Review loop

Every W-item that lands code gets an independent review pass ordered by the coordinator
(separate reviewer agent on the same subissue). The reviewer verifies against the spec
sections named above + this plan's acceptance criteria; findings go back to the implementing
agent as subissue comments/mail; the implementer fixes; then the subissue closes.

## What "done" means for the epic

`issue/1761-agent-runtime` contains: the contract package with a green conformance suite,
the terminal driver wrap flag-gated with zero default-path regressions, the interactions
backbone, receipt-migrated write paths behind the flag, and an opencode session running on
the server driver end-to-end — ready for the operator to test the branch. Nothing merged
to main.

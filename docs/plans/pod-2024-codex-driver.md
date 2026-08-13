# POD-2024 — Codex app-server driver (W6, stretch)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§3 incl. the protocol-churn section, §5 watch levels, §6 security). Prereqs: POD-2021 and
> POD-2023 landed. **Read the opencode driver (POD-2023's code) first and mirror its
> structure file-for-file where it fits** — divergence needs a reason, stated in a comment.

## Objective

The second server-family driver: Codex over `codex app-server` — JSON-RPC 2.0, per-session
**unix socket (0600)**, ChatGPT subscription auth riding `~/.codex/auth.json` untouched.
Same contract, same conformance suite, zero exemptions. The subscription-carrying payoff of
the whole architecture.

## Ground truth first (hour one)

`codex --version`; `codex app-server --help`. Establish the listen story on the pinned
version: the epic's research verified stdio (default), WebSocket (`--listen ws://…`,
experimental with `--ws-auth`), and unix-socket transports — confirm which this version
offers and prefer **unix socket in the instance state dir**; if only stdio exists on the
pinned version, stdio-as-child is acceptable for v1 (the socket is then moot — note it and
move on; a child's stdio is private by construction). Capture the handshake and every
method/notification you use as recorded fixtures immediately. Protocol names the epic
verified (re-verify against the binary — Codex has renamed approval methods before):
`initialize`/`initialized` (with `optOutNotificationMethods`), `thread/start|resume|fork`,
`turn/start`, `turn/steer`, `turn/interrupt`, notifications `thread/started`,
`turn/started|completed`, `item/started|completed`, `item/agentMessage/delta`, and
server→client requests `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval` (+ MCP elicitation). Repo grounding to read:
`docs/agent-harness-reference/codex.md`, `packages/harness/src/manifests/codex.ts`
(incl. `codexMcpArgs`), `apps/daemon/src/codex-hooks.ts` (the version-gate house pattern —
extend/reuse its range logic), the codex agent-state/observer files.

## Implementation order

1. **Process management** (`apps/daemon/src/runtime/codex-server.ts`): one `codex
   app-server` per session under a systemd scope (reuse whatever POD-2023 extracted for
   scope-wrapping non-PTY children); transport per ground-truth (unix socket 0600 in the
   instance state dir, or child-stdio); binding journal (socket/pid/scope/thread id) for
   `adopt()`; version gate with machine diagnostic.
2. **JSON-RPC client** (`packages/agent-runtime/src/drivers/codex/`): minimal bidirectional
   JSON-RPC over the transport — requests out, notifications in, **and server→client
   requests in** (the approval inversion). Strict handshake ordering. `optOut` the delta
   notifications by default; enable on `watch('fine')` (spec §5's watch-level knob, natively).
3. **Mapping** (`map.ts`): approvals → PendingInteractions (structured; answer = the JSON-RPC
   response `accept`/`decline`, optionally with amended policy → map from the W2 answer
   shapes); `turn/started` ack ⇒ `accepted` receipts; `turn/steer` ⇒ native steer
   (`deliveredAs: 'steer'` — the first driver where it's real); `turn/interrupt` ⇒ fence on
   the confirming event; items/deltas → `item` events (reuse `packages/transcript` codex
   mappers for shapes); `token_count`/`turn_context` → observed runtime facts; thread id =
   resume ref (`codex-thread` kind, consistent with the existing manifest `resumeKind`).
4. **Driver assembly + selection**: registry registration; `manifests/codex.ts`
   `runtime.server` fleshed out; same explicit per-spawn opt-in as opencode; default stays
   terminal (the terminal driver is Codex's permanent fallback — spec churn section).
5. **Auth**: none to build — the app-server child inherits `~/.codex/auth.json`. Do not
   touch, rotate, or copy tokens (`codex-auth.ts`'s read-only discipline applies). Verify a
   subscription-authed turn works headless; that demonstration is part of acceptance.
6. **Conformance + e2e**: zero exemptions; fixtures for every protocol shape; e2e mirror of
   POD-2023's flow (send/state/approval-answer/interrupt/steer/hibernate-resume) plus one
   steer demonstration. Default-path Codex sessions byte-identical.

## Out of scope
Attach via `codex --remote` (attach v2). Cloud. Superagent migration. Any change to the
Codex terminal path (it is the permanent fallback). WebSocket listen mode (unix/stdio only).

## Acceptance checklist
- [ ] Conformance green, zero exemptions; fixtures recorded for all used methods.
- [ ] Subscription-authed headless turn demonstrated end-to-end from the web UI.
- [ ] Approval round-trip: server→client request → PendingInteraction → answer → turn
      continues (fixture-tested + e2e).
- [ ] Native steer demonstrated (`deliveredAs: 'steer'`).
- [ ] Daemon-restart adopt works; version gate refuses out-of-range codex (unit-tested).

## Pitfalls
- Method names have churned (approval methods were renamed once already) — trust the binary
  + your fixtures, not docs or this plan's list. If names differ, update fixtures and note
  the pinned mapping in the driver.
- The server→client request direction is the novel machinery here; get its timeout/
  cancellation story right (a parked approval must surface as a PendingInteraction with an
  escalation deadline, never a hung RPC).
- Handshake strictness: everything before `initialized` errors — sequence your client.
- Don't let `optOutNotificationMethods` hide events the coarse observation plane needs
  (turn/item-completed must always flow; only deltas are watch-gated).

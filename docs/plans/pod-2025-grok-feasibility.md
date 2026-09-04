# POD-2025 — Grok headless feasibility (W7)

> FIRST ACTION in your worktree: `git merge --ff-only issue/1761-agent-runtime` (your branch
> was created off main and lacks the epic docs). Epic plan:
> `docs/plans/pod-1761-agent-runtime-plan.md`. Spec: `docs/2026-08-07-agent-runtime-architecture.html`
> (§2 driver families is the frame for your recommendation).

## Objective

A decision, not code: can grok run as a **server-family** driver (persistent headless server
we speak a protocol to), an **embedded/resume-exec-style** driver, or does it stay
**terminal-only**? Deliverable is one markdown report + a recommendation the coordinator can
turn into a follow-up work item (or not). TIMEBOX: one session. No implementation.

## Key fact up front (coordinator review finding)

The repo's own reference **already documents grok server modes**: `docs/agent-harness-reference/grok.md`
§2 records — marked *(established)* — `grok agent stdio` (**ACP** JSON-RPC over stdio),
`grok agent serve --bind 127.0.0.1:2419 --secret <tok>` (WebSocket server that can outlive a
client), and `grok agent headless` (xAI WS relay); §7/§11 note `updates.jsonl` is the same ACP
`session/update` stream a server client receives live. So your job is **verification, not
discovery**: do these modes meet the contract's needs — and should the spec's §2 row
"Grok, Cursor: terminal only" be overturned?

## Investigation checklist

1. **What Podium already knows.** Read `docs/agent-harness-reference/grok.md` in full (esp.
   §2 agent modes, §7 `events.jsonl`/`updates.jsonl` authority ranking, §8 hooks, §12 output
   formats), `packages/harness/src/manifests/grok.ts` (`headless`/`exec` declarations),
   `apps/daemon/src/headless-drivers.ts` (`resume-exec` path) + `headless-drivers.test.ts`,
   `apps/daemon/src/grok-hooks.ts` + test, `packages/harness/src/agent-state/grok*.ts` + tests.
2. **Verify the ACP server modes against spec §3's core contract.** Probe `grok agent stdio`
   and `grok agent serve` on this machine: can they (a) resume an existing session by id,
   (b) surface permission asks as structured requests (ACP `session/request_permission`?) and
   accept structured answers, (c) interrupt an in-flight turn, (d) deliver cursor-fenced
   updates (`session/update` stream vs `updates.jsonl` offsets)? Record actual JSON-RPC
   traffic for anything you demonstrate.
3. **ACP by name.** Web-sweep the Agent Client Protocol spec (agentclientprotocol.com) and
   grok CLI release notes; map ACP's session/permission/update vocabulary onto our contract
   (spec §3). An ACP driver would generalize beyond grok — say so if the evidence supports it.
4. **Fallback: multi-turn headless without a server.** Assess today's `resume-exec` pattern
   against the contract: receipts — note grok.md §12's `--output-format json|streaming-json`
   with explicit `stopReason` (NOT just exit codes); interactions — `events.jsonl` carries
   `permission_requested`/`permission_resolved`/`turn_ended{outcome}` as the highest-authority
   stream (grok.md §7); interrupt (child kill semantics); cursoring across one-shots.
5. **Cost/benefit + spec verdict.** Which family (server-via-ACP / resume-exec-style /
   terminal-only), and explicitly: does spec §2's "Grok: terminal only" row stand or fall?
   If it falls, that is a spec amendment the coordinator must make — flag it as such.

## Deliverable

`docs/agents/pod-2025-grok-headless.md` containing: findings per checklist item (with
evidence — commands, captured JSON-RPC, URLs), a one-paragraph recommendation
(`server driver via ACP` / `resume-exec embedded-style driver` / `stays terminal-only`), an
explicit verdict on spec §2's "Grok: terminal only" row (stands / must be amended), and — if
you recommend building anything — a half-page scope sketch the coordinator can lift into a
work item.
Merge it to the integration branch per the epic's landing procedure (epic plan,
"Integration workflow"). Then set your stage to review and mail the coordinator
(`podium issue mail send 1761`) with the recommendation in one sentence.

## Out of scope
Any code. Any manifest changes. Anything about codex/opencode. If you find grok bugs or
Podium bugs on the way, file them as subissues of POD-1761 — never top-level.

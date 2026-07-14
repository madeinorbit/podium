# Handoff — Automations phase 2 (#470)

You are picking up work on the Automations tab. Phase 1 (a real cron scheduler) is
**already merged to main**. This document is the full context for phase 2; it exists so
you do not have to re-derive any of it. Two expensive codebase investigations are
summarized below — trust them, but verify line numbers, since main moves fast.

## What is already merged (phase 1, do not redo)

Commits `a15b89f`, `db3653c`, `84cc509` on main. Spec:
`docs/internal/superpowers/specs/2026-07-14-automations-cron-design.md`. Human decisions:
`podium spec show SP-17db`.

- `automations` + `automation_runs` tables (migration `20260714142927-automations.ts`).
- `AutomationsService` (`apps/server/src/modules/automations/service.ts`) with CRUD + a
  `tick()`; the pure decision policy is in `decide.ts`; a hand-rolled 5-field cron parser
  with a 5-minute rate floor is in `cron.ts`; `scheduler.ts` is the tick service, wired in
  `relay.ts`.
- A fired automation spawns a session via `SessionsService.createSession` and delivers the
  prompt via `queueText` (NEVER `initialPrompt` — it is argv-only and silently dropped on
  opencode/cursor).
- The steward's `deliverNotify` now calls the real ntfy/Telegram notifier, and
  `settings.steward.enabled` defaults to true.
- UI: `apps/web/src/features/automations/` — `AutomationsView` (shell), `TriggersSection`
  (event subscriptions, real), `ScheduledSection` (real cron cards), `NewAutomationDialog`,
  `cron-format.ts`.

## Your worktree

Branch `feat/automations-editing`, worktree `.worktrees/automations-editing`, already
created off main with `bun install` run. **Work only there.** The main checkout is the
LIVE running server — editing it breaks the user's setup. Use absolute paths under the
worktree.

## The four tasks

### 1. Scheduled automations are not editable

Pure UI gap. The server ALREADY has a complete `automations.update` mutation
(`service.ts:116`) that correctly re-arms `next_run_at` when the cron or enabled flag
changes. `ScheduledSection.tsx`'s `AutomationCard` only exposes a toggle and a delete —
no edit affordance. Add one: an edit action that opens the composer pre-filled and calls
`update`. `NewAutomationDialog` needs an edit mode (it is currently create-only).

### 2. BUG — `automation_runs.session_id` is null on the error path

`service.ts:227-244`. `spawn()` calls `createSession` (which succeeds, producing a real
session), then `queueText`. If the prompt is rejected, `spawn` **throws** (line 240-242).
The catch in `apply()` (line 187-193) sets `outcome: 'error'` but leaves `sessionId = null`
— so the id of the session that WAS spawned survives only inside the `detail` string.

Fix it: carry the session id out of the failure so the `session_id` column is populated on
the error path. The run row should point at the orphan session it created. (The migration's
CHECK does not constrain this; `session_id` is a plain nullable TEXT.)

### 3. Live updates — promote automations to a DURABLE ENTITY

**This is the user's explicit decision.** Read the analysis below before you start.

**The finding:** Podium has exactly one real-time rail. An entity reaches clients live by
being modeled as a **durable ledger entity**: written through the write funnel
(`apps/server/src/modules/funnel.ts:50` — "every mutation flows authorize → repository
write → change append → broadcast, in that order and nowhere else"), registered in a
**closed, generated union** of message types
(`packages/protocol/src/messages/message-class.ts:8` — "Durable messages may ONLY be
produced by the write funnel"; `SERVER_MESSAGE_CLASS` at `:13-46`), given a
`COLLECTION_MESSAGE_ELEMENTS` entry (`packages/protocol/src/messages/codec.ts:46`), and
mirrored in a **client replica collection** (`packages/client-core/src/engine/engine.ts:402`
`this.replica.subscribeRows('issues', …)`). Issues, sessions, and conversations are live
*because of this*, with zero per-feature client code.

Automations has **none** of it. Its service says so outright (`service.ts:10-12`: "Cron is
a pure PRODUCER of sessions: it writes no events and needs no dispatcher changes"). It
writes raw SQL (`store/automations.ts:91,116,140,146` — no `ledger.commit`, no change
rows), has **no protocol wire type at all**, and the web view does a one-shot
`trpc.automations.list.query()` in a mount effect that only re-runs after the acting user's
own mutation. A scheduler tick, or an edit from another device, pushes nothing.

**What to build:** promote automations (definitions AND runs) to durable ledger entities so
they ride the same rails as issues:
- Protocol: add the wire type(s) to the `ServerMessage` union + `SERVER_MESSAGE_CLASS` +
  `COLLECTION_MESSAGE_ELEMENTS`.
- Server: route the store writes through `ledger.commit` / `reconcile` +
  `funnel.publishComputed`, the way `issues/service/core.ts:331,354,369-371` does. Study
  that file — it is the canonical exemplar.
- Client: add a replica collection and subscribe it, mirroring the issues path in
  `client-core/src/engine/engine.ts`.

Note the synergy with task 4: once each run produces a durable session (and an issue), the
run history is *partly* live for free via those existing entities. But the user chose the
full durable-entity treatment, so do the automations entities properly too.

### 4. Per-run sessions + a special issue type

The user wants: **each automation run gets its own session**, and the setup lets the user
choose between *resume the same session every run (if possible)* and *a fresh session every
run*. The spawned work should get a **special issue type**.

Facts you need (verified):

**Today** an automation passes NO `issueId` to `createSession` (`service.ts:228-235`), so
attachment happens only incidentally via `soleOwnerForCwd(cwd)`
(`sessions/service.ts:783`) — which is false for GLOBAL ($HOME) automations. So runs
currently produce **bare, issue-less sessions**. The `automations` table has **no session
identity column at all**; the only linkage is one `session_id` per fire in
`automation_runs`. `lastSpawnedSessions()` (`store/automations.ts:170-183`) computes the
last spawned session per automation via `MAX(rowid)`, used only for the overlap check.

**Resume IS possible, but it means re-spawn-with-a-ref, not a kept-alive PTY.** This is
the important constraint — do not promise the user something else:
- `resumeSession()` (`sessions/service.ts:835-891`) is keyed on a durable `ResumeRef`.
- `resurrectSession()` (`sessions/service.ts:1533-1579`) wakes a session under its SAME id
  using its stored resume ref, but **refuses a still-running session** (`:1541-1543`) and
  requires a resume ref (`:1547-1548`). It re-spawns the process (`--resume <ref>`).
- `resumeAndSend()` (`sessions/service.ts:1507-1530`) is the natural primitive for "wake
  the old session and give it a new turn": if live it sends text, if parked it resurrects
  then delivers.
- **The resume ref is not known at spawn time** — the harness reports it mid-session and it
  is persisted on the sessions row (`resumeKind`/`resumeValue`, `store/types.ts:35-36`).
  So "resume the same session" must read the ref off the previously-spawned session, and
  must handle the case where it never got one, or the session was deleted.

`AutomationsDeps` (`service.ts:26-48`) is narrowed to `createSession`/`queueText`/
`liveSessionIds` — you must **widen it** to reach a resume/re-drive method and to pass an
`issueId`.

**Issue types** (`packages/protocol/src/messages/issues.ts:19-30`): the enum is
`task, bug, feature, chore, epic, decision, spike, story, milestone`. Adding one requires
**both**: (a) the zod enum entry, and (b) **a new migration rebuilding the issues CHECK
constraint**. The CHECK was last built in `migrations/006-issues-fks-checks.ts:105` — a
fresh DB would pick up a new enum value (006 reads `IssueType.options` live), but an
**already-migrated DB's frozen CHECK will reject it**. Mirror the table-rebuild pattern in
006, or how 010 rebuilt the stage CHECK. The web filter dropdown and new-issue picker read
`IssueType.options` and adopt a new type automatically
(`IssuesView.tsx:726-733`, `NewIssueDialog.tsx:202`); types have no icons today, and only
`epic` is special-cased for its badge (`IssuesView.tsx:1121`).

## Rules that will bite you

- **Never edit or `cd` into `/home/mgw/src/other/podium`** (the live checkout). Use
  `git -C` for commands against other checkouts.
- **Migrations are now TIMESTAMP-versioned** (`YYYYMMDDHHMMSS`), as of #485 — `validate()`
  REJECTS a new sequential version above 23. Use `bun run migration:new`. During phase 1
  the migration number collided with main **three separate times**; main moves fast, so
  re-check right before merging.
- **Do NOT run the browser/Playwright e2e** — it races a fixed port with the user's live
  instance and has previously killed real agent sessions. Write the tests; ask the user
  before running them.
- `bun run lint` is **already red on main** (~290 pre-existing biome errors, tracked as
  #30). It cannot be used as a merge gate — your bar is "add no new errors".
- Two unit tests fail on main already and are NOT yours: `issue-authz.test.ts >
  classifies the structural/destructive commands as manage`, and
  `agent-bridge/.../claude-smoke.test.ts` (real-binary PTY smoke).
- `bun run test` chains with `&&`, so a vitest failure silently skips the bun half — run
  `bun run test:bun` separately.
- To merge: `podium merge-lock acquire --wait` → rebase onto main → `git merge --ff-only`
  → `podium merge-lock release` immediately.

## Known deferrals already recorded on #470

- Whether the 5-minute minimum interval is the right floor (open question for the user).

# POD-415 — the open-todos idle verdict, wired and quietened

Branch `issue/415-idle-verdict-for-open-todos`, 2 commits on `main`. Claude Code
only; Codex and Grok stay untouched per the narrowed scope (POD-433's Codex
investigation lands on POD-448).

## What was dead, and why nothing failed

`open_todos` has been a first-class `IdleVerdict` kind since 2026-06-12 — declared
in `packages/model`, carried in `packages/protocol`, and branched on by four
consumers. No producer ever reported it, so all four branches were unreachable.
Dead branches do not error, so nothing ever complained.

## What now reports it

`packages/harness/src/agent-state/claude-code.ts` — the label
`idle.needs_input.open_todo_list` already arrived from the classifier and was
flattened to `{ kind: 'done' }`. It now maps to `{ kind: 'open_todos' }`. Both
Claude terminal-verdict paths go through that one function (the Stop hook via
`classifyIdleTranscript`, and reattach via `bootEventsForClaudeRecords`), so the
verdict arrives on a fresh stop and on a reattach alike.

`packages/harness/src/agent-state/types.ts` still forbids the REDUCER from
inventing the kind; what changed is that a provider which actually observed the
list may now report it.

## The producer could not fire, and that was invisible

`openTodoCount` was computed from `TodoWrite` alone. **Current Claude Code has no
such tool.** Census over every Claude transcript on this host — 14 months,
~24k `tool_use` blocks:

| tool | calls |
|---|---|
| `TodoWrite` | **0** |
| `TaskCreate` | 47 |
| `TaskUpdate` | 65 |
| `TaskList` | 1 |

So the one-line wiring alone would have produced a verdict that never occurs.
`openTaskListCount()` in `packages/harness/src/manifests/claude-code-classifier.ts`
reconstructs the list from the current tools. Two things distinguish them from
`TodoWrite`:

- **The id lives in the RESULT, not the input.** `TaskCreate` takes
  `{subject, description}` and its result reads `Task #3 created successfully: …`.
  That numbering is authoritative; counting creates would only be a guess at it.
  The result is matched to its create by `tool_use_id`, because
  `Task #4 created successfully` is a string any tool output could contain.
- **The list is incremental, not a snapshot.** `TodoWrite` rewrote the whole list
  every call, so one snapshot from the current turn was complete. `TaskCreate` /
  `TaskUpdate` build state across turns, so the fold spans the window rather than
  the turn, and an update whose create is outside the window still registers its
  task. Open = `pending` | `in_progress`; `completed` closes an item, `deleted`
  removes it; an update carrying only an owner or subject leaves status alone.

### A precedence bug that was structurally unreachable

The open-todos branch sits ABOVE the required-action branch in
`classifyClaudeFeatures`. While `openTodoCount` was always 0 it could not steal
anything; the moment it started firing, a turn that left a todo open AND asked the
human to do something would have gone quiet. Now guarded by `requiredUserAction`
as well as `terminalQuestion` — a quiet verdict must never swallow a real ask.
Pinned by a test.

## The demotion — what "quiet" means, surface by surface

The kind arrived carrying an ATTENTION tone. An agent stopping with an item left
on its own list is ordinary; unchanged, a fleet would have filed every session
into NEEDS YOU and rung a sound.

| Surface | Before | Now |
|---|---|---|
| `session-status.ts` badge | `todos open`, tone **attention** (amber dot) | `todos open`, tone **idle** (blue dot) |
| Web sidebar row | — (label was gated on the amber tone) | prints `todos open` **dim** — see below |
| `notification-sounds.ts` | the **question** cue | **silent**, with `interrupted` and bare idle |
| `focus.ts` grouping | **needsYou** | **idle** |
| `focus.ts` summary | `Stopped with unfinished todos.` | unchanged — a quiet card line, not a quote |
| `motionPhase` | **waiting** (amber stillness) | **done** (still ✓) — the turn DID end |
| `daemon-lifecycle.ts` | an attention phase: cleared snoozes, ended the issue's defer | neither |
| `notify.ts` push | never fired for this kind | unchanged |

**The row label needed saving, not just quietening.** The sidebar's status word is
gated on `badge.tone === 'attention' || 'error'`, so demoting the tone alone would
have DELETED `todos open` from the row rather than made it calm. The row now
admits this one quiet verdict and renders it in the existing dim style — the same
treatment `paused` gets.

### The two questions, named once

`kind !== 'done'` had been spelled inline in six places, each answering one of two
different questions. That is exactly why one line in a harness adapter could move
a whole fleet into NEEDS YOU. They are now
`packages/model/src/predicates/idle-verdict.ts`:

- `idleVerdictNeedsHuman` — question, approval, interrupted.
- `idleVerdictFinishedTurn` — done, **open_todos**.

Both are `Record<IdleVerdict['kind'], boolean>`, so a NEW verdict kind is a
compile error until it declares what it means. POD-448 (Codex) is asked by mail to
build against these rather than re-deriving them.

## Verification

- `bun run typecheck` — 23/23 green.
- `bunx vitest run` in `apps/web` — the WHOLE web suite, 222 files / 1795 tests.
- `packages/client-core`, `packages/harness`, `packages/model` — 160 files / 2058
  tests. `apps/server` — 288 files / 4106 tests.
- `bun run test` (the official lane) reports ONE failure, `packages/runtime`
  `session-mint.test.ts`: a POD-1402 tripwire that fires because
  `client_sessions` gained `user_id` in 5409a3ac (2026-08-02, on main).
  Pre-existing, untouched by this branch, already filed three times
  (POD-382 / POD-440 / POD-441).

### Runtime, end-to-end through the real Stop-hook path

A transcript file on disk → `translateClaudeHookPayload({hook_event_name: 'Stop'})`
→ the reducer → every client-core answer:

```
events         [{"kind":"turn_completed","verdict":{"kind":"open_todos","summary":"open todo list"}}]
phase/verdict  idle {"kind":"open_todos","summary":"open todo list"}
badge          {"label":"todos open","tone":"idle","showContinue":false}
dot / motion   ready / done
group / sound  idle / null
card summary   open todo list
```

The row's own half is pinned by a render test
(`apps/web/src/features/worklist/PanelRow.open-todos.test.tsx`): the words are
there, `text-text-dim` not `text-attention`, and a question still renders amber.

Not verified in the live UI: this host's running instance serves `main` from the
shared checkout, and restarting it onto this branch would have disturbed the other
agents' sessions.

## One case survives — POD-453

The live Stop path classifies the last 128KB of transcript. A list created several
turns ago and then abandoned **without a single update** is outside that window, so
the turn reads as a plain `done`. Ticking items off as it goes — what an agent
normally does — keeps the list inside the window, because any update registers its
task.

Measured on a real session (POD-293's, 6 tasks created, never updated, 2010
records):

| window | `openTodoCount` | label |
|---|---|---|
| full file | 6 | `idle.needs_input.open_todo_list` |
| last 128KB | 0 | `idle.finished` |

Census: 7 sessions on this host used the Task list; 1 ended with an item still
open. So this is the tail case rather than the common one — but it is the session a
human would most want flagged. The fix is for the observer to FOLD this state as it
streams (it already scans new transcript bytes incrementally) instead of re-reading
megabytes on every Stop; filed as POD-453 with the measurement.

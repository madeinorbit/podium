# Automations: real cron scheduler + notifier wiring

Status: design (approved 2026-07-14). Issue: #470. Follows the audit in #456.
Related: #129 (event subscriptions), #169 (toggleable built-in defaults), #130 (git.* source).

## Problem

The Automations tab is two halves, and only one of them is real.

**The real half — "Notification triggers"** — is the UI for the event subscriptions
shipped in #129. Subscriptions persist, the steward dispatcher matches them against the
event log every 15s, and all six events the composer offers are genuinely emitted. But
it carries two defects:

1. **The "Notify" switch is a no-op.** Its label promises "Send an external notification
   (e.g. Telegram)". `deliverSubscription` (`steward.ts:348`) appends a `steward.notify`
   row to the event log and stops there. Nothing reads that kind — the only reference
   outside the emitter is its own unit test. Meanwhile a working ntfy/Telegram notifier
   already exists (`modules/notify/service.ts`), driven off raw session phase
   transitions, completely disjoint from subscriptions. A subscription with
   `notify: true` reaches your phone never, and the row it writes is pruned in 14 days.
2. **The steward ships dark.** `settings.steward.enabled` defaults to `false`
   (`packages/runtime/src/settings.ts:252`, "Ships dark — default off") and `tick()`
   returns immediately when it is off (`steward.ts:223`). On a fresh install the entire
   Notification-triggers section is inert: you can create triggers, toggle them, see
   them listed, and nothing will ever fire — with no indication in the UI. The feature
   has been live long enough to be trusted; the dark default now only breaks new users.

**The mock half — "Scheduled & reactive"** — is a front-end prototype with no backend at
all. `SEED_AUTOMATIONS` and `MOCK_RUNS` are hardcoded arrays in `AutomationsView.tsx`;
enabling a card flips a `useState` and is lost on reload; "New automation" builds a cron
string and discards it. Server-side there is no automations table, no cron parser, no
scheduler, and no run history. The fake run history ("Pruned 3 worktrees") is the least
honest part — it reads as real telemetry.

## Goal

Make scheduled automations real, end to end: create one in the tab, it persists, it
fires at its time, a session appears with the prompt, and its run history is the truth.
Fix the two defects in the half that already works. Leave the reactive half visible but
honestly marked unbuilt, on a foundation it can later reuse.

## Non-goals

- Reactive automations (event-triggered). The table is shaped so they land later as
  `trigger_kind = 'event'` reusing the subscription matcher, but they are not built here.
- Making the built-in default subscriptions toggleable (#169).
- A per-subscription message template. Every custom trigger still delivers the fixed
  generic nudge from `steward.ts:76`. Real limitation, separate change.
- Backfilling missed occurrences as a burst. Explicitly rejected below.

## Design

### Data model

One migration, two tables.

```
automations
  id           TEXT PRIMARY KEY
  name         TEXT NOT NULL
  enabled      INTEGER NOT NULL DEFAULT 0
  repo_path    TEXT              -- NULL = global; the session runs in $HOME
  cron         TEXT NOT NULL     -- 5-field, evaluated in server-local time
  agent_kind   TEXT NOT NULL
  model        TEXT NOT NULL DEFAULT 'auto'
  effort       TEXT NOT NULL DEFAULT 'auto'
  prompt       TEXT NOT NULL
  next_run_at  TEXT              -- ISO; NULL when disabled
  last_run_at  TEXT
  created_at   TEXT NOT NULL

automation_runs
  id            TEXT PRIMARY KEY
  automation_id TEXT NOT NULL    -- FK, ON DELETE CASCADE
  fired_at      TEXT NOT NULL
  session_id    TEXT             -- NULL unless outcome = 'spawned'
  outcome       TEXT NOT NULL    -- 'spawned' | 'missed' | 'skipped_overlap' | 'error'
  detail        TEXT             -- error message, or why it was skipped
  -- index on (automation_id, fired_at DESC)
```

`repo_path IS NULL` means a **global** automation: the session spawns in the user's home
directory, for cross-repo chores. This is an explicit product decision — a scheduled task
is not always about one repo.

`automation_runs` is what makes the tab's "Recent runs" list real. It replaces `MOCK_RUNS`
exactly: outcome + time + the spawned session, which the UI links to.

Cron is a standard 5-field expression evaluated in **server-local time**. No per-automation
timezone in this pass.

### The scheduler

A new `AutomationScheduler` in `apps/server/src/modules/automations/`, structured like the
existing tick services (`IssueAutoArchive`, `EventLogRetention`) and registered in the same
slot in `relay.ts`. Its own `setInterval`; **not** gated behind `steward.enabled` — cron is
a separate concern from event dispatch, and the scheduler is inert until an enabled
automation exists, so it is safe to ship on.

Each tick, for every enabled automation with `next_run_at <= now`:

| condition | outcome |
|---|---|
| more than `GRACE_MS` (1h) late | record a `missed` run; do not spawn |
| previous session for this automation still live | record `skipped_overlap`; do not spawn |
| otherwise | spawn; record a `spawned` run with the session id |
| spawn throws | record an `error` run with the message |

In every case `next_run_at` advances to the first occurrence strictly after `now`.

That single rule gives the missed-fire policy: an outage collapses any number of skipped
occurrences into **at most one** late fire, and the grace window keeps a 04:00 job from
ambushing the user at 14:00. Backfilling a burst is explicitly wrong here — each fire
spawns an agent session, so a naive catch-up over a weekend outage would spawn dozens.

The overlap check keeps a slow daily job from piling sessions on top of each other.

The decision logic is a pure function of `(now, automations, liveSessionIds)` → decisions,
with the clock injected. That is the seam the tests drive.

### Spawn

```ts
const { sessionId } = sessions.createSession({
  cwd: automation.repoPath ?? homedir(),
  agentKind: automation.agentKind,
  model: automation.model,
  effort: automation.effort,
  spawnedBy: `automation:${automation.id}`,
})
sessions.queueText({ sessionId, text: automation.prompt, mutationId: runId })
```

**Use `queueText`, not `initialPrompt`.** `initialPrompt` is only delivered via argv, and
only for argv-capable harnesses — `AGENT_CAPABILITIES[kind].argvPrompt` is true for
claude-code, codex, and grok, and **false for opencode and cursor**, where the prompt is
silently seeded into the composer draft and never sent. A scheduled task that quietly
does nothing on two of five harnesses is a trap. `queueText` is the durable outbox: it
waits for the session to be genuinely ready, survives a server restart, and works for
every harness. Setting `mutationId = runId` makes prompt delivery replay-safe.

Do **not** route through the `sessions.create` tRPC procedure — it stamps
`spawnedBy: 'user'`. Programmatic spawners call `SessionsService.createSession` directly
with their own provenance tag, as `spawn-on-wake` and the superagent tools already do.

`createSession` does no filesystem validation on `cwd`, and if no daemon is online the
control message queues and flushes on the daemon's next attach. Both are acceptable: a
scheduled spawn that lands when the machine reconnects is the desired behavior, not a
failure. The `error` outcome covers genuine throws.

Cron writes no events and needs no dispatcher changes. It is a pure producer of sessions.

### Notifier wiring

`deliverSubscription`'s `deliverNotify` branch (`steward.ts:348`) keeps its existing
`steward.notify` breadcrumb — it is the durable audit record and dedup is already keyed on
it — and *additionally* calls the existing `NotifyService`, so the switch does what its
label says. The notifier is injected as a steward dep (`notify: (notice) => void`) rather
than imported, keeping the steward's existing dependency-injection shape and its unit
tests hermetic.

### Steward default

`settings.steward.enabled` flips `false → true` in `packages/runtime/src/settings.ts:252`,
and the stale "Ships dark — default off" comment goes with it. Existing installs are
unaffected — the setting is persisted in the `meta` blob, so anyone who already has a
value keeps it. This only changes what a fresh install gets.

### UI

`AutomationsView.tsx` today is 1,022 lines and mixes a real backend section with a mock
one. This pass:

- **Scheduled** becomes real: list from the server, create/toggle/delete persist, and
  expanding a card shows actual rows from `automation_runs`, with the spawned session
  linked. The composer gains a target picker — the registered repos plus a "Global (home
  directory)" option. `SEED_AUTOMATIONS` and `MOCK_RUNS` are deleted.
- **Reactive** stays in the composer with Create disabled and an explicit "not yet wired
  to a runner" note. The seeded reactive cards and their fake history are removed. The
  design intent stays visible without pretending to work.
- The file is split — `AutomationsView.tsx` (shell), `TriggersSection.tsx` (existing
  subscriptions UI, moved as-is), `ScheduledSection.tsx`, `NewAutomationDialog.tsx`. This
  is the targeted cleanup the work requires, not a speculative refactor; #409 tracks the
  broader config-driven-subform idea and is unaffected.

New tRPC procedures under an `automations` namespace: `list`, `create`, `update`,
`remove`, `setEnabled`, `runs({ automationId })`.

## Testing

**Scheduler (the load-bearing tests).** Table-driven against the pure decision function
with an injected clock:

- due → spawns; not due → nothing; disabled → nothing.
- exactly at `GRACE_MS` and one ms past it → the boundary of `missed`.
- outage spanning many occurrences → **exactly one** late fire, then re-armed to the future.
- previous session still live → `skipped_overlap`, and `next_run_at` still advances.
- `createSession` throws → `error` run recorded, scheduler survives, next tick proceeds.
- `next_run_at` always advances strictly past `now` (no tight-loop re-fire).

**Spawn** is faked at the `createSession` / `queueText` seam and asserted on: cwd resolves
to `$HOME` for a global automation, `spawnedBy` is `automation:<id>`, and the prompt goes
through `queueText` (never `initialPrompt`).

**Notifier**: a subscription with `notify: true` calls the injected notifier once *and*
still writes the breadcrumb; `notify: false` calls it zero times.

**Cron parsing**: standard expressions plus the ones the UI's builder emits.

**Browser.** Per this repo's convention, UI work is not done until it is driven in a real
browser: a Playwright pass that creates a scheduled automation through the composer,
asserts it survives a reload (the thing the mock could never do), toggles it, expands it
to an empty run list, and deletes it.

## Rollout

The scheduler ships enabled; it does nothing until the user creates an automation. The
steward default flip only affects fresh installs. No data migration beyond the two new
tables.

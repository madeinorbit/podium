# Auto-Continue Mode — Design

**Date:** 2026-06-24
**Branch:** `worktree-auto-continue-impl`
**Issue:** #3 (auto-continue)

## Problem

When an agent hits a *continuable* error — rate limit (429), overloaded (529),
server error (500), etc. — Podium surfaces a red **Continue** button on the
session. Clicking it types `continue⏎` into the agent's PTY to nudge it to
retry. Today this is fully manual: the user must babysit the session and click
Continue every time it errors, which is tedious for transient errors that
resolve themselves after a wait (e.g. an hour-long rate limit).

We want an **auto-continue mode**: when enabled, Podium retries `continue` on
its own, with escalating backoff, until the agent recovers — even while the
user is away.

## Decisions (confirmed with user)

1. **Scope: a single global master switch.** When `autoContinue.enabled` is
   true, *every* live session that enters a retryable-errored state gets
   auto-continued. There is no per-session override in this iteration (a
   per-session kill-switch is a possible future follow-up).
2. **Backend-driven.** The retry loop runs in the server, not the web client,
   so an agent keeps recovering overnight even with the user's phone asleep /
   browser closed. This matches the "can run forever / keep using tokens"
   warning the feature must surface.

## How the existing Continue path works (baseline)

- **Error classification:** `packages/agent-bridge/src/agent-state/claude-code.ts`
  maps a `StopFailure` hook event's `error_type` to a class and a `retryable`
  flag. Retryable classes: `rate_limit`, `overloaded`, `server_error`,
  `max_output_tokens`, `unknown`.
- **Reducer:** `packages/agent-bridge/src/agent-state/reducer.ts` turns a
  `turn_failed` event into `phase: 'errored'` with
  `error: { class, retryable }`.
- **Protocol:** `AgentError` in `packages/protocol/src/messages.ts` carries
  `retryable: boolean` ("true → a blind 'continue' is worth offering").
- **Badge:** `apps/web/src/derive.ts` (`agentBadge`) sets
  `showContinue = s.error?.retryable ?? false` when phase is `errored`.
- **Manual button:** `Sidebar.tsx` and `HomeView.tsx` call
  `continueSession(sessionId)` → `store.continueSession` →
  `trpc.sessions.continue.mutate` → `router` → `registry.continueSession`.
- **Server handler:** `apps/server/src/relay.ts` `continueSession` validates the
  session is live/starting **and** in the `errored` phase, then sends an
  `input` control message with base64 `continue\r` to the daemon. (Guarded so a
  stray click can't inject text into a healthy prompt.)

The auto-continue feature **reuses `continueSession` unchanged** as the
"send one nudge" primitive. All new logic decides *when* to call it.

## Architecture

### 1. Settings (`packages/core/src/settings.ts`)

Add a new section to `PodiumSettings`:

```ts
autoContinue: z.object({
  enabled: z.boolean().default(false),
  promptDismissed: z.boolean().default(false),
}).default({})
```

- `enabled` — the master switch. Persisted in the SQLite `meta` table inside
  the settings blob (cross-device).
- `promptDismissed` — once true, the first-time popup never shows again.

Backoff constants live in `core` as exported code (not user-configurable UI):

```ts
export const AUTO_CONTINUE_BASE_DELAY_MS = 10_000   // first cooldown
export const AUTO_CONTINUE_MAX_DELAY_MS = 300_000   // 5 min cap
```

Exponential schedule: `delay(n) = min(BASE * 2^(n-1), MAX)` →
`10s, 20s, 40s, 80s, 160s, 300s, 300s, …`.

### 2. Backend controller (`apps/server/src/auto-continue.ts`, wired in `relay.ts`)

A small `AutoContinueController` owned by the `SessionRegistry`. One logical
retry loop per session, keyed by `sessionId`, guarded against duplicates.

**Inputs it observes:**
- Agent-state transitions for each session (the same point in `relay.ts` where
  incoming agent state updates a session's `agentState`/phase).
- The current `autoContinue.enabled` setting.
- Session lifecycle (live → hibernated/exited/killed).

**Per-session loop semantics:**
1. Trigger: session becomes `phase === 'errored'` && `error.retryable` &&
   `enabled` && session is live/starting && no loop already running for it.
2. Loop:
   - Send one nudge via `registry.continueSession({ sessionId })`.
   - `attempt++`; compute `delay = min(BASE * 2^(attempt-1), MAX)`.
   - Sleep `delay` (cancellable).
   - Re-read current session state. Continue the loop **only if** still
     `errored` + `retryable` + live + `enabled`. Otherwise stop.
3. **Reset:** when a session leaves the errored phase (a nudge "took" and the
   agent made progress), reset `attempt = 0` and end the loop. A later, fresh
   error starts the backoff gentle again.
4. **Cancel:** turning the setting off, or the session leaving live status,
   cancels the loop immediately (clear any pending timer).

**Arming on enable:** when `setSettings` flips `enabled` false→true, scan
existing sessions and arm loops for any already in a retryable-errored state.
When it flips true→false, cancel all loops.

The controller is pure-ish: timing via an injectable `setTimeout`/clock and the
"send" + "read state" as injected functions, so it is unit-testable with a fake
clock (see Testing).

### 3. First-time popup (frontend)

- The manual Continue button keeps its current behavior (sends `continue` in
  the background immediately).
- Centralize the popup trigger in `store.continueSession`: after a successful
  manual continue, if `settings.autoContinue.enabled === false` &&
  `settings.autoContinue.promptDismissed === false`, open an
  `AutoContinueDialog`. Both call sites (`Sidebar`, `HomeView`) already route
  through `store.continueSession`, so they share the trigger for free.
- `AutoContinueDialog` (rendered once in `AppShell`, using the existing
  `components/ui/dialog.tsx` primitive):
  - **Title:** "Auto-continue when agents error?"
  - **Body:** explains Podium will keep sending `continue` with increasing
    delays (up to 5 min) until the agent recovers. **Plain warning:** this can
    keep an agent running indefinitely and consuming tokens. Notes it can be
    toggled anytime in Settings → Sessions.
  - **Actions:** `Enable auto-continue` (sets `enabled = true`) and `Not now`.
  - **Any** choice sets `promptDismissed = true` → never shown again.
- Both writes go through the existing full-blob `trpc.settings.set` round-trip
  (the store already does optimistic settings updates).

### 4. Settings UI (`apps/web/src/SettingsView.tsx`)

Add a toggle row in the **Sessions** tab:
- Label: "Auto-continue on retryable errors"
- Helper text: same token / runaway warning, mentions backoff up to 5 min.
- Bound to `autoContinue.enabled` via the existing `patch()` + `settings.set`
  flow.

## Data flow

```
agent errors (retryable)
   │  (daemon → relay agent-state update)
   ▼
relay updates session phase = 'errored'
   │
   ▼
AutoContinueController.onStateChange(session)
   │  enabled? retryable? live? not already looping?
   ▼
loop: continueSession() ─→ sleep backoff ─→ re-check
   │                                           │
   recovered → reset + stop          still errored → escalate
```

```
user clicks Continue (manual)
   │
   ▼
store.continueSession() ──(success)──┐
   │                                  ▼
   sends continue          enabled==false && !promptDismissed?
                                      │ yes
                                      ▼
                            open AutoContinueDialog
                              ├ Enable  → enabled=true, promptDismissed=true
                              └ Not now → promptDismissed=true
```

## Error handling / edge cases

- **Duplicate loops:** controller keys by `sessionId`; a second trigger while a
  loop is live is a no-op.
- **Session dies mid-sleep:** lifecycle cancel clears the timer; the next
  `continueSession` would be a no-op anyway (gated to live + errored).
- **Setting toggled off mid-sleep:** cancel all loops immediately.
- **Non-retryable error:** never triggers (gated on `error.retryable`).
- **Recovery then re-error:** treated as a new episode; backoff restarts at 10s.
- **Server restart:** controllers are in-memory; on boot, re-arm from current
  session states if `enabled` (existing boot seeding already re-establishes
  agent state — hook re-arm there).

## Testing

**Unit (TDD, primary):** `auto-continue.test.ts` against a fake clock + spies:
- Sends `continue` once on first retryable error.
- Escalates delays `10s → 20s → 40s …` capped at 5 min while still errored.
- Resets to 10s after recovery, then re-errors → starts at 10s again.
- Stops on disable, on non-live, on non-retryable.
- No duplicate loops for the same session.
- Arming on enable picks up already-errored sessions; disabling cancels.

**Frontend:** a focused test that `store.continueSession` opens the dialog only
when `enabled===false && promptDismissed===false`, and that Enable / Not now
write the expected settings.

**Manual e2e (last):** induce real upstream errors by pointing a Claude Code
session's `ANTHROPIC_BASE_URL` at a tiny local fault-injecting proxy that
returns 500/529 for the first N requests (the `agentinsight` proxy on this
machine confirms the real error envelope → classes `server_error` /
`overloaded` / `rate_limit`, all already retryable). Then, in the live Podium
harness: confirm the Continue button + popup appear, enable auto-continue, and
watch the backend retry with escalating backoff until the proxy stops faulting
and the agent recovers.

## Out of scope (YAGNI)

- Per-session auto-continue override / kill-switch.
- User-configurable backoff numbers in the UI.
- A max-attempt cap or max-total-time cap (the 5-min ceiling + manual toggle
  are the controls; the warning makes the open-ended nature explicit).
- Auto-continue for non-Claude agents beyond what the shared retryable-error
  signal already covers.

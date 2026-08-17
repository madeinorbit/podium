# Abort from transcript view — what was broken, what changed

Four fixes to stopping an agent from transcript chat, plus the measurements they rest on.

## Measured harness behaviour

Each CLI was driven in a real PTY (tmux, 100×30) on this host: a turn was started, the
candidate key pressed, and the screen read back.

| Harness | Esc mid-turn | Ctrl-C mid-turn | The key at an IDLE prompt |
|---|---|---|---|
| claude-code 2.x | **interrupts** — prints `Interrupted`, recalls the prompt | (not needed) | Esc only clears the composer |
| grok 1.0.3 | **interrupts** — footer advertises `Esc:cancel`, prints `Turn cancelled by user` | (not needed) | inert |
| codex 0.147.0 | **nothing at all**, single *and* double — the stream ran on through both | **interrupts** — `Conversation interrupted` | Ctrl-C **exits the CLI** |
| opencode | unmeasured (no provider connected on this host) | — | — |
| cursor | unmeasured (cursor-agent not installed here) | — | — |

Two consequences:

1. Podium sent a bare `\x1b` regardless of harness, so **every stop on a codex session was a
   silent no-op**.
2. Ctrl-C cannot simply replace it — one Ctrl-C at an idle codex prompt quits the process, so
   an abort aimed at a turn that already ended would kill the session.

Also measured, and NOT fixable from here: a single Esc stops claude-code's main loop but
**not its background `Task` subagents** — one kept reading files for 44s and 38.7k tokens after
the interrupt landed. Those live inside the harness; no keystroke reaches them.

## The four fixes

| # | Was | Now |
|---|---|---|
| 1 | The stop button rendered only for headless superagent turns, leaving double-Escape as the only way to stop a native session | The button renders for any running turn; `headless` is gone from the composer, which no longer asks which kind of turn it is stopping |
| 2 | `.catch(() => {})` — and a refusal RESOLVES `{ ok: false, reason }` rather than throwing, so a stop that never reached the agent looked exactly like one that worked | The reason lands in the composer as its own **"Not stopped"** notice (not sending's "Not sent" — the failure being reported is that the agent is still running) |
| 3 | The chord was armed by `agentState.phase === working`, a lagging observation — so quiet-but-busy, or an observer a beat behind, meant two Escapes did nothing, silently | Armed by LIVENESS (`live`/`starting`). Whether the key is safe to send is the server's call; its refusal is now visible |
| 4 | `\x1b` hardcoded for every `agentKind` | The key comes from the harness manifest (`interruptKey`, `interruptQuitsWhenIdle`), and a quits-when-idle harness is refused with a reason instead of being sent a key that would kill it |

`interruptText` (interrupt-urgency mail) SKIPS the key when the agent is idle rather than
refusing — its job is to deliver the message, and that path must never be what ends a session.

## Where it lives

- `packages/harness/src/manifest.ts` — the two new capability declarations
- `packages/harness/src/registry.ts` — `harnessInterrupt()`, incl. both no-manifest cases
  (`shell` → Ctrl-C, unknown harness → Esc)
- `apps/server/src/modules/sessions/inbox.ts` — `abortKeyFor()`, the idle guard, the refusal
- `apps/web/src/features/chat/use-chat-surface.ts` — liveness arming, `interruptError`
- `apps/web/src/features/chat/ChatComposer.tsx` — ungated stop control, "Not stopped" notice

## Verification

- `apps/server/src/modules/sessions/inbox.test.ts` — per-harness key table, the idle-codex
  refusal, the idle Esc pass-through, and interruptText's skip. Positive control: flipping
  codex's manifest key to `esc` fails the table.
- `packages/harness/src/registry.test.ts` — the chord per harness and both fallbacks.
- `apps/web/src/features/chat/ChatComposer.test.tsx` / `ChatView.test.tsx` — the native stop
  control, liveness arming, an inert chord on a dead session, and the surfaced refusal.
  Positive control: restoring either old gate fails the new tests.
- Byte DELIVERY to the PTY was already covered by `tests/e2e/browser/chat-interrupt.browser.e2e.ts`
  (`[raw] 1b` at a keyecho agent); this change alters which byte is chosen, not how it travels.

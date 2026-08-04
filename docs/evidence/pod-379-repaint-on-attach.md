# POD-379 — grok terminal renders blank: measurement and before/after

Measured on vmi3431366 with grok 0.2.118 in an isolated `GROK_HOME`, 118×49 PTY, grok idle
at its prompt (first-run trust modal answered). The probe framed real PTY bytes exactly the
way `SessionTerminal` does, applied the same 256 KB replay-log trimming, and rendered the
result through a headless xterm — i.e. it reproduces what a browser client paints on attach.

## The cause, measured

Idle grok emits **408 KB in 60 s (6.64 KB/s)** and never stops: it shimmers the xAI logo,
repainting only the logo rows, and emits **no screen-reset sequence at all**. The server's
replay log (`MAX_REPLAY_BYTES = 256 KB`, reset only on `\e[2J` / `\e[3J` / `\ec` / `\e[?1049h|l`)
therefore turns over roughly every 30 s with no whole-screen anchor left in it.

`attachClient` replayed those bytes verbatim and nudged nothing. Replay is a byte stream,
not a screen — so past ~30 s of uptime there was nothing in it to rebuild a screen from.

## Before — what the client replayed on attach

7 of 49 rows, no prompt, no chrome: dim grey logo fragments on near-black. Reads as
"the CLI never launched".

```
12|      ⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄
13|      ⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀
14|      ⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀
15|      ⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀
16|      ⠀⠀⢹⣷⠀⠀⠀⠀⠀⢀⣴⡿⠀⠀
17|      ⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀
18|      ⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
```

## After — the same replay, followed by the attach repaint

The repaint (a soft SIGWINCH shrink/restore, `AgentSession.redraw()`) opens with
`\e[?2026h\e[2J\e[1;1H` and repaints all 49 rows from grok's own model: 19 of 49 rows,
identical to what the screen actually holds.

```
 1|   issue/379-bug-grok-terminal-renders-blank worktree ~/podium/.worktrees/issue-379-bug-…
10|   ╭────────────────────────────────────────────────────────────────────────────────────╮
12|   │  ⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⢀⠄   Grok Build Beta  0.2.118                                        │
14|   │  ⠀⠀⣼⡟⠁⠀⠀⠀⢀⡴⠻⣿⡀⠀   Workflows are here!                                             │
15|   │  ⠀⠀⣿⡇⠀⠀⠀⠔⠁⠀⠀⣿⡇⠀   Try them out using /workflows.                                  │
17|   │  ⠀⢀⠞⠁⠠⢶⣶⣶⣶⠿⠋⠀⠀⠀   New worktree                                            ctrl+w  │
18|   │  ⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀   Resume session                                          ctrl+s  │
22|   ╰────────────────────────────────────────────────────────────────────────────────────╯
41|  Tip: Use @! for hidden or ignored files: @!.github/workflows.
43|  ╭──────────────────────────────────────────────────────────────────────────────────────╮
44|  │ ❯                                                                                    │
45|  ╰──────────────────────────────────────── Grok 4.5 (high) · always-approve ─╯
47|                                                                             [stable]
```

The repaint also carries `\e[2J`, which matches `SCREEN_RESET` — so it **re-anchors the
replay log**. A second client attaching immediately after replayed a full 19-row screen
from the buffer alone, with no nudge of its own.

## What was ruled out on the way

| nudge | result |
| --- | --- |
| `session.redraw()` — soft SIGWINCH shrink/restore | full repaint ✅ (this is the fix) |
| hard geometry change, held (`cols-2`) | full repaint ✅ (no better, and it resizes the app) |
| Ctrl-L | **no repaint** — grok ignores it; it would also be a stray input byte in a TUI |
| launch flags (`--no-alt-screen`, `--minimal`) | no effect on the animation (measured in the issue brief) |

## The fix

`SessionTerminal.attachClient` nudges a repaint whenever the client is rebuilding its
screen from replay alone — a fresh attach, a resume whose gap outran the buffer, or a
restarted server with an empty log. A clean resume (including a caught-up one) keeps its
screen and takes only the delta, so a network blip does not flash the terminal.

It is harness-agnostic: it fixes any full-screen TUI that repaints regions without
re-anchoring, and it makes the replay-window size stop being load-bearing.

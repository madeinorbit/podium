# keyecho — keyboard/mouse echo test jig

- **Date:** 2026-06-07
- **Status:** Design — awaiting review
- **Branch:** `worktree-keyecho`

## Summary

A terminal jig, built on **Ink + React + TypeScript** (Claude Code's stack), that
reflects back *every* input it receives — as raw bytes, caret/escape notation, and
a human-readable label. It lets us verify that keyboard and mouse signals survive
any path into an agent TUI: a human typing at a real terminal, synthetic events
injected by code, or both at once through Podium's browser → server → PTY pipeline.

Capture is **pluggable** so the jig can localize *where* a byte gets mangled: the
raw wire bytes, Ink's own input handling, or both side-by-side.

## Why this exists (Podium context)

Podium presents agent terminal sessions (e.g. Claude Code) in a browser:
`xterm.js` + a mobile key toolbar in `packages/terminal-client` send keystrokes
over a WebSocket to `apps/server`, which writes them into a real PTY
(`node-pty`, already a dependency) running the agent. There is currently no
deterministic way to assert that a given keypress arrives at the far end intact.
`keyecho` is that far-end fixture: run it inside the PTY and it echoes exactly what
it received, so the whole transport can be tested with hard pass/fail evidence.

## Location & packaging

New top-level **`tests/`** workspace (add `tests/*` to root `package.json`
`workspaces`, alongside `apps/*`, `packages/*`, `tooling/*`, `e2e`). First package:
**`tests/keyecho`**. It is a workspace package because it carries its own deps
(`ink`, `react`, `node-pty`). The existing `e2e` workspace is unchanged.

```
tests/keyecho/
  package.json            # name @podium/keyecho, bin "keyecho", deps ink/react
  src/
    events.ts             # CaptureEvent types + formatters (hex, caret, label)
    parser.ts             # pure decodeInput(Buffer) -> InputEvent[]   (no I/O)
    sources/
      types.ts            # InputSource interface
      raw.ts              # raw stdin + parser.ts            (mode: raw)
      ink.tsx             # Ink useInput pipeline            (mode: ink)
      # codex.ts          # later: codex's stack             (mode: codex)
    app.tsx               # Ink UI: mode mgmt, tagged log, status, hotkeys
    cli.tsx               # entrypoint (tsx/node), TTY guard, terminal restore
  src/parser.test.ts      # unit: every sequence decodes correctly
  src/harness/
    shortcuts.ts          # Claude Code shortcut table: name -> bytes -> expect
    driver.ts             # node-pty: boot real app, inject bytes, capture, assert
  src/harness/shortcuts.test.ts  # integration: each shortcut round-trips per mode
```

Run via `tsx` (Node, matching Claude Code) — not bun — to keep Ink + `node-pty`
behavior identical to the real agent runtime.

## Architecture

### Pluggable capture (the core idea)

Capture is an `InputSource` that emits `CaptureEvent`s tagged with their origin.
This is what makes the jig a *diagnostic*, not just an echo:

| Mode | Source | Surfaces bugs in… |
|------|--------|-------------------|
| `raw` | raw stdin + our own `parser.ts` | transport / PTY / browser key-forwarding (ground-truth bytes) |
| `ink` | Ink's own `useInput` pipeline | **Ink's parsing/normalization** — what a real Ink agent (Claude Code) actually sees |
| `both` | run concurrently, tag each event `[raw]` / `[ink]` | the **discrepancy** — raw correct but ink wrong ⇒ bug is in Ink |
| `codex` | *(later)* codex's stack | same idea, their renderer |

- **Default mode: `both`** (raw bytes + Ink interpretation interleaved, tagged).
- Selectable via `--mode raw|ink|both` and cyclable at runtime via a hotkey.
- In `both`, a manual stdin `data` listener and Ink's `useInput` both attach to the
  same stdin stream (Node allows multiple listeners), so one keypress is seen
  through both lenses.
- `ink` mode will *not* surface mouse or bracketed paste (Ink ignores them) — that
  absence is itself a true, visible finding.

### Why not rely on Ink's `useInput` alone

`useInput` normalizes/swallows bytes and ignores mouse entirely — which would hide
exactly what we need to verify. So Ink renders the UI, but the `raw` source owns raw
mode and parses the `Buffer` itself. Keeping both as peer sources is what lets us
attribute a bug to Ink vs. the wire.

### Data flow

```
stdin (raw) ─┬─► RawInputSource ─► parser.decodeInput ─► CaptureEvent{source:'raw'}
             └─► Ink useInput    ───────────────────────► CaptureEvent{source:'ink'}
                                                                │
                                              append to event log (ring buffer)
                                                                │
                                                         Ink render (app.tsx)
```

`parser.ts` is the pure, fully unit-tested core. The `node-pty` harness boots the
real app and proves the whole chain (raw mode + sources + Ink) end-to-end.

## Parser scope (`raw` source)

`decodeInput(buf: Buffer): InputEvent[]` — pure, never throws, buffers partial
sequences split across chunks. Recognizes:

- Control chars `0x00–0x1f` and `0x7f` (DEL) → caret notation (`^C`, `^[`, `^?`).
- Printable UTF-8.
- CSI `ESC [ …`: arrows, `Shift+Tab` = `ESC[Z`, Home/End, PageUp `ESC[5~` /
  PageDown `ESC[6~`, F-keys, and `modifyOtherKeys` forms (e.g. `ESC[27;2;13~`).
- SS3 `ESC O …` (e.g. `ESC O P` = F1, `ESC O H` = Home).
- Alt/Meta: `ESC` + key (e.g. `ESC\r` = Alt/Option+Enter).
- **SGR mouse** `ESC [ < b ; x ; y M|m` → button, modifiers, coords, press/release,
  wheel (b=64/65).
- **Bracketed paste** `ESC[200~ … ESC[201~` → a single `Paste` event with payload.
- Anything unrecognized → `Unknown` event preserving raw bytes (never dropped).

## Reserved keys, quit, lock

A test jig must not steal keys it's supposed to be testing.

- **No double-Ctrl+C quit.** Raw mode disables terminal signal generation, so
  `Ctrl+C` (`0x03`) is captured as pure bytes every time — single, double, triple
  all echo. Double-Ctrl+C is therefore directly testable (a required Claude Code
  behavior).
- Reserved hotkeys default to keys Claude Code does not use and are configurable:
  - `Ctrl+Q` — quit (echoed first, then exits).
  - `F2` — cycle mode (raw → ink → both).
  - `F3` — toggle any-motion mouse reporting (`1003`, noisy).
  - `F4` — clear the log.
- **`--lock`** disables *all* hotkeys so the jig captures literally everything;
  exit by terminating the process. The `node-pty` harness kills the PTY, so
  automated runs need no in-app quit at all.

## Mouse & paste

On mount (when the active mode includes `raw`) write enable sequences; on exit
write the matching disable sequences:

- `ESC[?1000h` (click), `ESC[?1002h` (drag), `ESC[?1006h` (SGR encoding),
  `ESC[?2004h` (bracketed paste). `ESC[?1003h` (any-motion) is off by default,
  toggled by `F3`.

## Terminal safety

Always restore the terminal, even on crash/signal: disable mouse + paste modes,
leave raw mode, show cursor. Implemented via Ink unmount cleanup **and**
`process.on('exit'|'SIGINT'|'SIGTERM')` / `uncaughtException` handlers. Non-TTY
stdin prints a clear message and exits rather than half-initializing.

## Rendering / UX

- Scrolling event log (ring buffer, newest at bottom), each row:
  `time  [source]  raw-hex  caret/escape  human-label`.
- Status line: active mode, mouse on/off, lock state, event count.
- Help footer listing the active reserved keys.
- Color-code by source (`raw` vs `ink`) so discrepancies pop in `both` mode.

## Podium PTY hook

Expose a `keyecho` bin so a Podium session can launch the jig as its far-end
"agent" in place of `claude`. I will read how `apps/server` / `packages/agent-bridge`
spawn agents into the PTY and wire this thinly (a documented command/launcher), so
the browser → server → PTY → keyecho loop can be exercised end-to-end. Browser-side
human verification is manual here (headless Chromium crashes in this sandbox); the
byte-level correctness is proven by the `node-pty` harness regardless.

## Testing strategy (also deliverable #2)

1. **Unit (vitest):** table-driven over `shortcuts.ts` — every sequence decodes to
   the expected `InputEvent`. Fast, deterministic, the primary correctness proof.
2. **Integration (vitest + `node-pty`):** boot the real Ink app in a PTY, inject
   each shortcut's bytes, assert the rendered echo. Run per mode so we test the
   wire (`raw`) *and* Ink's interpretation (`ink`) and flag divergence.
3. Emit a pass/fail summary table across the full shortcut set.

### Claude Code shortcut set under test

| Name | Bytes | Notes |
|------|-------|-------|
| Enter (submit) | `\r` (0x0d) | |
| Ctrl+J (newline) | `0x0a` | |
| Alt/Option+Enter | `ESC \r` | newline in many terminals |
| Shift+Enter | `ESC[27;2;13~` | modifyOtherKeys form (terminal-dependent) |
| Ctrl+C | `0x03` | single **and** double (no quit collision) |
| Ctrl+D | `0x04` | EOF/exit when empty |
| Esc / Esc Esc | `0x1b` / `0x1b 0x1b` | interrupt / clear-or-rewind |
| Up / Down | `ESC[A` / `ESC[B` | history |
| Left / Right | `ESC[D` / `ESC[C` | cursor |
| Shift+Tab | `ESC[Z` | mode cycle (auto-accept / plan) |
| Tab | `0x09` | autocomplete |
| Ctrl+R | `0x12` | reverse-search / verbose |
| Ctrl+L | `0x0c` | clear screen |
| Ctrl+U / Ctrl+K / Ctrl+W | `0x15` / `0x0b` / `0x17` | line edit |
| Ctrl+A / Ctrl+E | `0x01` / `0x05` | line start / end |
| Ctrl+B / Ctrl+F | `0x02` / `0x06` | cursor back / forward |
| Backspace | `0x7f` | (`0x08` variant noted) |
| Home / End | `ESC[H` / `ESC[F` | (SS3 variants too) |
| PageUp / PageDown | `ESC[5~` / `ESC[6~` | transcript scroll |
| `!` `/` `@` `#` | `0x21 0x2f 0x40 0x23` | mode-trigger printables |
| Bracketed paste | `ESC[200~…ESC[201~` | paste detection |
| Mouse wheel up/down | `ESC[<64;x;yM` / `ESC[<65;x;yM` | scrollback |
| Mouse click | `ESC[<0;x;yM` / `ESC[<0;x;ym` | press / release |

## Out of scope (YAGNI)

- `codex` source (stubbed interface only; added when codex testing starts).
- Recording/replaying sessions to disk.
- Driving the real browser xterm in automated CI (sandbox can't run it).
- Any change to Podium's production transport beyond a thin launch hook.

## Open questions

- Exact Podium launch hook shape depends on how `apps/server`/`agent-bridge` spawn
  agents — resolved by reading that code during implementation.

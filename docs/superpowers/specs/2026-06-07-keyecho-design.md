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

## Test layout (repo-wide convention)

`keyecho` should not get a bespoke home — it should fall out of one clear, repo-wide
rule. The repo already follows a sound three-tier pattern de facto; this formalizes
it. **Existing colocated tests stay put — no churn.**

1. **Unit — colocated `src/foo.test.ts`** beside `foo.ts`. The default for testing a
   single module. Publish-safe: `tsup` bundles only what's reachable from
   `entry: ['src/index.ts']` (treeshaken) and packages ship `files: ["dist"]`, so
   colocated tests never reach `dist`; `tsconfig include: ["src"]` still type-checks
   them.
2. **Integration / structure — `<package>/test/`** (+ `test/fixtures/`,
   `test/helpers.ts`). Used when a test needs fixtures, spawns processes, or
   exercises the package as a black box via its public entry. This is exactly why
   `packages/agent-bridge/test/session.test.ts` (spawns a PTY fixture) and
   `apps/web/test/` (source-structure guards) already sit outside `src`.
3. **Cross-package end-to-end — the `tests/e2e` workspace** (multiple services, real
   PTY, browser, network).

**Global rule:** anything that is not a colocated unit test of one module lives under
the top-level `tests/` umbrella. **Per-package rule:** unit colocated, integration in
`test/`.

`tests/` is **not** a `{unit, integration, smoke, e2e}` type taxonomy. Test *type* is
expressed by *where* a test sits — colocated (`src/`), per-package (`test/`), or the
cross-system suite — not by central folders. Unit and integration tests never
centralize. The only genuinely overarching category is cross-system tests, and
**e2e + smoke are one family** (they already cohabit in the existing suite:
`relay.e2e.test.ts` + `run-resume-smoke.ts`). So `tests/` holds exactly two *kinds*:
the one cross-system **suite** (`tests/e2e`) and shared test **fixtures**
(`tests/keyecho`). That two-kind membership is what justifies the umbrella; were
`keyecho` to live elsewhere, `tests/` would hold a lone `e2e` and we'd keep `e2e/` at
the root instead.

## Decision: `e2e` moves under `tests/`

`e2e/` → **`tests/e2e`**, and root `workspaces` `"e2e"` becomes `"tests/*"` (covering
both `tests/e2e` and `tests/keyecho`). One discoverable umbrella for all
non-colocated, cross-cutting tests + shared test infrastructure. The package name
(`@podium/e2e`), its internal relative paths, and its `playwright.config.ts` are
unchanged, so churn is limited to the workspace glob plus a grep for stray `e2e/`
path references. *(Fallback if rejected: leave `e2e/` at root and use `tests/` only
for fixtures/jigs — but that re-splits the umbrella, so the move is recommended.)*

## Where `keyecho` and its tests live

`keyecho` is a **fake agent CLI** — a test double for `claude`/`codex` that sits on the
*same side of the PTY as the real agent*, opposite `agent-bridge`. Its job is to verify
a keystroke survives the **entire path** (browser `terminal-client` → `protocol` →
`apps/server` → `apps/daemon` → `agent-bridge` → PTY → agent), which spans every
package, so it belongs to none of them. It is therefore **standalone, private** test
infrastructure: its own workspace package **`@podium/keyecho` at `tests/keyecho`**
(`"private": true`, bin `keyecho`; deps `ink`, `react`, `node-pty`).

Explicitly **not** inside `agent-bridge`: that is the lean published (★) Node half and
keeps its *own* zero-dep fixture (`packages/agent-bridge/test/fixtures/fixture-tui.mjs`)
for its *own* tests; folding an Ink+React, human-runnable jig into it would be a
category error and pull `ink`/`react` into a published library's dev surface.

Its *own* tests follow the convention: the pure parser's unit tests are colocated in
`src/`; the `node-pty` harness that boots the real app is an integration test in
`tests/keyecho/test/`.

*Promotion path (not now):* if `keyecho` later proves worth open-sourcing as a
keystroke-fidelity conformance tool, it moves to `packages/keyecho` as a published (★)
peer of `agent-bridge`/`terminal-client` — a cheap move precisely because it is already
standalone. YAGNI until there's a reason.

## Where tests that *use* `keyecho` live

Validating Podium's keystroke fidelity (browser → server → PTY) is cross-package
end-to-end, so those specs live in **`tests/e2e`**, which adds `@podium/keyecho` as a
dependency and launches it as the far-end agent. `keyecho` is a *dependency of* e2e,
never a host of e2e tests.

```
tests/                         # workspace umbrella (tests/* in root workspaces)
  keyecho/                     # @podium/keyecho — the jig (reusable test fixture)
    package.json               #   bin "keyecho"; deps ink, react, node-pty
    src/
      events.ts                #   CaptureEvent types + formatters (hex, caret, label)
      parser.ts                #   pure decodeInput(Buffer) -> InputEvent[] (no I/O)
      parser.test.ts           #   UNIT (colocated)
      sources/{types,raw,ink}  #   InputSource: raw stdin / Ink useInput (codex later)
      app.tsx                  #   Ink UI: mode mgmt, tagged log, status, hotkeys
      cli.tsx                  #   entrypoint (tsx/node), TTY guard, terminal restore
    test/                      #   INTEGRATION (boots real app in a PTY)
      shortcuts.ts             #   Claude Code shortcut table: name -> bytes -> expect
      driver.ts                #   node-pty driver: inject bytes, capture, assert
      shortcuts.test.ts        #   each shortcut round-trips, per mode
  e2e/                         # MOVED from root — @podium/e2e (cross-package E2E)
    ...existing specs...
    keystroke-fidelity.e2e.test.ts   # NEW; depends on @podium/keyecho

packages/<pkg>/src/foo.test.ts       # unit (colocated) — default everywhere
packages/<pkg>/test/                 # integration + fixtures/helpers (when needed)
```

Run `keyecho` via `tsx` (Node, matching Claude Code) — not bun — to keep Ink +
`node-pty` behavior identical to the real agent runtime.

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

# @podium/keyecho

A keyboard/mouse **echo test jig** — a fake agent CLI (a test double for
`claude`/`codex`) that reflects back every input byte it receives, as hex, caret
notation, and a human label. Use it to verify that keystrokes and mouse events
survive any path into an agent TUI: a human typing, synthetic bytes injected by a
test, or both at once through Podium's browser → server → PTY pipeline.

Private internal test infrastructure — not published. Run via `tsx` (Node, matching
Claude Code), never bun.

## Run

```bash
bun run --filter @podium/keyecho start          # default mode: both
bun run --filter @podium/keyecho start -- --mode raw
bun run --filter @podium/keyecho start -- --mode ink
bun run --filter @podium/keyecho start -- --lock # disable all hotkeys
```

## Capture modes

- `raw`  — raw stdin parsed by our own decoder (ground-truth wire bytes).
- `ink`  — Ink's own `useInput` pipeline (what a real Ink agent sees).
- `both` — run both concurrently, each event tagged `[raw]`/`[ink]` (default).

## Reserved hotkeys (disabled by `--lock`)

`Ctrl+Q` quit · `F2` cycle mode · `F3` toggle any-motion mouse · `F4` clear log.
There is intentionally **no** double-`Ctrl+C` quit, so `Ctrl+C` stays fully testable.

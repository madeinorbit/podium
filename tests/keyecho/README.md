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

## Manual browser testing (Podium pipeline)

keyecho is a fake agent CLI, so you can run it as the far-end agent in a real Podium
session and watch echoes from the browser. The daemon chooses the agent command via its
`launch` option (default `agentLaunchCommand` → `claude`/`codex`); the launcher below
overrides it to spawn keyecho instead.

1. Start the relay + daemon wired to keyecho (from the repo root):

   ```bash
   node --conditions=@podium/source --import tsx tests/e2e/serve-keyecho.ts
   # KEYECHO_MODE=raw|ink|both (default both) · PORT / WEB_PORT to change ports
   ```

2. Serve the web app in another shell and open the printed URL:

   ```bash
   bun run --filter @podium/web build && bun run --filter @podium/web preview -- --host --port 4318
   ```

3. In the Live UI, attach to the starter session and type / use the mobile key toolbar /
   scroll. Each key (and mouse event, in `raw`/`both` mode) echoes in the log with its
   bytes and label — exercising browser → server → daemon → PTY → agent.

The headless browser in this environment can't be driven automatically, so step 3 is for
human verification. The same path minus the browser is proven automatically by
`tests/e2e/keystroke-fidelity.e2e.test.ts` (agent-bridge → PTY → keyecho).


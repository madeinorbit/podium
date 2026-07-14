# Driving Podium yourself (for agents)

How an agent can drive the Podium web UI with Playwright to verify UI / interaction
features at runtime (clickable links, terminal output, editor open/save) — the things
unit tests can't reach (real mouse hit-testing, popups, the full client→server→daemon
path). Written from actually doing it; every gotcha below cost a real failed run.

## Which instance to drive

| Goal | Target | Notes |
|---|---|---|
| Test **unmerged branch** code | the committed Playwright harness (`tests/e2e/`) | Builds the branch web on `http://localhost:4317` + a relay/daemon (`serve-harness.ts`) on `:8799`. Isolated state; safe. **Use this to verify your own changes.** |
| Dogfood / reproduce against **main** | the live app | `https://podium-host.example.com:55555` (tailscale TLS → web `:55556` → backend `:18787`). Runs `main` from source. **The user uses this — be careful.** |

Run the harness specs: `cd tests/e2e && npx playwright test <spec> --project=chromium-desktop --timeout=90000`. See `tests/e2e/browser/clickable-files.browser.e2e.ts` for a complete worked example (terminal click → editor → save; wrapped-URL → new tab).

## The `?e2e=1` test API (how you read the terminal)

Append `&e2e=1` to the URL. `AgentPanel` then exposes `window.__podium`:
- `screenText(): string` — the terminal buffer as text. **The only way to read terminal output** (xterm renders to a WebGL canvas — there is no per-character DOM to query).
- `state(): { cols, rows, role }` — the grid size (needed to convert buffer rows → pixels).
- `sendInput(data: string)` — write bytes to the PTY (append `\r` for Enter).
- `simulateKeyboard(inset)`.

**These methods do not survive `page.evaluate(() => window.__podium)`** (functions don't serialize). Call them *inside* `evaluate`: `page.evaluate(() => window.__podium.screenText())`.

### Native-terminal lifecycle diagnostics

The web client always retains the newest 500 privacy-safe terminal lifecycle events (no
buffer text or keystrokes). After a blank or wrongly-sized pane, inspect them before
resizing the browser:

```js
window.__podiumTerminalDiagnostics.snapshot()          // every recent mount
window.__podiumTerminalDiagnostics.snapshot(sessionId) // one session
```

Events include panel/page visibility, fit attempts and exhaustion, local/server grids,
DOM/canvas dimensions, renderer selection/context loss/recovery, attach/reconnect, and
epoch clears. Add `?terminalDebug=1` (or set `localStorage['podium.terminalDebug']='1'`)
to mirror non-anomalous events to the console; anomalies warn automatically. Under
`?e2e=1`, `window.__podium.diagnostics()` returns the current session's history.

## Setup gotchas

- **Force the native terminal**: `await page.addInitScript(() => localStorage.setItem('podium.panelMode','native'))` **before** `goto` — else you land in chat view and `__podium`/the xterm isn't mounted.
- **Live URL**: use the tailscale HTTPS URL with `ignoreHTTPSErrors: true`. `localhost:55556` is the raw web, but same-origin WS routing is wired through `:55555` — prefer it.
- **Ad-hoc Playwright script** (outside the repo): import from `@playwright/test` (bun nests `playwright-core`, so it's not a top-level package). For a script in `/tmp`, symlink `node_modules`: `ln -sfn <repo>/node_modules /tmp/x/node_modules`. Chromium is cached in `~/.cache/ms-playwright` (`npx playwright install chromium` if not).

## Navigating the UI (current shadcn/Base-UI DOM)

The app lands on the **Command center** home. To get into a workspace and a session:
1. **Enter a workspace**: click a worktree button in the sidebar — `getByRole('button', { name: /<branch>\s+<base>/ })` (e.g. `worktree-foo main`). The adjacent `Pin <branch>` button carries a `title=` attr; exclude it. Or click an existing session card: `Open <session title>`.
2. **Create a session**: `getByRole('button', { name: 'New panel' })` (the "+") → `getByRole('menuitem', { name: 'New Claude' })` (or `New Shell` / `New Codex`).
3. **Wait for readiness**: `page.waitForFunction(() => !!window.__podium)`, then poll `screenText()` for the agent's prompt (Claude: `/Claude Code|esc to interrupt|shortcuts/`).

Reusable helpers: `tests/e2e/browser/_harness.ts` (`openApp`, `gotoWorkspace`, `newSession`, `podium`). Keep them current — the shadcn migration broke the old `.tab-add`/`.sidebar .worktree` selectors once already.

## Sending a prompt to an agent

Focus the **visible** helper textarea, then type + Enter:
```js
await page.locator('.xterm-helper-textarea').last().focus()
await page.keyboard.type(promptText, { delay: 4 })
await page.keyboard.press('Enter')
```
Or `__podium.sendInput(text + '\r')`. Verify it actually submitted (Claude's composer can hold the text a beat) by polling `screenText()` for the response — and **don't match against your own typed prompt**: the composer text is in `screenText()` too, so scope the match to the output (e.g. the line that *starts with* the expected output, not the echoed command).

## Clicking a terminal cell (links)

xterm has no DOM for cells, so compute pixels from the grid:
```js
const st = await page.evaluate(() => { const s = window.__podium.state(); return { cols: s.cols, rows: s.rows } })
// pick the VISIBLE xterm-screen — the keep-mounted panel deck leaves hidden ones in the DOM:
const box = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.xterm-screen')]
  const el = els.find(e => e.offsetParent !== null && e.getBoundingClientRect().width > 0) ?? els[0]
  const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }
})
// buffer line → viewport row (when pinned to bottom): screenRow = lineIndex - (total - rows)
const x = box.x + (col + 0.5) * (box.w / st.cols)
const y = box.y + (screenRow + 0.5) * (box.h / st.rows)
await page.mouse.move(x, y); await page.waitForTimeout(250); await page.mouse.click(x, y)
```
- **Hover (`mouse.move`) + dwell before clicking** — xterm resolves the link under the pointer lazily; a cold click misses.
- **Retry** a few times re-reading the cell — the hit-test can miss right after render.
- **`screenText()` is the full buffer** (scrollback + viewport), right-trimmed, `\n`-joined; `total = split('\n').length - 1`.
- **Long content wraps** at the terminal width — a long absolute path won't equal any single screen line. Click a short/relative token, or handle the wrap.
- **New tab**: a URL click opens a popup → `context.waitForEvent('page')`.

## Be careful on the live instance

It is the user's real workspace with many live sessions. Only interact with sessions
**you** created. Spawning a session starts a real agent process — clean up (archive/kill)
what you spawn, or tell the user exactly what you left (title + repo) so they can.

## Quick reference — verifying a UI feature on your branch

1. `cd tests/e2e && npx playwright test --project=chromium-desktop` to confirm the harness builds + runs.
2. Add a `*.browser.e2e.ts` spec using `_harness.ts` (or self-navigate as in `clickable-files.browser.e2e.ts`).
3. `--repeat-each=4` to prove it isn't flaky before claiming done.

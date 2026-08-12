# POD-1946 — the diagnostic level, shown and settable, verified in a browser

**Date:** 2026-08-12 · follows [POD-1935](POD-1935-web-client-forwarding.md) in
the logging epic (POD-1897) · acceptance: *"Settings → Privacy → Diagnostic
detail says which level this client is running at right now — boot default vs a
temporary change and when it lifts — and lets you pick any level, with
reset-to-default kept."* This is UI, so the target is the pane in a real
Chromium, not a jsdom render.

## What was there before

POD-1920 shipped the mechanism and one preset on top of it: a paragraph and a
`Turn up for 30 minutes` button. The pane never said what level the client was
at, so a reader could not tell "this client had nothing more to say" from "this
client was never turned up" — and if an operator had raised it from a shell, the
pane still showed the button as though nothing were in force.

## What it is now

`apps/web/src/features/settings/sections/diagnostic-logging.tsx`:

- **A level picker** — `error / warn / info / debug / trace`, straight off
  `LEVELS` in `@podium/logger` so the list cannot drift from the levels that
  exist. The boot level is marked `(default)` in the list.
- **The state in prose**, rebuilt from `logLevelStatus()` on the same 5 s poll
  the old row used: `Running at debug (detailed diagnostics) — a temporary
  change from its usual warn.` at a raise, and `Running at warn (failures and
  warnings), this client's default.` otherwise. It reads the CONTROLLER, so an
  operator's `logs.setLevel` shows up here with no click involved.
- **The expiry, surfaced not reinvented** — a second row appears only while
  something is in force: `Back to warn by itself — 30 minutes left. Nothing is
  saved, so reloading this page returns to warn too.` The deadline is the
  controller's (`createLevelController`, 30 min default / 24 h max); this pane
  keeps no timer of its own.
- **Reset kept**, twice over: the `Back to normal` button, and picking the
  `(default)` level — both send `{ level: null }`, the one path that clears the
  deadline rather than pinning a raise at the level already in force.

**Still one knob.** The only mutation is `applyServerLogLevel`, which is the one
`setLogLevel` in `@podium/client-core/logging`. No threshold was added for
forwarding; the forwarding sink still pins no `minLevel`, so raising this raises
what the console shows and what the client forwards, together.

"Turned up" was deliberately dropped from the copy: the picker can also go
*below* the boot default, and calling that a raise would describe a different
act than the one the reader just performed.

## Verified in Chromium

Stack: this worktree's Vite dev server on `:55571` in front of an isolated
server+daemon on `:18795` (`PODIUM_STATE_DIR` under the session scratch, hooks
and agent-relay on ephemeral ports so the live instance on `:18787`/`45777` was
never touched). Real Chromium, real pointer sequences on the Base UI select.
Each step below is the pane's own text, read out of the DOM:

| step | trigger | row text |
|------|---------|----------|
| **default** | `warn (default)` | Running at warn (failures and warnings), this client's default. Turn it up before reproducing a problem; it comes back down by itself. *(no reset button)* |
| **picker open** | — | `error — failures only` · `warn (default) — failures and warnings` · `info — ordinary activity` · `debug — detailed diagnostics` · `trace — every message in and out` |
| **picked debug** | `debug` | Running at debug (detailed diagnostics) — a temporary change from its usual warn. · **Temporary change**: Back to warn by itself — 30 minutes left. Nothing is saved, so reloading this page returns to warn too. |
| **picked trace** | `trace` | Running at trace (every message in and out) — a temporary change from its usual warn. · 30 minutes left. |
| **Back to normal** | `warn (default)` | Running at warn (failures and warnings), this client's default. *(reset row gone)* |
| **picked error** | `error` | Running at error (failures only) — a temporary change from its usual warn. *(a picker, not a boost: below the default is a choice too)* |

Screenshots: [default](POD-1946/01-default.png) ·
[picker open](POD-1946/02-picker-open.png) ·
[raised to debug](POD-1946/03-raised-debug.png) ·
[back to normal](POD-1946/05-back-to-normal.png) ·
[lowered to error](POD-1946/06-error-level.png).

**The knob really moved, end to end.** Each transition landed in the isolated
server's per-origin client log — `<state>/logs/clients/web.ndjson` — which is
the forwarding path, not the console:

```
{"ts":"2026-08-12T17:03:31.365Z","level":"warn","ns":"client-core:log-level",
 "msg":"client log level raised","to":"debug","ttlMs":1800000,"role":"web"}
{"ts":"2026-08-12T17:03:39.952Z", … "msg":"client log level raised","to":"trace","ttlMs":1800000}
{"ts":"2026-08-12T17:03:41.441Z", … "msg":"client log level restored","from":"trace","to":"warn","reason":"reset"}
```

Two things about the harness, so the next reader does not re-derive them: the
first page load can push the batched tRPC call past the server's 10 s idle
timeout on a cold instance (cold `quota.summary` + `usage.summary`), which 502s
the batch and leaves the settings sheet skeletonised — a reload once warm
renders it, and it has nothing to do with this pane. And `Escape` inside the
sheet closes the SHEET, not the select popup; the popup also stays mounted when
closed, so "is it open" is a visibility question, not a presence one.

## Gates run

Each run directly, no pipe, so the exit status is the suite's own:

| lane | command | result |
|------|---------|--------|
| web settings + logging | `bun --bun vitest run src/features/settings src/lib/logging src/app/trpc.test.ts` (in `apps/web`) | exit 0 — 16 files, 147 tests |
| client-core logging | `bun --bun vitest run src/logging` (in `packages/client-core`) | exit 0 — 3 files, 25 tests |
| types | `bun run typecheck` (repo root, after `bun install`) | exit 0 — 24/24 |
| format | `bunx biome check --write` on the two touched files | clean |

The pane's own suite (`diagnostic-logging.test.tsx`, 9 tests) grew four cases
for this chunk: the level in force reads as the boot default; every level is on
offer, up AND down; an operator-pushed raise shows without anyone touching the
picker; and picking the default is a reset rather than a raise held there.

Boundary lint (`bun run lint:boundaries`) reports two violations, both
pre-existing and in files this change does not touch (`apps/server/src/store.ts`
console-ownership, `apps/web/src/features/git/DiffSheet.tsx` storage-ownership).

## What this does not cover

The mobile client has no diagnostic-detail pane; this is the web one. And the
row still polls rather than subscribing — 5 s is fast enough that it cannot
claim "raised" long after the TTL lifted, and a listener list in a module every
client imports is the cost this deliberately does not pay.

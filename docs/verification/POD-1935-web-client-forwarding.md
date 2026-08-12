# POD-1935 — the web client's logs, verified against the deployed build

**Date:** 2026-08-12 · fixes the defect found live after
[the logging epic](../superpowers/specs/2026-08-11-logging-strategy-plan.md)
shipped · acceptance: *"a thrown async error in the running web app produces a
crash event on the server containing the ring buffer, and warn-level records
land in a per-origin client log"* — **on the bundle ludovico is actually
serving**, not an isolated harness. POD-1903 verified the same sentence against
a worktree stack and the shipped build still went dark, which is why the target
is stated this way.

## What was actually wrong

The transport was never broken. Before changing a line, the deployed bundle was
driven with headless Chromium and a minted login session:

```
POST /trpc/logs.crash?batch=1    -> 200
POST /trpc/logs.crash?batch=1    -> 200
POST /trpc/logs.forward?batch=1  -> 200
```

`installClientLogging` runs at boot (the top-level `startWebLogging()` call
survives minification in `index-E9NwgP3Z.js`), the forwarding sink is
registered, the namespace level sits at `warn`, `toForwarded` produces a batch,
and the tRPC call is issued. Every yes/no in the brief's list answered yes. The
server half answered too: a hand-made `logs.forward` over curl returned
`{"accepted":1,"origin":"web-probe1935"}` and created its file.

And `~/.podium/logs/clients/web.ndjson` already existed on the live host — two
records, written at 14:27:44Z, carrying the very `TypeError: Cannot read
properties of undefined (reading 'kind')` the report says never arrived. The
matching crash event was on disk as
`logs/crashes/20260812T142744289-z24d5z.json`.

Two measurements in the report were reading the wrong instrument. Forwarded
client records go to per-origin **files**, never to the server's stdout, so
`journalctl … role=web` is silent by design however well forwarding works. And
the client dir is created by the first record that arrives, so "never created"
meant "nothing had been sent yet", not "sending is broken".

**The real defect: the client had nothing to say.** That crash event's ring
buffer — a 500-slot flight recorder pinned at `trace` — contained exactly the
crash's own two records after twenty minutes of a live, failing app. The whole
web app had eight logger call sites and not one of them on a failure path. The
hundreds of `issues.markRead` 500s, the 502s across the restart and the socket
drops all went to `console.error` and nowhere else: nothing was ever offered to
the logger, so the queue stayed empty, the file was never created, and a crash
report shipped a flight recorder with no flight in it.

## The fix

Three producers, all on paths that already knew something had gone wrong:

- **`apps/web/src/app/trpc.ts`** — one `reportingFetch` shared by every tRPC
  client in the app. A refused or unsendable call is a `warn` naming the
  procedure and the status. `logs.*` is exempt **by path**, not by convention:
  a failed `logs.forward` that logged would hand the record to the sink whose
  send just failed and mint another on every retry.
- **`packages/client-core/src/socket-transport/socket-hub.ts`** — `info` on
  connect (saying whether it is a reconnect), `warn` on an unintentional drop
  with its retry delay, `debug` per reconnect attempt, `warn` when the socket
  cannot be constructed at all.
- **`apps/web/src/lib/logging/index.ts`** — one `info` boot line, so a crash
  ships a buffer that begins by saying which page this was.

No threshold was added to the forwarding sink; it still follows the namespace
level, and `setLogLevel` remains one knob.

## Verification, on the deployed build

Landed on `main` as `f291c86a3`, then `bun run --filter @podium/web build` in
the live checkout, which is what `podium-web.service` runs. The server began
serving `assets/index-D0uzC_q0.js`; the probe asserts the bundle it loaded.

Headless Chromium, live server on `:18787`, real login cookie. One non-logs
procedure was failed at the network layer to reproduce the shape of the
`markRead` flood, `logs.*` left alone so what it produced could ship:

```js
await page.route('**/trpc/quota.summary*', (route) => route.fulfill({ status: 500, … }))
// …app boots, runs 25 s…
void Promise.reject(new Error('POD-1935 acceptance: async throw'))
```

**Warn records in the per-origin client log** —
`~/.podium/logs/clients/web.ndjson`:

```
15:15:33.152Z warn client-core:socket-hub  socket closed — reconnecting  retryInMs=500
15:15:33.201Z error web:crash              POD-1935 acceptance: async throw
15:15:33.203Z warn web:trpc                trpc call failed  path=quota.summary,settings.get,… status=500
```

**The crash event with the ring buffer** —
`~/.podium/logs/crashes/20260812T151533639-floufv.json`:

```
origin: { role: web }   err: POD-1935 acceptance: async throw   snapshot: 4 records
  info  web:boot                web client booted           path=/
  info  client-core:socket-hub  socket connected            reconnect=false
  warn  client-core:socket-hub  socket closed — reconnecting
  error web:crash               POD-1935 acceptance: async throw
```

That snapshot is the difference the fix makes: on the same page a day earlier it
would have held one line — the crash itself.

## Gates run

Focused lanes, each run without a pipe so the exit status is the suite's own:

| lane | command | result |
|------|---------|--------|
| web | `bun --bun vitest run src/app/trpc.test.ts src/lib/logging` (in `apps/web`) | exit 0 — 3 files, 16 tests |
| client-core | `bun --bun vitest run src/socket-transport src/logging` (in `packages/client-core`) | exit 0 — 11 files, 130 tests |
| types | `bun run typecheck` (repo root, after `bun install`) | exit 0 — 24/24 |
| format | `bunx biome check` on the six touched files | clean after `--write` |

## What this does not cover

`console.error` from React and from libraries is still invisible to the logger —
deliberately, since a console bridge would double every record that already goes
through both. What changed is that the app's own failure paths no longer rely on
the console being watched.

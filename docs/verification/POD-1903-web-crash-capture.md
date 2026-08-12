# POD-1903 — web crash capture, verified in the running app

**Date:** 2026-08-12 · **Chunk 4** of
[the logging plan](../superpowers/specs/2026-08-11-logging-strategy-plan.md) ·
acceptance: *"a thrown async error in the web UI produces a crash event on the
server containing the ring buffer"*.

Unit tests prove the pieces. This is the acceptance sentence itself, run against
a real browser and a real server, because the thing most likely to be wrong is
the wiring between them and no unit test spans it.

## The stack

An **isolated** server from this worktree (`PODIUM_STATE_DIR=/tmp/podium-1903-iso`,
`PODIUM_PORT=18790`, no daemon) behind the app's own Vite origin on `:55571`.
Isolated because the live dev host on `:18787` runs from the *main* checkout,
which has neither this chunk nor chunk 3's `logs.*` router — verifying against
it would have measured the wrong tree. The live server was confirmed healthy
before and after; the isolated state dir was removed.

A fresh state dir has no per-user credentials, so `clientAuthGuard` does not
require a login session and `/trpc` is reachable — which is what let a headless
Chrome exercise the path without a login flow.

## What was triggered

Headless Chromium (Playwright) loaded the app and evaluated the two producers
that no error boundary can see:

```js
setTimeout(() => { throw new Error('POD-1903 runtime crash probe') }, 0)
void Promise.reject(new Error('POD-1903 runtime rejection probe'))
```

## What the server received

Three calls, unprompted by anything but the throws:

```
POST /trpc/logs.crash?batch=1      <- window.onerror
POST /trpc/logs.crash?batch=1      <- unhandledrejection
POST /trpc/logs.forward?batch=1    <- the 5 s batch flush behind them
```

`/tmp/podium-1903-iso/logs/crashes/20260812T011244365-1l6g4o1.json`, abridged:

```json
{
  "origin": { "role": "web" },
  "err": { "name": "Error", "message": "POD-1903 runtime rejection probe", "stack": "…" },
  "snapshot": [
    { "level": "error", "ns": "web:crash", "msg": "POD-1903 runtime crash probe",
      "source": "window.onerror", "lineno": 3, "role": "web", "platform": "…HeadlessChrome…" },
    { "level": "error", "ns": "web:crash", "msg": "POD-1903 runtime rejection probe",
      "source": "unhandledrejection", "role": "web", "platform": "…" }
  ],
  "context": { "source": "unhandledrejection" },
  "id": "1l6g4o1",
  "receivedAt": "2026-08-12T01:12:44.365Z"
}
```

The acceptance sentence is the `snapshot` array: the second crash ships the
first one as history, which is the flight recorder doing exactly the job it
exists for. The forwarding sink independently appended both records to
`logs/clients/web.ndjson`, tagged with the same origin.

## Two honest notes

- **`origin.v` is absent above.** `podium-build.json` is written by
  `apps/web`'s build, so a Vite dev origin 404s it and the version stays
  unset — handled, not broken. A built bundle carries it.
- **The `ErrorBoundary` component-stack path is covered by unit tests, not by
  this probe.** Forcing a React render throw from outside the app would have
  meant shipping a test hook into the bundle to prove a boundary that
  `ErrorBoundary.test.tsx` already asserts against real React.

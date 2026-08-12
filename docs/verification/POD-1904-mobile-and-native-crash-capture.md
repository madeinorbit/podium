# POD-1904 — mobile and native crash capture, verified against a running server

**Date:** 2026-08-12 · **Chunk 5** of
[the logging plan](../superpowers/specs/2026-08-11-logging-strategy-plan.md) ·
acceptance: *"a forced mobile error and a forced Rust panic both surface as
server-side crash events"*.

Two producers, two runs, one acceptance sentence each. Unit tests prove the
pieces; this is the wiring between them, which is the part no unit test spans —
and for the native half the seam is genuinely load-bearing, because a Rust panic
reaches the server through a hand-off that happens on a LATER LAUNCH.

## The stack

An isolated server from this worktree — `PODIUM_STATE_DIR` in a scratch dir,
`PODIUM_PORT=18793` for the mobile run and `18792` for the native one, no
daemon. Isolated for chunk 4's reason: a server from the main checkout has
neither this chunk nor chunk 3's `logs.*` router, so verifying against it would
have measured the wrong tree. A fresh state dir has no credentials, so
`clientAuthGuard` does not require a login session and `/trpc` is reachable.
Both scratch servers were stopped afterwards.

---

## 1. The mobile error

`apps/mobile/src/lib/logging.ts` was run as the app runs it — the real
`installMobileLogging` over chunk 4's shared `installClientLogging`, the real
`createFetchLogTransport` against the real server, and a stand-in `ErrorUtils`,
which is all React Native's global handler is (an object with
`setGlobalHandler`). No mocks below that line.

```ts
createLogger('mobile:probe').debug('phone did something unremarkable', { step: 1 })
createLogger('mobile:probe').warn('POD-1904 mobile forward probe')
globalHandler(new Error('POD-1904 mobile crash probe'), true)   // what ErrorUtils delivers
```

`logs/crashes/20260812T015757893-614qa4.json`, abridged:

```json
{
  "origin": { "role": "mobile", "v": "1904-probe" },
  "err": { "name": "Error", "message": "POD-1904 mobile crash probe", "stack": "…" },
  "snapshot": [
    { "level": "info",  "ns": "mobile:boot",  "msg": "log capture installed",
      "rejectionCapture": "none", "uncaughtCapture": true },
    { "level": "debug", "ns": "mobile:probe", "msg": "phone did something unremarkable", "step": 1 },
    { "level": "warn",  "ns": "mobile:probe", "msg": "POD-1904 mobile forward probe" },
    { "level": "error", "ns": "mobile:crash", "msg": "POD-1904 mobile crash probe",
      "source": "ErrorUtils", "isFatal": true }
  ],
  "context": { "source": "ErrorUtils", "isFatal": true }
}
```

Every record carries `"role": "mobile", "v": "1904-probe", "platform": "ios"`.

**The `debug` record is the point.** It is below the forwarding threshold and
was never forwarded — `logs/clients/mobile.ndjson` holds exactly two lines, the
`warn` and the crash — yet it is in the crash payload, because the ring buffer
takes everything at `trace`. That is the flight recorder doing the job it exists
for: context nobody would have chosen to pay for, available for the one minute
that mattered.

## 2. The Rust panic

A real panic, in a real process, with the real hook installed
(`cargo run --example native_crash_handoff`, which panics under `catch_unwind`
so it survives to print). The hook wrote
`logs/desktop-native.ndjson` and queued the record; the example then printed the
hand-off script the next launch would inject.

That script was executed by a JS runtime with only two globals shimmed —
`window.__PODIUM_SERVER__ = 'ws://127.0.0.1:18792'` and a `tauri:` page
protocol, which is the all-in-one shape where the ws→http mapping has to work —
and its `fetch` was the real one against the real server.

`logs/crashes/20260812T014823074-10lqfrm.json`, abridged:

```json
{
  "origin": { "role": "desktop-native", "v": "0.1.0-probe", "machineId": "probe-machine" },
  "err": {
    "name": "RustPanic",
    "message": "POD-1904 native panic probe (at examples/native_crash_handoff.rs:30:9)",
    "stack": "RustPanic: POD-1904 native panic probe\n    at examples/…:30:9\n   0: podium_desktop_lib::logging::install_panic_hook::{{closure}}\n   …"
  },
  "context": { "source": "native-panic" }
}
```

### How a Rust panic reaches the server, in one paragraph

The panic hook cannot post it. Release builds are `panic = "abort"`, so the
process is gone microseconds later, and the session cookie `/trpc` requires
lives in the webview's cookie store, not in Rust. So the hook does two durable
writes instead — the NDJSON record, and an entry on a bounded pending-crash
queue — and the NEXT launch reads and CLEARS that queue and embeds it in the
webview's initialization script, which POSTs each record to `logs.crash`. This
is the standard native crash-reporter shape, and it has one consequence worth
knowing when reading the data: **a crash event's `ts` can predate the launch that
filed it.** The hand-off is at-most-once by choice — the record stays in
`desktop-native.ndjson` either way, and a retry loop against a server that is
down would replay a week of panics into an incident that has passed.

## The retention question, answered

A next-launch replay writes a crash event whose `ts` predates it, so the
30-day bound matters: if it pruned on the crash `ts`, a user who crashes, does
not reopen Podium for a month, and then does would have that crash written and
immediately discarded — the one crash most worth having, because it is the one
that stopped them using the app.

It prunes on WRITE TIME. `packages/runtime/src/crash-store.ts` derives every
entry's age from the FILENAME stamp, which is `stamp(receivedAt)` — the moment
the server stored it — and never opens the file to read `ts`. A replayed panic
is therefore a fresh event with an old `ts` inside it, and it survives.

## Three honest notes

- **The native run did not go through a Tauri webview.** Building the desktop
  bundle needs ~5 GB of Rust artifacts and the machine had 4.9 GB free; what was
  exercised instead is every link except the webview's `initialization_script`
  call itself — the real hook, the real queue file, the real generated script,
  the real endpoint. `bootstrap.rs`'s unit tests cover that the script is
  assembled into the init string; nothing between the panic and the server is
  assumed.
- **The mobile run did not go through Metro or a device.**
  `apps/mobile/src/lib/logging.ts` imports nothing from `react-native`, on
  purpose — the platform surfaces are injected — so the module under a plain
  runtime is the same module the phone runs. What a device would additionally
  exercise is Hermes' `enablePromiseRejectionTracker` branch, which is covered by
  unit tests and reported in the boot line (`rejectionCapture` reads `none` above
  precisely because the probe scope had neither surface).
- **`origin.v` is a build-time inline** (`EXPO_PUBLIC_APP_VERSION`, else `dev`),
  matching the server family's `PODIUM_APP_VERSION` convention. The probe passed
  one explicitly.

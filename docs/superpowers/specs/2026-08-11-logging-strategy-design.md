# Logging Strategy — Design Spec

**Date:** 2026-08-11
**Issue:** POD-1897 (Logging strategy and pipeline)
**Status:** Approved design, pending spec review

## Problem

Podium has no logging layer. ~470 raw `console.*` calls use a loose `[podium:x]`
prefix convention; server/daemon output lands in unbounded, unrotated
`~/.podium/logs/<role>.log` files (detached mode) or journald (systemd mode).
There are no levels, no structure, no verbosity control, and no correlation
between client and server. Clients capture only React render errors — async
errors and unhandled promise rejections vanish on web, mobile, and desktop.
The existing `@podium/telemetry` package has a fully built, consent-gated
`crash` tier with **zero call sites**: nothing ever feeds it.

This spec defines the logging layer that fixes all of the above and prepares
for crash reporting (Sentry-compatible, vendor decision deferred).

## Goals

1. One logger API used by every runtime: Bun server, daemon, janitor, CLI,
   browser (web), Tauri (Rust + webview), React Native (Expo).
2. Well-defined levels, applied consistently, controllable at runtime.
3. Structured records (NDJSON) with bound context: version, role, platform.
4. Sane storage: rotation for files, journald under systemd, server-side
   collection of client logs and crash events.
5. Crash capture wired end-to-end into the existing telemetry `crash` tier.
6. Pluggable delivery so Sentry (or GlitchTip / first-party relay) is a later,
   isolated sink decision — not a rewrite.

## Non-goals

- Metrics and distributions. `loop-metrics` and `/trpc/perf.snapshot` remain
  the aggregation layer. The logger records *events*; it must not be used to
  derive percentiles or counters. No "perf" level exists (severity is an
  attention axis, not a category); performance data rides as fields
  (`durationMs`) on normal records, with budget overruns logged at `warn`.
- Distributed tracing (spans, trace ids). The sink interface leaves the door
  open for OpenTelemetry later; not in scope now.
- Persisting the client ring buffer across reloads (crash-on-boot loops).
  Deliberate YAGNI; revisit if boot loops become a real support burden.
- Choosing the crash-reporting vendor. Self-hosted Sentry or GlitchTip fits
  the existing privacy posture better than sentry.io; decided later.

## Architecture

### Logger core — `packages/logger` (`@podium/logger`)

A thin custom core (~200 lines), not pino/winston: those are Node-centric and
we need identical behavior in Bun, browser, and React Native.

- `const log = createLogger('server:events')` — namespace formalizes the
  existing `[podium:x]` convention.
- Five levels: `error`, `warn`, `info`, `debug`, `trace`.
- Structured fields: `log.warn('sync failed', { machineId, attempt })`.
- Child loggers bind context: `log.child({ sessionId })`.
- Process-bound context attached once at boot: app version (existing
  `PODIUM_APP_VERSION` / `serverBuildVersion()`), role (`server` | `daemon` |
  `janitor` | `cli` | `web` | `desktop` | `mobile`), instance, platform.
- **Sinks** are the extension point. A sink receives every record and applies
  its own level threshold. The logger must be dependency-free and safe to
  import from the browser bundle (guarded by `audit-browser-reach`).
- Logging must never break the app: sinks are fail-open; a throwing or
  unreachable sink is disabled/degraded, never propagated.

### Record shape (NDJSON)

```json
{"ts":"2026-08-11T14:03:22.847Z","level":"warn","ns":"daemon:pty",
 "msg":"resize dropped","sessionId":"…","role":"daemon","v":"0.1.3"}
```

- `ts` is ISO-8601 with millisecond precision — mandatory on every record.
  Caveat stated for users of the data: cross-machine timestamp deltas are
  bounded by clock sync; for intra-process durations use a `durationMs` field
  from a monotonic clock, not timestamp subtraction.
- Reserved keys: `ts`, `level`, `ns`, `msg`, `role`, `v`, `err` (serialized
  error: name, message, stack). All other keys are free-form fields.
- No PII in fields, by convention and review; the telemetry scrubber remains
  the hard gate for anything leaving the user's infrastructure.

### Level semantics

| Level | Meaning | Example |
|---|---|---|
| `error` | Broken invariant; needs attention | unhandled exception, failed write |
| `warn` | Degraded but recovering / budget overrun | retry, slow op, dropped frame |
| `info` | Lifecycle events | boot, shutdown, session start, config load |
| `debug` | Diagnosis detail | state transitions, RPC summaries |
| `trace` | Firehose | per-frame / per-message detail |

Control: `PODIUM_LOG_LEVEL` (global default) plus per-namespace overrides via
`PODIUM_LOG` (e.g. `PODIUM_LOG="daemon:*=debug"`). Defaults: `info` on
server/daemon/janitor, `warn` for browser console. Runtime adjustment on
clients via config/settings (needed to live-diagnose one user's client).

### Sinks and per-sink thresholds

One stream of records fans out; each sink filters independently:

| Sink | Runs in | Default threshold | Purpose |
|---|---|---|---|
| Console | all | `warn` prod / `debug` dev | developer visibility |
| File (NDJSON, rotating) | server, daemon, janitor, CLI (detached mode) | `info` | durable local logs |
| Stdout NDJSON | server-family under systemd | `info` | journald owns retention |
| Ring buffer | all clients (web, desktop webview, mobile); optional on server | **all levels, always** | flight recorder |
| Forward-to-server | clients | `warn` (config-controlled) | central collection |
| Telemetry crash | server only | n/a (event-driven) | consent-gated vendor hop |

The ring buffer is a sink like any other — nothing bypasses the logger
(Tauri's Rust side is bridged in, see below). It keeps the last ~500 records
of *every* level in bounded memory, evicting oldest-first. Records below a
persistent sink's threshold still exist in the buffer — that is the point:
`debug`/`trace` context is available for the minute that mattered, paid for
only in memory, and shipped only when a crash event fires.

### Emission gate (addendum, ratified during chunk 1)

A record is constructed and dispatched when **any registered sink would
accept it** — the loosest threshold wins. The namespace/global level is not
an emission gate; it configures the sinks that follow config.

This is what makes "the ring buffer keeps every level, always" literally
true: with a buffer registered at `trace`, `debug` records still reach it
while the console sits at `warn`. The consequence, which downstream chunks
inherit: `PODIUM_LOG_LEVEL` and `PODIUM_LOG` steer the console/file/forward
sinks and never quieten the flight recorder. They are verbosity controls,
not a global mute.

Cost follows from this: call sites materialise a record whenever the buffer
is registered — roughly 1 µs, against ~60–110 ns when no sink would take it
(measured under load during chunk 1; order of magnitude, not a benchmark).
At a few hundred records a second that is nothing; at PTY-frame or
feed-rebuild rates it is real.

The logger therefore carries **two** predicates, and hot paths must use the
second one:

- `isLevelEnabled(level)` — will *any* sink consume this, flight recorder
  included. Once the ring buffer is pinned at `trace` this is permanently
  true for every level, so **guarding a hot path on it pays the full record
  cost anyway**. It is the predicate that looks right and does nothing.
- `isLevelRequested(level)` — did *configuration* ask for this level in this
  namespace, ignoring sinks that pin their own threshold. Defaults to false,
  so cost is paid only when an operator turns the namespace up. This is the
  hot-path guard: ~1300 ns becomes ~39 ns.

The trade belongs to the call site: guarding also keeps those records **out**
of the flight recorder, so a crash on that path arrives without per-frame
context. Guard where volume is genuinely high; prefer unguarded `trace`
everywhere else so the buffer stays worth shipping.

### Browser entrypoint constraint (addendum, ratified during chunk 1)

`@podium/logger` is a declared browser entrypoint in the architecture
manifest, and its tsconfig extends `dom.json` rather than `node.json` so
`process` stays untyped (env reads go through `globalThis` with an explicit
cast). All Node-only sinks — file, rotation, stdout — must therefore live
behind the `./node` subpath. Importing them from the barrel is what
`scripts/audit-browser-reach.ts` exists to refuse; this is a hard
constraint, not a style preference.

### Storage and rotation

- **Detached mode:** file sink writes NDJSON to `~/.podium/logs/<role>.ndjson`
  with in-process size-based rotation: 10 MB per file, 5 files kept
  (`<role>.ndjson`, `.1` … `.4`). The existing `spawnDetached` fd-append path
  is replaced by the sink; stray stdout/stderr still lands in the legacy
  `<role>.log` as a safety net.
- **systemd mode:** NDJSON to stdout, journald inherits (as today, but
  structured). No double-writing. `podium logs` keeps working in both modes.
- **Client logs on the server:** forwarded client records are written by the
  server into per-origin rotating files under the server's log dir, tagged
  with client role/version/machine. Same rotation policy.
- **Crash events:** stored server-side (see below) with bounded retention:
  last 50 crash events or 30 days, whichever is smaller.

### Client → server forwarding

- Batched (e.g. flush every 5 s or 50 records), bounded queue, fail-open:
  if the server is unreachable, drop oldest; never block or break the app.
- Transport: authenticated tRPC/HTTP endpoint on the server.
- Default `warn`+; raising a client's level to `debug` forwards debug too.
- Rationale: Podium is self-hosted — the client's server is the *user's own*
  server, so forwarding is not disclosure. In the future SaaS topology we are
  the operator and server-side collection is standard practice. In both cases
  no consent gate applies to this hop.

### Crash capture (end-to-end)

1. **Producers** — the currently missing handlers:
   - Web: `window.onerror` + `unhandledrejection`; keep/extend the existing
     `ErrorBoundary` (stop discarding `ErrorInfo` component stacks).
   - Mobile: `ErrorUtils.setGlobalHandler`.
   - Desktop: Rust panic hook + `log` crate bridged into the pipeline (via
     the webview logger or its own file sink); webview inherits web handlers.
   - Node/Bun processes: `installProcessSafetyNet` routes through the logger.
2. **Delivery:** a client crash always ships the error plus the full ring
   buffer to its server, stored as a **crash event** — unconditionally, both
   self-hosted and SaaS.
3. **Vendor hop:** the server (sole telemetry emitter, per SP-f933) feeds
   `telemetry.recordCrash()` — the dormant call site finally wired. Only the
   scrubbed signature leaves the installation, gated by the existing `crash`
   consent tier in Settings → Privacy. No new consent surface.
4. **Support flow:** because rich crash events already sit on the user's
   server, support can request a deliberate export
   (`podium logs export-crash` / a settings button) — a conscious user act,
   no standing opt-in needed for the full data.

### Migration and enforcement

- Sweep `console.*` → logger per package, in order: server, daemon,
  client-core, web, runtime/harness, mobile, desktop. CLI user-facing stdout
  is *output*, not logging, and stays `console`/direct writes; CLI
  diagnostics move to the logger.
- Afterward, a lint boundary forbids raw `console.*` outside the CLI output
  paths and the logger package itself, so it cannot creep back.

## Error handling

- Sinks fail open and independently; one broken sink never affects others.
- The forwarding sink degrades to drop-oldest under backpressure and retries
  with jittered backoff; it must not create log-about-logging loops (its own
  failures log at most once per interval, locally only).
- Rotation errors (ENOSPC etc.) degrade the file sink to console and emit a
  single local warning.

## Testing

- Unit: level filtering per sink, child-context binding, NDJSON shape,
  ring-buffer eviction, rotation (size trigger, file count), forwarding
  batching/drop behavior — all in `packages/logger`.
- Server: crash-event ingestion endpoint (auth, bounds, retention), wiring
  from safety net to `recordCrash` (extend existing telemetry tests).
- Client handler wiring verified at runtime per testing policy (UI changes
  need runtime verification); no long E2E flows for this.

## Decomposition (implementation sub-issues)

1. `@podium/logger` core + console/ring-buffer sinks + level/env control.
2. File sink with rotation + stdout/systemd mode + server/daemon/janitor/CLI
   adoption of the logger at boot.
3. Server ingestion: forwarding endpoint, per-origin client log files, crash
   event storage + retention + export command.
4. Web + desktop webview wiring: global handlers, forwarding sink,
   ErrorBoundary component-stack fix.
5. Mobile + Tauri Rust wiring: `ErrorUtils`, panic hook, Rust log bridge.
6. Crash-tier wiring: safety net → logger → `recordCrash`; scrubber
   round-trip test.
7. Console sweep + lint boundary (last, after the API is proven).

Each is independently shippable in that order; 1 blocks all, 3 blocks 4–6's
delivery paths (handlers can land before ingestion with buffer-only mode).

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
server/daemon/janitor, `warn` for browser console.

**Runtime level adjustment on clients is DEFERRED** (POD-1919). The
mechanism exists — the forwarding sink pins no `minLevel`, so `setLogLevel`
raises console and forwarding together as one knob — but nothing outside
boot calls it, so there is no operator surface for "raise this one user's
client to `debug`". That scenario is why the forwarding design exists, so
the gap is worth closing; it is deferred rather than dropped, and this epic
ships without it deliberately rather than leaving the promise silently
unmet.

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

### Serialized crashes and the scrubber (addendum, ratified during chunk 3 planning)

`TelemetryEmitter.recordCrash(err)` already calls `scrubError` internally,
along with the consent gate, the per-window cap and the cooldown. Ingestion
therefore hands it a throwable and **must not** scrub first.

That exposes a defect at the wire boundary. `scrubError` derives
`errorType` from `err.constructor?.name` behind an `err instanceof Error`
guard, but a forwarded client crash arrives as a serialized
`{name, message, stack}`. Reconstructing a plain `Error` from it makes
`constructor.name` be `'Error'` for every client crash — and `'Error'` is a
member of the closed `ErrorType` enum, so it is silently accepted rather
than folded to `'Other'`. Two consequences: a client `TypeError` reports as
`Error`, and since `crashSignature` is `errorType@topFrame` **and** the
rate-limit key, unrelated crash families sharing a top frame would suppress
each other through the cooldown.

**Decision: widen `scrubError` to accept a serialized error shape**
(`{name?, stack?}`) alongside a real `Error`, taking `errorType` from `name`
via the existing `normalizeErrorType`. Rejected alternatives:

- *Map known names back onto real constructors at ingestion* — brittle,
  covers only an enumerated set, and fabricates an `Error` solely to read
  its constructor name back out.
- *Give the emitter a pre-scrubbed entry point* — creates a path by which a
  caller can submit unscrubbed data to the vendor hop. The scrubber must
  stay the single, unavoidable gate.

The widening preserves every existing property: the enum stays closed
(unknown names still fold to `'Other'`, so no new leak surface), stack
scrubbing is unchanged, and there remains exactly one scrubbing path.

### Known limitation: client crashes do not reach the vendor tier (POD-1915)

Goal 5 is met for **storage** but not yet for the anonymous crash tier. A
browser or React Native stack frame is a URL into the served bundle
(`http://host:7777/assets/index-abc.js:1:2`), so `scrubFrame`'s
install-containment test drops every frame, `frames` comes back empty, and
`recordCrash` returns early.

So today: a real web or mobile crash **does** reach durable server-side
storage and `podium logs export-crash` — which is the support path, and the
one that matters for a user emailing about a problem — but contributes
nothing to the consent-gated tier that would feed Sentry. Server-origin
crashes are unaffected.

Resolving it is a **privacy decision on the scrubber's rules**, owned by the
telemetry spec (SP-f933), not by any chunk of this epic. The two candidate
answers: map same-origin bundle URLs onto install-relative asset paths, or
accept client crashes as storage-only and say so in `docs/TELEMETRY.md`.
Tracked as POD-1915.

### Migration and enforcement

- Sweep `console.*` → logger per package, in order: server, daemon,
  client-core, web, runtime/harness, mobile, desktop. CLI user-facing stdout
  is *output*, not logging, and stays `console`/direct writes; CLI
  diagnostics move to the logger.
- Afterward, a lint boundary forbids raw `console.*` outside the CLI output
  paths and the logger package itself, so it cannot creep back.

### Sink async contract and lifecycle (addendum, ratified after the chunk-1 review)

`write(record)` is synchronous and returns void, and it **must never
reject**. Fail-open dispatch can only catch synchronous throws, so a sink
that rejects asynchronously would escape isolation entirely, surface as an
`unhandledRejection`, and not be disabled — the precise failure the
"logging never breaks the app" rule exists to prevent. **A sink owns its own
async errors**, including its own retry, disable and degrade behaviour.

`Sink` therefore also carries two optional lifecycle members:

- `flush?(): Promise<void>` — settle what is buffered; resolves when it is
  durable. Needed for shutdown drain (chunk 2) and flush-before-crash-ship
  (chunks 3 and 4).
- `close?(): Promise<void>` — release the sink's resources. **Implies a
  final flush**, so a caller never has to flush first to avoid losing the
  tail.

Concretely: the file sink's ENOSPC degrade is swallowed inside the sink and
falls back to console; the forwarding sink's network failures never leave
its own boundary.

**A sink must not mutate the record it is given.** Records are shared by
reference across every sink and with the ring-buffer snapshot, so an
in-place edit rewrites another sink's history and corrupts the crash
payload — at the crash-ship end, where nobody is looking. If a sink needs a
shaped object, it builds a new one. The tempting violation is stamping
state (a degrade flag, a normalised field) onto the record before
serialising; put it in the sink's own output instead.

The rule is **enforced, not trusted**: `buildRecord` freezes the finished
record under `NODE_ENV` `test`/`development` or `PODIUM_LOG_FREEZE=1`.
Modules are strict mode, so a mutating sink throws, fail-open dispatch
disables it, and the existing local warning names it — the violation becomes
a failure in the offending sink's own test run rather than a corrupted crash
report weeks later. Production pays one cached boolean and no freeze. The
freeze is **shallow**: a nested field object is still mutable, so it catches
the common violation, not every one.

Two chunks will meet this head-on and should know before they write the
code, not after:

- **Chunk 2** (file sink): transform by building a new record; never
  normalise, sort, stamp or annotate in place. Degrade state belongs in the
  sink's own output, not on the record.
- **Chunk 3** (ingestion): a scrubber that redacts **in place** is the
  natural way to write it and will now throw in dev. Return a scrubbed
  *copy*. This is the freeze doing its job — an in-place scrubber would also
  be rewriting the ring-buffer history that the crash payload ships.

This contract is what lets `snapshot()` return a new array over the *same*
record objects rather than deep-copying: a deep copy costs on the crash path
and can throw on a field that resists cloning, which would turn crash-ship
into a second crash. The shared references are pinned by a test, so
switching to a copy later is a deliberate decision rather than a silent
change of meaning.

**Draining: scope matters.** The module-level `flushSinks()` and
`closeSinks()` helpers are for **whole-process** shutdown and crash-ship,
where tearing down everything is the intent. A *component* drains through
the handle that owns the sink it registered — `closeSinks()` empties the
whole registry, and the all-in-one desktop sidecar runs several components
in one process, so a registry-wide close during one component's shutdown
would tear down a sink another component is still writing to.

Two asymmetries in those helpers, both deliberate: a failed **write**
unregisters the sink, a failed **flush** does not (flush runs at shutdown
and crash-ship, where disabling a sink would discard the very records being
saved); and `closeSinks()` empties the registry even if a close fails,
because a sink whose handle is gone must not still be receiving.

### Console sink default (addendum, ratified after the chunk-1 review)

The sink table above says the console sink defaults to `warn` in prod and
`debug` in dev. In the implementation the console sink **follows config**
rather than baking in a threshold. The browser's `warn` default is therefore
a boot-time `setLogLevel` call in the client, not a property of the sink —
chunk 4 must set it explicitly rather than assume it.

## Error handling

- Sinks fail open and independently; one broken sink never affects others.
  Asynchronous failures are the sink's own responsibility (see the sink
  async contract addendum) — dispatch cannot see them.
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

**Superseded — the plan is authoritative.** This section originally listed
seven items; the crash-tier wiring became part of chunk 3 rather than a
chunk of its own, and chunks 2 and 3 turned out to be strictly sequential.
See the sequencing table in
`2026-08-11-logging-strategy-plan.md`, which carries the live decomposition
and blocker lineage:

| # | Chunk | Issue |
|---|---|---|
| 1 | Logger core package | POD-1900 |
| 2 | Server log sinks and rotation | POD-1901 |
| 3 | Crash events and log ingestion (incl. the `recordCrash` wiring) | POD-1902 |
| 4 | Web crash and log capture | POD-1903 |
| 5 | Mobile and Tauri log capture | POD-1904 |
| — | Epic review fixes | POD-1906 |
| 6 | Console sweep and lint gate | POD-1905 |

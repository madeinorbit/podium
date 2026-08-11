# Logging Strategy — Implementation Plan

**Date:** 2026-08-11
**Issue:** POD-1897 (Logging strategy and pipeline)
**Spec:** [2026-08-11-logging-strategy-design.md](2026-08-11-logging-strategy-design.md)

The spec decomposes into six chunks. Each is sized for a single agent session
to implement, test, and take through review; each lands independently on main
in dependency order. Blockers are listed per chunk.

```
1 Logger core ──┬─▶ 2 Server sinks/rotation ──┐
                ├─▶ 3 Ingestion + crash events ─┬─▶ 4 Web capture ──┐
                │                               └─▶ 5 Mobile/Tauri ─┼─▶ 6 Console sweep + lint
                └───────────────────────────────────────────────────┘
```

## Chunk 1 — Logger core package

**Blockers:** none.
**Scope:** New `packages/logger` (`@podium/logger`), dependency-free,
browser-safe (must pass `scripts/audit-browser-reach.ts`).

- `createLogger(ns)`, five levels (`error|warn|info|debug|trace`),
  structured fields, `log.child({...})` context binding.
- Process context set once at boot: `role`, `v` (app version), platform.
- Sink interface: `{ minLevel, write(record) }`, fan-out, fail-open (a
  throwing sink is disabled after one local warning; never propagates).
- Record shape per spec: `ts` (ISO-8601 ms), `level`, `ns`, `msg`, `role`,
  `v`, `err` (name/message/stack serializer), free-form fields.
- Level control: `PODIUM_LOG_LEVEL` global + `PODIUM_LOG` per-namespace
  overrides (`"daemon:*=debug"`), plus a programmatic setter (clients have
  no env).
- Built-in sinks: **console** (pretty in dev, level-thresholded) and
  **ring buffer** (all levels always, configurable capacity, default 500,
  oldest-first eviction, `snapshot()` accessor).

**Tests:** unit in-package — level filtering per sink, namespace override
parsing, child binding, err serialization, ring eviction, fail-open sink
isolation, NDJSON shape.
**Acceptance:** package builds, is importable from web bundle without
tripping browser-reach audit, `bun run test` green.

## Chunk 2 — Server sinks, rotation, and adoption

**Blockers:** chunk 1.
**Scope:** Node/Bun-only sinks in a `@podium/logger/node` subpath, plus
adoption in the server-family processes.

The subpath is a hard constraint, not a style choice: chunk 1 registered
`@podium/logger` as a declared browser entrypoint whose tsconfig extends
`dom.json`, so a Node-only import reachable from the barrel is exactly what
`scripts/audit-browser-reach.ts` refuses. See the browser-entrypoint
addendum in the design spec.

- **File sink:** NDJSON to `~/.podium/logs/<role>.ndjson` (via existing
  `logDir()` in `packages/runtime/src/run-registry.ts`), size-based rotation
  10 MB × 5. ENOSPC and other write errors degrade to console once.
- **Stdout sink:** NDJSON lines for systemd mode; selection driven by the
  existing `config.persistence` mode so there is no double-writing.
- Boot wiring in `packages/runtime/src/boot.ts` (server, daemon, janitor get
  it via the shared boot sequence) and `apps/cli` for detached spawns; route
  `installProcessSafetyNet` output through the logger.
- `podium logs` (`apps/cli/src/cli-lifecycle.ts`) reads the new files, keeps
  the journalctl hint under systemd; add `--pretty` rendering of NDJSON.
- Convert `console.*` diagnostics in `apps/server`, `apps/daemon`,
  `apps/janitor`, `packages/runtime` to the logger (their sweep happens here,
  not in chunk 6, so adoption is proven early). CLI user-facing stdout stays.

**Tests:** rotation trigger + file-count cap, mode selection, safety-net
routing; extend existing boot tests. Re-run `bun scripts/server-test-shards.ts
--write` if server test files are added.
**Acceptance:** detached-mode server writes rotated NDJSON; systemd units
unchanged; `podium logs` works in both modes.

## Chunk 3 — Client log ingestion and crash events

**Blockers:** chunk 1 (not 2 — ingestion writes via the same node sinks but
can land in parallel once 1 is in; if 2 is unmerged, coordinate on the
subpath). **Server-side only; no client changes.**

- Authenticated tRPC endpoints: `logs.forward` (batch of records, bounded
  size, tagged with client role/version/machine) and `logs.crash` (error +
  full ring-buffer snapshot).
- Forwarded records written to per-origin rotating files in the server log
  dir; same rotation policy.
- Crash events stored durably (migration: `crash_events` table or bounded
  file store — implementer's choice, spec bounds: keep last 50 or 30 days).
- Wire the dormant telemetry hop: crash event → `scrubError()` →
  `telemetry.recordCrash()` on the server emitter
  (`apps/server/src/telemetry.ts`), consent-gated by the existing `crash`
  tier. This closes the zero-call-site gap.
- `podium logs export-crash` in the CLI: bundle recent crash events for a
  deliberate support hand-off.

**Tests:** endpoint auth + payload bounds, retention pruning, scrubber
round-trip into `recordCrash` (extend `packages/telemetry` tests), export
command output.
**Acceptance:** a synthetic client crash posted to the endpoint appears in
storage, feeds `recordCrash` when consent is on, and is absent from the
telemetry queue when consent is off.

## Chunk 4 — Web and desktop-webview capture

**Blockers:** chunks 1 and 3.
**Scope:** `apps/web` (the Tauri webview ships the same bundle).

- Global handlers: `window.onerror` + `unhandledrejection` → logger.
- Forwarding sink: batch flush (5 s / 50 records), bounded queue,
  drop-oldest, jittered retry, no log-about-logging loops; default `warn`+,
  threshold adjustable at runtime (settings/config).
- Crash path: handler fires → ship error + ring-buffer snapshot to
  `logs.crash`.
- `ErrorBoundary.tsx`: stop discarding `ErrorInfo` — log the component stack
  and include it in the crash event. `CardBoundary` logs through the logger.
- Convert the ~9 real `console.*` sites in `apps/web/src` to the logger.

**Tests:** forwarding sink batching/drop/retry (unit, in-package or web
tests); boundary component-stack capture. Runtime verification of the crash
path in the running app per testing policy (no new E2E lane).
**Acceptance:** a thrown async error in the web UI produces a crash event on
the server containing the ring buffer.

## Chunk 5 — Mobile and Tauri native capture

**Blockers:** chunks 1 and 3.
**Scope:** `apps/mobile` (Expo/RN) and `apps/desktop` (Rust side).

- Mobile: initialize the logger with role `mobile`;
  `ErrorUtils.setGlobalHandler` + `unhandledrejection` equivalent → logger →
  forwarding + crash sinks (same client transport as chunk 4; extract shared
  client wiring into `packages/client-core` if both need it).
- Tauri Rust: adopt the `log` crate + a panic hook; replace bare
  `eprintln!("[podium-desktop] ...")` in `src-tauri/src/main.rs` and
  `updater.rs`. Bridge Rust records into the pipeline: emit to the webview
  logger or write an own NDJSON file with the same record shape —
  implementer's choice, spec requires records end up server-visible.

**Tests:** mobile handler wiring in the existing `test:mobile` vitest lane;
Rust side `cargo test` where practical, runtime verification for the panic
hook.
**Acceptance:** a forced mobile error and a forced Rust panic both surface
as server-side crash events.

## Chunk 6 — Console sweep and lint boundary

**Blockers:** chunks 2, 4, 5 (API proven everywhere first).
**Scope:** the long tail + enforcement.

- Sweep remaining `console.*` in `packages/client-core`, `packages/harness`,
  and stragglers (server-family swept in chunk 2, web in chunk 4). Judgment
  call per site: logger, or delete if worthless. CLI user-facing output
  explicitly stays `console`/direct writes.
- Lint boundary (existing `lint:boundaries` family) forbidding `console.*`
  outside the CLI output modules, the logger package, tests, and scripts.
  Run `lint:boundaries` directly to verify (lint gates are dark).
- Docs: short `docs/agents/logging.md` — level semantics table, how to add
  fields, how to raise verbosity, where logs live.

**Tests:** the lint rule itself (fixture or self-test consistent with
existing boundary rules). No behavioral tests — mechanical sweep.
**Acceptance:** `bun run lint` fails on a newly introduced raw
`console.log` in `apps/server`; docs page exists.

## Sequencing summary

| # | Chunk | Blocked by |
|---|---|---|
| 1 | Logger core package | — |
| 2 | Server sinks and rotation | 1 |
| 3 | Client log ingestion and crash events | 1 |
| 4 | Web and desktop-webview capture | 1, 3 |
| 5 | Mobile and Tauri native capture | 1, 3 |
| 6 | Console sweep and lint boundary | 2, 4, 5 |

Chunks 2 and 3 can run in parallel; 4 and 5 can run in parallel.

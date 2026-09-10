# Loop profile C — exposure on the wire and the perf snapshot

**Goal:** The daemon's latest minute record rides on the existing host metrics push, the
server keeps the newest per machine, and `perf.snapshot` gains a `loop` section with the
server's own rings and every daemon's latest minute.

**Spec:** `docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md` §7.1, §7.2.
**Depends on:** part A landed on dev/mw (`LoopMinute`, `LoopWindow`, `state.loopAccounting`,
the daemon's `latestMinute()`).

## Global constraints

- Every new wire field is optional; widen the parser before any sender emits the value
  (both are in this change, and the receiving parser is the one that must accept absence).
- The server keeps one minute per machine, chosen by `at`, never by arrival.
- No SQLite: the server's per-machine map is in memory and dies with the process.

## Steps

### 1. Protocol types (`packages/protocol/src/perf.ts`)

- `export const LoopProfileLevel = z.enum([...])`, `LoopMinuteWire`, `LoopWindowWire` Zod
  schemas mirroring the runtime types (numbers, optional where the runtime marks optional;
  `buckets` as `z.record(z.object({ wallMs, count }))`).
- `PerfSnapshot.loop?: { level; server: { windows: LoopWindowWire[]; minutes: LoopMinuteWire[] }; daemons: Record<string, LoopMinuteWire> }`.
- The runtime must not import from protocol here (dependency direction); the protocol
  schema is the wire contract and a test asserts a runtime `LoopMinute` parses with it.

### 2. Host metrics wire (`packages/model/src/entities/machine.ts:250`)

- `loop: LoopMinuteWire.optional()` on `HostMetricsWire`, with a comment that it repeats the
  same minute up to four pushes and the server dedupes by `at`.
- Round-trip test in `packages/protocol/src/messages.test.ts` next to the existing
  `hostMetrics` case: with the field, and a frame without it still parses.
- Check `packages/client-core` consumers of `HostMetricsWire` (`engine/state.ts`,
  `viewmodels/pulse.ts`) still typecheck; they should ignore the field.

### 3. Daemon sender (`apps/daemon/src/host-runtime.ts` `pushHostMetrics`)

- Spread `...(loop ? { loop } : {})` from the accounting handle's `latestMinute()`
  (absent below `accounting` and before the first minute completes).

### 4. Server receiver (`apps/server/src/modules/hosts/service.ts` `onHostMetrics`)

- `latestLoopMinutes: Map<MachineId, LoopMinuteWire>`; replace only if the incoming `at`
  is newer. Strip `loop` from what `broadcastHostMetrics` sends to clients (the web app does
  not need it and it is the largest field on that frame).
- Expose `loopMinutes(): Record<MachineId, LoopMinuteWire>`.
- Test: newer `at` wins, older ignored, broadcast frame has no `loop`.

### 5. Snapshot (`apps/server/src/modules/perf/registry.ts`, `queries.ts`)

- The registry does not own the accounting; compose in `queries.ts` `snapshot`:
  `{ ...state.perf.snapshot(), ...(loop ? { loop } : {}) }` where `loop` reads
  `state.loopAccounting?.snapshot()` and `state.modules.hosts.loopMinutes()`.
- Test in `apps/server/src/modules/perf/*.test.ts`: `loop` present at `accounting`, absent
  at `off` (inject a null handle).

### 6. Verification

- Focused lanes: `packages/protocol`, `packages/model`, `apps/server` perf and hosts tests,
  `apps/daemon` host-runtime metrics test.
- Live: `curl` the snapshot through the operator client (or `podium logs`-style helper) and
  confirm `loop.daemons` names the local machine with a minute no older than 2 minutes.

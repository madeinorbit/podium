# Loop profile B — attribution buckets and daemon parity

**Goal:** Every existing attribution seam on the server and the daemon feeds one of a fixed
set of buckets in the shared accounting module, the daemon gains the scheduler attribution
and `SIGUSR2` dump the server already has, and every minute record above `accounting`
carries buckets plus a coverage figure.

**Spec:** `docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md` §6.
**Depends on:** part A landed on dev/mw (`startLoopAccounting`, `attribute`, `LoopBucket`).

## Global constraints

- `attribute()` is the only entry point into the buckets; seams keep their own per-name maps
  for the per-stall record and the `SIGUSR2` dump.
- Below level `attribution` no seam is installed and `attribute` is a no-op; nothing in this
  part may add cost at `accounting` or `off`.
- The daemon has no SQL; `sql` is absent from its records, never zero.

## Steps

### 1. Bucket enum (`packages/runtime/src/loop-accounting.ts`)

- `export const LOOP_BUCKETS = ['ws.client','ws.daemon','rpc','sql','timers','control','frames','tails','worker'] as const`.
- Minute record: `buckets` only includes buckets that recorded at least once in the
  minute; `nestedBuckets: ['sql']` constant; `coverage = (sum(buckets) − sql) / busyMs`
  where `busyMs = utilizationPct × 60 000 / 100` (absent when utilization is absent).
- Tests: coverage math with and without `sql`; buckets omitted when empty.

### 2. Server seams

- `packages/runtime/src/query-attribution.ts` `recordQuery`: also `attribute('sql', wallMs)`.
  The module needs the accounting handle: export a `setLoopAccounting(handle)` from
  `loop-accounting.ts` that the process calls once after start, and a module-level
  `attribute` that no-ops until set. Same for task attribution.
- `task-attribution.ts` `recordTask`: `attribute('timers', wallMs)`.
- `measureTask` labels: map by prefix in `measureTask` itself: `ws.client.*` →
  `ws.client`; `ws.message.daemon` / `ws.message.machine` → `ws.daemon`;
  `ws.message.client` → `ws.client`; any other label → no bucket.
- `apps/server/src/trpc.ts` timing middleware: `attribute('rpc', ms)`; record
  `inclusive: ['rpc']` in the minute record (constant next to `nestedBuckets`).
- `apps/server/src/janitor-host.ts`: wrap the worker message handler body in
  `measureTask('worker.janitor', …)`; `worker.*` → `worker` bucket.

### 3. Daemon seams

- `apps/daemon/src/loop-attribution.ts`: re-implement `timeTask` over the runtime's
  `measureTask` (keep the > 50 ms warn line), and route labels: `controlParse` and
  `controlDispatch*` → `control`; `tailBatch*` → `tails`; `publishConv*` → `worker`.
- `apps/daemon/src/control/session.ts:522` (`countFrame`): the frame handling that follows
  it runs under `measureTask('frames', …)` → `frames`. Confirm the call site is the
  synchronous handler, not the socket read.
- `apps/daemon/src/host-runtime.ts`: at level ≥ `attribution` call `attributeTasks()` before
  the subsystems schedule anything, add the 1 s `resetTaskAttribution()` cadence (fold into
  `startLoopAttribution`'s existing timer), and a `SIGUSR2` handler that logs `task totals`
  and `control type costs` through `daemon:loop` — mirror the server's shape.
- `reportLongTick`: add `tasks`, `taskCoverage` (from `formatTopTasks` /
  `taskAttributionCoverage`) next to the existing counters.

### 4. Tests

- `loop-attribution.test.ts`: `attributeTasks` installed only at ≥ `attribution`; `SIGUSR2`
  handler logs both records; `timeTask` routes to the right bucket (spy on `attribute`).
- Server: a test in `gateway/ws-server.test.ts` or `client-socket.test.ts` that one inbound
  frame records into `ws.client` / `ws.daemon`; `trpc` middleware test records `rpc`.
- Runtime: `recordQuery` and `recordTask` call `attribute` with the right bucket.

### 5. Verification

- Focused lanes for `packages/runtime`, `apps/daemon`, and the two gateway test files.
- Live: at level `attribution` on the reference install, `coverage` appears in both minute
  files. Record the first ten minutes' `coverage` for server and daemon in the parent
  issue's state; below 0.5 on either is the finding, not a bug in this part.

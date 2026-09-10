# Loop profile D — profile capture and the perf CLI

**Goal:** At level `attribution` and above, both processes can capture a Bun sampling
profile on a long stall or on `SIGUSR2`, bounded and rate-limited, and a `podium perf`
command group lets agents find the files, trigger a capture, and read the resolved level.
The group is listed in `podium --help` only when the `podium-development` feature is on.

**Spec:** `docs/internal/superpowers/specs/2026-09-10-loop-profile-levels-design.md` §7.3, §8.
**Depends on:** part A landed on dev/mw (levels, accounting handle, `onLongTick`). Independent
of B and C.

## Global constraints

- A capture never runs below `attribution`, never overlaps another, never exceeds one per
  five minutes per component, and never leaves more than 20 files.
- Capture is refused, with a record saying so, where `bun:jsc` is absent.
- The CLI commands run regardless of the help gate; only the help listing is gated.

## Steps

### 1. Capture module (`packages/runtime/src/loop-profile-capture.ts`)

- `createProfileCapture({ component, dir, now, jsc? })` with `request(trigger, seconds)`.
  `jsc` is injected for tests; production does `await import('bun:jsc')` once and stores
  `undefined` on failure.
- `request`: refuse if a capture is running or the last one finished < 5 min ago (return
  `{ suppressed: true }`); otherwise `startSamplingProfiler()`, `setTimeout(seconds)`, then
  `samplingProfilerStackTraces()`, write
  `<dir>/profiles/<component>-<ISO>-<trigger>.json` with the envelope from spec §8
  (component, level, trigger, startedAt, endedAt, seconds, stallMs when trigger is
  `stall`, `minute` when the caller passes one, `stacks` text). Delete the oldest files
  beyond 20 before writing.
- Tests: rate limit, overlap refusal, retention at 20, envelope fields, absent `bun:jsc`.

### 2. Triggers

- Accounting: `onLongTick` in both processes calls `capture.request('stall', 10, { stallMs })`
  when `ms >= profileStallMs` (default 1000, override `PODIUM_LOOP_PROFILE_STALL_MS`
  documented in the config env table). A suppressed request increments the minute record's
  `profileSuppressed` counter (add the column in `loop-accounting.ts`).
- Signal: extend the server's existing `SIGUSR2` handler and the daemon's (from part B, or
  add it here if B has not landed; coordinate through the parent issue) to read
  `<stateDir>/perf/profile-request.json` `{ seconds }` if present (delete after reading,
  default 10 s) and call `capture.request('signal', seconds)`.

### 3. CLI (`apps/cli/src/perf-cli.ts`, dispatched from `cli.ts` as `case 'perf'`)

- `podium perf level` — prints `level=<x> source=<env|config|default>` from
  `resolveLoopProfileLevel`; `--json` for the object.
- `podium perf paths` — prints `<stateDir>/perf/loop-server.ndjson`,
  `loop-daemon.ndjson`, `profiles/`; `--json` for `{ minutes: {...}, profiles }`.
- `podium perf profile <server|daemon> [--seconds N]` — reads the pid from
  `<stateDir>/run/<component>.pid`, writes `profile-request.json`, sends `SIGUSR2`, polls
  `profiles/` for a new `<component>-*-signal.json` up to `N + 15` s, prints its path.
  Exits 2 with one line when the level is below `attribution` (say the level and that
  `config.loopProfile` or `PODIUM_LOOP_PROFILE` raises it), exits 3 if no file appeared.
- Help (`cli.ts` `helpText`): add under "Lifecycle" a gated block
  `...(enabledFeatures.has('podium-development') ? ['  perf <command>        Loop profile level, minute files, on-demand CPU profile'] : [])`.
- Tests `perf-cli.test.ts`: `level` and `paths` output, exit 2 below `attribution`, exit 3
  on timeout with a fake fs, help listing present only with the feature in the set.

### 4. Verification

- Focused lanes: `packages/runtime` capture tests, `apps/cli` perf and help tests.
- Live on the reference install at `attribution`: `podium perf profile server` returns a
  file within 25 s; open it and confirm the stacks text is non-empty. Attach that file to
  the parent issue as the first profile artifact.

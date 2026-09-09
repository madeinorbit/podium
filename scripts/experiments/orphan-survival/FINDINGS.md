# orphan-survival — what it answered (POD-3774, epic POD-3758)

Run **34365778220**, measured twice (original + re-run) on windows-latest and
ubuntu-latest, bun 1.3.14. Both runs agree arm for arm.

## The answer

`supervisorDeathSignal('win32') === 'none'` is **wrong**, not merely incomplete.

Spawned **detached** — the only shape in which a Windows child outlives its supervisor
at all — the child receives `'disconnect'` **20 ms / 19 ms** after the supervisor
vanishes, the same order as linux (36 ms) and the 9–23 ms POD-3760 saw on POSIX.
Windows delivers the close notification perfectly well.

POD-3760 measured a child that had been **killed before the channel could tell it
anything**, because it was spawned *attached*.

| arm | child's job | outlived supervisor | `'disconnect'` |
| --- | --- | --- | --- |
| `channelled` (ipc, attached) | `0x3c00` kill=true | ❌ died at once | — |
| `piped` (pipes, attached) | `0x3c00` kill=true | ❌ died at once | — |
| `ignored` (no handles, attached) | `0x3c00` kill=true | ❌ died at once | — |
| `ignored-detached` | `0x0` kill=false | ✅ whole window | — |
| `channelled-detached` | `0x0` kill=false | ✅ whole window | ✅ **+20/19 ms** |
| `shell-spawned` (orphaned by `cmd`) | `0x0` kill=false | ✅ whole window | — |

POSIX is the sanity control: every arm survives, both channelled arms are told.

## Why neither original reading survived

- **(a) "the IPC channel tears the child down"** — refuted. `piped` and `ignored` carry
  no channel and died identically to `channelled`.
- **(b) "the runner's job object kills the orphan"** — refuted three ways, all on the
  same runner in the same job: `shell-spawned` was orphaned by `cmd` and survived; the
  harness itself sits in that `0x3c00` `KILL_ON_JOB_CLOSE` job and stayed alive for the
  full 12 s *after* the attached children were gone, so the job had not closed; and the
  attached children died within 250 ms of their **immediate parent** exiting, which a
  step-level job cannot produce.

What remains: a child dies when the process that spawned it *attached* exits. That
follows a spawn flag that is ours to set, so it is a property of how the runtime spawns
on Windows, not of the CI machine — which is why this did not need a real desktop.

Not established: *which* mechanism inside the runtime does the killing (a deliberate
kill-on-parent-exit, or job assignment at spawn). The arms show it is attached-spawn-
scoped and defeated by `detached: true`, not which line does it.

## Consequences for the epic

- **POD-3761** — `supervisorDeathSignal` should return `'disconnect'` on win32 too, with
  a hard prerequisite: the supervisor spawns children **detached** on Windows. No
  positive parent-liveness check is needed. That is a spawn-site requirement, not a
  channel one.
- **Spawn attached on Windows and there is no handover at all** — the child is dead
  within 250 ms of the supervisor exiting, long before a successor exists. The risk was
  never that the child would not be *told*; it was that it would not be *there*.
- **POD-3762 / POD-3767** — may assume a uniform `'disconnect'` signal on all three
  platforms, conditional on that spawn shape. Worth asserting the shape in the gate: an
  attached spawn on Windows fails silently and looks exactly like POD-3760's result.

## Instrument notes

Each arm reports a survival **window**, not a boolean. Each child writes a synchronous
first heartbeat, so a dead instrument cannot read as a dead process (all six armed in
both runs). Liveness is measured twice over — heartbeat file and OS pid probe — and they
agree everywhere. The child keeps beating *after* `'disconnect'` rather than exiting on
it: POD-3760 fused "was told" with "died", and separating them is what let
`channelled-detached` show survival and notification at once. The parent exits without
`disconnect()` and without `kill()` — a supervisor vanishing, not a polite close.

The job-object probe (`bun:ffi`, reachable from a compiled binary per POD-3772) is
corroboration only, with one caveat: the detached arms can leave the runner's job
*because that job sets `BREAKAWAY_OK`*. A desktop has no such job and detached children
escape trivially. The conclusion rests on `shell-spawned`, which needed no breakaway.

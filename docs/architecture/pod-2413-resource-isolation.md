# Resource isolation and OOM truth (POD-2413)

Agent sessions used to run in bare transient scopes: a cgroup with a CPU weight, an
IO weight, and no limit of any kind. Nothing bounded a session's memory, nothing
bounded its task count, and the host's OOM killer picked its victim by badness score
— which on a box running ten agents is as likely to be the daemon or an innocent
neighbour as the runaway. Twice, it took the whole machine down.

`SessionHealth` made it worse by being quiet about it: every production driver
answered `oomEvents: 0`, a number that read as "no OOM kills here" and meant "nobody
ever looked".

This change gives sessions a real resource hierarchy and reports what the kernel
actually recorded. It closes audit items LD4 and LD5 of
[pod-1761-spec-gap-audit.md](pod-1761-spec-gap-audit.md) against spec §6.

## The hierarchy

```
podium.slice                                   (podium-<instance>.slice for a named instance)
└─ podium-sessions.slice                       MemoryHigh = 75% of host RAM  (aggregate throttle, never a Max)
   ├─ podium-<sessionId>.scope                 MemoryHigh/MemoryMax/MemorySwapMax, TasksMax, OOMPolicy=continue
   └─ podium-oc-attach-<sessionId>.scope       a client TUI — a terminal-sized budget, reclaimed FIRST
```

An attach scope is not named as a suffix of its session's label, and that is
load-bearing rather than cosmetic: memory attribution walks `/proc` with a
substring test, so `…-<id>-attach` would bill the whole client TUI to the agent
(`opencode-attach.ts` states the rule and pins it). What makes a scope an attach
scope here is the ROLE its spawn declares, which is what sizes it.

systemd derives a slice's parent from its own name by cutting at the last `-`, so
those two names *are* the tree; no unit files are involved and every level is
created on demand. The daemon and server units stay **outside** the sessions slice:
a supervisor that shares an OOM fate with what it supervises is not a supervisor.

All four spawn paths — the abduco master, `codex app-server`, `grok agent stdio`,
`opencode serve` — already funnelled through one argv builder
(`systemdScopeArgv` in `packages/pty/src/abduco.ts`), so the placement and the
budget land in one place and cannot drift per family.

Defaults are derived from host RAM, because the same daemon runs on an 8 GiB VPS and
a 128 GiB workstation: `MemoryMax` is 50% of RAM clamped to 2–16 GiB, `MemoryHigh` is
90% of that, `MemorySwapMax` equals the max, `TasksMax` is 4096. Every axis is
overridable (`PODIUM_SESSION_MEMORY_MAX`, … see the env table in
`packages/runtime/src/config.ts`), and `PODIUM_NO_SESSION_BUDGET` keeps the tree
while dropping every limit — an operator who needs a 40 GiB build is a real person,
and a budget they cannot raise is a budget they will disable wholesale.

## What the live probes settled

Measured on this host (systemd 259, cgroup v2 with `memory`+`pids` delegated to the
user manager, 11.9 GiB RAM, 40 GiB swap) before the defaults were chosen. Each is
reproducible with `systemd-run --user --scope --slice=… --property=…`.

**1. `MemoryHigh` does not kill — it throttles, and a low one is a livelock.**
A scope with `MemoryHigh=200M` against a workload wanting 1.6 GiB logged 967
reclaim-throttle events in four seconds, sat pinned just above the limit, made
essentially no progress, and never reached `MemoryMax` at all. A wedged agent is
worse than a killed one, so `MemoryHigh` here is a narrow warning band under
`MemoryMax` rather than a low throttle point — and `memory.events`' `high` counter
is surfaced as `throttleEvents` so the band being wrong is visible rather than
mysterious.

**2. `MemoryMax` alone does not bound anything on a host with swap.**
The first probe allocated 1.6 GiB under `MemoryMax=64M` and finished normally: the
kernel simply paged it out. With 40 GiB of swap on this box, that is precisely the
"machine stopped responding" failure — no OOM kill anywhere in it. `MemorySwapMax`
is therefore part of the budget, not an extra.

**3. `OOMPolicy=continue` is what makes a budget survivable.**
`MemoryMax=128M`, `MemorySwapMax=0`, a hog under a shell: the kernel killed the hog
(`137`), the shell kept running, the scope stayed `active`, and `memory.events`
reported `oom_kill 1`. Without it a killed `bun test` would end the agent session
hosting it.

**4. `/proc/<pid>/cgroup` is the only reliable locator, and the obvious guess is
wrong.** A scope in `podium-sessions.slice` lands under
`…/user@<uid>.service/podium.slice/podium-sessions.slice/<unit>`, not beside the
caller's own `app.slice` unit. The supervisor derives the path from its own cgroup
(cut at `user@<uid>.service`) plus the slice chain, falling back to logind's fixed
layout for a system service with `User=`, and also looks in `app.slice` so a session
adopted from before this change is still observable.

## Observation, and what counts as truth

`packages/pty/src/cgroup.ts` reads the cgroup; `apps/daemon/src/runtime/scope-monitor.ts`
knows which cgroup belongs to which session, samples every live session every 10s,
and is the daemon's single answer to "what does this session cost". All four driver
hosts read their numbers from it, so the answer does not vary by family.

- `health()` now reports `memoryBytes` (the cgroup's `memory.current`, not a `/proc`
  attribution heuristic), `peakMemoryBytes`, `tasks`, the `memoryMaxBytes` actually
  in force, `throttleEvents`, and `oomEvents` from `memory.events`' `oom_kill`.
- Where there is no cgroup — macOS, an unscoped fallback spawn, a collected scope —
  the old `/proc` attribution still answers the memory question and the rest is
  **absent**. Absent, not zero: "we could not look" and "this session used no memory
  and was never OOM-killed" are different statements.

**The baseline rule.** The kill counter is cumulative for the life of the cgroup, so
a session adopted after a daemon restart may already carry kills, and announcing
those would re-emit a durable `oomKilled` on every restart. Baselining on first
sight is just as wrong the other way: a live probe of a scope that OOM-killed 2.5s
after spawn had its kill swallowed as "the baseline" and said nothing. cgroupfs
settles it — the directory's mtime is stamped at creation, so a scope older than the
observer was adopted (its kills are history) and a younger one started on our watch
(baseline 0, every kill is news). `health()` reports the true total either way: a
count is a measurement, an event is a claim about something happening now.

## Saying it: `oomKilled`, and a stated stop reason

The supervisor observes; the **driver** states. A runtime event without a causal
envelope is not a runtime event — only the driver holds a session's cursor, observer
generation and turn epoch — so the monitor calls `reportOomKill(sessionId)` on the
machine runtime, which dispatches to whichever family holds that session, and the
driver emits `{ t: 'process', ev: { ev: 'oomKilled', scopeUnit } }` into its own
stream. Durable-synced like every other coarse event.

The server correlates rather than assumes. `process.oomKilled` is **not** a death —
with `OOMPolicy=continue` the usual victim is a build the agent started, and the
session keeps serving. What it changes is what a *nearby* exit is allowed to be
called: a session whose tree died within 60s of a kernel kill exited because the box
ran out of memory, and its row says `stopReason: 'oom'` instead of `exited`
(surfaced as "out of memory" in the sidebar). Both orderings are handled — the
daemon samples on a timer, so the evidence routinely lands after the exit frame and
upgrades a row already stamped.

## Reclaim, on attributable evidence

Attachment-first reclaim under memory pressure already existed (spec §5); what it
lacked was evidence about *whose* pressure it was. Host-wide `MemAvailable` moves
identically whether the memory went to agent sessions or to a browser someone left
open, and only one of those is fixed by parking a session. The daemon now reports the
sessions slice's `memory.current` against its aggregate `MemoryHigh`
(`HostMetricsWire.sessionsMemory`), and the server treats "the sessions are over
their own budget" as a trigger alongside the host-wide one. Attach scopes are named
as siblings (`<label>-attach.scope`) and reclaimed before session scopes on every
teardown path.

## Where the flag line falls

Isolation is unconditional; truth rides the contract. Every session's scope is
placed and budgeted at spawn regardless of `PODIUM_RUNTIME_CONTRACT`, because that
is the part that keeps a runaway from taking the host — it is argv, not a code path.
Per-session `health()` and `process.oomKilled`, though, are agent-runtime surfaces:
they exist for sessions that have a runtime binding, which for the terminal family
means the contract flag. Server-family sessions always have one. The aggregate
pressure signal is universal either way, because it reads the slice rather than any
session.

## What this is not

Telemetry. There is no metrics pipeline, no retention, no dashboard, and none is
implied: this is resource **truth** at the moment it is asked for, which is the thing
fleet-scale claims actually rest on.

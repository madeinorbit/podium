# POD-1953 — rows that said "parked" over agents that were still running

*Investigated 2026-08-12/13. Every timestamp UTC unless marked CEST.*

## What the user saw

Resume on POD-1945's session died red with `create-session: Address already in
use`, and the row went terminal. POD-1952 fixed that collision by making the
spawn adopt the live master. This is the upstream question it left open: **why
did podium think that session needed a fresh process at all?**

## The chain

| time | what happened |
| --- | --- |
| 16:23:13 | session `fa53a325` spawned on flatblock; abduco master + scope up |
| 16:30:23 | last observation — the agent goes idle |
| **17:19:09** | **the load governor parks it**: flatblock at 1.515 load/core, over the 1.5 threshold. `hibernateSession` flips the row to `hibernated` and fires a `kill` at the daemon |
| 17:19–20:32 | the row reads `hibernated`. The master and its 15-task scope keep running |
| 20:32:50 | Resume → `spawn` → abduco refuses the label → `markSpawnError` → row terminal |
| 20:32–20:34 | four more attempts, four more `session.exited` events |

The park was never a user action, and the kill never landed: the scope's
`ActiveEnterTimestamp` was still **18:23:13 CEST**, i.e. session creation,
unbroken through the whole "hibernated" window.

## Not one row

At the time of writing, rows the server called `hibernated` whose masters were
alive, scope `active` with 15–23 tasks each:

- **flatblock: 7** — of only 32 live masters. Parked 2026-08-05, 08-10 (×4),
  08-12 (×2).
- **ludovico: 3**.

A load governor parking sessions to relieve load, on a host where its previous
parks never actually freed anything.

## Root cause

Three failures stacked, and each one alone is survivable:

1. **The park's kill is fire-and-forget.** `hibernateSession` sets
   `status = 'hibernated'`, persists, then calls `toMachine(…{type:'kill'})`.
   Nothing acknowledges it, nothing verifies it. The row's status is a claim
   about a kill that was *requested*.
2. **The reap could half-run.** `killAbducoSession` awaited the global `abduco`
   listing — which connects to every master in turn, and had **no timeout** —
   and only *then* swept the systemd scope. The scope sweep is the half that
   always works (it signals the cgroup by unit name and needs nothing from
   abduco), but it was reachable only *through* that await. One wedged master
   and the whole kill is a silent no-op: master alive, scope alive, nothing
   logged. That is the only single condition that explains the evidence —
   neither the SIGTERM nor the scope stop touched the label.
3. **Nothing ever re-asks.** `SessionMachineReconciler.onAttached` probes
   `reconnecting` and non-archived `exited` rows — never `hibernated`, correctly,
   since hibernation is deliberate. So a wrongly-parked row cannot self-heal, and
   `resurrectSession` always spawns. The disagreement is permanent until a Resume
   collides with the label.

## The fix

Measure, don't assume — at all three points.

- `killAbducoSession` starts the scope sweep **before** the listing rather than
  after it, and the listing is bounded. The reliable half can no longer be taken
  down by the unreliable one.
- The daemon reports what the reap **did**: `sessionKillResult` carries a
  `killed` measured from the socket index after one retry.
- The daemon censuses its live durable labels on connect
  (`durableSessionCensus`), covering kills this server never saw the end of — one
  sent into a socket that had already died, or issued by a server process that
  has since restarted.

Both signals land on one repair, and **the durable host wins**, per the
reconciler's own rule: a parked row whose master is alive goes back to
`reconnecting` and is reattached.

`reconnecting`, not `live` — the daemon disposed the PTY bridge when it took the
kill, so the row is only honest once the reattach binds a new one. A master that
turns out to be gone answers `reattachFailed`, and `onExit` leaves a hibernated
row hibernated: a wrong guess costs one probe, never a resurrection.
`lastActiveAt` is deliberately not stamped — if the park was right, the governor
takes the session again on its next tick, and now the kill says whether *that*
one landed.

## What this does not fix

The census is O(n) now, but the **spawn** path still reads the whole socket
directory per call, and that directory holds 6944 leaked `.abduco-<pid>` bind
temps against 88 real sockets (`POD-1963`). Separately, four test gates were
already red on main before this work started (`POD-1962`); this branch
regenerated only the `terminal` wire golden, the one family it changed.

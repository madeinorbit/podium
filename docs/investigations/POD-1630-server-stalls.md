# POD-1630 — where the server stalls actually come from

Measured on ludovico against the live instance (`podium-server.service`, pid 4136417,
booted 02:05:14), 2026-08-04 02:09–02:35 CEST. Base: `issue/279-integration` @ 79ac3f586,
i.e. **after** POD-1623 and POD-1624 landed.

## What was already believed, and what survived

The brief's own analysis survives intact and is what made this findable:

- flat JS heap (107–137MB) against RSS swinging 360→980MB is **off-heap churn, not a heap leak**;
- the stall bursts **not** coinciding with `quota.summary` is the observation that killed the
  first theory.

Two leads did **not** survive. `sessions.transcriptRead` is no longer the driver (POD-1623),
and `discovery.refreshRepos` — the coordinator's "most interesting unexplained path" — is a
victim of the blocked loop, not its cause. See "The stalls are not on the request path".

## The stalls are still here

POD-1623 and POD-1624 did not remove them. On a freshly restarted server:

    02:09:38  stall 1387ms | own-cpu=1536ms | heap=127MB rss=932MB
    02:10:15  stall 1749ms | own-cpu=1827ms | heap=143MB rss=1052MB
    02:10:23  stall 1697ms | own-cpu=1737ms | heap=143MB rss=972MB

`own-cpu ≈ wall` on nearly every line: this is synchronous work in the server process, not
scheduler starvation.

## The stalls are not on the request path

A 180s window (02:15:28–02:18:28) measured by diffing two `/trpc/perf.snapshot` reads
against the journal for the same interval:

| measured over the same 180s | value |
|---|---|
| stalls | 15 |
| own-CPU in those stalls | 4787 ms |
| tRPC calls of any path | **0** (excluding the probe itself) |
| instrumented phase work | **~1 ms** |

The work is background, and it is invisible to every counter the server currently has.
This is why ranking `[perf] slow rpc` lines by path could only ever point at victims:
a slow RPC during a stall is an RPC that was *waiting on* the stall.

## What is actually burning the CPU

From `/proc/<pid>/io`, `/proc/<pid>/status` and `ss -tinp`, sampled per second:

    02:20:14 rss=742MB  rchar=+25MB/s  cpu=1060ms/s
    02:20:15 rss=1005MB rchar=+18MB/s  cpu=770ms/s
    02:20:25 rss=1261MB rchar=+9MB/s   cpu=920ms/s
    (quiet seconds: rchar=0, cpu=150ms/s)

Read bursts land exactly on the CPU bursts and on the RSS climb. Three facts pin what the
reads are:

1. **Files, not sockets** — over one 10s window: `rchar` +6MB vs socket `bytes_received`
   +33KB.
2. **Page cache, not disk** — `rchar` 3.5GB against `read_bytes` 238MB since boot.
3. **SQLite, not file slurps** — the average read is ~3950 B (4KB pages), and the only file
   the process holds open is `podium.db` (218MB). No fd offset ever advances, which is the
   signature of `pread`, which is how SQLite reads.

**The atomic unit is one ~7.3MB / ~1900-page scan.** It runs a couple of times per 15s when
the box is idle, and 5–8 times *per second* under activity:

    02:24:39  45970KB  reads=12161
    02:24:41  56727KB  reads=15028
    02:25:15  38136KB  reads=10954
    (idle cadence: 7346KB reads=1932, ~every 15s)

Repeated row materialization from that scan is the off-heap allocation the brief inferred
from the RSS/heap divergence. The collector paying for it is the stall.

## It blocks real clients (answering POD-279)

POD-279 asked the right discriminator: while the UI is frozen, does plain `curl` stall too?
It does, near ms-for-ms — 0.4s probe loop against `/trpc/features.state`, joined to the journal:

| probe | server stall |
|---|---|
| 02:30:15 → 1.69s | 1841 ms |
| 02:30:06 → 0.73s | 907 ms |
| 02:30:08 → 0.58s | 716 ms |
| 02:30:33 → 0.56s | 570 ms |
| 02:29:33 → 0.44s | 539 ms |

Between stalls the same request is 10–20ms. So the freeze is server-side.

**One honest limit:** this proves the server blocks external HTTP for the stall's duration.
It does not prove POD-279's 150s scroll is *only* this — the worst single stall measured is
3.1s, so a 150s freeze needs a long pile-up or a client-side amplifier on top. The server
loop is confirmed; the client multiplier is still open.

## What this change adds

Per-statement attribution at `openDatabase`, the one seam every database passes through.
A stall line now carries the statements that ran in the second around it:

    [podium:loop] server stall 1749ms | ... | sql=8x/1520ms/41200rows SELECT * FROM …

Notes on the shape:

- **Zero cost when off.** With `PODIUM_LOOP_PROFILE` unset, `openDatabase` returns the
  database object unchanged.
- **The gate is a parameter, not an ambient read.** `PODIUM_LOOP_PROFILE` is set in some
  shells (the live unit sets it), so a test reading the env would assert whatever the
  environment happened to be.
- **The migrator trap.** The drizzle migrator resolves its native handle by wrapper
  *identity* through a `WeakMap`; decorating the database would silently cost it that
  handle. `aliasBunSqliteClient` carries the registration onto the outer wrapper. Verified
  by booting an instrumented instance against a temp `PODIUM_STATE_DIR` and watching all
  51 migrations apply.

## What is NOT done

**The offending statement is not yet named.** The scan cost depends on the real 218MB
corpus and on live agent activity; an isolated instance with an empty database issues no
background queries at all, so it cannot reproduce it. Collecting requires this on the live
server, which runs from the **main checkout source**
(`ExecStart=bun --conditions=@podium/source scripts/server.ts`, `WorkingDirectory=/home/mgw/src/other/podium`)
— so it needs a merge to main plus a restart.

**One thing to weigh before that:** `PODIUM_LOOP_PROFILE=1` is already set on the live unit,
so merging turns attribution **on in production**. The per-statement cost is one
`performance.now()` pair and a map update, but it lands on a server that is already
executing ~1900-page scans several times a second. That is a deliberate call, not a
side effect.

Once the statement is named, the fix is expected to be bounding or indexing that scan —
not a cache. Nothing here changes runtime behavior.

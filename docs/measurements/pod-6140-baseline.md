# POD-6140 baseline: live server numbers and the server data bench

The fresh baseline for POD-6140 (server data access and caching), step 1 of the design
([2026-10-15-server-data-access-design.md](../internal/superpowers/specs/2026-10-15-server-data-access-design.md) §7).
It has two halves:

1. **Live baseline**: what the operator's live server does today, read off its event-loop accounting
   (POD-3810). This is the "before" picture for the end of the epic. It cannot be re-run on a commit.
2. **Server data bench**: a repeatable benchmark that boots two commits' servers on the same seeded
   corpus, drives the same synthetic load, interleaved A B A B …, and prints a side-by-side table.
   Every POD-6140 landing runs it against its parent commit ([How a landing runs its A/B](#how-a-landing-runs-its-ab)).

The older POD-3810 numbers are stale and do not count.

## 1. Live baseline

Read-only, on ludovico. The live server was not restarted, reconfigured or tested on; no profiler
was armed (`podium perf profile server` was not run, POD-3887).

- **Source:** the server's minute file `~/.podium/perf/loop-server.ndjson`, level `attribution`
  (`PODIUM_LOOP_PROFILE=attribution` in the server's environment), copied at 2026-10-15T13:41Z.
- **Build labels:** the minute file has no build version. Each minute is labeled from the server's
  journal copy of the same `loop minute` record, which carries `v`.
- **As of:** windows end 2026-10-15T13:41:00Z.
- **Running server:** `0.2.1-dev.19+2f57072`, PID 3921742, started 2026-10-15T11:07:30Z (`~/.podium/run/server.pid`).
- **The 24 h window mixes three builds:** dev.16 (1,260 minutes), dev.18 (10) and dev.19 (146), because the
  server updated at 10:53Z and 11:04Z. The 1 h window is dev.19 only. A third table covers everything
  since the last restart, on one build.
- **What `at` means:** it labels the minute's END rounded down to a whole minute. A loop minute is 60 one-second
  sample windows counted from accounting start, not a clock minute.

| metric | 24 h median | 24 h p90 | 1 h median | 1 h p90 | since restart median | since restart p90 |
|---|---:|---:|---:|---:|---:|---:|
| utilizationPct | 51.9 | 59.6 | 57.3 | 65.3 | 58.7 | 65.0 |
| blockedPct | 15.1 | 23.8 | 24.6 | 41.6 | 22.0 | 38.3 |
| stalls/min | 17 | 26 | 27 | 48 | 24 | 43 |
| SQL statements/min | 35,302 | 51,816 | 40,624 | 66,276 | 45,518 | 65,676 |
| SQL wall ms/min | 3,164 | 4,679 | 4,813 | 6,804 | 4,668 | 6,706 |
| `ws.daemon` frames/min | 27,896 | 45,165 | 29,299 | 34,976 | 33,827 | 41,525 |
| `ws.daemon` wall ms/min | 10,326 | 11,314 | 9,462 | 10,666 | 10,162 | 11,002 |
| SQL statements per daemon frame | 1.25 | 1.62 | 1.45 | 2.59 | 1.28 | 2.20 |
| RSS MiB | 1,414 | 1,492 | 1,497 | 1,579 | 1,460 | 1,557 |
| heap used MiB | 588 | 663 | 573 | 629 | 562 | 620 |

Window coverage: 24 h has 1,416 of 1,440 minutes (gaps are restarts), 1 h has 57 of 60, since restart
(11:09Z to 13:41Z) has 145 of 152.

**What each number counts.** All are per loop minute (`buckets.sql` and `buckets["ws.daemon"]` count and
wall), and "per daemon frame" is all SQL statements in the minute divided by that minute's daemon frames.
`ws.daemon` counts every inbound daemon and machine WebSocket message, including binary terminal output.
Live load: one user, eight machines, 211 live sessions (from the research row counts below).

### Boot (last restart, 2026-10-15T11:07:30Z, dev.19)

Boot time is logged (`server:boot` "boot stage completed"; `durationMs` is process uptime). The longest
stages were:

| stage | stage ms | process uptime at end, ms |
|---|---:|---:|
| backfill | 1,014 | 1,760 |
| ledger baseline read (`change_latest`) | 3,105 | 4,999 |
| sessions draft hydration | 1,289 | 6,321 |
| sessions row recovery (5,761 sessions; row read 4,696 ms) | 5,798 | 12,120 |
| issues catch-up | 1,228 | 14,093 |
| listen | 1 | **15,138** |
| health exposed | 1,224 | **16,375** |

**Gap: boot RSS is not logged.** No boot stage records memory. The nearest reading is the first minute
record of the new process, at about 30 s of uptime: RSS 1,230 MiB, heap 521 MiB. The bench measures boot RSS
itself (`rssAfterBootMiB`).

### Top statements in the stall journal

`scripts/issue-stall-composition.ts --top=N` (added here) ranks the statements named in
`server event-loop stall` journal records, per build. A stall record names only its top three
statements, with the text cut off, so these are executions named in stalls. They are not total traffic.
Window: 24 h to 2026-10-15T13:41Z. In that window dev.16 logged 19,122 stall records and dev.19 logged 3,081.

| build | executions named | wall ms | in stalls | statement (prefix) |
|---|---:|---:|---:|---|
| dev.16 | 2,894,752 | 126,544 | 16,761 | `select session_id, provider, provider_session_id, binding_version, observation_generation, checkpoint…` (`session_observation_checkpoints`) |
| dev.16 | 1,430,149 | 101,211 | 13,180 | `select observer_generation, cursor_json, turn_epoch, closed_turn_epoch, updated_at from runtime_eve…` (`runtime_event_checkpoints`) |
| dev.16 | 268,440 | 693,065 | 14,572 | `select id, thread_id, in_reply_to, from_kind, from_session, from_issue, …` (`messages`) |
| dev.16 | 179,824 | 7,792 | 515 | `select resource_kind, resource_id, grantee, verb, custody, owner, visibility, …` (grants) |
| dev.16 | 153,662 | 30,315 | 400 | `select id, text, queued_at, attempts, delivery_owner, input_origin, …` (`queued_messages`) |
| dev.19 | 343,344 | 16,241 | 1,867 | `select session_id, provider, … checkpoint…` (`session_observation_checkpoints`) |
| dev.19 | 229,549 | 15,368 | 329 | `select id from users where role = ? and disabled_at is null order by users.created_a…` |
| dev.19 | 221,711 | 6,572 | 282 | `select session_id, count(*) from queued_messages where session_id in (select value fro…` |
| dev.19 | 204,487 | 13,400 | 1,516 | `select observer_generation, cursor_json, … from runtime_eve…` |
| dev.19 | 119,695 | 1,507 | 147 | `select id, display_name, email, account_id, avatar, role, created_at, disabled_at from users…` |
| dev.19 | 39,154 | 85,405 | 1,731 | `select id, thread_id, … from messages` |

The users-by-role lookup and the per-session queued-message count are new near the top in dev.19.
The bench reproduces both (§2).

### Table row counts

Taken from [pod-6140-research.md §3](../internal/pod-6140-research.md) (the live database opened
read-only, 2026-10-15), per the operator's rule not to copy or scan the live 3.6 GB database again:

| table | rows |
|---|---:|
| issues | 7,232 |
| sessions | 6,015 (211 live, 5 reconnecting, 1 starting) |
| messages | 39,526 |
| machines | 8 |
| change_latest | 25,712 |
| changes | 20,110 |
| podium_events | 50,100 |
| applied_mutations | 78,332 (2.15 GB of 3.58 GB) |

The session status split comes from the 11:04Z update backup copy
(`podium.db.backup-vupdate-…-dev.19…`), opened `mode=ro&immutable=1` before the operator's rule arrived.

### Reproducing the live tables

On the live host, only light reads: copy the minute file and export the journal. Then analyze on the VM.

```sh
# on ludovico (read-only; nothing heavy)
cp ~/.podium/perf/loop-server.ndjson /tmp/lb/loop-server.ndjson
journalctl --user -u podium.service --since "<end - 25 h>" -o cat -g '"loop minute"' \
  | grep '"component":"server"' | jq -c '{at,v}' > /tmp/lb/minute-versions.ndjson
journalctl --user -u podium.service --since "<end - 24 h>" --until "<end>" -o cat \
  -g 'server event-loop stall' > /tmp/lb/stalls-24h.ndjson
journalctl --user _PID=<server pid> --since "<restart>" --until "<restart + 3 min>" -o cat > /tmp/lb/boot.log
scp /tmp/lb/* polaris-agents:server-data-bench/live-<date>/
# on the VM
bun scripts/server-data-bench/live-baseline.ts --minutes=…/loop-server.ndjson \
  --versions=…/minute-versions.ndjson --end=<end ISO> --since-restart=<ISO>
bun scripts/issue-stall-composition.ts --top=12 < …/stalls-24h.ndjson
grep 'boot stage completed' …/boot.log | jq -c '{stage, stageDurationMs, durationMs}'
```

## 2. The server data bench

`scripts/server-data-bench/` holds one command (`run.ts`) and its parts:

| file | what it does |
|---|---|
| `corpus-export.ts` | writes one `buildCorpusCell` cell (POD-4747) as JSON, in the harness checkout, so both arms get identical facts |
| `seed.ts` | writes that corpus into a fresh database through the ARM's own store: machines with tokens, repos, issues (parents first), deps, sessions |
| `serve.ts` | the bench server process. It boots the arm's `startServer` on an isolated state directory and prints its logs as NDJSON. On stdin, `totals <label>` prints the lifetime statement and task totals. |
| `drive.ts` | the synthetic load, run as its own process so its CPU stays out of the server's accounting |
| `run.ts` | the orchestrator: arm checkouts, templates, interleaved rounds, the table |
| `report.ts` | the pure summaries, pinned by `report.test.ts` |
| `live-baseline.ts` | the live tables above, from exported files |

**Isolation.** Every bench server gets a whitelisted environment (`benchEnvironment`):

- its own `HOME`, `PODIUM_STATE_DIR`, XDG dirs and `TMPDIR` under the bench root, with
  `PODIUM_INSTANCE=server-data-bench`;
- ports 0, no relay, no telemetry, `PODIUM_UPDATE_SCOPE=fleet-only`, transcript lake off,
  `PODIUM_MODE=server`;
- `PODIUM_LOOP_PROFILE=attribution`.

`serve.ts` refuses a state directory outside a `server-data-bench` root. No daemon, supervisor or live
instance is involved; the "daemons" are the load driver's sockets.

**Corpus.** The default cell is `h1a1`, seed 4443: 4,867 issues and 4,304 sessions, 84 of them live,
spread over 6 machines, plus 485 repos and 3,594 deps. `--cell=h10a1` is about 28k issues and 31k sessions.
Corpus ids are mapped to server ids deterministically (`benchUuid`). Each arm seeds its own template
once per commit, then boots it once as a warm-up, so the password, signing key and first-boot backfills
are not measured. Every round boots a fresh copy of that template.

**Load.** `drive.ts`, for the whole window:

- *Daemons:* one fake daemon per seeded machine. It dials the real `/daemon` socket with a machine token
  (`peerHello` → `peerHelloOk`), reports an inventory, and then sends daemon frames for that machine's live
  sessions. The `1x` rate is **28,000 frames/min in total**, which is today's live 24 h median. `10x` is
  280,000. Every daemon also sends `hostMetrics` every 5 s, as a real daemon does, and answers
  `runtimeLifecycleRequest`.
- *When the server drops a daemon:* an overloaded server drops a daemon whose liveness ping goes
  unanswered. Like a real daemon, the fake one reconnects after 1 s. Frames that come due while it is
  down are counted as dropped (`framesDroppedPerMin`), not queued, so the offered schedule never changes.
- *Frame mix* (`FRAME_MIX`, spread evenly over time): 90% `agentFrameBatch` (terminal output),
  4% `runtimeEvent`, 4% `agentObservation`, 1.5% `agentState`, 0.5% `title`. Why this mix:
  - In live daemon stall records the server's `runtimeEventAck` (2,604) and `agentObservationAck` (2,356)
    run about one to one; the rest of the daemon traffic is terminal output.
  - The first mix (70% terminal output) ran 4.0 SQL statements per frame against 1.25 live. The
    calibrated mix runs **1.41 per frame and 39.5k statements/min with frames alone**, between the live
    24 h (1.25, 35.3k) and 1 h (1.45, 40.6k) medians.
  - The hot statements are the live ones: the users-by-role select, the queued-message counts and the
    runtime event checkpoints.
- *Clients:* 4 logged-in `/client` sockets (`hello`, then they read the feed).
- *Writes:* 10× the operator's measured rate (POD-5874: 186 session updates and 22 issue updates per
  minute), as tRPC `sessions.rename` at **1,860/min** and `issues.update` (priority) at **220/min**.
  *Session write targeting* (`--session-write-targeting`, added by POD-6161): the runs in §3 picked
  the renamed session uniformly over the whole table, so about 98% of renames hit parked sessions.
  New runs default to `running`: 95% of renames go to live sessions and 5% to parked ones (an
  assumption, documented in `drive.ts` `RUNNING_WRITE_SHARE`; the live database is not scanned).
  `--session-write-targeting=uniform` reproduces the old profile; a resumed run keeps its own.

**Collection.** Per round:

- **Boot:** the `listen` boot stage (process uptime) and the RSS when `startServer` resolved.
- **Window:** the run waits 10 s, then starts the load 10 s before a whole minute. The measured window
  is `minutes + 1` long. At its start and end, `serve.ts` prints the lifetime attribution totals
  (`queryAttributionTotals`, `taskAttributionTotals`) and memory.
- **Exact rates:** SQL statements and wall, daemon frames and wall, and statements per minute by
  operation kind (verb plus first table) all come from the end totals minus the start totals.
- **Loop shares:** utilization, blocked share and stalls come from the `loop minute` records whose whole
  span lies in the window, selected by the record's log time. Under load a loop minute can run longer
  than 60 s, because the sampler runs late. Its span is reported (`minuteSpanS`), and stall counts are
  scaled to 60 s of wall time.
- **End of window:** RSS and heap.

Every round's `round.json` also keeps what the driver sent and received.

**Rounds.** A and B alternate, A B A B …, for `--rounds` rounds each (default 3). The table shows the
median over rounds, the min–max over rounds, and B vs A.

## 3. Noise band and first A/B

### Same server code, two commits (the noise run)

**What was compared:** A = `7119f0da72` (the epic branch tip) against B = `1f77e3884a` (this issue's
branch: the same server code plus the bench scripts and this doc). The machine was the polaris agents
VM (4 CPU, 12 GB), the run ID `2026-10-15T15-30-11-944Z-noise-1x`, as of 2026-10-15T16:11Z.

**Setup:**
- Corpus: cell `h1a1`, seed 4443.
- Load: `1x`.
- Rounds: 4 measured minutes each, 3 rounds per arm, order A B A B A B.
- Round starts (UTC): A1 15:32, B1 15:38, A2 15:44, B2 15:50, A3 15:56, B3 16:06.
- B3 ran in a second call, after the lock was released between pairs.
- This run's driver predates the reconnect handling. No daemon socket closed in any 1x round (the driver
  logged no errors), so the reconnect handling would not have changed it.

| metric | A median (min–max) | B median (min–max) | B vs A | noise band | what it counts |
|---|---:|---:|---:|---:|---|
| bootListenMs | 2,291 (2,263–2,331) | 2,397 (2,325–2,518) | +4.6% | ±8% | process start to the `listen` boot stage, ms |
| rssAfterBootMiB | 508 (487–513) | 516 (488–534) | +1.6% | ±9% | server RSS when `startServer` resolved |
| rssEndMiB | 488 (484–526) | 481 (473–494) | −1.3% | ±9% | server RSS at the end of the window |
| heapEndMiB | 140 (134–151) | 128 (124–138) | −8.6% | ±12% | server heap used at the end of the window |
| utilizationPct | 45.7 (45.2–45.9) | 46.0 (45.8–46.1) | +0.7% | ±1.5% | event-loop utilization, median of window minutes |
| blockedPct | 24.0 (23.7–24.1) | 24.2 (23.9–24.3) | +1.0% | ±2% | share of the minute the loop was blocked |
| stallsPerMin | 5.4 (5.0–6.9) | 5.9 (5.0–5.9) | +9.2% | ±40% | stalls per 60 s of wall time (small counts) |
| minuteSpanS | 60.7 (60.7–60.8) | 60.6 (60.6–60.7) | −0.1% | – | wall seconds per loop minute |
| sqlStatementsPerMin | 69,021 (68,914–69,022) | 69,003 (68,993–69,010) | −0.0% | ±0.5% | SQL statements per minute, exact window |
| sqlWallMsPerMin | 5,039 (4,994–5,052) | 5,058 (5,046–5,100) | +0.4% | ±1.5% | SQL wall ms per minute, exact window |
| daemonFramesPerMin | 28,070 (28,049–28,074) | 28,072 (28,071–28,074) | +0.0% | (load) | daemon frames handled per minute |
| daemonWallMsPerMin | 1,106 (1,091–1,120) | 1,120 (1,119–1,123) | +1.3% | ±3% | ms per minute handling daemon frames |
| windowSqlPerDaemonFrame | 2.46 | 2.46 | −0.0% | ±0.5% | all SQL in the window / daemon frames (includes the writes' SQL) |

**The noise band** is, per metric, the larger of the B-vs-A gap and the spread within one arm's rounds
(max − min over the median), rounded up. Two runs of the same server code agree within it. A later landing's
B vs A inside the band is "no worse"; outside it, in the bad direction, it is a real effect to explain or fix.

- **Exact counts are nearly deterministic** (statements per minute, statements per frame), so the bench
  sees even a single extra statement per operation.
- **Times move about 1–3%:** utilization, blocked share, SQL wall and daemon wall.
- **Memory and boot move up to about 10%.**
- **Stall counts are small (5–7 per minute)** and only show large effects.

**Statement mix at 1x, A arm** (per minute, by verb and first table). The kinds come from
the attribution layer's statement keys. Those keys are cut off for long statements, so a kind without a
table (`select`) is a statement whose `FROM` lies past the cut.

| kind | per min | kind | per min |
|---|---:|---|---:|
| select (table cut off) | 12,145 | select podium_events | 3,357 |
| select users | 11,059 | insert change_latest | 3,342 |
| select cli… | 8,328 | insert changes | 3,342 |
| select queued_messages | 5,788 | select meta | 2,317 |
| insert sessions | 3,542 | select user_preferences | 2,245 |

**The bench against live:**
- The bench and the live server run on different machines with different loads, so their absolute times do not
  compare. Compare a bench number only with the other arm of the same run.
- Frames alone at 1x give 39.5k statements per minute and 1.41 per frame, close to live (§2).
- The 10× writes add about 30k statements per minute (the session renames write `sessions`, `changes` and
  `change_latest`, and fan out through the users and queued-message reads).
- About 1–9 of each round's roughly 10.8k writes are refused with 409, because some seeded issues are in
  the system-owned `shipping` stage. The refusal is the same in both arms.

### 10x daemon frames: saturation

**What was compared:** the same two commits, run `2026-10-15T16-55-52-019Z-noise-10x`, as of 2026-10-15T17:29Z.

**Setup:**
- Corpus: cell `h1a1`.
- Load: `10x` (280,000 frames/min offered, writes as at 1x).
- Rounds: 3 measured minutes, 2 rounds per arm, order A B A B.
- Round starts (UTC): A1 16:57, B1 17:02, A2 17:20, B2 17:25. A2 came after a 14-minute gap: the lock was
  released between pairs.

| metric | A median (min–max) | B median (min–max) | B vs A | noise band | what it counts |
|---|---:|---:|---:|---:|---|
| daemonFramesPerMin | 90,814 (90,105–91,523) | 93,506 (92,255–94,757) | +3.0% | ±5% | frames the server handled per minute (of 280,000 offered) |
| sqlStatementsPerMin | 154,821 (153,294–156,349) | 157,228 (155,359–159,098) | +1.6% | ±3% | SQL statements per minute, exact window |
| sqlWallMsPerMin | 11,624 (11,571–11,677) | 11,878 (11,865–11,891) | +2.2% | ±3% | SQL wall ms per minute |
| daemonWallMsPerMin | 2,495 (2,470–2,520) | 2,567 (2,551–2,582) | +2.9% | ±4% | ms per minute handling daemon frames |
| windowSqlPerDaemonFrame | 1.70 | 1.68 | −1.4% | ±2% | all SQL in the window / frames handled |
| daemonReconnects | 64.5 (64–65) | 60 (58–62) | −7.0% | ±10% | times the server dropped a fake daemon in a round |
| framesDroppedPerMin | 24,319 (23,356–25,281) | 26,533 (25,097–27,969) | +9.1% | ±15% | frames due while their daemon was disconnected |
| rssEndMiB | 584 (567–601) | 563 (547–579) | −3.6% | ±6% | RSS at the end of the window |
| heapEndMiB | 124 (123–126) | 136 (129–143) | +9.3% | ±12% | heap used at the end of the window |
| bootListenMs | 2,456 (2,450–2,462) | 2,506 (2,498–2,513) | +2.0% | ±8% | boot to `listen` |

**Today's server cannot carry 10x on this VM:**
- It handles about 91k of the 280k frames offered per minute, about 3.2 times today's live rate.
- Its loop is about 99% blocked.
- It drops every fake daemon about every 15 s, because the liveness ping goes unanswered behind the
  frame backlog. The daemons reconnect after 1 s.
- The loop sampler starves: one loop "minute" takes 190–200 s, and a round holds 0–1 whole minutes.

So at 10x, **compare throughput, not loop shares**: frames handled, SQL statements and wall, reconnects
and memory. `utilizationPct`, `blockedPct`, `stallsPerMin` and `minuteSpanS` rest on 0–1 minutes and
are not a valid comparison there; this run's table shows them with a −30% "change" that is only that
artifact. A change that makes the server faster shows up at 10x as more frames handled, fewer
reconnects and fewer dropped frames.

**Live-host caveat.** The live host (ludovico) is a different machine. Its own 1x utilization is 52%, so its
saturation point differs. That point is for the final measurement (POD-6161) to establish on the live
server if wanted; this issue does not stress the live server.

## How a landing runs its A/B

Run the bench on the **polaris agents VM**, through `polaris-lane`, which pushes your committed HEAD and
holds `test:polaris-agents` for the call. Nothing heavy runs on ludovico, and benchmarks do not run on
flatblock (operator rule 2026-10-15). Hold the lock for at most 20 minutes per acquisition (coordinator
rule, same day): run **one A/B pair per call** and resume between calls, so queued test runs get through.
The arms are interleaved, so gaps between calls do not bias A against B. The report lists any gap.

```sh
# commit first; polaris-lane refuses a dirty tree. First call: A1 and B1 (about 15 minutes).
POLARIS_LOCK_TTL=25m POLARIS_TIMEOUT=1500 polaris-lane <issue> run \
  bun --conditions=@podium/source scripts/server-data-bench/run.ts \
    --a=<parent sha> --b=<candidate sha> --rounds=3 --minutes=4 --cell=h1a1 --load=1x --max-new-rounds=2
# it prints "paused … Resume with --resume=<run dir>"; each later call runs the next pair:
POLARIS_LOCK_TTL=25m POLARIS_TIMEOUT=1500 polaris-lane <issue> run \
  bun --conditions=@podium/source scripts/server-data-bench/run.ts --resume=<run dir> --max-new-rounds=2
# the call that finishes the last round prints the table and writes <run dir>/report.md
```

- **A is your parent commit** (the epic branch tip you rebased onto) and **B is your candidate**. Each is
  resolved once, at the first call, and saved in `<run dir>/run.json`. Later calls reuse those SHAs even
  after a newer push. Both must be in the pushed history. The bench makes a worktree per SHA under `~/server-data-bench/checkouts/`
  and seeds a template per SHA (about a minute the first time).
- **Keep the setup the same as the baseline:** cell `h1a1`, seed 4443, `--load=1x`, 4 measured minutes,
  3 rounds each, interleaved. For a change whose effect grows with data, also run `--cell=h10a1`. For one
  on the daemon path, also run `--load=10x`.
- **Paste into your handoff** the printed table (it names both SHAs, the as-of time and what each
  number counts) and the evidence directory it prints.
- **Read it against the noise band** in §3. A change smaller than the band is "no worse"; a change larger
  than the band in the bad direction must be explained or fixed before landing.
- **Keep it apples to apples:** a timing comparison is valid only between arms of one run on one machine.
- **Per-round details:** in `~/server-data-bench/runs/<run>/<arm>-r<k>/round.json`:
  - top statement kinds,
  - top tasks,
  - the driver's sent and received counts and any errors.
- **Copy-removal comparisons:** an old-vs-new test over "the benchmark corpus" (docs/agents/server-data.md)
  can seed it with `corpus-export.ts` + `seed.ts` into a test database.

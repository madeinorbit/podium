# Worker-owned delta scoping

The delta HTTP producer now runs in the existing sync worker. The route admits the request, checks feed identity, negotiates encoding, and relays bytes. `Authority.changesRange` and the snapshot producer share `scopeChangesRange`, including its bounded page lookahead, scoping, and final range certification.

## Durable visibility

`grant_audiences` stores distinct `(resource_kind, resource_id, grantee)` entries. Grant upserts and individual revokes record audiences in the same transaction as their grant statement. Migration seeds existing live grants; historical revoked readers that existed only in memory before upgrade cannot be reconstructed. Audience entries are deliberately never pruned, even when resources or change rows disappear. This preserves correctness at the cost of cumulative historical audience storage.

Worker jobs read audiences through `GrantsRepository` on their read-only snapshot connection. The snapshot-local visibility cache uses the snapshot head as its revision; it is never shared between jobs. The main-thread cache retains its existing grant revision counter, so grant-only writes still invalidate it without requiring a feed-head advance.

Issue-event subjects come from committed `change_latest` rows, sorted by event id. The publisher window is not always equivalent: `publish()` pushes the arrival and shifts evictions before awaiting capture, then swallows capture failures. It can therefore contain unpublished rows and omit still-committed rows. POD-4033 owns that defect. Differential equality is asserted on a clean window; the worker deliberately follows committed state when the publisher window diverges.

## Paired 20,000-row observation

Both arms used **Bun 1.4.2** on 2026-09-15, with the programme's deterministic corpus: 5,120 public repo keys, 10 KiB payload fields, and 20,000 retained updates over `(5120, 25120]`. Identity encoding, a fast external Python HTTP reader, and isolated loopback hosts were used. This measures payload scaling, not a representative distribution of private grants.

The before arm loads the route from integration commit `9bd1a5231`, using its main-thread producer. The after arm loads the worker route in this change. Both use the same current shared scoping implementation and fixture. Main CPU is the difference in `/proc/<pid>/task/<pid>/stat` utime+stime divided by `SC_CLK_TCK`, as in POD-3946. Busy fraction divides main CPU by the HTTP request-to-completion window. Client CPU is excluded; no health/ping probe ran in this focused comparison.

| Arm | First record | Completion | Main CPU | Main busy | Rows / pages | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main thread | 102.9 ms | 1,545.4 ms | 1,120 ms | 72.47% | 20,000 / 40 | 206,775,247 |
| Worker | 118.5 ms | 3,419.4 ms | 590 ms | 17.25% | 20,000 / 40 | 206,775,247 |

Main CPU decreased 47.3%, while completion time increased 2.21×. This is one paired observation, not a latency guarantee. Shared-host 1/5/15-minute load was 8.97/21.64/33.77 before and 9.73/21.20/33.43 after; scheduler competition and the worker byte relay contribute to elapsed time. Both streams certified seq 25120 and completed with exactly 20,000 rows. Temporary databases and WAL files were removed after each arm.

Reproduction: use the task-owned Bun 1.4.2 binary (or another verified 1.4.2 installation), materialize `git show 9bd1a5231:apps/server/src/sync/routes.ts` as `apps/server/src/sync/delta-baseline.measurement.ts`, and run `scripts/sync-measurements/delta-worker-run.py` from the repository root after updating its Bun path if necessary. It launches `delta-worker.mjs` with `--conditions=@podium/source` for each arm. Remove the temporary baseline route afterward. Raw measurements are attached to the issue.

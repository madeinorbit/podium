# `podium issue` CLI latency profile

**Measured as of `3334b266` on `ludovico`**, 2026-08-02. Repo state at measurement:
1286 issues (609 open), `~/.podium/podium.db` 205 MB + 11 MB WAL. The box was running
other agent sessions throughout, so absolute numbers drift ±30%; the *ratios* and the
mechanisms below are what hold. All figures are medians of 7–9 runs.

## Headline

Every `podium issue …` call an agent makes costs **0.3–1.1 s**. About 200 ms of that is
unavoidable process startup. The rest is server-side work, and it is dominated by one
bug-shaped thing: **the list-style reads (`ready`, `blocked`, `stats`, `graph`, `count`)
never pass the batch object that `list` uses**, so they re-run ~5 SQL statements plus an
O(N) scan *per issue*, 1286 times.

The clearest single symptom: **fetching one issue costs more than fetching all 1286.**

## End-to-end CLI latency (agent/relay path — what agents actually pay)

| Command | median | min | max |
|---|---|---|---|
| `podium --version` (startup floor) | 218 ms | 187 | 284 |
| `podium issue children 1331` | 313 ms | 264 | 401 |
| `podium issue count` | 405 ms | 355 | 1596 |
| `podium issue show <id>` | 538 ms | 440 | 774 |
| `podium issue prime` | 673 ms | 478 | 1008 |
| `podium issue blocked` | 708 ms | 695 | 831 |
| `podium issue graph` | 786 ms | 722 | 878 |
| `podium issue list` | 791 ms | 534 | 1148 |
| `podium issue stats` | 1048 ms | 833 | 1359 |
| `podium issue ready` | 1054 ms | 786 | 2590 |

Writes (measured separately, same conditions):

| Command | median |
|---|---|
| `issue label` / `update --priority` | ~230 ms (≈ startup floor) |
| `issue state --set`, `todo --add`, `claim`, `comment` | 400–430 ms |
| `issue update --stage` | 520 ms |
| `issue mail send` | 534 ms |
| `issue dep-add` | 824 ms |
| **`issue create`** | **1.05–1.36 s** (server-side `issues.create` alone ≈ 850 ms) |
| **`issue close`** | **~1.1 s** |

## Where the time goes

### 1. Process startup: ~200 ms, fixed, unavoidable-ish

`~/.local/bin/podium` is a bash shim that `exec`s `bun --conditions=@podium/source
scripts/cli.ts`. Breakdown:

- bare `bun -e ''` — 17 ms
- `import('apps/cli/src/cli')` — ~100 ms (zod schema construction across `@podium/protocol`
  plus the `@podium/issue-client` barrel, which builds the issue **and** lock **and** spec
  command tables even when one command runs)
- rest of `--version` path — ~70 ms

Verified there is **no** per-invocation git subprocess, worktree detection, transcript read,
migration check, or direct SQLite open. Only 3 `execve`s total (shim → bash → bun).

### 2. Server-side RPC: the real cost

The CLI never touches SQLite. It POSTs `{router, proc, input}` to the agent relay
(`PODIUM_AGENT_RELAY`, 127.0.0.1:45778), which forwards over the daemon↔server WebSocket.
Measured with `curl` straight at the relay (no CLI startup), interleaved:

| RPC | median | response size |
|---|---|---|
| relay noop (unknown router) | 39 ms | — | ← transport floor |
| `repos.inferFromPath` | 35 ms | 61 B |
| `issues.count` | 26–221 ms | 493 B |
| `issues.list` | **139–165 ms** | **4.76 MB** |
| `issues.get` (by `iss_…`) | 183 ms | 1.4 KB |
| `issues.get` (by seq `"1332"`) | 219 ms | 1.4 KB |
| `issues.ready` | **421–443 ms** | 805 KB |
| `issues.stats` | 444 ms | **97 B** |
| `issues.blocked` | 453 ms | 218 KB |
| `issues.graph` | 499 ms | 450 KB |

Note `stats` returns **97 bytes** and costs 444 ms, while `list` returns **4.76 MB** and
costs 165 ms. Cost tracks per-row work, not payload.

### 3. Root cause: the missing `IssueWireBatch`

`IssueServiceCore.toWire()` (`apps/server/src/modules/issues/service/core.ts:119-165`) takes
an optional `batch` argument. With it, everything is a map lookup. Without it, **every
single row** does:

- `getIssueLabels(row.id)` — SQL (`core.ts:124`)
- `[...this.rows.values()].filter(r => r.parentId === row.id)` — **full 1286-row spread and
  scan, per row** → O(N²) ≈ 1.65 M object visits (`core.ts:128`)
- `listIssueDeps(row.id)` — SQL (`core.ts:135`)
- `listDependents(row.id)` — SQL (`core.ts:143`)
- `computeBlocked(row)` → `listIssueDeps(row.id)` **again** — SQL (`core.ts:109-115`)
- `prefixForPath(row.repoPath)` — SQL (`core.ts:159`)

`list()` passes the batch (`core.ts:250-290`) and pays 4 bulk queries total. But
`readyList` (`reads.ts:41-48`), `blockedList` (`:50-57`), `graph` (`:59-84`),
`stats` (`:426-440`), `children` (`:104-117`) and `get` (`:442-445`) all call
`this.toWire(r, commentCounts)` — **`commentCounts` but no `batch`**. Verified by reading
the source; the ternaries in `toWire` all take the else branch.

That single missing argument is the ~3× gap between `list` (139 ms) and `ready` (443 ms)
over the identical row set.

### 4. `resolveRepoIdForPath` has no cache and runs 2× per row

`inRepoScope` (`core.ts:303-308`) calls `store.repos.resolveRepoIdForPath()` twice for every
row — once for the scope path, once for the row's path. That function
(`apps/server/src/store/repos.ts:285-296`) runs a **full `listRepos()` query** every call, with
no memoisation. The CLI always supplies `repoPath` (see §6), so this fires **2 × 1286 times
per read command**.

This is why `issues.count` — which never calls `toWire` at all — still costs 221 ms.
It is the clean isolated measurement of the repo-id lookup cost.

### 5. No statement cache in the SQLite adapter

`openBunDatabase` (`packages/runtime/src/sqlite/bun.ts:43-64`) calls `db.prepare(sql)` fresh on
every statement — no cache. With ~8–10 k statements per `ready` call, every one recompiles
its SQL. This is a multiplier on everything above.

**Indexes are not the problem.** `idx_issues_repo_id_seq` (unique, on `repo_id, seq`),
`idx_issue_deps_from/to`, `idx_issue_comments_issue`, `idx_issues_parent` all exist
(`apps/server/src/migrations/drizzle/20260715135845_baseline/migration.sql:540-556`). Issue rows
are hydrated into an in-memory `Map` and never re-read per request. Adding indexes would
change nothing.

### 6. Wasted round-trips

**A serialized `repos.inferFromPath` pre-call.** `resolveRepoArg`
(`apps/cli/src/issue-cli.ts:213-222`) fires it for any command whose schema has `repoPath`
and no explicit `--repo-path`. Confirmed by `strace` on the real CLI:

```
podium issue ready   → repos.inferFromPath, then issues.ready
podium issue list    → repos.inferFromPath, then issues.list
podium issue stats   → repos.inferFromPath, then issues.stats
podium issue create  → repos.inferFromPath, then issues.create
podium issue graph / doctor / deps / blocked / prime → same
podium issue show    → issues.get, then issues.comments   (no inferFromPath)
podium issue tree / children → single call
```

It is `await`ed before the real call, so `httpBatchLink` cannot merge it. Costs ~35 ms —
and, worse, it is what supplies the `repoPath` that then triggers 2572 uncached
`listRepos()` calls in §4.

**`show` is two serialized RPCs.** `issues.get` then `issues.comments`, the second needing
the internal `iss_…` id from the first (`packages/issue-client/src/commands.ts:277-283`).
There is no combined proc and no `includeComments` flag.

### 7. `issues.get`: single-issue fetch also enumerates every session

Beyond the unbatched `toWire`, the `get` def (`apps/server/src/modules/issues/registry.ts:563-578`)
calls `sessionsForIssue(…, ctx.deps.listSessions(), …)`. `listSessions()`
(`apps/server/src/modules/sessions/service.ts:1166-1181`) stamps **every** session through
`computeSessionDisplayRef` (`:734-741`), which per session does a `getIssue` **and** a
`prefixForPath` → `resolveRepoIdForPath` → `listRepos()`. Roughly 4 SQL statements per
session, per single-issue fetch — then the filter throws most of it away.

Lookup by seq (`"1332"`) costs a further ~35 ms: `resolveRef` (`core.ts:358-364`) does a
full-map scan for the seq rather than using the `(repo_id, seq)` index, then calls
`inRepoScope` per candidate.

### 8. Relay vs direct transport

Interleaved A/B, same commands, `PODIUM_NO_RELAY=1` for the direct tRPC path:

| Command | relay (agents) | direct (operator) |
|---|---|---|
| `issue ready` | 848 ms | 333 ms |
| `issue list` | 696 ms | 418 ms |
| `issue graph` | 738 ms | 305 ms |

Agents **always** take the relay path (the daemon sets `PODIUM_AGENT_RELAY`), so agents pay
this consistently. The relay's own transport floor is only ~39 ms, and the relay handles a
4.76 MB `list` response in 165 ms — so payload size is *not* the explanation. Per call the
relay adds: 3 JSON encode/decode hops, an extra process hop through the (busy) daemon event
loop, and a `capabilityForSession()` mint that itself runs an O(N) scan over all 1286 rows
(`apps/server/src/modules/sessions/service.ts:1507`, `reads.ts:485-497`). I did not fully
attribute the remaining gap; daemon event-loop contention under concurrent agent load is
the likely remainder, and this is worth its own measurement.

### 9. Client-side parse and render is not free either

`strace` on `podium issue list`: total 666–949 ms, of which the network window (first send →
last recv) is only 225–294 ms. The rest is startup plus `JSON.parse` and table-rendering of
a **4.76 MB** payload — to print a summary table.

## Recommended fixes, by expected impact

1. **Pass the existing `IssueWireBatch` into `readyList` / `blockedList` / `stats` / `graph` /
   `children` / `get`.** One argument. Should bring `ready` from ~443 ms toward `list`'s
   ~139 ms, and kills the O(N²) children scan.
2. **Memoise `resolveRepoIdForPath` / `prefixForPath`** (per request at minimum). Removes
   ~2572 full `listRepos()` queries per read command; `count`'s 221 ms is the direct measure
   of what this buys.
3. **Stop calling `listSessions()` on single-issue `get`**, or cache
   `computeSessionDisplayRef`.
4. **Add a prepared-statement cache** to `packages/runtime/src/sqlite/bun.ts` — a cheap
   multiplier on all of the above.
5. **Drop the serialized `repos.inferFromPath` pre-call** — cache it per cwd, or fold the
   cwd into the real call's input. Saves a round-trip *and* the repoPath-triggered scans.
6. **Add `includeComments` to `issues.get`** — halves `show`'s wall time.
7. **Resolve seq via the existing `(repo_id, seq)` index** instead of a full-map scan.
8. **Profile `issues.create` (~850 ms) and `issues.close` (~1.1 s) separately** — not covered
   here; they are the slowest single operations and their cost is not explained by the above.

## Method

- `bench.sh N label cmd…` — wall-clock via `date +%s%N`, reports median/min/max.
- Server-side RPCs timed with `curl` POSTing directly at `$PODIUM_AGENT_RELAY`, which removes
  CLI startup from the measurement.
- Round-trip counts and per-RPC timings from
  `strace -f -ttt -s 900 -e trace=sendto,recvfrom podium issue …`.
- Relay-vs-direct A/B interleaved run-by-run (not in blocks) to cancel load drift on a box
  running other agents.
- Nine throwaway sub-issues were created under this issue as write targets and have been
  closed and archived.

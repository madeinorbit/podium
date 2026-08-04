# POD-1654 — live-host findings for the repeating full issue scan

Statement under investigation:

```sql
SELECT * FROM issues ORDER BY repo_path ASC, seq ASC
```

All measurements taken on the live host `ludovico`, 2026-08-04, against the
running `podium-server.service`. Repo state when read: `ecd55d614`; the live
main checkout was at `51ef08640`. Nothing was restarted and nothing was written
to `~/.podium`.

## 1. The prescribed method cannot run as written — stacks are OFF live

The brief says "PODIUM_LOOP_PROFILE_STACKS=1 samples caller stacks ... the live
unit already sets it". Only the first half holds. The live unit sets:

```
Environment=HOME=… PATH=… PODIUM_PORT=18787 PODIUM_LOOP_PROFILE=1
```

and the running process's `/proc/<pid>/environ` confirms `PODIUM_LOOP_PROFILE=1`
is the ONLY profile variable present. `packages/runtime/src/sqlite/query-attribution.ts`
computes

```ts
const STACKS = ENABLED && !!process.env.PODIUM_LOOP_PROFILE_STACKS
```

at module load. So `recordCallerStack` has never run in this process, the
`stacks` map is empty, and the SIGUSR2 handler's `STACKS` section prints
nothing. **The instrument that would name the caller directly is not armed on
the live host, and arming it requires a restart** — which the brief forbids.

## 2. SIGUSR2 works; totals are readable

`kill -USR2 <MainPID>` against the live server printed `[podium:loop] TOTALS`
(top 15 by count) with no ill effect. Over ~12 minutes of uptime the full scan
did **not** appear in the top 15 — the 15th entry was 666x, so its lifetime
count over that window is bounded below 666, and by §3 it is almost certainly 1
(boot hydration).

## 3. The multiplier exists in exactly ONE burst, all of it on pre-fix code

Every occurrence of the statement in 24h of `podium-server.service` journal,
with pid:

| time (local) | pid | sample |
|---|---|---|
| 08:57:41 | 825383 | 1x/287ms/1621rows |
| 08:57:44 | 825383 | 2x/120ms/3242rows |
| 08:58:47 | 825383 | **9x/487ms/14589rows** |
| 08:58:48 | 825383 | **7x/330ms/11347rows** |
| 08:59:18 | 825383 | 1x/65ms/1621rows |
| 08:59:41 | 825383 | 1x/45ms/1621rows |
| 09:00:00 | 825383 | 1x/62ms/1621rows |
| 09:00:02 | 825383 | **4x/199ms/6484rows** |
| 09:50:12 | 871721 | 1x/53ms/1623rows |
| 09:50:16 | 871721 | 1x/64ms/1623rows |

POD-1653 landed at **09:44:42** (`193fe69ee`). Both pids above predate it —
871721 was still running old code at 09:50. Since the first post-fix boot
(12:41) the statement has not appeared in a single stall window.

So the 9x/7x/4x samples are all from a **single 2.5-minute burst on pre-POD-1653
code**, and no post-fix multiplier has been observed. That is consistent with
the fix having removed the multiplier's source, but it is NOT proof — the host
has been comparatively quiet since.

## 4. Caller census, and what it rules out

Production callers of the unscoped `listIssueRows()` — the only path that
issues this statement (`apps/server/src/store/issues.ts:411`):

| caller | before POD-1653 | after |
|---|---|---|
| `DurableIssueAccessIndex` — `worktreePaths` / `issueForCwd` / `soleOwnerForCwd` | yes, per call | **gone** — now `listIssueCwdRows()` (5 columns, `issues.ts:326`) |
| `MemorySearchService.search` (`modules/memory/search.ts:114`) | yes, per search | unchanged |
| `IssueService.hydrate` (`modules/issues/service/core.ts:202`) | yes | unchanged |

Ruled out on live evidence:

- **`hydrate()` re-running (brief candidate 2).** `hydrated` is set once and
  never nulled again, and the only production `reload()` caller is
  `crud.ts:629` inside `purgeEmptyDraft`. The `changes` table records **zero**
  `entity='issue' op='remove'` rows anywhere in 08:55–09:02, so no draft was
  purged and no `reload()` ran. Hydration contributes the 1x, not the multiplier.
- **A per-session `.filter` (`relay.ts:2195`).** With 1208 sessions that path
  would show ~1208x, not 9x. The row counts are exact multiples of 1621, so the
  scan ran 9 discrete times.
- **Omni-search.** `search.query` has no live client — the web app calls
  `conversations.search`, not the omni route; the only `search.query` callers in
  the repo are tests and e2e.

That leaves the **`DurableIssueAccessIndex` cwd questions — brief candidate 1 —
as the only surviving explanation for the multiplier**, and POD-1653 removed
them from this statement. Correlation attempts against message volume (4
messages in the whole 7-minute window) and session creation (1) did not line up
second-for-second, so this is an elimination argument, not a positive
identification.

## 5. What is still unproven, and what would close it

Naming the caller positively still requires the stack sampler. That needs
`PODIUM_LOOP_PROFILE_STACKS=1` in the unit environment and a restart of
`podium-server.service`, then SIGUSR2 after a period of real traffic. The brief
forbids the restart, so this is a decision for the human rather than something
to work around with a fourth harness.

## 6. Unrelated finding worth its own issue

The same burst shows a far larger defect than the one under investigation:

```
08:57:41  server stall 19950ms | own-cpu=19922ms | rss=2564MB
          sql=799155x/4878ms/0rows SELECT * FROM grants WHERE resource_kind = ? AND resource_id = ? ORDER BY created_at ASC
09:50:12  server stall 20516ms | own-cpu=20757ms | rss=2673MB
          sql=803387x/5081ms/0rows  (same statement)
```

~800k executions of a zero-row statement inside a single second, twice. Both
samples are pre-POD-1653; that commit batched the per-session grants read, so it
may already be addressed — but a ~20s event-loop freeze deserves its own
verification against post-fix code.

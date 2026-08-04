# POD-1639 — serve narrow callers without a full session pass

Measured on a **copy** of the live corpus (`~/.podium/podium.db`, never the live
dir): **1582 non-deleted issues / 1200 session rows / 1119 visible sessions**.

## What was wrong

POD-1618 removed the repeated per-session lookups inside `SessionView.list()`
but not the pass. Every issue mutation still built the full reader-scoped
`SessionMeta` projection for all 1119 sessions and then kept the handful that
belonged to the issue being mutated — `cascadeArchiveSessions` found ZERO member
sessions and still paid a whole pass.

Nine call sites spelled the same thing:

```ts
sessionsForIssue(row.worktreePath, deps.listSessions(), row.id)
```

## The fix

`SessionView.listForIssue(worktreePath, issueId, principal?)` applies the
membership predicate to the **live `Session` objects**, before the projection,
and projects only the survivors.

It is sound because membership is decided by two fields that live on the session
itself — `issueId` and `cwd` — and the projection copies both through unchanged,
so the pre-filter selects exactly the set the post-filter would. `isIssueMember`
was lifted out of `sessionsForIssue` so both paths share one predicate and cannot
drift. `list()` and `listForIssue()` share one private `project()`, so the
visibility rule and the memo lifetime have exactly one definition — **visibility
is not narrowed**: surviving members still go through `canReadSession` for the
same principal.

Plumbed as an OPTIONAL `IssueDeps.listSessionsForIssue` consumed through one
seam, `IssueStore.sessionsFor`, which falls back to filtering the full list. The
fallback is what keeps the ~dozen test fixtures that supply only `listSessions`
correct: same predicate, applied after the pass instead of before — slow, not
wrong.

Converted: `cascadeArchiveSessions`, `retireIssueOffers`, `sweepAutoArchive`,
`IssueStore.unreadFor`, the assistant member read, the workflow member read.

## Callers deliberately left alone

- **`reads.ts:217`, `attention.ts:345`** — these receive an already-hoisted full
  list built once for a multi-issue pass. Converting them would turn one full
  pass into N narrow ones, which is worse for a whole-board read.
- **`workflow.ts:1063,1146`** — filter a single-element array; no list is built.
- **`MessageService.onIssuesEligibilityChanged`** — genuinely a SET operation
  over every session ("which sessions resolve into which issue"). It needs the
  whole list.
- **`MessageScheduler.flushDeliveryTriggers`** — narrow by shape, but `all` is a
  **snapshot** taken once before a loop that mutates session state as it goes.
  Per-message narrow reads would make delivery order-dependent. Filed as
  **POD-1642** with the snapshot constraint written into the acceptance shape.
- **36 `listSessions().find(s => s.sessionId === id)` by-id lookups** across 22
  files — a second family, hottest on the per-request authz path. Filed as
  **POD-1644**.

## Measurement

**Harness.** One tree, one binary, the narrow read behind
`PODIUM_NARROW_SESSION_READ` so both arms are the SAME build — the A/B controls
the harness, not just the code. Fresh corpus copy and fresh boot per arm, 20s
settle after listen, one warm archive/unarchive pair discarded, then
`perf.reset` and 25 measured archive mutations. Percentiles come from the
server's own perf registry (`/trpc/perf.snapshot`), which reports p50/p90/p99
over a 512-sample ring; the archive wall column is the driver's own timing of the
`archived: true` call only.

Interleaved **A/B/A/B**. A = full pass (pre-change behaviour), B = narrow read.

| arm | archive wall p50 | p99 | `rpc.issues.update` p50 | p99 | `sessionView.list` n / p50 / p99 | `listForIssue` n / p50 / p99 |
|---|---|---|---|---|---|---|
| A1 | 921 ms | 1559 ms | 670 ms | 1553 ms | 75 / 403 ms / 930 ms | 0 |
| B1 | **487 ms** | **990 ms** | **463 ms** | **973 ms** | 50 / 417 ms / 824 ms | 25 / 0 ms / 1 ms |
| A2 | 1087 ms | 1793 ms | 704 ms | 1770 ms | 75 / 452 ms / 1109 ms | 0 |
| B2 | **529 ms** | **1140 ms** | **518 ms** | **1246 ms** | 50 / 461 ms / 1098 ms | 25 / 1 ms / 3 ms |

Both A arms are worse than both B arms on every column, so the ordering does not
depend on which pair you read — which is the point of interleaving on a box under
fan-out. Archive p50 **921/1087 → 487/529 ms**; p99 **1559/1793 → 990/1140 ms**.

**The count is the defect, and it moved.** Session-list passes per 50 mutations
fall **75 → 50** in both pairs: exactly the 25 passes `cascadeArchiveSessions`
was paying on the 25 archive-true mutations. The narrow read that replaced them
costs **p50 0–1 ms / p99 1–3 ms** against the full pass's 403–461 ms. That gap is
not a tuning win; it is a different algorithm. The old cost was O(all sessions)
whatever the issue looked like, and the new one is O(that issue's members) — for
`cascadeArchiveSessions`, which routinely finds zero, that is O(0) work plus the
scan of an in-memory Map.

`sessionView.list` p50 is *unchanged* between arms (403/417/452/461 ms) and that is
the expected result: this change removes passes, it does not make a pass cheaper.
The passes that remain are the message-delivery callers — POD-1642.

## Session identity is preserved, and that was checked

`Session` objects are used as WeakMap keys (`session-binding.ts:37`), so identity
is load-bearing. `listForIssue` filters `ports.sessions.values()` and passes the
ORIGINAL objects through to `project()`; it never constructs, copies or wraps a
Session. Checked rather than assumed, after POD-1638 lost 26 oracle-handoff tests
to a wrapper that broke a db handle's identity as a Map key.

## Two disclosures

1. **This is not the post-POD-1638 number, but POD-1638 is a small part of this
   pass — smaller than either of us first said.** Both arms were measured on
   `issue/279-integration` tip (`ec2cf9928`) WITHOUT POD-1638's branch.

   An earlier draft of this doc said both arms "still contain its 22209 repo
   full-scans per pass". **That was wrong and is retracted.** The 22209 figure
   was measured at `9404eab40`, the base POD-1638 branched from. `ec2cf9928`
   already contains POD-1618, which memoized the per-session lookups, so on the
   base this issue actually measured on, the same statement runs **1278x**, not
   22209x. The first 20931 belong to POD-1618, not to POD-1638. Its earlier
   "685 + 341 + 283 ms across 66320 executions" split was taken on the old base
   too and is retracted with it.

   On this measurement base, the repo scans are roughly **1278 executions /
   16614 rows / ~51 ms of wall in a 30s window** — a rounding error inside the
   403–461 ms pass, not the bulk of it. What POD-1638 ships is 1278 → 0, and
   that elimination is worth having (the registry is read once per pass instead
   of per session, a property that does not depend on the base) — it is just not
   where this pass's time goes.

   **Where it does go**, from POD-1638's like-for-like measurement with both
   arms on `ec2cf9928` (cite this table, not the older one):

   | statement | before | after |
   |---|---|---|
   | `issues WHERE id = ?` | 32474x | 22198x |
   | grants by resource | 24992x | 17040x |
   | `repos ORDER BY rowid ASC` | 1278x | 0 |
   | `repo_prefixes` (full) | 1278x | 0 |
   | `repo_prefixes WHERE repo_id = ?` | 971x | 0 |

   22198 + 17040 executions of `getIssue` + grants **per session**, against
   1278 + 1278 + 971 for the repo reads. So the pass is dominated by per-session
   issue and grant lookups, which is **POD-1644's** territory — almost nothing
   else in it belongs to POD-1638 or to this issue. Expect the pass to get
   cheaper there, not here. See `docs/evidence/pod-1638/attribution-before-after.md`
   (the `ec2cf9928` table).
2. **p99 over 25 samples is a max, near enough.** The perf registry computes it
   by nearest rank, so at n=25 the reported p99 IS the maximum sample. It is
   reported because the brief asked for it, and it is labelled here rather than
   dressed up as a tail estimate.

# Fix multi-machine tracker fragmentation: scope issue identity by `repo_id` (#140)

## Problem

The issue tracker scopes issues by `repo_path` (the local checkout path), not the
stable `repo_id` (origin-URL hash from #74). Two checkouts of the **same** repo at
different paths — e.g. podium-host `/home/user/src/other/podium` and vmi
`/home/till/src/podium`, same origin ⇒ same `repo_id` — become **separate tracker
partitions** with independent, colliding `#N` sequences.

Confirmed:
- `store.ts:1665 nextIssueSeq(repoPath)` = `MAX(seq) WHERE repo_path = ?` → each path gets its own counter.
- `issues.ts:762 resolveRef(ref)` matches `seq` across **all** in-memory rows (no repo scope).
- Every `issues.list/readyList/...` filters `r.repoPath === repoPath`.
- Reproduced live from a vmi session: `ambiguous issue ref #4 (matches /home/user/src/other/podium#4, /home/till/src/podium#4)`.
- Data: `repo_36de…` spans 2 paths — `/home/user` (137 issues, seq 3–142) and `/home/till` (8, seq 1–8); seqs 3–8 collide.

## Key enabler

`repo_id` is **already fully plumbed** (#74): computed, stored on `issues.repo_id`,
dual-written on create/upsert, backfilled every boot (`backfillRepoIds`), and on the
wire. `store.ts:432 resolveRepoIdForPath(repoPath)` already maps path → repo_id
server-side. **Nothing reads on it yet.** So this is flipping predicates, not new plumbing.

## Changes

### 1. seq allocation by `repo_id`
- `store.ts:1665` `nextIssueSeq(repoId)` → `SELECT MAX(seq) FROM issues WHERE repo_id = ?`.
- `issues.ts:1083` `create()`: compute `repoId = resolveRepoIdForPath(input.repoPath)` (already done at 1088) **before** allocating, pass `repoId` to `nextIssueSeq`.

### 2. Read/list scoping by `repo_id` (signatures unchanged)
Add to `IssueService`:
```ts
private inScope(r: IssueRow, repoPath: string | undefined): boolean {
  if (!repoPath) return true
  const scope = this.deps.store.resolveRepoIdForPath(repoPath)
  if (scope && r.repoId) return r.repoId === scope
  return r.repoPath === repoPath // fallback when repo_id unknown
}
```
Replace the ~17 `r.repoPath === repoPath` / `!repoPath || r.repoPath === repoPath`
filters (`list/readyList/blockedList/graph/depReport/closeEligibleEpics/findDuplicates/
staleList/lint/doctor/preflight/orphans/search/count/stats/prime/emitReadyAfterClose/
sibling-scan`) with `this.inScope(r, repoPath)`.
- `store.ts:1460 listIssueRows(repoPath)` → scope by repo_id too (used at hydration; convert for parity).

### 3. `#N` resolution scoped by `repo_id`
- `issues.ts:762` `resolveRef(ref, scopeRepoPath?: string)` (optional → backward compatible).
  When a bare `#seq` has >1 match and `scopeRepoPath` given, narrow to
  `r.repoId === resolveRepoIdForPath(scopeRepoPath)`; resolve if unique, else throw.
- Thread scope where cheap: `router.ts:116` authz middleware — for a constrained
  capability, derive the bound issue's `repoId` and pass its `repoPath`. Operator
  (`scope.kind === 'all'`) stays global (fine once seq is unique per repo_id).

### 4. One-time renumber migration (data)
In `store.ts migrate()`, **after** `backfillRepoIds()` (so all rows have repo_id),
guarded by a `schema_version` bump (9 → 10) so it runs exactly once:
for each `repo_id`, keep the canonical `repo_path` (most issues; tie-break min path)
and renumber every issue on other paths to append after that repo_id's `MAX(seq)`,
ordered by `(seq, created_at, id)`. Proven on a copy of the live DB: 8 `/home/till`
issues → `#143–150`, `/home/user` untouched, **zero** `(repo_id, seq)` collisions,
147 issues + 128 deps + 139 comments intact. Relation tables key on the stable
`id`, so renumbering `seq` is safe.

### 5. Companion index
`CREATE INDEX IF NOT EXISTS idx_issues_repo_id ON issues(repo_id)`.

## Tests (TDD — failing first)
- `store-issues.test.ts`: two `repo_path`s sharing a `repo_id` draw from **one** seq
  sequence (currently independent — inverts the existing 41-46 assertion).
- `issues.test.ts`: `list` for either path of one origin returns the **unified** set;
  `resolveRef('#N', pathA)` resolves within the caller's repo.
- migration test: seed colliding seqs across two paths/one repo_id → after migrate,
  seq unique per repo_id, majority path unchanged, relations intact.
- `issue-cli.e2e.test.ts`: two checkouts, same origin → shared `#N` space (no ambiguity).

## Rollout / verify
1. TDD in this worktree; `bun test` green; typecheck; build.
2. Dry-run the migration against the scratchpad backup copy (already validated).
3. Merge → server redeploys → boot runs backfill (existing) then the one-shot renumber → unified.
4. Verify live: from a vmi session, `podium issue show --id <n>` resolves unambiguously; `list` on both machines shows one unified set; new issue on vmi gets a non-colliding `#N`.

## Risk / blast radius
- `repo_id` already dual-written + backfilled → the flip is mechanical.
- `resolveRef` gains an **optional** arg (default = old global behavior) → existing callers unaffected.
- Migration one-shot, guarded by `schema_version`, validated on a live-DB copy; relations key on `id`.
- Out of scope (unchanged): `worktree_path`, `branch`, physical checkout location stay per-path; concierge `conciergeThreadId(repoPath)` identity is left as-is (separate concern).

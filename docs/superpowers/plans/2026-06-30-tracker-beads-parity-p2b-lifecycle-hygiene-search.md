# Tracker → beads Parity — P2b: Lifecycle, Hygiene & Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the server-side tracker surface with beads-style lifecycle (supersede/duplicate/find-duplicates), hygiene (stale/orphans/lint/preflight), and query (search/count/stats/doctor) operations.

**Architecture:** Builds on P1 + P2a (branch `worktree-tracker-beads-parity`). All operations are `IssueService` methods over the in-memory `this.rows` map + the store's label/dep readers, surfaced as `issues.*` tRPC procedures. The only externally-dependent feature is `orphans`, which scans `repoOp('log', repoPath)` output (mockable in tests). Still server-only; CLI/MCP (P3) + UI (P4) consume these.

**Tech Stack:** TypeScript, Bun, `node:sqlite` (`SessionStore`), zod (protocol), tRPC, vitest, biome.

## Global Constraints

- **Runtime/tests:** Bun; `npx vitest run <path>` from worktree root; `:memory:` store; `harness()` in `issues.test.ts` returns `{ store, deps, svc }`, `now: () => '<ISO date>'`, and `deps.repoOp` is a `vi.fn` you can override per-test.
- **Reuse existing authorities:** `isClosed` (stage==='done' || closedReason!=null), `toWire`, `update`, `addDep` (rejects `parent-child`, cycle-checks only `blocks`), `close`, `rowOrThrow`. Do NOT re-derive closed/ready state.
- **`parent-child` is reparent-only** — lifecycle deps use `supersedes`/`related`, never `parent-child`.
- **Closed-reason vocabulary:** `done` | `superseded` | `duplicate` | `wontfix`. `supersede` sets `closedReason='superseded'`+`supersededBy`; `duplicate` sets `closedReason='duplicate'`+`duplicateOf`.
- **Additive protocol only**; new query return types are zod objects, not added to the `ServerMessage` union.
- **Commits:** conventional, one per task, scope `tracker`. **Isolation:** worktree only; never touch the main checkout; no PTY/e2e suite.

---

### Task 1: `supersede` + `duplicate`

**Files:**
- Modify: `apps/server/src/issues.ts` — add `supersede`/`duplicate`.
- Modify: `apps/server/src/router.ts` — add `issues.supersede`/`issues.duplicate`.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces: `supersede(oldId: string, newId: string): IssueWire` — closes `oldId` (stage `done`, `closedReason='superseded'`, `supersededBy=newId`) and records a `supersedes` dep `oldId → newId`; returns the updated OLD wire. `duplicate(id: string, canonicalId: string): IssueWire` — closes `id` (`closedReason='duplicate'`, `duplicateOf=canonicalId`) and records a `related` dep `id → canonicalId`. Both throw if either id is unknown (`rowOrThrow`).
- Consumes: `update`, `addDep`, `rowOrThrow`.

- [ ] **Step 1: Write the failing test**

```ts
describe('IssueService supersede/duplicate (P2b)', () => {
  it('supersede closes old with reason + supersededBy + supersedes dep', () => {
    const { svc, store } = harness()
    const oldI = svc.create({ repoPath: '/r', title: 'old', startNow: false })
    const newI = svc.create({ repoPath: '/r', title: 'new', startNow: false })
    const w = svc.supersede(oldI.id, newI.id)
    expect(w.stage).toBe('done')
    expect(w.closedReason).toBe('superseded')
    expect(store.listIssueDeps(oldI.id)).toEqual([{ toId: newI.id, type: 'supersedes' }])
  })

  it('duplicate closes id with reason + duplicateOf + related dep', () => {
    const { svc, store } = harness()
    const dup = svc.create({ repoPath: '/r', title: 'dup', startNow: false })
    const canon = svc.create({ repoPath: '/r', title: 'canon', startNow: false })
    const w = svc.duplicate(dup.id, canon.id)
    expect(w.closedReason).toBe('duplicate')
    expect(store.listIssueDeps(dup.id)).toEqual([{ toId: canon.id, type: 'related' }])
  })

  it('supersede throws on unknown id', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'a', startNow: false })
    expect(() => svc.supersede(a.id, 'iss_missing')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.supersede is not a function`.

- [ ] **Step 3: Implement**

In `IssueService` (after `close`):

```ts
  supersede(oldId: string, newId: string): IssueWire {
    this.rowOrThrow(newId)
    this.addDep(oldId, newId, 'supersedes')
    return this.update(oldId, { stage: 'done', closedReason: 'superseded', supersededBy: newId })
  }

  duplicate(id: string, canonicalId: string): IssueWire {
    this.rowOrThrow(canonicalId)
    this.addDep(id, canonicalId, 'related')
    return this.update(id, { stage: 'done', closedReason: 'duplicate', duplicateOf: canonicalId })
  }
```

In `router.ts` `issues` router:

```ts
    supersede: t.procedure
      .input(z.object({ oldId: z.string(), newId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.supersede(input.oldId, input.newId)),
    duplicate: t.procedure
      .input(z.object({ id: z.string(), canonicalId: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.duplicate(input.id, input.canonicalId)),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): supersede + duplicate lifecycle commands"
```

---

### Task 2: `findDuplicates` (mechanical Jaccard)

**Files:**
- Create: `apps/server/src/issue-similarity.ts` — pure `jaccard`/`tokenize` helpers.
- Modify: `packages/protocol/src/messages.ts` — add `DuplicateCandidate` type.
- Modify: `apps/server/src/issues.ts` — add `findDuplicates`.
- Modify: `apps/server/src/router.ts` — add `issues.findDuplicates`.
- Test: `apps/server/src/issue-similarity.test.ts` (create) + `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces pure helpers `tokenize(text: string): Set<string>` (lowercase word tokens, length ≥ 3) and `jaccard(a: Set<string>, b: Set<string>): number` (|∩|/|∪|, 0 when both empty). Wire `DuplicateCandidate = { a: string, b: string, score: number }`. `findDuplicates(repoPath?: string, threshold = 0.6): DuplicateCandidate[]` — all open (`!isClosed`) issue pairs in the repo whose Jaccard over `title + ' ' + description` ≥ threshold, sorted by score desc; `a`/`b` are issue ids with `a.seq < b.seq`.
- Consumes: `tokenize`/`jaccard`, `this.rows`, `isClosed`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/issue-similarity.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { jaccard, tokenize } from './issue-similarity'

describe('issue-similarity', () => {
  it('tokenize lowercases and drops short tokens', () => {
    expect([...tokenize('Fix the Login BUG')].sort()).toEqual(['bug', 'fix', 'login', 'the'])
  })
  it('jaccard is intersection over union; 0 for disjoint, 1 for equal', () => {
    expect(jaccard(tokenize('login bug fix'), tokenize('login bug fix'))).toBe(1)
    expect(jaccard(tokenize('login bug'), tokenize('logout flow'))).toBe(0)
    expect(jaccard(new Set(), new Set())).toBe(0)
  })
})
```

Append to `issues.test.ts`:

```ts
describe('IssueService findDuplicates (P2b)', () => {
  it('flags near-identical open issues above threshold', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'Fix login bug', description: 'cannot sign in', startNow: false })
    svc.create({ repoPath: '/r', title: 'Fix login bug', description: 'cannot sign in', startNow: false })
    svc.create({ repoPath: '/r', title: 'Add dark mode', description: 'theme toggle', startNow: false })
    const dups = svc.findDuplicates('/r', 0.6)
    expect(dups.length).toBe(1)
    expect(dups[0].score).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/src/issue-similarity.test.ts apps/server/src/issues.test.ts`
Expected: FAIL — module `./issue-similarity` not found / `svc.findDuplicates is not a function`.

- [ ] **Step 3: Implement**

Create `apps/server/src/issue-similarity.ts`:

```ts
/** Lowercase word tokens of length >= 3 (drops punctuation + tiny stopwords-ish noise). */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  )
}

/** Jaccard similarity |a ∩ b| / |a ∪ b|; 0 when the union is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}
```

In `messages.ts` (near `IssueWire`):

```ts
export const DuplicateCandidate = z.object({ a: z.string(), b: z.string(), score: z.number() })
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>
```

In `issues.ts` (import `jaccard`, `tokenize` from `./issue-similarity` and `DuplicateCandidate` type from `@podium/protocol`):

```ts
  findDuplicates(repoPath?: string, threshold = 0.6): DuplicateCandidate[] {
    const open = [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && !this.isClosed(r))
      .sort((a, b) => a.seq - b.seq)
    const toks = new Map(open.map((r) => [r.id, tokenize(`${r.title} ${r.description}`)]))
    const out: DuplicateCandidate[] = []
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const score = jaccard(toks.get(open[i].id)!, toks.get(open[j].id)!)
        if (score >= threshold) out.push({ a: open[i].id, b: open[j].id, score })
      }
    }
    return out.sort((x, y) => y.score - x.score)
  }
```

In `router.ts` `issues` router:

```ts
    findDuplicates: t.procedure
      .input(z.object({ repoPath: z.string().optional(), threshold: z.number().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.findDuplicates(input.repoPath, input.threshold)),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issue-similarity.test.ts apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issue-similarity.ts apps/server/src/issue-similarity.test.ts packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): mechanical (Jaccard) duplicate detection"
```

---

### Task 3: `staleList` + `lint`

**Files:**
- Create: `apps/server/src/issue-lint.ts` — pure `lintIssue` function.
- Modify: `packages/protocol/src/messages.ts` — add `LintFinding` type.
- Modify: `apps/server/src/issues.ts` — add `staleList`/`lint`.
- Modify: `apps/server/src/router.ts` — add `issues.stale`/`issues.lint`.
- Test: `apps/server/src/issue-lint.test.ts` (create) + `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces pure `lintIssue(row): string[]` — missing-section findings by type: `bug` ⇒ requires non-empty `description` AND `acceptance` (message `'bug missing reproduction (description)'` / `'bug missing acceptance criteria'`); `task`/`feature` ⇒ requires `acceptance` (`'missing acceptance criteria'`); `epic` ⇒ requires ≥1 child is out of scope here (epics need a non-empty `description`, `'epic missing description'`); all types require a non-empty `title` (`'missing title'`). Wire `LintFinding = { id: string, seq: number, findings: string[] }`.
- `staleList(repoPath?: string, days = 30, nowMs?: number): IssueWire[]` — open issues whose `updatedAt` is older than `days` days before now (`nowMs` injectable for tests), sorted oldest-first.
- `lint(repoPath?: string): LintFinding[]` — open issues with ≥1 `lintIssue` finding.
- Consumes: `lintIssue`, `this.rows`, `isClosed`, `toWire`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/issue-lint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { lintIssue } from './issue-lint'

const base = { title: 'T', description: '', acceptance: null } as any

describe('lintIssue', () => {
  it('bug requires description + acceptance', () => {
    expect(lintIssue({ ...base, type: 'bug' })).toEqual([
      'bug missing reproduction (description)',
      'bug missing acceptance criteria',
    ])
  })
  it('feature requires acceptance only', () => {
    expect(lintIssue({ ...base, type: 'feature', description: 'x' })).toEqual([
      'missing acceptance criteria',
    ])
  })
  it('a complete task has no findings', () => {
    expect(lintIssue({ ...base, type: 'task', acceptance: 'done when X' })).toEqual([])
  })
  it('missing title is always flagged', () => {
    expect(lintIssue({ ...base, title: '  ', type: 'task', acceptance: 'x' })).toEqual(['missing title'])
  })
})
```

Append to `issues.test.ts`:

```ts
describe('IssueService stale/lint (P2b)', () => {
  it('staleList returns issues older than the cutoff (open only)', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'old', startNow: false })
    // backdate updatedAt directly in the store, then refresh the in-memory row
    const row = store.getIssue(a.id)!
    row.updatedAt = '2000-01-01T00:00:00.000Z'
    store.upsertIssue(row)
    svc.reload() // re-hydrate this.rows from the store (see Step 3)
    const stale = svc.staleList('/r', 30, Date.parse('2026-06-30T00:00:00.000Z'))
    expect(stale.map((w) => w.title)).toEqual(['old'])
  })

  it('lint flags a feature with no acceptance', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'F', description: 'd', type: 'feature', startNow: false })
    const findings = svc.lint('/r')
    expect(findings.length).toBe(1)
    expect(findings[0].findings).toEqual(['missing acceptance criteria'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/src/issue-lint.test.ts apps/server/src/issues.test.ts`
Expected: FAIL — module `./issue-lint` not found / `svc.staleList is not a function` / `svc.reload is not a function`.

- [ ] **Step 3: Implement**

Create `apps/server/src/issue-lint.ts`:

```ts
import type { IssueRow } from './store'

/** Template-completeness findings for one issue, by type. Empty = clean. */
export function lintIssue(row: Pick<IssueRow, 'title' | 'description' | 'acceptance' | 'type'>): string[] {
  const out: string[] = []
  if (!row.title || !row.title.trim()) out.push('missing title')
  const hasDesc = !!row.description && row.description.trim().length > 0
  const hasAcc = !!row.acceptance && row.acceptance.trim().length > 0
  if (row.type === 'bug') {
    if (!hasDesc) out.push('bug missing reproduction (description)')
    if (!hasAcc) out.push('bug missing acceptance criteria')
  } else if (row.type === 'task' || row.type === 'feature') {
    if (!hasAcc) out.push('missing acceptance criteria')
  } else if (row.type === 'epic') {
    if (!hasDesc) out.push('epic missing description')
  }
  return out
}
```

In `messages.ts`:

```ts
export const LintFinding = z.object({
  id: z.string(), seq: z.number().int(), findings: z.array(z.string()),
})
export type LintFinding = z.infer<typeof LintFinding>
```

In `issues.ts` (import `lintIssue` from `./issue-lint`, `LintFinding` type from `@podium/protocol`). Add a small public `reload()` so tests (and future external mutators) can re-hydrate the in-memory map — the constructor already does `for (const r of deps.store.listIssueRows()) this.rows.set(r.id, r)`; extract that into `reload`:

```ts
  reload(): void {
    this.rows.clear()
    for (const r of this.deps.store.listIssueRows()) this.rows.set(r.id, r)
  }

  staleList(repoPath?: string, days = 30, nowMs = Date.now()): IssueWire[] {
    const cutoff = nowMs - days * 24 * 60 * 60 * 1000
    return [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && !this.isClosed(r))
      .filter((r) => Date.parse(r.updatedAt) < cutoff)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .map((r) => this.toWire(r))
  }

  lint(repoPath?: string): LintFinding[] {
    return [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && !this.isClosed(r))
      .map((r) => ({ id: r.id, seq: r.seq, findings: lintIssue(r) }))
      .filter((f) => f.findings.length > 0)
  }
```

Update the constructor to call `this.reload()` instead of the inline loop (behavior-identical). Note: `Date.now()` is fine in production; tests pass an explicit `nowMs`.

In `router.ts` `issues` router:

```ts
    stale: t.procedure
      .input(z.object({ repoPath: z.string().optional(), days: z.number().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.staleList(input.repoPath, input.days)),
    lint: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.lint(input.repoPath)),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issue-lint.test.ts apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issue-lint.ts apps/server/src/issue-lint.test.ts packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): stale + lint hygiene endpoints"
```

---

### Task 4: `search` + `count` + `stats`

**Files:**
- Modify: `packages/protocol/src/messages.ts` — add `IssueCount`, `IssueStats` types.
- Modify: `apps/server/src/issues.ts` — add `search`/`count`/`stats`.
- Modify: `apps/server/src/router.ts` — add `issues.search`/`issues.count`/`issues.stats`.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces `search(filter): IssueWire[]` where `filter = { repoPath?, text?, status?, stage?, priority?, type?, assignee?, label?, parentId? }`; `status` ∈ `'open'|'closed'|'ready'|'blocked'|'deferred'`. Text matches (case-insensitive) title/description/notes. Wire `IssueCount = { byStage, byPriority, byType, byAssignee: Record<string, number> }`; `count(repoPath?): IssueCount`. Wire `IssueStats = { total, open, closed, ready, blocked, deferred }`; `stats(repoPath?): IssueStats`.
- Consumes: `this.rows`, `toWire`, `getIssueLabels` (via store) for label filtering, `isClosed`/`isDeferred`/`computeBlocked` (through `toWire`'s derived flags).

- [ ] **Step 1: Write the failing test**

```ts
describe('IssueService search/count/stats (P2b)', () => {
  it('search filters by text + priority + status', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'Login fails', priority: 0, startNow: false })
    svc.create({ repoPath: '/r', title: 'Dark mode', priority: 2, startNow: false })
    const done = svc.create({ repoPath: '/r', title: 'Login done', startNow: false })
    svc.close(done.id)
    expect(svc.search({ repoPath: '/r', text: 'login' }).map((w) => w.title).sort())
      .toEqual(['Login done', 'Login fails'])
    expect(svc.search({ repoPath: '/r', text: 'login', status: 'open' }).map((w) => w.title))
      .toEqual(['Login fails'])
    expect(svc.search({ repoPath: '/r', priority: 0 }).map((w) => w.title)).toEqual(['Login fails'])
  })

  it('count groups and stats totals', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'A', priority: 0, type: 'bug', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.close(b.id)
    expect(svc.count('/r').byPriority['0']).toBe(1)
    expect(svc.count('/r').byType['bug']).toBe(1)
    const s = svc.stats('/r')
    expect(s.total).toBe(2)
    expect(s.closed).toBe(1)
    expect(s.open).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.search is not a function`.

- [ ] **Step 3: Implement**

In `messages.ts`:

```ts
export const IssueCount = z.object({
  byStage: z.record(z.number()), byPriority: z.record(z.number()),
  byType: z.record(z.number()), byAssignee: z.record(z.number()),
})
export type IssueCount = z.infer<typeof IssueCount>
export const IssueStats = z.object({
  total: z.number().int(), open: z.number().int(), closed: z.number().int(),
  ready: z.number().int(), blocked: z.number().int(), deferred: z.number().int(),
})
export type IssueStats = z.infer<typeof IssueStats>
export const IssueSearchFilter = z.object({
  repoPath: z.string().optional(), text: z.string().optional(),
  status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
  stage: IssueStage.optional(), priority: z.number().int().optional(),
  type: IssueType.optional(), assignee: z.string().optional(),
  label: z.string().optional(), parentId: z.string().optional(),
})
export type IssueSearchFilter = z.infer<typeof IssueSearchFilter>
```

In `issues.ts` (import the `IssueCount`/`IssueStats`/`IssueSearchFilter` types):

```ts
  search(filter: IssueSearchFilter): IssueWire[] {
    const text = filter.text?.toLowerCase()
    return [...this.rows.values()]
      .filter((r) => !filter.repoPath || r.repoPath === filter.repoPath)
      .map((r) => this.toWire(r))
      .filter((w) => {
        if (filter.stage && w.stage !== filter.stage) return false
        if (filter.priority != null && w.priority !== filter.priority) return false
        if (filter.type && w.type !== filter.type) return false
        if (filter.assignee && w.assignee !== filter.assignee) return false
        if (filter.parentId && w.parentId !== filter.parentId) return false
        if (filter.label && !w.labels.includes(filter.label)) return false
        if (filter.status === 'open' && (w.stage === 'done' || w.closedReason)) return false
        if (filter.status === 'closed' && !(w.stage === 'done' || w.closedReason)) return false
        if (filter.status === 'ready' && !w.ready) return false
        if (filter.status === 'blocked' && !w.blocked) return false
        if (filter.status === 'deferred' && !w.deferred) return false
        if (text) {
          const hay = `${w.title} ${w.description} ${w.notes ?? ''}`.toLowerCase()
          if (!hay.includes(text)) return false
        }
        return true
      })
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
  }

  count(repoPath?: string): IssueCount {
    const rows = [...this.rows.values()].filter((r) => !repoPath || r.repoPath === repoPath)
    const c: IssueCount = { byStage: {}, byPriority: {}, byType: {}, byAssignee: {} }
    const bump = (m: Record<string, number>, k: string): void => {
      m[k] = (m[k] ?? 0) + 1
    }
    for (const r of rows) {
      bump(c.byStage, r.stage)
      bump(c.byPriority, String(r.priority))
      bump(c.byType, r.type)
      bump(c.byAssignee, r.assignee ?? '(unassigned)')
    }
    return c
  }

  stats(repoPath?: string): IssueStats {
    const wires = [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .map((r) => this.toWire(r))
    const closed = wires.filter((w) => w.stage === 'done' || w.closedReason).length
    return {
      total: wires.length, closed, open: wires.length - closed,
      ready: wires.filter((w) => w.ready).length,
      blocked: wires.filter((w) => w.blocked).length,
      deferred: wires.filter((w) => w.deferred).length,
    }
  }
```

In `router.ts` `issues` router (import `IssueSearchFilter` if you reference it; the input shape is the zod object inline):

```ts
    search: t.procedure
      .input(z.object({
        repoPath: z.string().optional(), text: z.string().optional(),
        status: z.enum(['open', 'closed', 'ready', 'blocked', 'deferred']).optional(),
        stage: IssueStage.optional(), priority: z.number().int().optional(),
        type: IssueType.optional(), assignee: z.string().optional(),
        label: z.string().optional(), parentId: z.string().optional(),
      }))
      .query(({ ctx, input }) => ctx.registry.issues.search(input)),
    count: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.count(input.repoPath)),
    stats: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.stats(input.repoPath)),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): search + count + stats endpoints"
```

---

### Task 5: `doctor` + `preflight`

**Files:**
- Modify: `packages/protocol/src/messages.ts` — add `DoctorReport` type.
- Modify: `apps/server/src/issues.ts` — add `doctor`/`preflight`.
- Modify: `apps/server/src/router.ts` — add `issues.doctor`/`issues.preflight`.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces wire `DoctorReport = { cycles: string[][], danglingDeps: { from, to, type }[], lintCount: number, staleCount: number }`. `doctor(repoPath?): DoctorReport` — `cycles`: arrays of issue ids forming a `blocks`/`parent-child` cycle (detect by running the existing `wouldCycle` logic over the edge set, or a DFS); `danglingDeps`: `issue_deps` rows whose `to` id is not a known issue; counts from `lint`/`staleList`. `preflight(repoPath?): { ok: boolean, report: DoctorReport }` — `ok = cycles.length===0 && danglingDeps.length===0`.
- Consumes: store `listIssueDeps`, `this.rows`, `lint`, `staleList`.

- [ ] **Step 1: Write the failing test**

```ts
describe('IssueService doctor/preflight (P2b)', () => {
  it('doctor reports dangling deps and clean preflight when none', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    store.addIssueDep(a.id, 'iss_ghost', 'blocks') // target does not exist
    const d = svc.doctor('/r')
    expect(d.danglingDeps).toEqual([{ from: a.id, to: 'iss_ghost', type: 'blocks' }])
    expect(svc.preflight('/r').ok).toBe(false)
  })

  it('preflight ok when no cycles or dangling deps', () => {
    const { svc } = harness()
    svc.create({ repoPath: '/r', title: 'A', acceptance: 'x', startNow: false })
    expect(svc.preflight('/r').ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.doctor is not a function`.

- [ ] **Step 3: Implement**

In `messages.ts`:

```ts
export const DoctorReport = z.object({
  cycles: z.array(z.array(z.string())),
  danglingDeps: z.array(z.object({ from: z.string(), to: z.string(), type: z.string() })),
  lintCount: z.number().int(), staleCount: z.number().int(),
})
export type DoctorReport = z.infer<typeof DoctorReport>
```

In `issues.ts`:

```ts
  doctor(repoPath?: string): DoctorReport {
    const rows = [...this.rows.values()].filter((r) => !repoPath || r.repoPath === repoPath)
    const ids = new Set(rows.map((r) => r.id))
    const danglingDeps: DoctorReport['danglingDeps'] = []
    const adj = new Map<string, string[]>()
    for (const r of rows) {
      for (const d of this.deps.store.listIssueDeps(r.id)) {
        if (!ids.has(d.toId)) danglingDeps.push({ from: r.id, to: d.toId, type: d.type })
        if (d.type === 'blocks' || d.type === 'parent-child') {
          adj.set(r.id, [...(adj.get(r.id) ?? []), d.toId])
        }
      }
    }
    // cycle detection over blocks+parent-child edges (DFS colouring).
    const cycles: string[][] = []
    const colour = new Map<string, number>() // 0=white,1=grey,2=black
    const stack: string[] = []
    const visit = (u: string): void => {
      colour.set(u, 1)
      stack.push(u)
      for (const v of adj.get(u) ?? []) {
        if (!ids.has(v)) continue
        if (colour.get(v) === 1) cycles.push([...stack.slice(stack.indexOf(v)), v])
        else if (!colour.get(v)) visit(v)
      }
      stack.pop()
      colour.set(u, 2)
    }
    for (const r of rows) if (!colour.get(r.id)) visit(r.id)
    return {
      cycles, danglingDeps,
      lintCount: this.lint(repoPath).length,
      staleCount: this.staleList(repoPath).length,
    }
  }

  preflight(repoPath?: string): { ok: boolean; report: DoctorReport } {
    const report = this.doctor(repoPath)
    return { ok: report.cycles.length === 0 && report.danglingDeps.length === 0, report }
  }
```

In `router.ts` `issues` router:

```ts
    doctor: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.doctor(input.repoPath)),
    preflight: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.preflight(input.repoPath)),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): doctor + preflight health checks"
```

---

### Task 6: `orphans` (git-log scan)

**Files:**
- Modify: `packages/protocol/src/messages.ts` — add `OrphanIssue` type.
- Modify: `apps/server/src/issues.ts` — add `async orphans`.
- Modify: `apps/server/src/router.ts` — add `issues.orphans`.
- Test: `apps/server/src/issues.test.ts` (extend, mocking `deps.repoOp`).

**Interfaces:**
- Produces wire `OrphanIssue = { id: string, seq: number, title: string, ref: string }`. `async orphans(repoPath: string): Promise<OrphanIssue[]>` — runs `repoOp('log', repoPath)`, scans the output text for references to each OPEN issue (its branch stem `issue/<seq>-` OR a `#<seq>` token with a word boundary), and returns the open issues that ARE referenced in a commit (implemented but not closed). `ref` is the matched substring.
- Consumes: `repoOp`, `this.rows`, `isClosed`.

- [ ] **Step 1: Write the failing test**

```ts
describe('IssueService orphans (P2b)', () => {
  it('flags open issues referenced in commit messages', async () => {
    const { svc, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'Add login', startNow: false }) // seq 1
    svc.create({ repoPath: '/r', title: 'Other', startNow: false }) // seq 2, not referenced
    ;(deps.repoOp as any).mockResolvedValueOnce({
      ok: true,
      output: 'abc123 feat: implement login (#1)\ndef456 chore: tidy',
    })
    const orphans = await svc.orphans('/r')
    expect(orphans.map((o) => o.seq)).toEqual([1])
    expect(orphans[0].id).toBe(a.id)
  })

  it('returns [] when repoOp(log) fails', async () => {
    const { svc, deps } = harness()
    svc.create({ repoPath: '/r', title: 'X', startNow: false })
    ;(deps.repoOp as any).mockResolvedValueOnce({ ok: false, output: '' })
    expect(await svc.orphans('/r')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.orphans is not a function`.

- [ ] **Step 3: Implement**

In `messages.ts`:

```ts
export const OrphanIssue = z.object({
  id: z.string(), seq: z.number().int(), title: z.string(), ref: z.string(),
})
export type OrphanIssue = z.infer<typeof OrphanIssue>
```

In `issues.ts`:

```ts
  async orphans(repoPath: string): Promise<OrphanIssue[]> {
    const res = await this.deps.repoOp('log', repoPath).catch(() => ({ ok: false, output: '' }))
    if (!res.ok || !res.output) return []
    const log = res.output
    const out: OrphanIssue[] = []
    for (const r of this.rows.values()) {
      if (r.repoPath !== repoPath || this.isClosed(r)) continue
      // Reference forms: the branch stem `issue/<seq>-`, or a `#<seq>` token.
      const hashRef = new RegExp(`#${r.seq}\\b`).exec(log)?.[0]
      const branchRef = log.includes(`issue/${r.seq}-`) ? `issue/${r.seq}-` : undefined
      const ref = hashRef ?? branchRef
      if (ref) out.push({ id: r.id, seq: r.seq, title: r.title, ref })
    }
    return out.sort((a, b) => a.seq - b.seq)
  }
```

In `router.ts` `issues` router:

```ts
    orphans: t.procedure
      .input(z.object({ repoPath: z.string() }))
      .query(({ ctx, input }) => ctx.registry.issues.orphans(input.repoPath)),
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issues.test.ts` then `bun run typecheck`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): orphans (git-log scan for referenced-but-open issues)"
```

---

## Phase Close (P2b)

- [ ] Full tracker scope green: `npx vitest run apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts apps/server/src/store-issues.test.ts apps/server/src/router.issues.test.ts apps/server/src/issue-similarity.test.ts apps/server/src/issue-lint.test.ts packages/protocol/src/issues.test.ts apps/web/src/derive-issues.test.ts`
- [ ] `bun run typecheck` clean; `bun run lint` clean on changed files.
- [ ] Close `podium-hi7.2` (P2 fully done: P2a + P2b).
- [ ] Hand off to **P3 plan** (the `podium` CLI + MCP issue tools + roles), which consumes all these endpoints.

## Self-Review notes (author)

- **Spec coverage (P2b):** supersede/duplicate (Task 1) ✓; find-duplicates Jaccard (Task 2) ✓; stale/lint (Task 3) ✓; search/count/stats (Task 4) ✓; doctor/preflight (Task 5) ✓; orphans git-log scan (Task 6) ✓. Epic close-eligible was delivered in P2a. AI dup-detection + full query-language remain explicit non-goals (design §2). 
- **Placeholder scan:** none — every step has complete code.
- **Type consistency:** all new methods read derived state through `toWire`/`isClosed` (no parallel re-derivation). `search`/`stats` treat closed as `stage==='done' || closedReason` consistent with `isClosed`. `doctor` cycle detection mirrors `wouldCycle`'s `blocks`+`parent-child` edge set. `findDuplicates`/`lintIssue` are pure + unit-tested standalone.
- **Risk:** Task 3 extracts the constructor's hydration into `reload()` and the stale test mutates `updatedAt` directly + calls `reload()` — verify the constructor still hydrates identically (behavior-preserving refactor). Task 6's reference heuristic (`#<seq>` / `issue/<seq>-`) is deliberately simple; documented as such.

# Tracker → beads Parity — P1: Data Model + API Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Podium's native issue store with beads-style rich fields, a typed
dependency graph, labels and comments, and derive `ready`/`blocked`/`deferred` + epic
progress onto the wire — exposed through the existing `issues` tRPC router.

**Architecture:** Additive SQLite migration (new `issues` columns + 3 new tables +
`blocked_by`→`issue_deps` backfill) following the codebase's column-presence-guard
migration pattern. New store methods for labels/deps/comments. `IssueRow`/`IssueWire`
and `IssueService.toWire` gain the new fields; ready/blocked/epic counts are derived
server-side at serialization. The `issues` router gains field mutations. All logic stays
in `IssueService` + `SessionStore`; front-ends (CLI/MCP/UI) come in later milestones.

**Tech Stack:** TypeScript, Bun, `node:sqlite` (via `SessionStore`), zod (protocol),
tRPC, vitest, biome.

## Global Constraints

- **Runtime:** Bun; tests via `vitest run`. Run a single file with
  `npx vitest run <path>` from the worktree root.
- **DB:** `node:sqlite` through `SessionStore`; tests use `new SessionStore(':memory:')`.
- **Migrations are additive-only:** never drop/rename existing issue columns; new columns
  go in the `CREATE TABLE issues` block (fresh DBs) **and** as `PRAGMA table_info`-guarded
  `ALTER TABLE` (existing live DBs), mirroring the sessions-table pattern in `migrate()`.
- **Protocol:** wire shapes are zod in `packages/protocol/src/messages.ts`; server + web
  deploy together, so adding wire fields is safe. Optional string fields are `.optional()`
  and emitted via conditional spread (match existing `toWire`).
- **Stage enum** stays `['backlog','planning','in_progress','review','verifying','done']`
  (`IssueStage`). No new status column — status is derived.
- **Dependency types:** `blocks` | `related` | `parent-child` | `discovered-from` |
  `tracks` | `supersedes` | `caused-by` | `validates`. Only `blocks` gates ready/blocked.
- **Priorities:** integer `0..4`, default `2`. **Issue types:** `task`(default) | `bug` |
  `feature` | `chore` | `epic` | `decision` | `spike` | `story` | `milestone`.
- **Commits:** conventional commits, one per task, scope `tracker`.
- **Isolation:** all work in worktree `worktree-tracker-beads-parity`; never edit the main
  checkout. Do not run the PTY/agent-spawning e2e suite during routine test runs.

---

### Task 1: Migration — new `issues` columns

**Files:**
- Modify: `apps/server/src/store.ts` — `CREATE TABLE issues` block (~1129-1153) and add an
  ALTER-guard block right after the `idx_issues_repo` index (~1155).
- Test: `apps/server/src/store.issues.test.ts` (create).

**Interfaces:**
- Produces: the `issues` table gains columns `priority INTEGER NOT NULL DEFAULT 2`,
  `type TEXT NOT NULL DEFAULT 'task'`, `assignee TEXT`, `parent_id TEXT`, `design TEXT`,
  `acceptance TEXT`, `notes TEXT`, `due_at TEXT`, `defer_until TEXT`, `closed_reason TEXT`,
  `superseded_by TEXT`, `duplicate_of TEXT`, `pinned INTEGER NOT NULL DEFAULT 0`,
  `estimate_min INTEGER`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/store.issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

function issueColumns(store: SessionStore): Set<string> {
  // @ts-expect-error reach the private db for a schema assertion
  const rows = store.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

describe('issues schema migration (P1)', () => {
  it('fresh DB has all new rich-field columns', () => {
    const cols = issueColumns(new SessionStore(':memory:'))
    for (const c of [
      'priority', 'type', 'assignee', 'parent_id', 'design', 'acceptance', 'notes',
      'due_at', 'defer_until', 'closed_reason', 'superseded_by', 'duplicate_of',
      'pinned', 'estimate_min',
    ]) {
      expect(cols.has(c), `missing column ${c}`).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: FAIL — `missing column priority` (and others).

- [ ] **Step 3: Add the columns to the CREATE block and ALTER guards**

In `store.ts`, change the `CREATE TABLE IF NOT EXISTS issues (...)` block to include the new
columns just before `created_at TEXT NOT NULL` (additive, keep existing columns verbatim):

```sql
         blocked_by TEXT NOT NULL DEFAULT '[]',
         dependency_note TEXT,
         pr_url TEXT,
         priority INTEGER NOT NULL DEFAULT 2,
         type TEXT NOT NULL DEFAULT 'task',
         assignee TEXT,
         parent_id TEXT,
         design TEXT,
         acceptance TEXT,
         notes TEXT,
         due_at TEXT,
         defer_until TEXT,
         closed_reason TEXT,
         superseded_by TEXT,
         duplicate_of TEXT,
         pinned INTEGER NOT NULL DEFAULT 0,
         estimate_min INTEGER,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         archived INTEGER NOT NULL DEFAULT 0
```

Immediately after `this.db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path)')`
add the upgrade guards for existing DBs:

```ts
    // Additive rich-tracker columns (structural guard — no version marker bump). Fresh
    // DBs already have them from the CREATE above; live DBs gain them in place.
    const issueCols = new Set(
      (this.db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).map((c) => c.name),
    )
    const addIssueCol = (name: string, ddl: string): void => {
      if (!issueCols.has(name)) this.db.exec(`ALTER TABLE issues ADD COLUMN ${ddl}`)
    }
    addIssueCol('priority', 'priority INTEGER NOT NULL DEFAULT 2')
    addIssueCol('type', "type TEXT NOT NULL DEFAULT 'task'")
    addIssueCol('assignee', 'assignee TEXT')
    addIssueCol('parent_id', 'parent_id TEXT')
    addIssueCol('design', 'design TEXT')
    addIssueCol('acceptance', 'acceptance TEXT')
    addIssueCol('notes', 'notes TEXT')
    addIssueCol('due_at', 'due_at TEXT')
    addIssueCol('defer_until', 'defer_until TEXT')
    addIssueCol('closed_reason', 'closed_reason TEXT')
    addIssueCol('superseded_by', 'superseded_by TEXT')
    addIssueCol('duplicate_of', 'duplicate_of TEXT')
    addIssueCol('pinned', 'pinned INTEGER NOT NULL DEFAULT 0')
    addIssueCol('estimate_min', 'estimate_min INTEGER')
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.issues.test.ts
git commit -m "feat(tracker): add rich-field columns to issues table"
```

---

### Task 2: Migration — `issue_labels`, `issue_deps`, `issue_comments` + `blocked_by` backfill

**Files:**
- Modify: `apps/server/src/store.ts` — add three `CREATE TABLE IF NOT EXISTS` + indexes in
  `migrate()` (after the issue-column guards from Task 1), and a `backfillIssueDeps()` call.
- Test: `apps/server/src/store.issues.test.ts` (extend).

**Interfaces:**
- Produces tables: `issue_labels(issue_id, label)`, `issue_deps(from_id, to_id, type)`,
  `issue_comments(id, issue_id, author, body, created_at)`. Each row of `issues.blocked_by`
  is mirrored into `issue_deps` with `type='blocks'` (idempotent, `INSERT OR IGNORE`).

- [ ] **Step 1: Write the failing test**

Append to `store.issues.test.ts`:

```ts
function tableNames(store: SessionStore): Set<string> {
  // @ts-expect-error private db
  const rows = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

describe('issues child tables (P1)', () => {
  it('creates issue_labels, issue_deps, issue_comments', () => {
    const t = tableNames(new SessionStore(':memory:'))
    expect(t.has('issue_labels')).toBe(true)
    expect(t.has('issue_deps')).toBe(true)
    expect(t.has('issue_comments')).toBe(true)
  })

  it('backfills blocked_by into issue_deps as type=blocks', () => {
    const store = new SessionStore(':memory:')
    // @ts-expect-error private db — seed a legacy row with a blocked_by array
    store.db.prepare(
      `INSERT INTO issues (id, repo_path, seq, title, stage, parent_branch, default_agent,
         blocked_by, created_at, updated_at)
       VALUES ('iss_a','/r',1,'A','backlog','main','claude-code','["iss_b"]','t','t')`,
    ).run()
    // @ts-expect-error private method
    store.backfillIssueDeps()
    // @ts-expect-error private db
    const deps = store.db.prepare('SELECT from_id, to_id, type FROM issue_deps').all()
    expect(deps).toEqual([{ from_id: 'iss_a', to_id: 'iss_b', type: 'blocks' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: FAIL — `no such table: issue_labels` / `store.backfillIssueDeps is not a function`.

- [ ] **Step 3: Add tables + backfill**

In `migrate()`, after the Task 1 column guards, add:

```ts
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_labels (
         issue_id TEXT NOT NULL,
         label    TEXT NOT NULL,
         PRIMARY KEY (issue_id, label)
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_deps (
         from_id TEXT NOT NULL,
         to_id   TEXT NOT NULL,
         type    TEXT NOT NULL DEFAULT 'blocks',
         PRIMARY KEY (from_id, to_id, type)
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_from ON issue_deps(from_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_deps_to ON issue_deps(to_id)')
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS issue_comments (
         id         TEXT PRIMARY KEY,
         issue_id   TEXT NOT NULL,
         author     TEXT NOT NULL,
         body       TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
    )
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id)')
    this.backfillIssueDeps()
```

Add the private method to `SessionStore` (near the other issue methods, before `close()`):

```ts
  /** One-time, idempotent: mirror legacy issues.blocked_by arrays into issue_deps. */
  private backfillIssueDeps(): void {
    const rows = this.db.prepare("SELECT id, blocked_by FROM issues WHERE blocked_by != '[]'").all() as {
      id: string
      blocked_by: string
    }[]
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, 'blocks')",
    )
    for (const r of rows) {
      let ids: unknown
      try {
        ids = JSON.parse(r.blocked_by)
      } catch {
        ids = []
      }
      if (Array.isArray(ids)) {
        for (const to of ids) if (typeof to === 'string' && to) ins.run(r.id, to)
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.issues.test.ts
git commit -m "feat(tracker): add issue_labels/issue_deps/issue_comments tables + blocked_by backfill"
```

---

### Task 3: `IssueRow` + `upsertIssue` + `mapIssueRow` field round-trip

**Files:**
- Modify: `apps/server/src/store.ts` — `IssueRow` (~105-129), `upsertIssue` (~878-935),
  `mapIssueRow` (~937-963).
- Test: `apps/server/src/store.issues.test.ts` (extend).

**Interfaces:**
- Produces: `IssueRow` gains `priority: number`, `type: string`, `assignee: string | null`,
  `parentId: string | null`, `design: string | null`, `acceptance: string | null`,
  `notes: string | null`, `dueAt: string | null`, `deferUntil: string | null`,
  `closedReason: string | null`, `supersededBy: string | null`, `duplicateOf: string | null`,
  `pinned: boolean`, `estimateMin: number | null`. `upsertIssue`/`getIssue` round-trip them.

- [ ] **Step 1: Write the failing test**

Append to `store.issues.test.ts`:

```ts
import type { IssueRow } from './store'

function baseRow(over: Partial<IssueRow> = {}): IssueRow {
  return {
    id: 'iss_x', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
    worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
    linearId: null, linearIdentifier: null, linearUrl: null, activityNotes: null,
    notesUpdatedAt: null, suggestedStage: null, suggestedReason: null, blockedBy: [],
    dependencyNote: null, prUrl: null, createdAt: 't', updatedAt: 't', archived: false,
    priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
    notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
    duplicateOf: null, pinned: false, estimateMin: null,
    ...over,
  }
}

describe('IssueRow rich fields round-trip (P1)', () => {
  it('persists and reads back new fields', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow({
      priority: 0, type: 'bug', assignee: 'agent:claude', parentId: 'iss_epic',
      design: 'D', acceptance: 'A', notes: 'N', dueAt: '2026-07-01', deferUntil: '2026-07-05',
      closedReason: 'duplicate', supersededBy: 'iss_new', duplicateOf: 'iss_canon',
      pinned: true, estimateMin: 30,
    }))
    const r = store.getIssue('iss_x')!
    expect(r.priority).toBe(0)
    expect(r.type).toBe('bug')
    expect(r.assignee).toBe('agent:claude')
    expect(r.parentId).toBe('iss_epic')
    expect(r.pinned).toBe(true)
    expect(r.estimateMin).toBe(30)
    expect(r.deferUntil).toBe('2026-07-05')
    expect(r.closedReason).toBe('duplicate')
  })

  it('defaults are applied for a minimal legacy-style insert', () => {
    const store = new SessionStore(':memory:')
    store.upsertIssue(baseRow())
    const r = store.getIssue('iss_x')!
    expect(r.priority).toBe(2)
    expect(r.type).toBe('task')
    expect(r.pinned).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: FAIL — type error / `r.priority` is `undefined`.

- [ ] **Step 3: Extend `IssueRow`, `upsertIssue`, `mapIssueRow`**

Add to the `IssueRow` interface (after `archived: boolean`, keep existing fields):

```ts
  priority: number
  type: string
  assignee: string | null
  parentId: string | null
  design: string | null
  acceptance: string | null
  notes: string | null
  dueAt: string | null
  deferUntil: string | null
  closedReason: string | null
  supersededBy: string | null
  duplicateOf: string | null
  pinned: boolean
  estimateMin: number | null
```

In `upsertIssue`, extend the INSERT column list, the VALUES placeholders, the
`ON CONFLICT ... DO UPDATE SET` list, and the `.run(...)` args. Replace the INSERT column tail
`pr_url, created_at, updated_at, archived)` with:

```sql
            suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
            priority, type, assignee, parent_id, design, acceptance, notes, due_at,
            defer_until, closed_reason, superseded_by, duplicate_of, pinned, estimate_min,
            created_at, updated_at, archived)
```

Set the placeholder count to match (39 columns → 39 `?`). Add to the `DO UPDATE SET` block:

```sql
           priority = excluded.priority, type = excluded.type, assignee = excluded.assignee,
           parent_id = excluded.parent_id, design = excluded.design,
           acceptance = excluded.acceptance, notes = excluded.notes, due_at = excluded.due_at,
           defer_until = excluded.defer_until, closed_reason = excluded.closed_reason,
           superseded_by = excluded.superseded_by, duplicate_of = excluded.duplicate_of,
           pinned = excluded.pinned, estimate_min = excluded.estimate_min,
```

And add to the `.run(...)` arg list, in the same position (after `row.prUrl,` and before
`row.createdAt,`):

```ts
        row.priority,
        row.type,
        row.assignee,
        row.parentId,
        row.design,
        row.acceptance,
        row.notes,
        row.dueAt,
        row.deferUntil,
        row.closedReason,
        row.supersededBy,
        row.duplicateOf,
        row.pinned ? 1 : 0,
        row.estimateMin,
```

In `mapIssueRow`, add (before `createdAt:`):

```ts
      priority: (r.priority as number) ?? 2,
      type: (r.type as string) ?? 'task',
      assignee: (r.assignee as string | null) ?? null,
      parentId: (r.parent_id as string | null) ?? null,
      design: (r.design as string | null) ?? null,
      acceptance: (r.acceptance as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      dueAt: (r.due_at as string | null) ?? null,
      deferUntil: (r.defer_until as string | null) ?? null,
      closedReason: (r.closed_reason as string | null) ?? null,
      supersededBy: (r.superseded_by as string | null) ?? null,
      duplicateOf: (r.duplicate_of as string | null) ?? null,
      pinned: r.pinned === 1,
      estimateMin: (r.estimate_min as number | null) ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: PASS (5 tests). Then run the existing suite to confirm no regression:
`npx vitest run apps/server/src/issues.test.ts` → the existing IssueService tests will now fail
to typecheck because `create()` builds an `IssueRow` literal without the new fields — that is
fixed in Task 7. For now just confirm the store test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.issues.test.ts
git commit -m "feat(tracker): persist rich issue fields in IssueRow upsert/map"
```

---

### Task 4: Store methods — labels

**Files:**
- Modify: `apps/server/src/store.ts` — add label methods in the `// ---- issues ----` block.
- Test: `apps/server/src/store.issues.test.ts` (extend).

**Interfaces:**
- Produces: `setIssueLabels(issueId: string, labels: string[]): void` (replaces the set),
  `getIssueLabels(issueId: string): string[]` (sorted), `listAllLabels(): string[]` (distinct,
  sorted), `deleteIssueChildRows(issueId: string): void` (removes labels/deps/comments for an
  issue — used by `deleteIssue`).

- [ ] **Step 1: Write the failing test**

Append to `store.issues.test.ts`:

```ts
describe('issue labels (P1)', () => {
  it('sets, reads (sorted), and lists distinct labels', () => {
    const store = new SessionStore(':memory:')
    store.setIssueLabels('iss_a', ['ui', 'backend', 'ui'])
    store.setIssueLabels('iss_b', ['backend'])
    expect(store.getIssueLabels('iss_a')).toEqual(['backend', 'ui'])
    expect(store.listAllLabels()).toEqual(['backend', 'ui'])
  })

  it('setIssueLabels replaces the prior set', () => {
    const store = new SessionStore(':memory:')
    store.setIssueLabels('iss_a', ['x', 'y'])
    store.setIssueLabels('iss_a', ['y', 'z'])
    expect(store.getIssueLabels('iss_a')).toEqual(['y', 'z'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: FAIL — `store.setIssueLabels is not a function`.

- [ ] **Step 3: Implement label methods**

Add to `SessionStore` (in the issues section):

```ts
  setIssueLabels(issueId: string, labels: string[]): void {
    const clean = [...new Set(labels.filter((l) => typeof l === 'string' && l.trim()))].map((l) =>
      l.trim(),
    )
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    const ins = this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label) VALUES (?, ?)')
    for (const l of clean) ins.run(issueId, l)
  }

  getIssueLabels(issueId: string): string[] {
    return (
      this.db
        .prepare('SELECT label FROM issue_labels WHERE issue_id = ? ORDER BY label ASC')
        .all(issueId) as { label: string }[]
    ).map((r) => r.label)
  }

  listAllLabels(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT label FROM issue_labels ORDER BY label ASC').all() as {
        label: string
      }[]
    ).map((r) => r.label)
  }

  deleteIssueChildRows(issueId: string): void {
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId)
    this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? OR to_id = ?').run(issueId, issueId)
    this.db.prepare('DELETE FROM issue_comments WHERE issue_id = ?').run(issueId)
  }
```

Also call it from `deleteIssue`:

```ts
  deleteIssue(id: string): void {
    this.deleteIssueChildRows(id)
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.issues.test.ts
git commit -m "feat(tracker): issue label store methods + child-row cleanup on delete"
```

---

### Task 5: Store methods — dependencies

**Files:**
- Modify: `apps/server/src/store.ts` — add dep methods.
- Test: `apps/server/src/store.issues.test.ts` (extend).

**Interfaces:**
- Produces: `addIssueDep(fromId, toId, type = 'blocks'): void` (idempotent),
  `removeIssueDep(fromId, toId, type?): void` (omit type ⇒ remove all types for the pair),
  `listIssueDeps(fromId): { toId: string; type: string }[]`,
  `listDependents(toId): { fromId: string; type: string }[]`.

- [ ] **Step 1: Write the failing test**

Append to `store.issues.test.ts`:

```ts
describe('issue deps (P1)', () => {
  it('adds, lists (both directions), and removes deps', () => {
    const store = new SessionStore(':memory:')
    store.addIssueDep('iss_a', 'iss_b')
    store.addIssueDep('iss_a', 'iss_c', 'related')
    store.addIssueDep('iss_a', 'iss_b') // idempotent
    expect(store.listIssueDeps('iss_a')).toEqual([
      { toId: 'iss_b', type: 'blocks' },
      { toId: 'iss_c', type: 'related' },
    ])
    expect(store.listDependents('iss_b')).toEqual([{ fromId: 'iss_a', type: 'blocks' }])
    store.removeIssueDep('iss_a', 'iss_b')
    expect(store.listIssueDeps('iss_a')).toEqual([{ toId: 'iss_c', type: 'related' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: FAIL — `store.addIssueDep is not a function`.

- [ ] **Step 3: Implement dep methods**

```ts
  addIssueDep(fromId: string, toId: string, type = 'blocks'): void {
    this.db
      .prepare('INSERT OR IGNORE INTO issue_deps (from_id, to_id, type) VALUES (?, ?, ?)')
      .run(fromId, toId, type)
  }

  removeIssueDep(fromId: string, toId: string, type?: string): void {
    if (type) {
      this.db
        .prepare('DELETE FROM issue_deps WHERE from_id = ? AND to_id = ? AND type = ?')
        .run(fromId, toId, type)
    } else {
      this.db.prepare('DELETE FROM issue_deps WHERE from_id = ? AND to_id = ?').run(fromId, toId)
    }
  }

  listIssueDeps(fromId: string): { toId: string; type: string }[] {
    return (
      this.db
        .prepare('SELECT to_id, type FROM issue_deps WHERE from_id = ? ORDER BY to_id ASC, type ASC')
        .all(fromId) as { to_id: string; type: string }[]
    ).map((r) => ({ toId: r.to_id, type: r.type }))
  }

  listDependents(toId: string): { fromId: string; type: string }[] {
    return (
      this.db
        .prepare('SELECT from_id, type FROM issue_deps WHERE to_id = ? ORDER BY from_id ASC, type ASC')
        .all(toId) as { from_id: string; type: string }[]
    ).map((r) => ({ fromId: r.from_id, type: r.type }))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.issues.test.ts
git commit -m "feat(tracker): issue dependency store methods"
```

---

### Task 6: Store methods — comments

**Files:**
- Modify: `apps/server/src/store.ts` — add comment methods.
- Test: `apps/server/src/store.issues.test.ts` (extend).

**Interfaces:**
- Produces: `IssueCommentRow { id, issueId, author, body, createdAt }`;
  `addIssueComment(c: IssueCommentRow): void`;
  `listIssueComments(issueId): IssueCommentRow[]` (oldest-first).

- [ ] **Step 1: Write the failing test**

Append to `store.issues.test.ts`:

```ts
describe('issue comments (P1)', () => {
  it('adds and lists comments oldest-first', () => {
    const store = new SessionStore(':memory:')
    store.addIssueComment({ id: 'c1', issueId: 'iss_a', author: 'mike', body: 'first', createdAt: 't1' })
    store.addIssueComment({ id: 'c2', issueId: 'iss_a', author: 'agent', body: 'second', createdAt: 't2' })
    store.addIssueComment({ id: 'c3', issueId: 'iss_b', author: 'x', body: 'other', createdAt: 't1' })
    const cs = store.listIssueComments('iss_a')
    expect(cs.map((c) => c.body)).toEqual(['first', 'second'])
    expect(cs[0].author).toBe('mike')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: FAIL — `store.addIssueComment is not a function`.

- [ ] **Step 3: Implement comment methods + row type**

Add an exported interface near `IssueRow`:

```ts
export interface IssueCommentRow {
  id: string
  issueId: string
  author: string
  body: string
  createdAt: string
}
```

Add methods to `SessionStore`:

```ts
  addIssueComment(c: IssueCommentRow): void {
    this.db
      .prepare(
        'INSERT INTO issue_comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(c.id, c.issueId, c.author, c.body, c.createdAt)
  }

  listIssueComments(issueId: string): IssueCommentRow[] {
    return (
      this.db
        .prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC')
        .all(issueId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      author: r.author as string,
      body: r.body as string,
      createdAt: r.created_at as string,
    }))
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/store.issues.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.issues.test.ts
git commit -m "feat(tracker): issue comment store methods"
```

---

### Task 7: Protocol `IssueWire` + `toWire` (rich fields + derived ready/blocked/epic)

**Files:**
- Modify: `packages/protocol/src/messages.ts` — `IssueWire` (~581-608); add `IssueComment`,
  `IssueDepWire`, `IssueType`, `ISSUE_DEP_TYPES`.
- Modify: `apps/server/src/issues.ts` — `toWire` (~45-64); `create` literal (~93-102) to set
  new defaults; add a private `isClosed`/`deriveStatus` helper.
- Modify: `apps/server/src/issues.test.ts` — fix `harness`/assertions for new fields; add derive tests.
- Test: covered in `apps/server/src/issues.test.ts`.

**Interfaces:**
- Produces wire fields: `priority: number`, `type: IssueType`, `assignee?`, `parentId?`,
  `design?`, `acceptance?`, `notes?`, `dueAt?`, `deferUntil?`, `closedReason?`, `pinned: boolean`,
  `estimateMin?`, `labels: string[]`, `deps: IssueDepWire[]`, `dependents: IssueDepWire[]`,
  `comments: IssueComment[]`, and derived `ready: boolean`, `blocked: boolean`,
  `deferred: boolean`, `childCount: number`, `childDoneCount: number`.
- `IssueDepWire = { id: string; type: string }` (the other issue's id + the edge type).
- Consumes (from Tasks 3-6): the `IssueRow` fields and the store label/dep/comment readers.

- [ ] **Step 1: Write the failing test**

In `issues.test.ts`, first update `harness` is unnecessary (it uses the service, not row literals).
Add a new describe block:

```ts
describe('IssueService derived status (P1)', () => {
  it('new issue is ready (open, no blockers) with defaults', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(w.priority).toBe(2)
    expect(w.type).toBe('task')
    expect(w.pinned).toBe(false)
    expect(w.labels).toEqual([])
    expect(w.deps).toEqual([])
    expect(w.ready).toBe(true)
    expect(w.blocked).toBe(false)
    expect(w.deferred).toBe(false)
  })

  it('a blocks-dependency on an open issue makes the dependent blocked (not ready)', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
    const reloaded = svc.get(a.id)!
    expect(reloaded.blocked).toBe(true)
    expect(reloaded.ready).toBe(false)
    expect(reloaded.deps).toEqual([{ id: b.id, type: 'blocks' }])
  })

  it('closing the blocker (stage=done) unblocks the dependent', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
    svc.update(b.id, { stage: 'done' })
    expect(svc.get(a.id)!.ready).toBe(true)
  })

  it('a future defer_until marks the issue deferred and not ready', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const deferred = svc.update(a.id, { deferUntil: '2999-01-01' })
    expect(deferred.deferred).toBe(true)
    expect(deferred.ready).toBe(false)
  })

  it('epic counts reflect children by parentId', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const c1 = svc.create({ repoPath: '/r', title: 'c1', startNow: false })
    const c2 = svc.create({ repoPath: '/r', title: 'c2', startNow: false })
    svc.update(c1.id, { parentId: epic.id })
    svc.update(c2.id, { parentId: epic.id, stage: 'done' })
    const e = svc.get(epic.id)!
    expect(e.childCount).toBe(2)
    expect(e.childDoneCount).toBe(1)
  })
})
```

Note: `svc.update` must accept `deferUntil`/`parentId` — added in this task's Step 3 (extend the
`update` patch pick). `harness` already returns `{ store, deps, svc }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `w.ready` is `undefined`, and TS errors on `update({ deferUntil })`.

- [ ] **Step 3: Extend protocol + toWire + create defaults + update pick**

In `messages.ts`, before `IssueWire`, add:

```ts
export const IssueType = z.enum([
  'task', 'bug', 'feature', 'chore', 'epic', 'decision', 'spike', 'story', 'milestone',
])
export type IssueType = z.infer<typeof IssueType>

export const ISSUE_DEP_TYPES = [
  'blocks', 'related', 'parent-child', 'discovered-from', 'tracks', 'supersedes',
  'caused-by', 'validates',
] as const

export const IssueDepWire = z.object({ id: z.string(), type: z.string() })
export type IssueDepWire = z.infer<typeof IssueDepWire>

export const IssueComment = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
})
export type IssueComment = z.infer<typeof IssueComment>
```

In `IssueWire`, add (before the derived `sessions`):

```ts
  priority: z.number().int(),
  type: IssueType,
  assignee: z.string().optional(),
  parentId: z.string().optional(),
  design: z.string().optional(),
  acceptance: z.string().optional(),
  notes: z.string().optional(),
  dueAt: z.string().optional(),
  deferUntil: z.string().optional(),
  closedReason: z.string().optional(),
  pinned: z.boolean(),
  estimateMin: z.number().int().optional(),
  labels: z.array(z.string()),
  deps: z.array(IssueDepWire),
  dependents: z.array(IssueDepWire),
  comments: z.array(IssueComment),
  ready: z.boolean(),
  blocked: z.boolean(),
  deferred: z.boolean(),
  childCount: z.number().int(),
  childDoneCount: z.number().int(),
```

In `issues.ts` `create()`, add the new defaults to the `IssueRow` literal (after `prUrl: null,`):

```ts
      priority: 2, type: 'task', assignee: null, parentId: null, design: null, acceptance: null,
      notes: null, dueAt: null, deferUntil: null, closedReason: null, supersededBy: null,
      duplicateOf: null, pinned: false, estimateMin: null,
```

Extend the `update` signature's `Pick` to include the new patchable fields:

```ts
  update(id: string, patch: Partial<Pick<IssueRow,
    'title' | 'description' | 'stage' | 'worktreePath' | 'branch' | 'parentBranch' | 'defaultAgent'
    | 'archived' | 'priority' | 'type' | 'assignee' | 'parentId' | 'design' | 'acceptance'
    | 'notes' | 'dueAt' | 'deferUntil' | 'closedReason' | 'supersededBy' | 'duplicateOf'
    | 'pinned' | 'estimateMin'>>): IssueWire {
```

Add a private helper and rich `toWire` to `IssueService` (replace the existing `toWire` body
tail and add helpers):

```ts
  private isClosed(row: IssueRow): boolean {
    return row.stage === 'done' || row.closedReason != null
  }

  private isDeferred(row: IssueRow): boolean {
    return row.deferUntil != null && row.deferUntil > this.now()
  }

  /** blocked = open AND ≥1 `blocks` dep whose target issue is not closed. */
  private computeBlocked(row: IssueRow): boolean {
    if (this.isClosed(row)) return false
    return this.deps.store
      .listIssueDeps(row.id)
      .filter((d) => d.type === 'blocks')
      .some((d) => {
        const target = this.rows.get(d.toId)
        return target ? !this.isClosed(target) : false
      })
  }
```

Then extend `toWire` to include the new fields (keep the existing head + sessions tail):

```ts
  toWire(row: IssueRow): IssueWire {
    const sessions = sessionsForIssue(row.worktreePath, this.deps.listSessions())
    const labels = this.deps.store.getIssueLabels(row.id)
    const deps = this.deps.store.listIssueDeps(row.id).map((d) => ({ id: d.toId, type: d.type }))
    const dependents = this.deps.store
      .listDependents(row.id)
      .map((d) => ({ id: d.fromId, type: d.type }))
    const comments = this.deps.store.listIssueComments(row.id)
    const children = [...this.rows.values()].filter((r) => r.parentId === row.id)
    const blocked = this.computeBlocked(row)
    const deferred = this.isDeferred(row)
    const ready = !this.isClosed(row) && !deferred && !blocked
    return {
      id: row.id, repoPath: row.repoPath, seq: row.seq, title: row.title, description: row.description,
      stage: row.stage as IssueWire['stage'], worktreePath: row.worktreePath, branch: row.branch,
      parentBranch: row.parentBranch, defaultAgent: row.defaultAgent,
      ...(row.linearId ? { linearId: row.linearId } : {}),
      ...(row.linearIdentifier ? { linearIdentifier: row.linearIdentifier } : {}),
      ...(row.linearUrl ? { linearUrl: row.linearUrl } : {}),
      ...(row.activityNotes ? { activityNotes: row.activityNotes } : {}),
      ...(row.notesUpdatedAt ? { notesUpdatedAt: row.notesUpdatedAt } : {}),
      ...(row.suggestedStage ? { suggestedStage: row.suggestedStage as IssueWire['stage'] } : {}),
      ...(row.suggestedReason ? { suggestedReason: row.suggestedReason } : {}),
      blockedBy: row.blockedBy,
      ...(row.dependencyNote ? { dependencyNote: row.dependencyNote } : {}),
      ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      priority: row.priority, type: row.type as IssueWire['type'], pinned: row.pinned,
      ...(row.assignee ? { assignee: row.assignee } : {}),
      ...(row.parentId ? { parentId: row.parentId } : {}),
      ...(row.design ? { design: row.design } : {}),
      ...(row.acceptance ? { acceptance: row.acceptance } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.dueAt ? { dueAt: row.dueAt } : {}),
      ...(row.deferUntil ? { deferUntil: row.deferUntil } : {}),
      ...(row.closedReason ? { closedReason: row.closedReason } : {}),
      ...(row.estimateMin != null ? { estimateMin: row.estimateMin } : {}),
      labels, deps, dependents, comments,
      ready, blocked, deferred,
      childCount: children.length,
      childDoneCount: children.filter((c) => this.isClosed(c)).length,
      createdAt: row.createdAt, updatedAt: row.updatedAt, archived: row.archived,
      sessions, sessionSummary: summarizeSessions(sessions),
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts`
Expected: PASS (all). Also run `bun run typecheck` and confirm `apps/server` + `packages/protocol` typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): rich IssueWire + derived ready/blocked/deferred/epic counts"
```

---

### Task 8: `IssueService` field mutations (labels, comments, deps+cycle-check, defer, reparent, claim, close)

**Files:**
- Modify: `apps/server/src/issues.ts` — add methods to `IssueService`.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces (all return the updated `IssueWire`, persist + broadcast via `persist`):
  - `setLabels(id: string, labels: string[]): IssueWire`
  - `addComment(id: string, author: string, body: string): IssueWire`
  - `addDep(fromId: string, toId: string, type?: string): IssueWire` — throws on self-dep,
    unknown issue, or a `blocks`/`parent-child` cycle.
  - `removeDep(fromId: string, toId: string, type?: string): IssueWire`
  - `defer(id: string, until: string | null): IssueWire`
  - `reparent(id: string, parentId: string | null): IssueWire` — also maintains a
    `parent-child` dep edge.
  - `claim(id: string, assignee: string): IssueWire` — sets assignee + stage `in_progress`.
  - `close(id: string, reason?: string): IssueWire` — stage `done` + `closedReason`.
- Consumes: store dep/label/comment methods (Tasks 4-6), `randomUUID` (already imported).

- [ ] **Step 1: Write the failing test**

Append to `issues.test.ts`:

```ts
describe('IssueService field mutations (P1)', () => {
  it('setLabels persists and surfaces on the wire', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.setLabels(a.id, ['ui', 'p1']).labels).toEqual(['p1', 'ui'])
  })

  it('addComment appends a comment', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const w = svc.addComment(a.id, 'mike', 'looks good')
    expect(w.comments.map((c) => c.body)).toEqual(['looks good'])
    expect(w.comments[0].author).toBe('mike')
  })

  it('addDep blocks ready; rejects self-dep and cycles', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    expect(svc.addDep(a.id, b.id).blocked).toBe(true)
    expect(() => svc.addDep(a.id, a.id)).toThrow(/self/)
    expect(() => svc.addDep(b.id, a.id)).toThrow(/cycle/) // a->b already; b->a closes the loop
  })

  it('claim sets assignee + in_progress; close sets done + reason', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const claimed = svc.claim(a.id, 'agent:claude')
    expect(claimed.assignee).toBe('agent:claude')
    expect(claimed.stage).toBe('in_progress')
    const closed = svc.close(a.id, 'wontfix')
    expect(closed.stage).toBe('done')
    expect(closed.closedReason).toBe('wontfix')
  })

  it('reparent maintains a parent-child edge', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.reparent(child.id, epic.id)
    expect(store.listIssueDeps(child.id)).toEqual([{ toId: epic.id, type: 'parent-child' }])
    svc.reparent(child.id, null)
    expect(store.listIssueDeps(child.id)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.setLabels is not a function`.

- [ ] **Step 3: Implement the mutations**

Add to `IssueService` (after `update`):

```ts
  setLabels(id: string, labels: string[]): IssueWire {
    const row = this.rowOrThrow(id)
    this.deps.store.setIssueLabels(id, labels)
    return this.persist(row)
  }

  addComment(id: string, author: string, body: string): IssueWire {
    const row = this.rowOrThrow(id)
    this.deps.store.addIssueComment({
      id: `cmt_${randomUUID()}`, issueId: id, author, body, createdAt: this.now(),
    })
    return this.persist(row)
  }

  /** Cycle check over `blocks` + `parent-child` edges, following from->to. */
  private wouldCycle(fromId: string, toId: string): boolean {
    const seen = new Set<string>()
    const stack = [toId]
    while (stack.length) {
      const cur = stack.pop() as string
      if (cur === fromId) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const d of this.deps.store.listIssueDeps(cur)) {
        if (d.type === 'blocks' || d.type === 'parent-child') stack.push(d.toId)
      }
    }
    return false
  }

  addDep(fromId: string, toId: string, type = 'blocks'): IssueWire {
    const row = this.rowOrThrow(fromId)
    this.rowOrThrow(toId)
    if (fromId === toId) throw new Error('an issue cannot depend on itself (self-dep)')
    if ((type === 'blocks' || type === 'parent-child') && this.wouldCycle(fromId, toId)) {
      throw new Error(`dependency ${fromId} -> ${toId} would create a cycle`)
    }
    this.deps.store.addIssueDep(fromId, toId, type)
    return this.persist(row)
  }

  removeDep(fromId: string, toId: string, type?: string): IssueWire {
    const row = this.rowOrThrow(fromId)
    this.deps.store.removeIssueDep(fromId, toId, type)
    return this.persist(row)
  }

  defer(id: string, until: string | null): IssueWire {
    return this.update(id, { deferUntil: until })
  }

  reparent(id: string, parentId: string | null): IssueWire {
    const row = this.rowOrThrow(id)
    if (row.parentId) this.deps.store.removeIssueDep(id, row.parentId, 'parent-child')
    if (parentId) {
      this.rowOrThrow(parentId)
      if (this.wouldCycle(id, parentId)) throw new Error(`reparent would create a cycle`)
      this.deps.store.addIssueDep(id, parentId, 'parent-child')
    }
    return this.update(id, { parentId })
  }

  claim(id: string, assignee: string): IssueWire {
    return this.update(id, { assignee, stage: 'in_progress' })
  }

  close(id: string, reason = 'done'): IssueWire {
    return this.update(id, { stage: 'done', closedReason: reason })
  }
```

If `rowOrThrow` is not already a method (the codebase uses it in `start`/`action`), it exists;
reuse it. `randomUUID` is already imported in `issues.ts` (used by `create`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts`
Expected: PASS (all). Run `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): IssueService label/comment/dep/defer/reparent/claim/close mutations"
```

---

### Task 9: Router — extend `create`/`update` inputs + add field-mutation procedures

**Files:**
- Modify: `apps/server/src/router.ts` — `issues` router (~358-422). Import `IssueType` from
  `@podium/protocol` alongside the existing `IssueStage` import.
- Test: `apps/server/src/router.issues.test.ts` (create) — typed-input parse assertions.

**Interfaces:**
- Consumes: `IssueService` methods from Task 8 + extended `create`/`update`.
- Produces tRPC procedures: extends `issues.create` (priority/type/assignee/labels/parentId at
  creation) and `issues.update` (all new patch fields); adds `issues.setLabels`,
  `issues.addComment`, `issues.depAdd`, `issues.depRemove`, `issues.defer`, `issues.reparent`,
  `issues.claim`, `issues.close`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/router.issues.test.ts` (assert the router's input zod schemas accept
the new shapes — no server runtime needed):

```ts
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'

function inputSchema(path: string) {
  // tRPC stores the parsed input parser on the procedure's _def.
  const proc = (appRouter as any)._def.procedures[path]
  return proc._def.inputs[0]
}

describe('issues router inputs (P1)', () => {
  it('create accepts priority/type/labels/parentId', () => {
    const parsed = inputSchema('issues.create').parse({
      repoPath: '/r', title: 'A', startNow: false,
      priority: 0, type: 'bug', labels: ['ui'], parentId: 'iss_e',
    })
    expect(parsed.priority).toBe(0)
    expect(parsed.type).toBe('bug')
  })

  it('depAdd requires fromId + toId', () => {
    expect(() => inputSchema('issues.depAdd').parse({ fromId: 'a' })).toThrow()
    expect(inputSchema('issues.depAdd').parse({ fromId: 'a', toId: 'b' }).type).toBeUndefined()
  })

  it('close accepts an optional reason', () => {
    expect(inputSchema('issues.close').parse({ id: 'a' }).id).toBe('a')
    expect(inputSchema('issues.close').parse({ id: 'a', reason: 'duplicate' }).reason).toBe('duplicate')
  })
})
```

(If the `_def.procedures` shape differs in the installed tRPC version, fall back to importing the
input zod objects directly — define them as named `const`s in `router.ts` and import them here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/router.issues.test.ts`
Expected: FAIL — `issues.depAdd` procedure does not exist / create rejects `priority`.

- [ ] **Step 3: Extend the router**

At the top of `router.ts`, extend the protocol import to include `IssueType`:

```ts
import { IssueStage, IssueType /* …existing imports… */ } from '@podium/protocol'
```

Extend `issues.create` input with optional new fields (and pass through — `createAndMaybeStart`
calls `create`, so also extend `CreateIssueInput` + `create()` to accept them; for P1 wire the
optional `priority`/`type`/`assignee`/`labels`/`parentId` into the created row, defaulting as in
Task 7). Add to the `create` input object:

```ts
          priority: z.number().int().min(0).max(4).optional(),
          type: IssueType.optional(),
          assignee: z.string().optional(),
          labels: z.array(z.string()).optional(),
          parentId: z.string().optional(),
```

Extend `issues.update` `patch` object with:

```ts
            priority: z.number().int().min(0).max(4).optional(),
            type: IssueType.optional(),
            assignee: z.string().optional(),
            parentId: z.string().optional(),
            design: z.string().optional(),
            acceptance: z.string().optional(),
            notes: z.string().optional(),
            dueAt: z.string().optional(),
            deferUntil: z.string().optional(),
            closedReason: z.string().optional(),
            pinned: z.boolean().optional(),
            estimateMin: z.number().int().optional(),
```

Add new procedures inside the `issues` router (after `refreshAssistant`):

```ts
    setLabels: t.procedure
      .input(z.object({ id: z.string(), labels: z.array(z.string()) }))
      .mutation(({ ctx, input }) => ctx.registry.issues.setLabels(input.id, input.labels)),
    addComment: t.procedure
      .input(z.object({ id: z.string(), author: z.string(), body: z.string().min(1) }))
      .mutation(({ ctx, input }) => ctx.registry.issues.addComment(input.id, input.author, input.body)),
    depAdd: t.procedure
      .input(z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.addDep(input.fromId, input.toId, input.type)),
    depRemove: t.procedure
      .input(z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.removeDep(input.fromId, input.toId, input.type)),
    defer: t.procedure
      .input(z.object({ id: z.string(), until: z.string().nullable() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.defer(input.id, input.until)),
    reparent: t.procedure
      .input(z.object({ id: z.string(), parentId: z.string().nullable() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.reparent(input.id, input.parentId)),
    claim: t.procedure
      .input(z.object({ id: z.string(), assignee: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.claim(input.id, input.assignee)),
    close: t.procedure
      .input(z.object({ id: z.string(), reason: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.close(input.id, input.reason)),
```

Extend `CreateIssueInput` (`issues.ts`) with the optional fields and apply them in `create()`
(default to the Task 7 values when absent), then call `setLabels` after persist if labels given:

```ts
// in CreateIssueInput
  priority?: number
  type?: string
  assignee?: string
  labels?: string[]
  parentId?: string
```

```ts
// in create(), after building `row` set the optional overrides before persist:
    if (input.priority != null) row.priority = input.priority
    if (input.type) row.type = input.type
    if (input.assignee) row.assignee = input.assignee
    if (input.parentId) row.parentId = input.parentId
    const wire = this.persist(row)
    if (input.labels?.length) return this.setLabels(row.id, input.labels)
    return wire
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/router.issues.test.ts apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts`
Expected: PASS. Then `bun run typecheck` → clean (this is the primary guarantee that the thin
router procedures match the tested `IssueService` signatures).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/router.ts apps/server/src/issues.ts apps/server/src/router.issues.test.ts
git commit -m "feat(tracker): extend issues router with rich create/update + field mutations"
```

---

## Phase Close (P1)

- [ ] Run the full issue-tracker test scope:
  `npx vitest run apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts apps/server/src/router.issues.test.ts apps/web/src/derive-issues.test.ts`
- [ ] `bun run typecheck` clean across `apps/server`, `packages/protocol`.
- [ ] `bun run lint` (biome) clean on changed files.
- [ ] Confirm no regression in `apps/server/src/issues.test.ts` (existing CRUD/start tests).
- [ ] Hand off to **P2 plan** (deps/ready-list/blocked-list/graph + lifecycle/hygiene/search +
  stats/doctor server endpoints), to be written next, building on these store/service methods.

## Self-Review notes (author)

- **Spec coverage (P1 slice):** rich fields (Tasks 1,3,7) ✓; labels (4,7,8) ✓; comments (6,7,8) ✓;
  typed deps + cycle check (2,5,7,8) ✓; ready/blocked/deferred derivation (7) ✓; epic counts (7) ✓;
  defer/reparent/claim/close field mutations (8,9) ✓; `blocked_by` migration (2) ✓. Out of this
  milestone by design (→ P2): ready/blocked/graph *list* endpoints, search/count/stats/doctor/lint,
  supersede/duplicate/stale/orphans/preflight. Out (→ P3): CLI/MCP/roles. Out (→ P4): UI.
- **Placeholder scan:** none — every code step shows full code.
- **Type consistency:** `IssueRow` (Task 3) ⇄ `upsertIssue`/`mapIssueRow` (3) ⇄ `IssueWire`/`toWire`
  (7) ⇄ service mutations (8) ⇄ router (9) use the same field names (`deferUntil`, `parentId`,
  `closedReason`, `estimateMin`, `pinned`). Dep store returns `{toId,type}`/`{fromId,type}`;
  `toWire` maps them to `{id,type}` for the wire (`IssueDepWire`). Consistent.
- **Risk:** the `router.issues.test.ts` reflection into `_def.procedures` may be tRPC-version
  specific; Step 1 names the fallback (export the input schemas as consts and import them).

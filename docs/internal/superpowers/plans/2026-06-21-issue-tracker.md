# Issue Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class **Issue** to Podium — a unit of work that owns one git worktree and every session/shell in it, tracks a 6-stage kanban, exposes one-click rebase/PR/merge actions, and runs a background AI assistant (on `settings.workLlm`) that keeps an activity summary, suggests stage moves, and rates cross-issue dependencies.

**Architecture:** A new `issues` SQLite table (schema v5) + zod `IssueWire` protocol types. Server logic lives in an injected `IssueService` (new `apps/server/src/issues.ts`) owned by the existing `SessionRegistry`, with pure helpers in `issue-util.ts` and the AI worker in `issueAssistant.ts`. Membership is **derived**: a session belongs to an issue when its `cwd` is the issue's `worktree_path` (or under it) — no change to the `sessions` table. The daemon's `runRepoOp` gains write ops (rebase / merge / PR). The web gets a new top-level `IssuesView` board reusing `agentBadge`/`SessionCard`.

**Tech Stack:** TypeScript, bun workspaces, zod (protocol + settings validation), `node:sqlite` `DatabaseSync`, tRPC, React + shadcn/Base UI + Tailwind v4, vitest, Playwright.

## Global Constraints

- All protocol + settings types are **zod schemas** with `z.infer` types; new wire/settings shapes MUST follow that pattern.
- SQLite is `node:sqlite` `DatabaseSync` (prepare/run/get/all); migrations are **additive** and gated on the `meta.schema_version` value. Bump it to `'5'`. Never rewrite existing tables.
- Membership is derived from `session.cwd`; do **not** add an `issue_id` column to `sessions`.
- Background AI uses `settings.workLlm` via `llmClient(backend, apiKeys).complete(messages, [])` from `apps/server/src/llm.ts`. Default model is `google/gemini-2.5-flash`.
- Stage set (exact ids): `backlog`, `planning`, `in_progress`, `review`, `verifying`, `done`.
- Stage moves are **suggest-only** (assistant never auto-moves); activity notes auto-update.
- Merge default is `ff-only`; setting lives at `settings.gitWorkflow.mergeStyle ∈ {ff-only, pr, ask}`.
- Timestamps are `new Date().toISOString()` in app code; inject a `now()` dep in services so tests are deterministic.
- Commit after every green task. Branch is `worktree-issue-tracker`.
- `bun run test` runs vitest from the repo root. Run a single file with `bunx vitest run <path>`.
- **Known baseline:** 23 pre-existing failures, mostly `apps/web/*` tests failing on the unresolved `@/lib/utils` alias under vitest. Task 1 fixes the vitest alias so web logic is testable; treat only *new* failures as yours.

---

### Task 1: vitest `@` alias + protocol Issue types

**Files:**
- Modify: `vitest.config.ts` (repo root) — add `@` → `apps/web/src` alias so web unit tests resolve.
- Modify: `packages/protocol/src/messages.ts` — add Issue types, extend `RepoOp`, extend `ServerMessage`.
- Modify: `packages/protocol/src/index.ts` (or wherever `messages` is re-exported) — export the new names if the barrel lists them explicitly.
- Test: `packages/protocol/src/issues.test.ts` (new).

**Interfaces:**
- Produces:
  - `IssueStage = z.enum(['backlog','planning','in_progress','review','verifying','done'])`
  - `ISSUE_STAGES: IssueStage[]` (ordered, exported const)
  - `IssueSessionSummary` `{ total: number; byPhase: Record<string, number> }`
  - `IssueWire` (zod) — all persisted fields + derived `sessions: SessionMeta[]`, `sessionSummary: IssueSessionSummary`
  - `IssuesChangedMessage` `{ type:'issuesChanged'; issues: IssueWire[] }`
  - `IssueUpdatedMessage` `{ type:'issueUpdated'; issue: IssueWire }`
  - `RepoOp` extended enum: adds `'rebase'`, `'mergeFfOnly'`, `'prCreate'`

- [ ] **Step 1: Add the vitest alias.** In `vitest.config.ts`, ensure a `resolve.alias` maps `@` to the web src. Read the file first; add inside the existing `defineConfig({ ... })`:

```ts
import { fileURLToPath } from 'node:url'
// ...inside the config object (merge with any existing `resolve`):
resolve: {
  alias: {
    '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
  },
},
```

- [ ] **Step 2: Verify the alias fixes a baseline failure.**

Run: `bunx vitest run apps/web/src/recency-order.test.ts`
Expected: PASS (was failing with "Cannot find package '@/lib/utils'").

- [ ] **Step 3: Write the failing protocol test.** Create `packages/protocol/src/issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ISSUE_STAGES, IssueStage, IssueWire, RepoOp, ServerMessage } from './messages'

describe('issue protocol types', () => {
  it('has the six ordered stages', () => {
    expect(ISSUE_STAGES).toEqual(['backlog', 'planning', 'in_progress', 'review', 'verifying', 'done'])
    expect(IssueStage.parse('verifying')).toBe('verifying')
  })

  it('parses an IssueWire with derived members', () => {
    const wire = IssueWire.parse({
      id: 'iss_1', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'backlog',
      worktreePath: null, branch: null, parentBranch: 'main', defaultAgent: 'claude-code',
      blockedBy: [], createdAt: 't', updatedAt: 't', archived: false,
      sessions: [], sessionSummary: { total: 0, byPhase: {} },
    })
    expect(wire.stage).toBe('backlog')
    expect(wire.worktreePath).toBeNull()
  })

  it('accepts the new write RepoOps', () => {
    expect(RepoOp.parse('rebase')).toBe('rebase')
    expect(RepoOp.parse('mergeFfOnly')).toBe('mergeFfOnly')
    expect(RepoOp.parse('prCreate')).toBe('prCreate')
  })

  it('round-trips issue broadcast messages', () => {
    const issue = IssueWire.parse({
      id: 'iss_1', repoPath: '/r', seq: 1, title: 'X', description: '', stage: 'planning',
      worktreePath: '/r/wt', branch: 'issue/1-x', parentBranch: 'main', defaultAgent: 'claude-code',
      blockedBy: [], createdAt: 't', updatedAt: 't', archived: false,
      sessions: [], sessionSummary: { total: 0, byPhase: {} },
    })
    expect(ServerMessage.parse({ type: 'issuesChanged', issues: [issue] }).type).toBe('issuesChanged')
    expect(ServerMessage.parse({ type: 'issueUpdated', issue }).type).toBe('issueUpdated')
  })
})
```

- [ ] **Step 4: Run it to confirm it fails.**

Run: `bunx vitest run packages/protocol/src/issues.test.ts`
Expected: FAIL (`ISSUE_STAGES`/`IssueWire` undefined; `RepoOp` rejects `'rebase'`).

- [ ] **Step 5: Implement the types in `messages.ts`.** Add near the existing `RepoOp` definition and `SessionMeta`. Replace the `RepoOp` enum line and add the issue block:

```ts
export const RepoOp = z.enum(['status', 'log', 'branches', 'worktreeAdd', 'rebase', 'mergeFfOnly', 'prCreate'])
export type RepoOp = z.infer<typeof RepoOp>

export const IssueStage = z.enum(['backlog', 'planning', 'in_progress', 'review', 'verifying', 'done'])
export type IssueStage = z.infer<typeof IssueStage>
export const ISSUE_STAGES: IssueStage[] = ['backlog', 'planning', 'in_progress', 'review', 'verifying', 'done']

export const IssueSessionSummary = z.object({
  total: z.number().int().nonnegative(),
  byPhase: z.record(z.number().int().nonnegative()),
})
export type IssueSessionSummary = z.infer<typeof IssueSessionSummary>

export const IssueWire = z.object({
  id: z.string(),
  repoPath: z.string(),
  seq: z.number().int(),
  title: z.string(),
  description: z.string(),
  stage: IssueStage,
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  parentBranch: z.string(),
  defaultAgent: z.string(),
  linearId: z.string().optional(),
  linearIdentifier: z.string().optional(),
  linearUrl: z.string().optional(),
  activityNotes: z.string().optional(),
  notesUpdatedAt: z.string().optional(),
  suggestedStage: IssueStage.optional(),
  suggestedReason: z.string().optional(),
  blockedBy: z.array(z.string()),
  dependencyNote: z.string().optional(),
  prUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  // Derived server-side at serialization (not persisted):
  sessions: z.array(SessionMeta),
  sessionSummary: IssueSessionSummary,
})
export type IssueWire = z.infer<typeof IssueWire>

export const IssuesChangedMessage = z.object({
  type: z.literal('issuesChanged'),
  issues: z.array(IssueWire),
})
export const IssueUpdatedMessage = z.object({
  type: z.literal('issueUpdated'),
  issue: IssueWire,
})
```

Then add `IssuesChangedMessage` and `IssueUpdatedMessage` to the `ServerMessage` discriminated union array.

- [ ] **Step 6: Export from the barrel if needed.** If `packages/protocol/src/index.ts` re-exports names explicitly (not `export *`), add `IssueStage`, `ISSUE_STAGES`, `IssueWire`, `IssueSessionSummary`. Confirm with: `grep -n "RepoOp\|SessionMeta" packages/protocol/src/index.ts`.

- [ ] **Step 7: Run tests + typecheck.**

Run: `bunx vitest run packages/protocol/src/issues.test.ts && bun run --filter @podium/protocol typecheck`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add vitest.config.ts packages/protocol/src/messages.ts packages/protocol/src/index.ts packages/protocol/src/issues.test.ts
git commit -m "feat(issues): protocol types + RepoOp write ops + vitest @ alias"
```

---

### Task 2: Store — `issues` table (schema v5) + CRUD

**Files:**
- Modify: `apps/server/src/store.ts` — add `IssueRow` type, the `issues` CREATE TABLE, the v5 bump, and CRUD methods.
- Test: `apps/server/src/store-issues.test.ts` (new).

**Interfaces:**
- Consumes: nothing (store is standalone; `new SessionStore(':memory:')`).
- Produces (methods on `SessionStore`):
  - `upsertIssue(row: IssueRow): void`
  - `getIssue(id: string): IssueRow | null`
  - `listIssueRows(repoPath?: string): IssueRow[]`
  - `deleteIssue(id: string): void`
  - `nextIssueSeq(repoPath: string): number` (max seq for repo + 1; starts at 1)
  - `IssueRow` type (camelCase; `blockedBy: string[]` stored as JSON text):

```ts
export interface IssueRow {
  id: string
  repoPath: string
  seq: number
  title: string
  description: string
  stage: string
  worktreePath: string | null
  branch: string | null
  parentBranch: string
  defaultAgent: string
  linearId: string | null
  linearIdentifier: string | null
  linearUrl: string | null
  activityNotes: string | null
  notesUpdatedAt: string | null
  suggestedStage: string | null
  suggestedReason: string | null
  blockedBy: string[]
  dependencyNote: string | null
  prUrl: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
}
```

- [ ] **Step 1: Write failing tests.** Create `apps/server/src/store-issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

const base = () => ({
  id: 'iss_1', repoPath: '/r', seq: 1, title: 'Fix login', description: 'desc',
  stage: 'backlog', worktreePath: null, branch: null, parentBranch: 'main',
  defaultAgent: 'claude-code', linearId: null, linearIdentifier: null, linearUrl: null,
  activityNotes: null, notesUpdatedAt: null, suggestedStage: null, suggestedReason: null,
  blockedBy: [] as string[], dependencyNote: null, prUrl: null,
  createdAt: 't0', updatedAt: 't0', archived: false,
})

describe('store issues', () => {
  it('round-trips an issue', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    const got = s.getIssue('iss_1')
    expect(got?.title).toBe('Fix login')
    expect(got?.worktreePath).toBeNull()
    expect(got?.blockedBy).toEqual([])
    expect(got?.archived).toBe(false)
  })

  it('updates on conflict and preserves JSON blockedBy', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    s.upsertIssue({ ...base(), stage: 'planning', worktreePath: '/r/wt', branch: 'issue/1-x', blockedBy: ['iss_2'] })
    const got = s.getIssue('iss_1')
    expect(got?.stage).toBe('planning')
    expect(got?.worktreePath).toBe('/r/wt')
    expect(got?.blockedBy).toEqual(['iss_2'])
  })

  it('lists by repo and increments seq per repo', () => {
    const s = new SessionStore(':memory:')
    expect(s.nextIssueSeq('/r')).toBe(1)
    s.upsertIssue({ ...base(), id: 'a', repoPath: '/r', seq: 1 })
    s.upsertIssue({ ...base(), id: 'b', repoPath: '/r', seq: 2 })
    s.upsertIssue({ ...base(), id: 'c', repoPath: '/other', seq: 1 })
    expect(s.nextIssueSeq('/r')).toBe(3)
    expect(s.nextIssueSeq('/other')).toBe(2)
    expect(s.listIssueRows('/r').map((i) => i.id).sort()).toEqual(['a', 'b'])
    expect(s.listIssueRows().length).toBe(3)
  })

  it('deletes', () => {
    const s = new SessionStore(':memory:')
    s.upsertIssue(base())
    s.deleteIssue('iss_1')
    expect(s.getIssue('iss_1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/store-issues.test.ts`
Expected: FAIL (`upsertIssue` not a function).

- [ ] **Step 3: Add the table + v5 bump in `migrate()`.** In `store.ts` `migrate()`, after the `superagent_threads` CREATE block and before the FTS `try`, add:

```ts
this.db.exec(
  `CREATE TABLE IF NOT EXISTS issues (
     id TEXT PRIMARY KEY,
     repo_path TEXT NOT NULL,
     seq INTEGER NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     stage TEXT NOT NULL,
     worktree_path TEXT,
     branch TEXT,
     parent_branch TEXT NOT NULL DEFAULT 'main',
     default_agent TEXT NOT NULL,
     linear_id TEXT,
     linear_identifier TEXT,
     linear_url TEXT,
     activity_notes TEXT,
     notes_updated_at TEXT,
     suggested_stage TEXT,
     suggested_reason TEXT,
     blocked_by TEXT NOT NULL DEFAULT '[]',
     dependency_note TEXT,
     pr_url TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0
   )`,
)
this.db.exec('CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_path)')
```

Then change the existing schema-version gate from `< 4`/`'4'` to bump to `'5'` (leave v4 logic; the `CREATE TABLE IF NOT EXISTS` is idempotent so the table is created for both fresh and existing DBs):

```ts
if (!v || Number(v.value) < 5)
  this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '5')
```

- [ ] **Step 4: Add the CRUD methods + row mapper.** Add to the `SessionStore` class (mirroring `upsertSession`/`loadSessions`):

```ts
upsertIssue(row: IssueRow): void {
  this.db
    .prepare(
      `INSERT INTO issues
         (id, repo_path, seq, title, description, stage, worktree_path, branch, parent_branch,
          default_agent, linear_id, linear_identifier, linear_url, activity_notes, notes_updated_at,
          suggested_stage, suggested_reason, blocked_by, dependency_note, pr_url,
          created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description, stage = excluded.stage,
         worktree_path = excluded.worktree_path, branch = excluded.branch,
         parent_branch = excluded.parent_branch, default_agent = excluded.default_agent,
         linear_id = excluded.linear_id, linear_identifier = excluded.linear_identifier,
         linear_url = excluded.linear_url, activity_notes = excluded.activity_notes,
         notes_updated_at = excluded.notes_updated_at, suggested_stage = excluded.suggested_stage,
         suggested_reason = excluded.suggested_reason, blocked_by = excluded.blocked_by,
         dependency_note = excluded.dependency_note, pr_url = excluded.pr_url,
         updated_at = excluded.updated_at, archived = excluded.archived`,
    )
    .run(
      row.id, row.repoPath, row.seq, row.title, row.description, row.stage, row.worktreePath,
      row.branch, row.parentBranch, row.defaultAgent, row.linearId, row.linearIdentifier,
      row.linearUrl, row.activityNotes, row.notesUpdatedAt, row.suggestedStage, row.suggestedReason,
      JSON.stringify(row.blockedBy ?? []), row.dependencyNote, row.prUrl,
      row.createdAt, row.updatedAt, row.archived ? 1 : 0,
    )
}

private mapIssueRow(r: Record<string, unknown>): IssueRow {
  return {
    id: r.id as string,
    repoPath: r.repo_path as string,
    seq: r.seq as number,
    title: r.title as string,
    description: (r.description as string) ?? '',
    stage: r.stage as string,
    worktreePath: (r.worktree_path as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    parentBranch: r.parent_branch as string,
    defaultAgent: r.default_agent as string,
    linearId: (r.linear_id as string | null) ?? null,
    linearIdentifier: (r.linear_identifier as string | null) ?? null,
    linearUrl: (r.linear_url as string | null) ?? null,
    activityNotes: (r.activity_notes as string | null) ?? null,
    notesUpdatedAt: (r.notes_updated_at as string | null) ?? null,
    suggestedStage: (r.suggested_stage as string | null) ?? null,
    suggestedReason: (r.suggested_reason as string | null) ?? null,
    blockedBy: JSON.parse((r.blocked_by as string | null) ?? '[]'),
    dependencyNote: (r.dependency_note as string | null) ?? null,
    prUrl: (r.pr_url as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archived: r.archived === 1,
  }
}

getIssue(id: string): IssueRow | null {
  const r = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? this.mapIssueRow(r) : null
}

listIssueRows(repoPath?: string): IssueRow[] {
  const rows = (repoPath
    ? this.db.prepare('SELECT * FROM issues WHERE repo_path = ? ORDER BY seq ASC').all(repoPath)
    : this.db.prepare('SELECT * FROM issues ORDER BY repo_path ASC, seq ASC').all()) as Record<string, unknown>[]
  return rows.map((r) => this.mapIssueRow(r))
}

deleteIssue(id: string): void {
  this.db.prepare('DELETE FROM issues WHERE id = ?').run(id)
}

nextIssueSeq(repoPath: string): number {
  const r = this.db.prepare('SELECT MAX(seq) AS m FROM issues WHERE repo_path = ?').get(repoPath) as { m: number | null }
  return (r.m ?? 0) + 1
}
```

Add `IssueRow` (from the Interfaces block) near `SessionRow` at the top of the file.

- [ ] **Step 5: Run tests + typecheck.**

Run: `bunx vitest run apps/server/src/store-issues.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/store.ts apps/server/src/store-issues.test.ts
git commit -m "feat(issues): issues table (schema v5) + store CRUD"
```

---

### Task 3: Pure helpers — branch slug, membership, stage order

**Files:**
- Create: `apps/server/src/issue-util.ts`
- Test: `apps/server/src/issue-util.test.ts`

**Interfaces:**
- Consumes: `SessionMeta`, `IssueStage`, `ISSUE_STAGES` from `@podium/protocol`.
- Produces:
  - `slugifyBranch(seq: number, title: string): string` → `issue/<seq>-<slug>` (slug: lowercase, `[^a-z0-9]+`→`-`, trim `-`, ≤40 chars; empty title → `issue/<seq>`)
  - `isMemberCwd(issueWorktree: string | null, cwd: string): boolean` (false when worktree null; true when equal or `cwd` startsWith `worktree + '/'`)
  - `sessionsForIssue(worktreePath: string | null, sessions: SessionMeta[]): SessionMeta[]`
  - `summarizeSessions(sessions: SessionMeta[]): IssueSessionSummary` (`byPhase` counts `agentState.phase`, shells with no state count as `'shell'`)
  - `stageIndex(stage: IssueStage): number` (index in `ISSUE_STAGES`)

- [ ] **Step 1: Write failing tests.** Create `apps/server/src/issue-util.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { isMemberCwd, sessionsForIssue, slugifyBranch, stageIndex, summarizeSessions } from './issue-util'

const sess = (cwd: string, phase?: string): SessionMeta =>
  ({
    sessionId: cwd, agentKind: phase ? 'claude-code' : 'shell', title: 't', cwd,
    status: 'live', controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0,
    clientCount: 0, createdAt: 't', lastActiveAt: 't', origin: { kind: 'spawn' }, archived: false,
    ...(phase ? { agentState: { phase, since: 't', openTaskCount: 0 } } : {}),
  }) as unknown as SessionMeta

describe('slugifyBranch', () => {
  it('builds issue/<seq>-<slug>', () => {
    expect(slugifyBranch(7, 'Fix the Login Flow!')).toBe('issue/7-fix-the-login-flow')
  })
  it('truncates and trims', () => {
    expect(slugifyBranch(1, 'a'.repeat(80)).length).toBeLessThanOrEqual('issue/1-'.length + 40)
  })
  it('handles empty title', () => {
    expect(slugifyBranch(3, '  ')).toBe('issue/3')
  })
})

describe('membership', () => {
  it('matches exact and nested cwds, never when worktree null', () => {
    expect(isMemberCwd(null, '/r/wt')).toBe(false)
    expect(isMemberCwd('/r/wt', '/r/wt')).toBe(true)
    expect(isMemberCwd('/r/wt', '/r/wt/pkg')).toBe(true)
    expect(isMemberCwd('/r/wt', '/r/wt-other')).toBe(false)
  })
  it('filters sessions and summarizes phases', () => {
    const all = [sess('/r/wt', 'working'), sess('/r/wt/pkg', 'idle'), sess('/r/wt'), sess('/other')]
    const members = sessionsForIssue('/r/wt', all)
    expect(members.length).toBe(3)
    const sum = summarizeSessions(members)
    expect(sum.total).toBe(3)
    expect(sum.byPhase).toEqual({ working: 1, idle: 1, shell: 1 })
  })
})

describe('stageIndex', () => {
  it('orders stages', () => {
    expect(stageIndex('backlog')).toBe(0)
    expect(stageIndex('done')).toBe(5)
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/issue-util.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `issue-util.ts`:**

```ts
import { ISSUE_STAGES, type IssueSessionSummary, type IssueStage, type SessionMeta } from '@podium/protocol'

export function slugifyBranch(seq: number, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  return slug ? `issue/${seq}-${slug}` : `issue/${seq}`
}

export function isMemberCwd(issueWorktree: string | null, cwd: string): boolean {
  if (!issueWorktree) return false
  return cwd === issueWorktree || cwd.startsWith(`${issueWorktree}/`)
}

export function sessionsForIssue(worktreePath: string | null, sessions: SessionMeta[]): SessionMeta[] {
  return sessions.filter((s) => isMemberCwd(worktreePath, s.cwd))
}

export function summarizeSessions(sessions: SessionMeta[]): IssueSessionSummary {
  const byPhase: Record<string, number> = {}
  for (const s of sessions) {
    const key = s.agentState?.phase ?? 'shell'
    byPhase[key] = (byPhase[key] ?? 0) + 1
  }
  return { total: sessions.length, byPhase }
}

export function stageIndex(stage: IssueStage): number {
  return ISSUE_STAGES.indexOf(stage)
}
```

- [ ] **Step 4: Run tests.**

Run: `bunx vitest run apps/server/src/issue-util.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/issue-util.ts apps/server/src/issue-util.test.ts
git commit -m "feat(issues): pure helpers (slug, membership, summary, stage order)"
```

---

### Task 4: Settings — `gitWorkflow` + `issues` blocks

**Files:**
- Modify: `packages/core/src/settings.ts`
- Test: `packages/core/src/settings-issues.test.ts` (new)

**Interfaces:**
- Produces (on `PodiumSettings`):
  - `gitWorkflow: { defaultParentBranch: string; mergeStyle: 'ff-only'|'pr'|'ask'; autoRebaseBeforeMerge: boolean }`
  - `issues: { assistantEnabled: boolean }`

- [ ] **Step 1: Write failing tests.** Create `packages/core/src/settings-issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'

describe('gitWorkflow + issues settings', () => {
  it('defaults are present', () => {
    expect(DEFAULT_SETTINGS.gitWorkflow).toEqual({ defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true })
    expect(DEFAULT_SETTINGS.issues).toEqual({ assistantEnabled: true })
  })
  it('back-compat: an old blob with no gitWorkflow parses with defaults', () => {
    const s = normalizeSettings({ sessionDefaults: { agent: 'claude-code' } })
    expect(s.gitWorkflow.mergeStyle).toBe('ff-only')
    expect(s.issues.assistantEnabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run packages/core/src/settings-issues.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the blocks to `PodiumSettings`** (inside the `z.object({ ... })`, after `sidebar`):

```ts
gitWorkflow: z
  .object({
    /** Parent branch for new issue worktrees + merge target. '' = auto-detect repo default. */
    defaultParentBranch: z.string().default(''),
    mergeStyle: z.enum(['ff-only', 'pr', 'ask']).default('ff-only'),
    autoRebaseBeforeMerge: z.boolean().default(true),
  })
  .default({}),
issues: z
  .object({
    assistantEnabled: z.boolean().default(true),
  })
  .default({}),
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `bunx vitest run packages/core/src/settings-issues.test.ts && bun run --filter @podium/core typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/settings.ts packages/core/src/settings-issues.test.ts
git commit -m "feat(issues): gitWorkflow + issues settings blocks"
```

---

### Task 5: Daemon — write RepoOps (rebase / mergeFfOnly / prCreate) + worktreeAdd start-point

**Files:**
- Modify: `apps/daemon/src/daemon.ts` — extract `argvFor` into a pure exported function and extend it; special-case `prCreate` (runs `gh`).
- Create: `apps/daemon/src/repo-op.ts` (pure argv builder, testable without the daemon).
- Test: `apps/daemon/src/repo-op.test.ts`

**Interfaces:**
- Consumes: `RepoOp` (extended in Task 1), `args: Record<string,string>` carrying `path`/`branch`/`parentBranch`/`startPoint`.
- Produces: `repoOpCommand(op: RepoOp, args?: Record<string,string>): { bin: 'git'|'gh'; argv: string[] } | { error: string }`
  - `worktreeAdd`: `git worktree add <path> -b <branch> [<startPoint>]`
  - `rebase`: `git rebase <parentBranch>` (run in the worktree)
  - `mergeFfOnly`: `git merge --ff-only <branch>` (caller runs with `cwd = repoPath`)
  - `prCreate`: `gh pr create --base <parentBranch> --head <branch> --fill` (run in the worktree)

- [ ] **Step 1: Write failing test.** Create `apps/daemon/src/repo-op.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { repoOpCommand } from './repo-op'

describe('repoOpCommand', () => {
  it('builds read ops', () => {
    expect(repoOpCommand('status')).toEqual({ bin: 'git', argv: ['status', '--porcelain=v1', '-b'] })
    expect(repoOpCommand('log')).toEqual({ bin: 'git', argv: ['log', '--oneline', '-20'] })
  })
  it('worktreeAdd with and without start point', () => {
    expect(repoOpCommand('worktreeAdd', { path: '/r/wt', branch: 'issue/1-x' }))
      .toEqual({ bin: 'git', argv: ['worktree', 'add', '/r/wt', '-b', 'issue/1-x'] })
    expect(repoOpCommand('worktreeAdd', { path: '/r/wt', branch: 'issue/1-x', startPoint: 'main' }))
      .toEqual({ bin: 'git', argv: ['worktree', 'add', '/r/wt', '-b', 'issue/1-x', 'main'] })
  })
  it('rebase / mergeFfOnly / prCreate', () => {
    expect(repoOpCommand('rebase', { parentBranch: 'main' })).toEqual({ bin: 'git', argv: ['rebase', 'main'] })
    expect(repoOpCommand('mergeFfOnly', { branch: 'issue/1-x' })).toEqual({ bin: 'git', argv: ['merge', '--ff-only', 'issue/1-x'] })
    expect(repoOpCommand('prCreate', { branch: 'issue/1-x', parentBranch: 'main' }))
      .toEqual({ bin: 'gh', argv: ['pr', 'create', '--base', 'main', '--head', 'issue/1-x', '--fill'] })
  })
  it('reports missing args', () => {
    expect(repoOpCommand('worktreeAdd', {})).toEqual({ error: 'missing args' })
    expect(repoOpCommand('rebase', {})).toEqual({ error: 'missing args' })
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/daemon/src/repo-op.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/daemon/src/repo-op.ts`:**

```ts
import type { RepoOp } from '@podium/protocol'

export type RepoOpCommand = { bin: 'git' | 'gh'; argv: string[] } | { error: string }

export function repoOpCommand(op: RepoOp, args: Record<string, string> = {}): RepoOpCommand {
  switch (op) {
    case 'status':
      return { bin: 'git', argv: ['status', '--porcelain=v1', '-b'] }
    case 'log':
      return { bin: 'git', argv: ['log', '--oneline', '-20'] }
    case 'branches':
      return { bin: 'git', argv: ['branch', '-a', '-v'] }
    case 'worktreeAdd': {
      const { path, branch, startPoint } = args
      if (!path || !branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['worktree', 'add', path, '-b', branch, ...(startPoint ? [startPoint] : [])] }
    }
    case 'rebase': {
      const { parentBranch } = args
      if (!parentBranch) return { error: 'missing args' }
      return { bin: 'git', argv: ['rebase', parentBranch] }
    }
    case 'mergeFfOnly': {
      const { branch } = args
      if (!branch) return { error: 'missing args' }
      return { bin: 'git', argv: ['merge', '--ff-only', branch] }
    }
    case 'prCreate': {
      const { branch, parentBranch } = args
      if (!branch || !parentBranch) return { error: 'missing args' }
      return { bin: 'gh', argv: ['pr', 'create', '--base', parentBranch, '--head', branch, '--fill'] }
    }
  }
}
```

- [ ] **Step 4: Rewire the daemon handler** to use it. In `daemon.ts` `runRepoOp`, replace the inline `argvFor` switch with:

```ts
const cmd = repoOpCommand(msg.op, msg.args ?? {})
if ('error' in cmd) {
  send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: cmd.error })
  return
}
try {
  const runArgs = cmd.bin === 'git' ? ['-C', msg.cwd, ...cmd.argv] : cmd.argv
  const opts = cmd.bin === 'git' ? { timeout: 120_000, maxBuffer: 1024 * 1024 } : { cwd: msg.cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }
  const { stdout, stderr } = await execFileAsync(cmd.bin, runArgs, opts)
  send({ type: 'repoOpResult', requestId: msg.requestId, ok: true, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() })
} catch (err) {
  send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: err instanceof Error ? err.message : String(err) })
}
```

Add `import { repoOpCommand } from './repo-op'` at the top. (Timeout raised to 120s since rebase/PR can be slower than a status.)

- [ ] **Step 5: Run tests + typecheck.**

Run: `bunx vitest run apps/daemon/src/repo-op.test.ts && bun run --filter @podium/daemon typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/daemon/src/repo-op.ts apps/daemon/src/repo-op.test.ts apps/daemon/src/daemon.ts
git commit -m "feat(issues): daemon write RepoOps (rebase/merge/pr) + worktree start-point"
```

---

### Task 6: IssueService — CRUD + IssueWire serialization + registry wiring

**Files:**
- Create: `apps/server/src/issues.ts`
- Modify: `apps/server/src/relay.ts` — construct `IssueService`, expose as `registry.issues`, add a `broadcast(msg)` passthrough + `issuesChanged` after session changes.
- Test: `apps/server/src/issues.test.ts`

**Interfaces:**
- Consumes: `SessionStore` (Task 2), `IssueRow`, `sessionsForIssue`/`summarizeSessions` (Task 3), `IssueWire`/`IssueStage` (Task 1).
- Produces:
  - `interface IssueDeps` `{ store; listSessions(): SessionMeta[]; getSettings(): PodiumSettings; spawnSession(o:{cwd:string;agentKind?:string}):{sessionId:string}; seedDraft(sessionId:string,text:string):void; repoOp(op:RepoOp,cwd:string,args?:Record<string,string>):Promise<{ok:boolean;output:string}>; broadcast(msg:ServerMessage):void; now?():string; defaultRepoBranch?(repoPath:string):Promise<string>; llm?: typeof llmClient }`
  - `class IssueService` with: `list(repoPath?):IssueWire[]`, `get(id):IssueWire|null`, `toWire(row):IssueWire`, `create(input):IssueWire`, `update(id,patch):IssueWire`, `archive(id):IssueWire`, and a private `persistAndBroadcast(row)`.
  - `CreateIssueInput` `{ repoPath:string; title:string; description?:string; parentBranch?:string; defaultAgent?:string; startNow:boolean; linear?:{ id?:string; identifier:string; url:string } }` (start handled in Task 7).

- [ ] **Step 1: Write failing tests.** Create `apps/server/src/issues.test.ts` with a fake-deps harness (covers create/list/toWire/update/archive; `start` is Task 7):

```ts
import { describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@podium/protocol'
import { SessionStore } from './store'
import { IssueService, type IssueDeps } from './issues'

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () => ({ gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true }, sessionDefaults: { agent: 'claude-code' } }) as never,
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    seedDraft: vi.fn(),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast: vi.fn(),
    now: () => 't0',
  }
  return { store, deps, svc: new IssueService(deps) }
}

const sess = (cwd: string, phase = 'working'): SessionMeta =>
  ({ sessionId: cwd, agentKind: 'claude-code', title: 't', cwd, status: 'live', controllerId: null,
     geometry: { cols: 80, rows: 24 }, epoch: 0, clientCount: 0, createdAt: 't', lastActiveAt: 't',
     origin: { kind: 'spawn' }, archived: false, agentState: { phase, since: 't', openTaskCount: 0 } }) as unknown as SessionMeta

describe('IssueService CRUD', () => {
  it('creates a backlog issue (startNow=false), assigns seq, broadcasts', () => {
    const { svc, deps } = harness()
    const wire = svc.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    expect(wire.seq).toBe(1)
    expect(wire.stage).toBe('backlog')
    expect(wire.worktreePath).toBeNull()
    expect(deps.broadcast).toHaveBeenCalled()
    expect(svc.list('/r').length).toBe(1)
  })

  it('toWire derives members + summary from live sessions', () => {
    const { svc } = harness([sess('/r/wt', 'working'), sess('/r/wt/pkg', 'idle'), sess('/elsewhere')])
    const wire = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    // simulate a started issue by updating the worktree path
    const updated = svc.update(wire.id, { worktreePath: '/r/wt', stage: 'planning' })
    expect(updated.sessions.length).toBe(2)
    expect(updated.sessionSummary.total).toBe(2)
  })

  it('update patches fields; archive sets the flag', () => {
    const { svc } = harness()
    const w = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    expect(svc.update(w.id, { stage: 'in_progress' }).stage).toBe('in_progress')
    expect(svc.archive(w.id).archived).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/issues.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/server/src/issues.ts`** (CRUD + serialization; `start`/`action`/assistant come in later tasks but stub their method signatures so the class compiles):

```ts
import { randomUUID } from 'node:crypto'
import type { PodiumSettings } from '@podium/core'
import { type IssueWire, type RepoOp, type ServerMessage, type SessionMeta } from '@podium/protocol'
import { sessionsForIssue, slugifyBranch, summarizeSessions } from './issue-util'
import type { IssueRow, SessionStore } from './store'
import { llmClient } from './llm'

export interface IssueDeps {
  store: SessionStore
  listSessions(): SessionMeta[]
  getSettings(): PodiumSettings
  spawnSession(o: { cwd: string; agentKind?: string }): { sessionId: string }
  seedDraft(sessionId: string, text: string): void
  repoOp(op: RepoOp, cwd: string, args?: Record<string, string>): Promise<{ ok: boolean; output: string }>
  broadcast(msg: ServerMessage): void
  now?(): string
  defaultRepoBranch?(repoPath: string): Promise<string>
  llm?: typeof llmClient
}

export interface CreateIssueInput {
  repoPath: string
  title: string
  description?: string
  parentBranch?: string
  defaultAgent?: string
  startNow: boolean
  linear?: { id?: string; identifier: string; url: string }
}

export class IssueService {
  private readonly rows = new Map<string, IssueRow>()
  constructor(private readonly deps: IssueDeps) {
    for (const r of deps.store.listIssueRows()) this.rows.set(r.id, r)
  }
  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString()
  }

  toWire(row: IssueRow): IssueWire {
    const sessions = sessionsForIssue(row.worktreePath, this.deps.listSessions())
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
      createdAt: row.createdAt, updatedAt: row.updatedAt, archived: row.archived,
      sessions, sessionSummary: summarizeSessions(sessions),
    }
  }

  list(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .sort((a, b) => (a.repoPath === b.repoPath ? a.seq - b.seq : a.repoPath.localeCompare(b.repoPath)))
      .map((r) => this.toWire(r))
  }
  get(id: string): IssueWire | null {
    const r = this.rows.get(id)
    return r ? this.toWire(r) : null
  }
  allWire(): IssueWire[] {
    return this.list()
  }

  private persist(row: IssueRow): IssueWire {
    row.updatedAt = this.now()
    this.rows.set(row.id, row)
    this.deps.store.upsertIssue(row)
    const wire = this.toWire(row)
    this.deps.broadcast({ type: 'issueUpdated', issue: wire })
    this.deps.broadcast({ type: 'issuesChanged', issues: this.allWire() })
    return wire
  }

  create(input: CreateIssueInput): IssueWire {
    const seq = this.deps.store.nextIssueSeq(input.repoPath)
    const ts = this.now()
    const row: IssueRow = {
      id: `iss_${randomUUID()}`, repoPath: input.repoPath, seq, title: input.title,
      description: input.description ?? '', stage: 'backlog', worktreePath: null, branch: null,
      parentBranch: input.parentBranch || this.deps.getSettings().gitWorkflow.defaultParentBranch || 'main',
      defaultAgent: input.defaultAgent || this.deps.getSettings().sessionDefaults.agent || 'claude-code',
      linearId: input.linear?.id ?? null, linearIdentifier: input.linear?.identifier ?? null,
      linearUrl: input.linear?.url ?? null, activityNotes: null, notesUpdatedAt: null,
      suggestedStage: null, suggestedReason: null, blockedBy: [], dependencyNote: null, prUrl: null,
      createdAt: ts, updatedAt: ts, archived: false,
    }
    const wire = this.persist(row)
    return wire
  }

  update(id: string, patch: Partial<Pick<IssueRow, 'title' | 'description' | 'stage' | 'worktreePath' | 'branch' | 'parentBranch' | 'defaultAgent' | 'archived'>>): IssueWire {
    const row = this.rows.get(id)
    if (!row) throw new Error(`unknown issue ${id}`)
    Object.assign(row, patch)
    return this.persist(row)
  }

  archive(id: string): IssueWire {
    return this.update(id, { archived: true })
  }

  // The following are implemented in later tasks (declared here so the class is complete):
  // start(id), action(id, kind), linearSearch(query), applySuggestion(id),
  // dismissSuggestion(id), refreshAssistant(id), addSession/addShell, onSessionActivity.
  /** @internal exposed for later tasks */
  protected rowOrThrow(id: string): IssueRow {
    const r = this.rows.get(id)
    if (!r) throw new Error(`unknown issue ${id}`)
    return r
  }
  /** @internal */
  protected persistRow(row: IssueRow): IssueWire {
    return this.persist(row)
  }
  /** @internal */
  protected get d(): IssueDeps {
    return this.deps
  }
  protected slug = slugifyBranch
}
```

(Note: Tasks 7–10/15–16 add methods to this same class; they reference `this.rowOrThrow`, `this.persistRow`, `this.d`, `this.slug` so they don't need `private` access.)

- [ ] **Step 4: Run the CRUD tests.**

Run: `bunx vitest run apps/server/src/issues.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `SessionRegistry` (`relay.ts`).** Add a public field + a broadcast passthrough. After the `sessions`/`clients` Maps and inside the constructor (after `this.loadFromStore()`), construct the service:

```ts
// field:
readonly issues: IssueService
// in constructor, after loadFromStore():
this.issues = new IssueService({
  store: this.store,
  listSessions: () => this.listSessions(),
  getSettings: () => this.store.getSettings(),
  spawnSession: (o) => this.createSession({ cwd: o.cwd, agentKind: o.agentKind as never }),
  seedDraft: (sessionId, text) => this.setSessionDraft(sessionId, text),
  repoOp: (op, cwd, args) => this.repoOp(op, cwd, args),
  broadcast: (msg) => { for (const c of this.clients.values()) c.send(msg) },
})
```

If `setSessionDraft(sessionId, text)` and `repoOp(op, cwd, args)` are not already public methods, add thin public wrappers around the existing draft-write + repoOp round-trip code (search `repoOp`/`draft` in `relay.ts`). `createSession` already returns the session — adapt to return `{ sessionId }` if needed.

- [ ] **Step 6: Broadcast issues on first attach + session changes.** Find where a new client is attached (`attachClient`) and where `broadcastSessions()` is called; add an `issuesChanged` push so clients stay live:

```ts
// in attachClient, alongside the initial sessions push:
client.send({ type: 'issuesChanged', issues: this.issues.allWire() })
// after broadcastSessions() in the method that handles session list changes:
for (const c of this.clients.values()) c.send({ type: 'issuesChanged', issues: this.issues.allWire() })
```

- [ ] **Step 7: Run server typecheck + tests.**

Run: `bun run --filter @podium/server typecheck && bunx vitest run apps/server/src/issues.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts apps/server/src/relay.ts
git commit -m "feat(issues): IssueService CRUD + IssueWire + registry wiring"
```

---

### Task 7: Start flow — worktree + first session + draft seed

**Files:**
- Modify: `apps/server/src/issues.ts` — add `start(id)` and make `create` honor `startNow`.
- Test: extend `apps/server/src/issues.test.ts`.

**Interfaces:**
- Consumes: `deps.repoOp` (worktreeAdd), `deps.spawnSession`, `deps.seedDraft`, `slugifyBranch`.
- Produces: `start(id: string): Promise<IssueWire>` — assigns branch, creates worktree off `parentBranch`, spawns the default agent, seeds its draft with the description, sets `stage='planning'`. `create` calls `start` when `startNow` and returns the started wire.

- [ ] **Step 1: Write failing tests** (append to `issues.test.ts`):

```ts
describe('IssueService.start', () => {
  it('creates a worktree off parent, spawns the agent, seeds the draft, moves to planning', async () => {
    const { svc, deps } = harness()
    const created = svc.create({ repoPath: '/r', title: 'Fix login', description: 'do the thing', startNow: false })
    const started = await svc.start(created.id)
    expect(started.stage).toBe('planning')
    expect(started.branch).toBe('issue/1-fix-login')
    expect(started.worktreePath).toBe('/r/.worktrees/issue-1-fix-login')
    expect(deps.repoOp).toHaveBeenCalledWith('worktreeAdd', '/r',
      { path: '/r/.worktrees/issue-1-fix-login', branch: 'issue/1-fix-login', startPoint: 'main' })
    expect(deps.spawnSession).toHaveBeenCalledWith({ cwd: '/r/.worktrees/issue-1-fix-login', agentKind: 'claude-code' })
    expect(deps.seedDraft).toHaveBeenCalledWith('s1', 'do the thing')
  })

  it('create(startNow=true) starts immediately', async () => {
    const { svc } = harness()
    const wire = await svc.createAndMaybeStart({ repoPath: '/r', title: 'X', startNow: true })
    expect(wire.stage).toBe('planning')
    expect(wire.worktreePath).not.toBeNull()
  })

  it('start fails clearly when the worktree op fails', async () => {
    const { svc, deps } = harness()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, output: 'fatal: branch exists' })
    const created = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await expect(svc.start(created.id)).rejects.toThrow(/fatal: branch exists/)
  })
})
```

Also update the earlier `create` test name usage: keep `create` synchronous (backlog only) and add `createAndMaybeStart` as the start-aware entry the router uses.

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/issues.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `IssueService`:

```ts
private worktreePathFor(repoPath: string, branch: string): string {
  // branch is `issue/<seq>-<slug>`; flatten to a directory name under <repo>/.worktrees
  const dir = branch.replace(/\//g, '-')
  return `${repoPath}/.worktrees/${dir}`
}

async start(id: string): Promise<IssueWire> {
  const row = this.rowOrThrow(id)
  if (row.worktreePath) return this.toWire(row) // already started
  const branch = this.slug(row.seq, row.title)
  const path = this.worktreePathFor(row.repoPath, branch)
  const res = await this.d.repoOp('worktreeAdd', row.repoPath, { path, branch, startPoint: row.parentBranch })
  if (!res.ok) throw new Error(`worktree add failed: ${res.output}`)
  row.branch = branch
  row.worktreePath = path
  row.stage = 'planning'
  const wire = this.persistRow(row)
  const { sessionId } = this.d.spawnSession({ cwd: path, agentKind: row.defaultAgent })
  if (row.description.trim()) this.d.seedDraft(sessionId, row.description)
  return wire
}

async createAndMaybeStart(input: CreateIssueInput): Promise<IssueWire> {
  const created = this.create(input)
  return input.startNow ? this.start(created.id) : created
}
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `bunx vitest run apps/server/src/issues.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "feat(issues): start flow (worktree + first session + draft seed)"
```

---

### Task 8: Quick actions + Linear search

**Files:**
- Modify: `apps/server/src/issues.ts` — add `action(id, kind)`, `addSession`, `addShell`, `linearSearch(query)`.
- Test: extend `apps/server/src/issues.test.ts`.

**Interfaces:**
- Consumes: `deps.repoOp`, `deps.getSettings().gitWorkflow`, `deps.getSettings().integrations.linearApiKey`, `searchIssues` from `./linear` (inject via an optional dep for tests).
- Produces:
  - `action(id, kind: 'rebase'|'pr'|'merge'): Promise<{ ok: boolean; output: string; issue: IssueWire }>`
    - `rebase`: `repoOp('rebase', worktree, { parentBranch })`
    - `pr`: `repoOp('prCreate', worktree, { branch, parentBranch })`; on ok, parse the URL from output → set `prUrl`.
    - `merge`: if `autoRebaseBeforeMerge`, rebase first; then `repoOp('mergeFfOnly', repoPath, { branch })`.
  - `addSession(id, agentKind?)` / `addShell(id)` → spawn another member in the worktree.
  - `linearSearch(query): Promise<LinearIssue[]>` (proxy; `[]` if no key).
- Add `linearSearch?: (key:string, q:string)=>Promise<LinearIssue[]>` to `IssueDeps` (defaults to the real `searchIssues`).

- [ ] **Step 1: Write failing tests** (append):

```ts
import { /* existing */ } from './issues'

describe('IssueService.action', () => {
  async function started() {
    const { svc, deps } = harness()
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.start(c.id)
    return { svc, deps, id: c.id }
  }

  it('rebase calls repoOp on the worktree with the parent branch', async () => {
    const { svc, deps, id } = await started()
    const r = await svc.action(id, 'rebase')
    expect(r.ok).toBe(true)
    expect(deps.repoOp).toHaveBeenCalledWith('rebase', '/r/.worktrees/issue-1-x', { parentBranch: 'main' })
  })

  it('pr captures the PR url from output', async () => {
    const { svc, deps, id } = await started()
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, output: 'https://github.com/o/r/pull/42' })
    const r = await svc.action(id, 'pr')
    expect(r.issue.prUrl).toBe('https://github.com/o/r/pull/42')
  })

  it('merge auto-rebases then ff-merges in the repo root', async () => {
    const { svc, deps, id } = await started()
    const calls: string[] = []
    ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => { calls.push(op); return { ok: true, output: '' } })
    await svc.action(id, 'merge')
    expect(calls).toEqual(['rebase', 'mergeFfOnly'])
    expect(deps.repoOp).toHaveBeenCalledWith('mergeFfOnly', '/r', { branch: 'issue/1-x' })
  })
})

describe('IssueService.linearSearch', () => {
  it('returns [] when no key configured', async () => {
    const { svc } = harness()
    expect(await svc.linearSearch('login')).toEqual([])
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/issues.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `IssueService` (and add the default `linearSearch` dep + import `searchIssues`, `LinearIssue` from `./linear`):

```ts
async action(id: string, kind: 'rebase' | 'pr' | 'merge'): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
  const row = this.rowOrThrow(id)
  if (!row.worktreePath || !row.branch) throw new Error('issue not started')
  const gw = this.d.getSettings().gitWorkflow
  if (kind === 'rebase') {
    const r = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
    return { ...r, issue: this.toWire(row) }
  }
  if (kind === 'pr') {
    const r = await this.d.repoOp('prCreate', row.worktreePath, { branch: row.branch, parentBranch: row.parentBranch })
    if (r.ok) {
      const url = r.output.match(/https?:\/\/\S+/)?.[0]
      if (url) row.prUrl = url
    }
    return { ...r, issue: this.persistRow(row) }
  }
  // merge
  if (gw.autoRebaseBeforeMerge) {
    const rb = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
    if (!rb.ok) return { ...rb, issue: this.toWire(row) }
  }
  const r = await this.d.repoOp('mergeFfOnly', row.repoPath, { branch: row.branch })
  return { ...r, issue: this.toWire(row) }
}

addSession(id: string, agentKind?: string): IssueWire {
  const row = this.rowOrThrow(id)
  if (!row.worktreePath) throw new Error('issue not started')
  this.d.spawnSession({ cwd: row.worktreePath, agentKind: agentKind ?? row.defaultAgent })
  return this.toWire(row)
}
addShell(id: string): IssueWire {
  return this.addSession(id, 'shell')
}

async linearSearch(query: string): Promise<LinearIssue[]> {
  const key = this.d.getSettings().integrations?.linearApiKey
  if (!key) return []
  const search = this.d.linearSearch ?? searchIssues
  return search(key, query)
}
```

Add `linearSearch?(key: string, q: string): Promise<LinearIssue[]>` to `IssueDeps`.

- [ ] **Step 4: Run tests + typecheck.**

Run: `bunx vitest run apps/server/src/issues.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "feat(issues): quick actions (rebase/pr/merge) + linear search + add session/shell"
```

---

### Task 9: AI assistant — stage mapping, context, JSON parse

**Files:**
- Create: `apps/server/src/issueAssistant.ts`
- Test: `apps/server/src/issueAssistant.test.ts`

**Interfaces:**
- Produces:
  - `interface StageDigest { stage: IssueStage; hasPlanArtifact: boolean; anyWorking: boolean; allIdleDone: boolean; prOpen: boolean; merged: boolean; testsGreen: boolean }`
  - `suggestStage(d: StageDigest): IssueStage | null` (deterministic; returns a stage **only if different** from current)
  - `interface AssistantResult { activityNotes: string; suggestedStage: IssueStage | null; suggestedReason: string; blockedBy: string[]; dependencyNote: string }`
  - `parseAssistantJson(text: string): AssistantResult | null` (tolerant: strips ```json fences; returns null on garbage)
  - `buildAssistantMessages(ctx): LlmMessage[]` (system + user JSON-request prompt)
  - `interface AssistantContext { issue: { title; description; stage; branch; prUrl?: string }; gitStatus: string; gitLog: string; members: { agentKind: string; phase: string; tail: string }[]; otherIssues: { seq: number; title: string; stage: string; branch: string | null }[] }`

- [ ] **Step 1: Write failing tests.** Create `apps/server/src/issueAssistant.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseAssistantJson, suggestStage } from './issueAssistant'

describe('suggestStage', () => {
  const base = { stage: 'planning' as const, hasPlanArtifact: false, anyWorking: false, allIdleDone: false, prOpen: false, merged: false, testsGreen: false }
  it('planning + plan artifact + idle -> in_progress', () => {
    expect(suggestStage({ ...base, hasPlanArtifact: true, allIdleDone: true })).toBe('in_progress')
  })
  it('pr open -> review', () => {
    expect(suggestStage({ ...base, stage: 'in_progress', prOpen: true })).toBe('review')
  })
  it('merged -> verifying', () => {
    expect(suggestStage({ ...base, stage: 'review', merged: true })).toBe('verifying')
  })
  it('verifying + tests green -> done', () => {
    expect(suggestStage({ ...base, stage: 'verifying', testsGreen: true })).toBe('done')
  })
  it('returns null when no change vs current stage', () => {
    expect(suggestStage({ ...base, stage: 'review', prOpen: true })).toBeNull()
  })
})

describe('parseAssistantJson', () => {
  it('parses a fenced JSON block', () => {
    const r = parseAssistantJson('```json\n{"activityNotes":"ok","suggestedStage":"review","suggestedReason":"pr","blockedBy":[],"dependencyNote":""}\n```')
    expect(r?.activityNotes).toBe('ok')
    expect(r?.suggestedStage).toBe('review')
  })
  it('coerces an invalid suggestedStage to null and defaults arrays', () => {
    const r = parseAssistantJson('{"activityNotes":"x","suggestedStage":"bogus"}')
    expect(r?.suggestedStage).toBeNull()
    expect(r?.blockedBy).toEqual([])
  })
  it('returns null on non-JSON', () => {
    expect(parseAssistantJson('I could not produce JSON')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/issueAssistant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `issueAssistant.ts`:**

```ts
import { ISSUE_STAGES, type IssueStage } from '@podium/protocol'
import type { LlmMessage } from './llm'

export interface StageDigest {
  stage: IssueStage
  hasPlanArtifact: boolean
  anyWorking: boolean
  allIdleDone: boolean
  prOpen: boolean
  merged: boolean
  testsGreen: boolean
}

export function suggestStage(d: StageDigest): IssueStage | null {
  let target: IssueStage = d.stage
  if (d.merged) target = d.testsGreen ? 'done' : 'verifying'
  else if (d.prOpen) target = 'review'
  else if (d.stage === 'verifying' && d.testsGreen) target = 'done'
  else if (d.stage === 'planning' && d.hasPlanArtifact && d.allIdleDone) target = 'in_progress'
  return target !== d.stage ? target : null
}

export interface AssistantResult {
  activityNotes: string
  suggestedStage: IssueStage | null
  suggestedReason: string
  blockedBy: string[]
  dependencyNote: string
}

export function parseAssistantJson(text: string): AssistantResult | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : text).trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const stage = obj.suggestedStage
  return {
    activityNotes: typeof obj.activityNotes === 'string' ? obj.activityNotes : '',
    suggestedStage: typeof stage === 'string' && (ISSUE_STAGES as string[]).includes(stage) ? (stage as IssueStage) : null,
    suggestedReason: typeof obj.suggestedReason === 'string' ? obj.suggestedReason : '',
    blockedBy: Array.isArray(obj.blockedBy) ? obj.blockedBy.filter((x): x is string => typeof x === 'string') : [],
    dependencyNote: typeof obj.dependencyNote === 'string' ? obj.dependencyNote : '',
  }
}

export interface AssistantContext {
  issue: { title: string; description: string; stage: string; branch: string | null; prUrl?: string }
  gitStatus: string
  gitLog: string
  members: { agentKind: string; phase: string; tail: string }[]
  otherIssues: { seq: number; title: string; stage: string; branch: string | null }[]
}

export function buildAssistantMessages(ctx: AssistantContext): LlmMessage[] {
  const system =
    'You maintain a software issue tracker card. Given the issue, its git state, and the agents working in its ' +
    'worktree, return ONLY a JSON object: {"activityNotes": string (1-4 sentence markdown summary of progress ' +
    'across all agents), "suggestedStage": one of ' + JSON.stringify(ISSUE_STAGES) + ' or null (only when a move ' +
    'is clearly warranted), "suggestedReason": short string, "blockedBy": array of other issue branch names this ' +
    'likely depends on, "dependencyNote": short advisory or "". Do not wrap in prose.'
  const user = JSON.stringify(ctx, null, 2)
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
```

- [ ] **Step 4: Run tests + typecheck.**

Run: `bunx vitest run apps/server/src/issueAssistant.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/issueAssistant.ts apps/server/src/issueAssistant.test.ts
git commit -m "feat(issues): assistant stage mapping + context + JSON parse"
```

---

### Task 10: Assistant scheduling + suggestion apply/dismiss + refresh

**Files:**
- Modify: `apps/server/src/issues.ts` — add `refreshAssistant(id)`, `applySuggestion(id)`, `dismissSuggestion(id)`, `onSessionActivity(sessionId)` with debounce; run the LLM + persist results.
- Modify: `apps/server/src/relay.ts` — call `this.issues.onSessionActivity(sessionId)` where `sessionAgentStateChanged`/agent-exit is handled.
- Test: extend `apps/server/src/issues.test.ts` (inject a fake LLM; use fake timers for debounce).

**Interfaces:**
- Consumes: `buildAssistantMessages`, `parseAssistantJson`, `suggestStage`, `deps.repoOp('status'|'log')`, `deps.getSettings().workLlm`/`apiKeys`/`issues.assistantEnabled`, `deps.llm` (defaults `llmClient`).
- Produces:
  - `refreshAssistant(id): Promise<IssueWire>`
  - `applySuggestion(id): IssueWire` (sets `stage = suggestedStage`, clears suggestion)
  - `dismissSuggestion(id): IssueWire` (clears suggestion only)
  - `onSessionActivity(sessionId): void` (debounced trigger; finds the owning issue by membership)

- [ ] **Step 1: Write failing tests** (append; fake LLM returns canned JSON):

```ts
describe('IssueService assistant', () => {
  function harnessWithLlm(json: string) {
    const { store, deps, svc } = harness([])
    deps.llm = (() => ({ label: 'fake', complete: async () => ({ text: json, toolCalls: [] }) })) as never
    deps.repoOp = vi.fn(async (op: string) => ({ ok: true, output: op === 'status' ? '## issue/1-x' : 'abc plan' })) as never
    deps.getSettings = (() => ({
      gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
      sessionDefaults: { agent: 'claude-code' }, integrations: { linearApiKey: '' },
      issues: { assistantEnabled: true }, workLlm: { kind: 'api', provider: 'openrouter', model: 'm' }, apiKeys: {},
    })) as never
    return { svc: new IssueService(deps), deps }
  }

  it('refreshAssistant writes activity notes + suggestion and broadcasts', async () => {
    const { svc } = harnessWithLlm('{"activityNotes":"making progress","suggestedStage":"in_progress","suggestedReason":"plan done","blockedBy":[],"dependencyNote":""}')
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    const wire = await svc.refreshAssistant(c.id)
    expect(wire.activityNotes).toBe('making progress')
    expect(wire.suggestedStage).toBe('in_progress')
  })

  it('applySuggestion moves the stage and clears the suggestion', async () => {
    const { svc } = harnessWithLlm('{"activityNotes":"x","suggestedStage":"in_progress","suggestedReason":"r","blockedBy":[],"dependencyNote":""}')
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    await svc.refreshAssistant(c.id)
    const moved = svc.applySuggestion(c.id)
    expect(moved.stage).toBe('in_progress')
    expect(moved.suggestedStage).toBeUndefined()
  })

  it('dismissSuggestion clears without moving', async () => {
    const { svc } = harnessWithLlm('{"activityNotes":"x","suggestedStage":"in_progress","suggestedReason":"r","blockedBy":[],"dependencyNote":""}')
    const c = svc.create({ repoPath: '/r', title: 'X', startNow: false })
    await svc.update(c.id, { worktreePath: '/r/wt', branch: 'issue/1-x', stage: 'planning' })
    await svc.refreshAssistant(c.id)
    const d = svc.dismissSuggestion(c.id)
    expect(d.stage).toBe('planning')
    expect(d.suggestedStage).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/issues.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `IssueService` (import the assistant helpers + `llmClient`):

```ts
private assistantTimers = new Map<string, ReturnType<typeof setTimeout>>()

applySuggestion(id: string): IssueWire {
  const row = this.rowOrThrow(id)
  if (row.suggestedStage) row.stage = row.suggestedStage
  row.suggestedStage = null
  row.suggestedReason = null
  return this.persistRow(row)
}
dismissSuggestion(id: string): IssueWire {
  const row = this.rowOrThrow(id)
  row.suggestedStage = null
  row.suggestedReason = null
  return this.persistRow(row)
}

onSessionActivity(sessionId: string): void {
  if (!this.d.getSettings().issues?.assistantEnabled) return
  const sess = this.d.listSessions().find((s) => s.sessionId === sessionId)
  if (!sess) return
  const row = [...this.rows.values()].find((r) => r.worktreePath && (sess.cwd === r.worktreePath || sess.cwd.startsWith(`${r.worktreePath}/`)))
  if (!row) return
  const prev = this.assistantTimers.get(row.id)
  if (prev) clearTimeout(prev)
  this.assistantTimers.set(row.id, setTimeout(() => {
    this.assistantTimers.delete(row.id)
    void this.refreshAssistant(row.id).catch(() => {})
  }, 120_000))
}

async refreshAssistant(id: string): Promise<IssueWire> {
  const row = this.rowOrThrow(id)
  if (!row.worktreePath) return this.toWire(row)
  const settings = this.d.getSettings()
  const members = sessionsForIssue(row.worktreePath, this.d.listSessions()).map((s) => ({
    agentKind: s.agentKind, phase: s.agentState?.phase ?? 'shell', tail: '',
  }))
  const [status, log] = await Promise.all([
    this.d.repoOp('status', row.worktreePath).catch(() => ({ ok: false, output: '' })),
    this.d.repoOp('log', row.worktreePath).catch(() => ({ ok: false, output: '' })),
  ])
  const others = [...this.rows.values()]
    .filter((r) => r.id !== row.id && r.repoPath === row.repoPath && !r.archived)
    .map((r) => ({ seq: r.seq, title: r.title, stage: r.stage, branch: r.branch }))
  const ctx = {
    issue: { title: row.title, description: row.description, stage: row.stage, branch: row.branch, ...(row.prUrl ? { prUrl: row.prUrl } : {}) },
    gitStatus: status.output, gitLog: log.output, members, otherIssues: others,
  }
  let result = null as ReturnType<typeof parseAssistantJson>
  try {
    const factory = this.d.llm ?? llmClient
    const client = factory(settings.workLlm, settings.apiKeys)
    const resp = await client.complete(buildAssistantMessages(ctx), [])
    result = parseAssistantJson(resp.text)
  } catch {
    result = null
  }
  if (!result) return this.toWire(row) // leave prior state intact
  row.activityNotes = result.activityNotes || row.activityNotes
  row.notesUpdatedAt = this.now()
  row.blockedBy = result.blockedBy
  row.dependencyNote = result.dependencyNote || null
  // Suggestion: trust the model's stage if valid and different; else fall back to the deterministic mapping.
  const digestStage = result.suggestedStage
  row.suggestedStage = digestStage && digestStage !== row.stage ? digestStage : null
  row.suggestedReason = row.suggestedStage ? result.suggestedReason : null
  return this.persistRow(row)
}
```

Import at top of `issues.ts`: `import { buildAssistantMessages, parseAssistantJson } from './issueAssistant'`. (`suggestStage` is referenced by the prompt's deterministic backbone in `buildAssistantMessages` context; keep the import available for a future server-side fallback — if unused, omit to satisfy lint.)

- [ ] **Step 4: Hook session activity in `relay.ts`.** Where `sessionAgentStateChanged` is broadcast and where a session exits, add:

```ts
this.issues.onSessionActivity(sessionId)
```

- [ ] **Step 5: Run tests + typecheck.**

Run: `bunx vitest run apps/server/src/issues.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/server/src/issues.ts apps/server/src/relay.ts
git commit -m "feat(issues): assistant scheduling + apply/dismiss/refresh suggestions"
```

---

### Task 11: tRPC `issues.*` namespace

**Files:**
- Modify: `apps/server/src/router.ts`
- Test: `apps/server/src/router-issues.test.ts` (new; uses `appRouter.createCaller`)

**Interfaces:**
- Consumes: `ctx.registry.issues` (the `IssueService`).
- Produces tRPC procedures under `issues`:
  - `list({ repoPath? }) → IssueWire[]`
  - `get({ id }) → IssueWire | null`
  - `create({ repoPath, title, description?, parentBranch?, defaultAgent?, startNow, linear? }) → IssueWire` (calls `createAndMaybeStart`)
  - `start({ id }) → IssueWire`
  - `update({ id, patch }) → IssueWire`
  - `archive({ id }) → IssueWire`
  - `action({ id, kind }) → { ok, output, issue }`
  - `addSession({ id, agentKind? }) → IssueWire`
  - `addShell({ id }) → IssueWire`
  - `applySuggestion({ id }) → IssueWire`
  - `dismissSuggestion({ id }) → IssueWire`
  - `refreshAssistant({ id }) → IssueWire`
  - `linearSearch({ query }) → LinearIssue[]`

- [ ] **Step 1: Write failing test.** Create `apps/server/src/router-issues.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { SessionRegistry } from './relay'

function caller() {
  const registry = new SessionRegistry() // in-memory store
  return appRouter.createCaller({ registry, repos: {} as never, superagent: {} as never })
}

describe('issues router', () => {
  it('creates and lists', async () => {
    const c = caller()
    const created = await c.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    expect(created.seq).toBe(1)
    const list = await c.issues.list({ repoPath: '/r' })
    expect(list.length).toBe(1)
  })

  it('updates stage', async () => {
    const c = caller()
    const created = await c.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    const moved = await c.issues.update({ id: created.id, patch: { stage: 'in_progress' } })
    expect(moved.stage).toBe('in_progress')
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/server/src/router-issues.test.ts`
Expected: FAIL (`issues` router undefined).

- [ ] **Step 3: Implement.** In `router.ts`, add an `issues` router to `appRouter` (import `IssueStage`, `z`):

```ts
issues: t.router({
  list: t.procedure.input(z.object({ repoPath: z.string().optional() })).query(({ ctx, input }) => ctx.registry.issues.list(input.repoPath)),
  get: t.procedure.input(z.object({ id: z.string() })).query(({ ctx, input }) => ctx.registry.issues.get(input.id)),
  create: t.procedure
    .input(z.object({
      repoPath: z.string(),
      title: z.string().min(1),
      description: z.string().optional(),
      parentBranch: z.string().optional(),
      defaultAgent: z.string().optional(),
      startNow: z.boolean(),
      linear: z.object({ id: z.string().optional(), identifier: z.string(), url: z.string() }).optional(),
    }))
    .mutation(({ ctx, input }) => ctx.registry.issues.createAndMaybeStart(input)),
  start: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.registry.issues.start(input.id)),
  update: t.procedure
    .input(z.object({
      id: z.string(),
      patch: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        stage: IssueStage.optional(),
        parentBranch: z.string().optional(),
        defaultAgent: z.string().optional(),
        archived: z.boolean().optional(),
      }),
    }))
    .mutation(({ ctx, input }) => ctx.registry.issues.update(input.id, input.patch)),
  archive: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.registry.issues.archive(input.id)),
  action: t.procedure.input(z.object({ id: z.string(), kind: z.enum(['rebase', 'pr', 'merge']) })).mutation(({ ctx, input }) => ctx.registry.issues.action(input.id, input.kind)),
  addSession: t.procedure.input(z.object({ id: z.string(), agentKind: z.string().optional() })).mutation(({ ctx, input }) => ctx.registry.issues.addSession(input.id, input.agentKind)),
  addShell: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.registry.issues.addShell(input.id)),
  applySuggestion: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.registry.issues.applySuggestion(input.id)),
  dismissSuggestion: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.registry.issues.dismissSuggestion(input.id)),
  refreshAssistant: t.procedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ctx.registry.issues.refreshAssistant(input.id)),
  linearSearch: t.procedure.input(z.object({ query: z.string() })).query(({ ctx, input }) => ctx.registry.issues.linearSearch(input.query)),
}),
```

If `appRouter` isn't exported, export it (the web client already imports its type — confirm with `grep -n "appRouter\|AppRouter" apps/server/src/router.ts`).

- [ ] **Step 4: Run tests + typecheck.**

Run: `bunx vitest run apps/server/src/router-issues.test.ts && bun run --filter @podium/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/server/src/router.ts apps/server/src/router-issues.test.ts
git commit -m "feat(issues): tRPC issues.* namespace"
```

---

### Task 12: Web data layer — hub `onIssues` + store state

**Files:**
- Modify: the SocketHub source (where `onSessions` is defined — find via `grep -rn "onSessions" apps/web/src`).
- Modify: `apps/web/src/store.tsx` — `MainView` adds `'issues'`; add `issues` state + `onIssues`/`onIssueUpdated` subscription.
- Test: `apps/web/src/issue-card.test.ts` (a pure card-model helper, see below) + a hub-dispatch unit test if the hub has one.

**Interfaces:**
- Produces:
  - `hub.onIssues(cb: (issues: IssueWire[]) => void): () => void`
  - `hub.onIssueUpdated(cb: (issue: IssueWire) => void): () => void`
  - store: `issues: IssueWire[]`, `setIssues`, and an `issuesByRepo`/selector if convenient.
  - `issueCardModel(issue: IssueWire): { title: string; subtitle: string; phaseBadges: { label: string; tone: string }[]; hasSuggestion: boolean }` in `apps/web/src/issue-card.ts` (pure, reuses `agentBadge` from `derive.ts`).

- [ ] **Step 1: Write the failing pure-helper test.** Create `apps/web/src/issue-card.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { IssueWire } from '@podium/protocol'
import { issueCardModel } from './issue-card'

const issue = (over: Partial<IssueWire> = {}): IssueWire =>
  ({ id: 'i', repoPath: '/r', seq: 4, title: 'Fix login', description: '', stage: 'in_progress',
     worktreePath: '/r/wt', branch: 'issue/4-fix-login', parentBranch: 'main', defaultAgent: 'claude-code',
     blockedBy: [], createdAt: 't', updatedAt: 't', archived: false,
     sessions: [], sessionSummary: { total: 2, byPhase: { working: 1, idle: 1 } }, ...over }) as IssueWire

describe('issueCardModel', () => {
  it('shows seq + repo basename subtitle and session count', () => {
    const m = issueCardModel(issue())
    expect(m.title).toBe('Fix login')
    expect(m.subtitle).toContain('#4')
    expect(m.subtitle).toContain('2 sessions')
  })
  it('flags a pending suggestion', () => {
    expect(issueCardModel(issue({ suggestedStage: 'review' })).hasSuggestion).toBe(true)
    expect(issueCardModel(issue()).hasSuggestion).toBe(false)
  })
})
```

- [ ] **Step 2: Run to confirm failure.**

Run: `bunx vitest run apps/web/src/issue-card.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `apps/web/src/issue-card.ts`:**

```ts
import type { IssueWire } from '@podium/protocol'

export function issueCardModel(issue: IssueWire): {
  title: string
  subtitle: string
  phaseBadges: { label: string; tone: string }[]
  hasSuggestion: boolean
} {
  const repo = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
  const count = issue.sessionSummary.total
  const subtitle = `#${issue.seq} · ${repo} · ${count} session${count === 1 ? '' : 's'}`
  const phaseBadges = Object.entries(issue.sessionSummary.byPhase).map(([phase, n]) => ({ label: `${n} ${phase}`, tone: phase }))
  return { title: issue.title, subtitle, phaseBadges, hasSuggestion: Boolean(issue.suggestedStage) }
}
```

- [ ] **Step 4: Run the test.**

Run: `bunx vitest run apps/web/src/issue-card.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire hub + store.** In the SocketHub source, mirror `onSessions`: add registries for `issuesChanged` → `onIssues` and `issueUpdated` → `onIssueUpdated`, dispatching in the message switch. In `store.tsx`: extend `MainView` to `... | 'issues'`; add `const [issues, setIssues] = useState<IssueWire[]>([])`; in the subscription `useEffect`, add `const offIssues = hub.onIssues(setIssues)` and `const offIssueUpd = hub.onIssueUpdated((u) => setIssues((xs) => xs.map((i) => (i.id === u.id ? u : i))))`; return both in cleanup; expose `issues` + `setView` through the store context value.

- [ ] **Step 6: Typecheck.**

Run: `bun run --filter @podium/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/issue-card.ts apps/web/src/issue-card.test.ts apps/web/src/store.tsx apps/web/src/*.ts*
git commit -m "feat(issues): web hub onIssues + store state + card model"
```

---

### Task 13: Web — Issues board view + nav entry

**Files:**
- Create: `apps/web/src/IssuesView.tsx` (board: stage columns + cards)
- Modify: `apps/web/src/AppShell.tsx` (desktop switch) + the mobile app nav (mirror existing home/settings entries) to render `<IssuesView/>` for `view === 'issues'`.
- Modify: `apps/web/src/Sidebar.tsx` (or wherever the home/settings nav buttons live) — add an "Issues" nav button calling `setView('issues')`.

**Interfaces:**
- Consumes: `useStore()` → `issues`, `setView`, `trpc`; `issueCardModel` (Task 12); `agentBadge` tones; `ISSUE_STAGES` for column order.
- Produces: `IssuesView` component; reachable via `view === 'issues'`.

- [ ] **Step 1: Implement `IssuesView.tsx`** (board with a column per stage; cards open the detail panel from Task 14 via local state):

```tsx
import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { useState } from 'react'
import { issueCardModel } from './issue-card'
import { useStore } from './store'
import { trpc } from './trpc' // adjust import to the project's trpc client location
import { NewIssueDialog } from './NewIssueDialog'
import { IssueDetail } from './IssueDetail'

const STAGE_LABELS: Record<IssueStage, string> = {
  backlog: 'Backlog', planning: 'Planning', in_progress: 'In Progress',
  review: 'Review', verifying: 'Verifying', done: 'Done',
}

export function IssuesView(): JSX.Element {
  const { issues } = useStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const active = issues.filter((i) => !i.archived)
  const open = openId ? issues.find((i) => i.id === openId) ?? null : null

  return (
    <div className="issues-view">
      <header className="issues-view__header">
        <h1>Issues</h1>
        <button type="button" onClick={() => setCreating(true)}>New Issue</button>
      </header>
      <div className="issues-board">
        {ISSUE_STAGES.map((stage) => (
          <IssueColumn key={stage} label={STAGE_LABELS[stage]} issues={active.filter((i) => i.stage === stage)} onOpen={setOpenId} />
        ))}
      </div>
      {creating && <NewIssueDialog onClose={() => setCreating(false)} />}
      {open && <IssueDetail issue={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function IssueColumn({ label, issues, onOpen }: { label: string; issues: IssueWire[]; onOpen: (id: string) => void }): JSX.Element {
  return (
    <section className="issues-column">
      <h2>{label} <span className="issues-column__count">{issues.length}</span></h2>
      {issues.map((issue) => {
        const m = issueCardModel(issue)
        return (
          <button type="button" key={issue.id} className="issue-card" onClick={() => onOpen(issue.id)}>
            <div className="issue-card__title">{m.title}</div>
            <div className="issue-card__subtitle">{m.subtitle}</div>
            <div className="issue-card__badges">
              {m.phaseBadges.map((b) => (<span key={b.label} className={`badge tone-${b.tone}`}>{b.label}</span>))}
              {issue.linearIdentifier && <span className="badge tone-linear">{issue.linearIdentifier}</span>}
            </div>
            {m.hasSuggestion && <div className="issue-card__suggestion">Suggested: move to {issue.suggestedStage}</div>}
            {issue.activityNotes && <div className="issue-card__notes">{issue.activityNotes}</div>}
          </button>
        )
      })}
    </section>
  )
}
```

(Use the project's existing shadcn `Button`/`Card`/`Badge` primitives instead of raw elements where they exist — match `HomeView.tsx`. Confirm the trpc client import path with `grep -rn "trpc" apps/web/src/SettingsView.tsx`.)

- [ ] **Step 2: Add the desktop switch case** in `AppShell.tsx`:

```tsx
) : view === 'issues' ? (
  <IssuesView />
```

and `import { IssuesView } from './IssuesView'`. Add the same for the mobile app's view switch (mirror its `home`/`settings` entries).

- [ ] **Step 3: Add a nav button** wherever `setView('home')`/`setView('settings')` buttons are rendered (Sidebar): an "Issues" button calling `setView('issues')`.

- [ ] **Step 4: Typecheck + build.**

Run: `bun run --filter @podium/web typecheck && bun run --filter @podium/web build`
Expected: PASS (build emits the PWA bundle).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/IssuesView.tsx apps/web/src/AppShell.tsx apps/web/src/Sidebar.tsx apps/web/src/MobileApp.tsx
git commit -m "feat(issues): Issues board view + nav entry"
```

---

### Task 14: Web — New Issue dialog + Issue detail panel

**Files:**
- Create: `apps/web/src/NewIssueDialog.tsx`
- Create: `apps/web/src/IssueDetail.tsx`

**Interfaces:**
- Consumes: `trpc.issues.create/start/update/action/addSession/addShell/applySuggestion/dismissSuggestion/refreshAssistant/linearSearch`, `useStore()` (repos list, settings for `mergeStyle`, `setView`/session open), `ISSUE_STAGES`.
- Produces: the two components used by `IssuesView`.

- [ ] **Step 1: Implement `NewIssueDialog.tsx`** (title, description or Linear import, repo, parent branch, agent, Start-now toggle):

```tsx
import { useState } from 'react'
import type { LinearIssue } from '@podium/protocol' // if not exported, type inline { identifier; title; url }
import { useStore } from './store'
import { trpc } from './trpc'

export function NewIssueDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { repos } = useStore()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [repoPath, setRepoPath] = useState(repos[0]?.path ?? '')
  const [parentBranch, setParentBranch] = useState('')
  const [agent, setAgent] = useState('') // '' = use default
  const [startNow, setStartNow] = useState(true)
  const [linear, setLinear] = useState<{ identifier: string; url: string } | undefined>()
  const [results, setResults] = useState<LinearIssue[]>([])
  const [busy, setBusy] = useState(false)

  const searchLinear = async (q: string) => setResults(await trpc.issues.linearSearch.query({ query: q }))
  const submit = async () => {
    setBusy(true)
    try {
      await trpc.issues.create.mutate({
        repoPath, title, description: description || undefined,
        parentBranch: parentBranch || undefined, defaultAgent: agent || undefined,
        startNow, linear,
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New Issue</h2>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <details>
          <summary>Import from Linear</summary>
          <input placeholder="search…" onChange={(e) => searchLinear(e.target.value)} />
          {results.map((r) => (
            <button type="button" key={r.identifier} onClick={() => { setTitle(r.title); setLinear({ identifier: r.identifier, url: r.url }); setDescription(`From ${r.identifier}: ${r.url}`) }}>
              {r.identifier} {r.title}
            </button>
          ))}
        </details>
        <label>Repo
          <select value={repoPath} onChange={(e) => setRepoPath(e.target.value)}>
            {repos.map((r) => (<option key={r.path} value={r.path}>{r.path}</option>))}
          </select>
        </label>
        <label>Parent branch<input value={parentBranch} placeholder="main" onChange={(e) => setParentBranch(e.target.value)} /></label>
        <label>Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Default</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="grok">Grok</option>
          </select>
        </label>
        <label><input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> Start work now</label>
        <div className="dialog__actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!title || !repoPath || busy} onClick={submit}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Implement `IssueDetail.tsx`** (description, AI notes, dependency note, members + add buttons, stage selector, quick actions per `mergeStyle`, start, suggestion approve/dismiss):

```tsx
import { ISSUE_STAGES, type IssueWire } from '@podium/protocol'
import { useState } from 'react'
import { useStore } from './store'
import { trpc } from './trpc'

export function IssueDetail({ issue, onClose }: { issue: IssueWire; onClose: () => void }): JSX.Element {
  const { settings, setView } = useStore()
  const mergeStyle = settings?.gitWorkflow.mergeStyle ?? 'ff-only'
  const [toast, setToast] = useState('')
  const run = async (fn: () => Promise<unknown>) => { try { await fn() } catch (e) { setToast(e instanceof Error ? e.message : String(e)) } }
  const action = (kind: 'rebase' | 'pr' | 'merge') => run(async () => {
    const r = await trpc.issues.action.mutate({ id: issue.id, kind })
    setToast(r.ok ? `${kind} ok` : `${kind} failed: ${r.output}`)
  })

  return (
    <div className="drawer">
      <header><h2>#{issue.seq} {issue.title}</h2><button type="button" onClick={onClose}>×</button></header>

      {issue.suggestedStage && (
        <div className="suggestion-banner">
          Move to <b>{issue.suggestedStage}</b>? {issue.suggestedReason}
          <button type="button" onClick={() => run(() => trpc.issues.applySuggestion.mutate({ id: issue.id }))}>Approve</button>
          <button type="button" onClick={() => run(() => trpc.issues.dismissSuggestion.mutate({ id: issue.id }))}>Dismiss</button>
        </div>
      )}

      <label>Stage
        <select value={issue.stage} onChange={(e) => run(() => trpc.issues.update.mutate({ id: issue.id, patch: { stage: e.target.value as IssueWire['stage'] } }))}>
          {ISSUE_STAGES.map((s) => (<option key={s} value={s}>{s}</option>))}
        </select>
      </label>

      <section><h3>Description</h3><p>{issue.description || '—'}</p></section>
      {issue.activityNotes && <section><h3>Activity notes</h3><p>{issue.activityNotes}</p>
        <button type="button" onClick={() => run(() => trpc.issues.refreshAssistant.mutate({ id: issue.id }))}>Refresh</button></section>}
      {issue.dependencyNote && <section className="dependency"><h3>Dependencies</h3><p>{issue.dependencyNote}</p></section>}

      <section>
        <h3>Sessions ({issue.sessionSummary.total})</h3>
        {issue.sessions.map((s) => (
          <button type="button" key={s.sessionId} onClick={() => setView('workspace') /* + select session via store */}>{s.name ?? s.title}</button>
        ))}
        {issue.worktreePath ? (
          <>
            <button type="button" onClick={() => run(() => trpc.issues.addSession.mutate({ id: issue.id }))}>+ Session</button>
            <button type="button" onClick={() => run(() => trpc.issues.addShell.mutate({ id: issue.id }))}>+ Shell</button>
          </>
        ) : (
          <button type="button" onClick={() => run(() => trpc.issues.start.mutate({ id: issue.id }))}>Start work</button>
        )}
      </section>

      {issue.worktreePath && (
        <section className="actions">
          <h3>Actions</h3>
          {/* primary first, by mergeStyle */}
          {mergeStyle === 'pr'
            ? <button type="button" onClick={() => action('pr')}>Open PR</button>
            : <button type="button" onClick={() => action('merge')}>FF-only merge</button>}
          <button type="button" onClick={() => action('rebase')}>Rebase on {issue.parentBranch}</button>
          {mergeStyle !== 'pr' && <button type="button" onClick={() => action('pr')}>Open PR</button>}
          {mergeStyle === 'pr' && <button type="button" onClick={() => action('merge')}>FF-only merge</button>}
          {issue.prUrl && <a href={issue.prUrl} target="_blank" rel="noreferrer">PR ↗</a>}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
```

(Match existing component primitives + the way `HomeView` opens a session in the workspace — wire the member-session button to the store's existing "select session" action.)

- [ ] **Step 3: Typecheck + build.**

Run: `bun run --filter @podium/web typecheck && bun run --filter @podium/web build`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/web/src/NewIssueDialog.tsx apps/web/src/IssueDetail.tsx
git commit -m "feat(issues): new-issue dialog + issue detail panel"
```

---

### Task 15: Web — Settings "Workflow" tab

**Files:**
- Modify: `apps/web/src/SettingsView.tsx`

**Interfaces:**
- Consumes: the loaded `settings.gitWorkflow` + `settings.issues`; the existing `setSettings`/`save` pattern.

- [ ] **Step 1: Add the tab id + entry.** Extend `SettingsTab` with `'workflow'` and add `{ key: 'workflow', label: 'Workflow' }` to `SETTINGS_TABS`.

- [ ] **Step 2: Render the section** (mirror an existing tab block; edits go through the same local-settings setter + `save`):

```tsx
{tab === 'workflow' && settings && (
  <Section title="Git workflow" hint="Defaults for issue worktrees and the quick-action buttons.">
    <label>Default parent branch
      <input value={settings.gitWorkflow.defaultParentBranch}
        onChange={(e) => setSettings({ ...settings, gitWorkflow: { ...settings.gitWorkflow, defaultParentBranch: e.target.value } })}
        placeholder="(auto-detect)" />
    </label>
    <label>Merge style
      <select value={settings.gitWorkflow.mergeStyle}
        onChange={(e) => setSettings({ ...settings, gitWorkflow: { ...settings.gitWorkflow, mergeStyle: e.target.value as 'ff-only' | 'pr' | 'ask' } })}>
        <option value="ff-only">FF-only merge</option>
        <option value="pr">Open PR</option>
        <option value="ask">Ask each time</option>
      </select>
    </label>
    <label><input type="checkbox" checked={settings.gitWorkflow.autoRebaseBeforeMerge}
      onChange={(e) => setSettings({ ...settings, gitWorkflow: { ...settings.gitWorkflow, autoRebaseBeforeMerge: e.target.checked } })} /> Rebase before merge</label>
    <label><input type="checkbox" checked={settings.issues.assistantEnabled}
      onChange={(e) => setSettings({ ...settings, issues: { ...settings.issues, assistantEnabled: e.target.checked } })} /> Issue AI assistant enabled</label>
  </Section>
)}
```

(Use the real `Section`/control components from the file for styling parity.)

- [ ] **Step 3: Typecheck + build.**

Run: `bun run --filter @podium/web typecheck && bun run --filter @podium/web build`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add apps/web/src/SettingsView.tsx
git commit -m "feat(issues): settings Workflow tab"
```

---

### Task 16: End-to-end verification (Playwright) + full suite

**Files:**
- Create: `e2e/issues.spec.ts` (follow the existing committed Playwright harness — see `podium-headless-browser-testing` patterns + existing specs in `e2e/`).

**Interfaces:**
- Consumes: the `?e2e=1` harness + `__podium` test API used by existing specs.

- [ ] **Step 1: Read an existing e2e spec** to copy the harness bootstrap (`grep -rln "__podium" e2e tests`), then write `e2e/issues.spec.ts` covering:
  1. open the Issues view via the nav button; assert 6 stage columns render;
  2. New Issue dialog → create with `startNow=false`; assert a card appears in **Backlog**;
  3. move stage via the detail panel's stage selector; assert the card moves columns;
  4. seed an issue with a `suggestedStage` (via `trpc.issues.update`/a test hook) and assert Approve moves it.

```ts
import { test, expect } from '@playwright/test'
// mirror the bootstrap (serve-harness relay + ?e2e=1) from the existing specs.

test('create an issue and move its stage', async ({ page }) => {
  await page.goto('/?e2e=1')
  await page.getByRole('button', { name: 'Issues' }).click()
  await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible()
  await page.getByRole('button', { name: 'New Issue' }).click()
  await page.getByLabel('Title').fill('E2E issue')
  await page.getByLabel('Start work now').uncheck()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('E2E issue')).toBeVisible()
})
```

- [ ] **Step 2: Run the e2e spec.**

Run: `npx playwright test e2e/issues.spec.ts`
Expected: PASS. (If the harness needs the dev server, follow the existing specs' webServer config.)

- [ ] **Step 3: Run the full unit suite — confirm no NEW failures beyond the known baseline.**

Run: `bun run test 2>&1 | tail -5`
Expected: the 23 known-baseline failures only shrink (the web `@`-alias ones are fixed by Task 1); zero failures in any `*issue*`/`store-issues`/`router-issues`/`repo-op`/`settings-issues` file.

- [ ] **Step 4: Commit.**

```bash
git add e2e/issues.spec.ts
git commit -m "test(issues): e2e board + create + stage move"
```

---

## Self-Review

**Spec coverage** (spec §→task):
- §3 Issue entity 1:1 worktree, derived membership → Tasks 2, 3, 6 ✓
- §4 data model (table, fields, schema v5) → Task 2 ✓
- §5 protocol (IssueWire, broadcasts, RepoOp) → Task 1 ✓
- §6 tRPC procedures → Task 11 ✓ (every listed procedure present)
- §7 create + start flow (Linear import, start-now, draft seed) → Tasks 6, 7, 8, 14 ✓
- §8 quick actions (rebase/PR/merge, mergeStyle primary) → Tasks 5, 8, 14 ✓
- §9 AI assistant (workLlm, debounced triggers, JSON output, suggest-only, dependency rating, deterministic backbone) → Tasks 9, 10 ✓
- §10 settings (gitWorkflow + issues + Workflow tab) → Tasks 4, 15 ✓
- §11 board + detail panel UI → Tasks 13, 14 ✓
- §12 IssueRegistry/IssueService wiring + broadcasts → Task 6, 10 ✓
- §13 testing (unit + integration + e2e + `@` alias fix) → Tasks 1–16, e2e Task 16 ✓
- §14 build order → tasks ordered to match ✓
- §15 out-of-scope items are not implemented ✓

**Placeholder scan:** no "TBD/TODO/handle edge cases"; each code-changing step shows code. Two intentional "match the existing primitive / read the existing file" notes (mobile nav, SocketHub, e2e bootstrap) point at concrete files with a concrete mirror instruction — acceptable for an existing-codebase plan, not placeholders. (Fixed a stray `why` token call-out in Task 15.)

**Type consistency:** `IssueWire`/`IssueRow` field names match across protocol (Task 1), store (Task 2), service (Tasks 6–10), router (Task 11), and web (Tasks 12–14). `RepoOp` values (`rebase`/`mergeFfOnly`/`prCreate`) match between protocol (Task 1), `repoOpCommand` (Task 5), and service calls (Task 8). `action` kinds (`rebase`/`pr`/`merge`) are consistent between service (Task 8), router (Task 11), and detail UI (Task 14). `createAndMaybeStart` is the single create-entry used by the router (Task 7 defines, Task 11 calls). Stage ids match the spec everywhere.

**Risks flagged for the implementer:**
- `relay.ts` is large; adding the `IssueService` wiring requires locating the existing `repoOp` round-trip + draft-write + client-attach points. Grep first; add thin public wrappers rather than duplicating logic.
- `ff-only merge` runs in the **repo root** (`repoOp('mergeFfOnly', repoPath, …)`), which must be on the parent branch; failures surface verbatim in the toast — that is intended, not a bug.
- The web pieces (Tasks 12–15) must use the project's real shadcn primitives + trpc client import path; the raw-element JSX shown is structurally correct but should adopt the existing components for styling parity.

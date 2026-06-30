# Tracker → beads Parity — P4b: Full interactive UI + delete + drag-and-drop + CLI ergonomics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tracker fully usable from the web UI and a clean CLI: hard-delete, drag-and-drop between kanban stages, in-drawer editing (priority/type/assignee/labels) + lifecycle/dep/comment actions, a board filter bar, full `podium issue` verb parity, and cwd→repo inference so the CLI stops needing `--repoPath`.

**Architecture:** Backend gains `issues.delete` (the store's `deleteIssue` already exists); the shared `ISSUE_COMMANDS` registry gains the missing verbs (so CLI *and* MCP both get them); the CLI resolves the repo from cwd via a new `repos.inferFromPath` query. The web extends the existing `IssuesView`/`IssueDetail` components — DnD via **native HTML5** (no new dependency), with pure helpers (drop→stage, board filter) unit-tested in vitest+happy-dom and the JSX/interaction build-verified (final visual/drag verification is manual, per the project's UI convention).

**Tech Stack:** TypeScript, React, Bun, tRPC, vitest + happy-dom, native HTML5 drag-and-drop.

## Global Constraints

- **No new runtime dependency** (DnD is native HTML5) — avoids the lockfile-changes-need-bun-install-on-deploy landmine.
- **Test pattern:** unit-test pure functions (registry, inference, drop→stage, board filter) in vitest; UI component wiring verified by `bun run typecheck` + `bun run --filter @podium/web build`; visual/drag correctness is manual.
- **Role tiers (P3b):** `delete` is **maintainer**; stage change via DnD / editors are **worker**; the web UI presents the maintainer token so all of this works in-browser.
- **Mutations already exist** (P1–P2): `issues.update` (`{id, patch}`), `setLabels`, `depAdd`/`depRemove`, `addComment`, `defer`, `supersede`, `duplicate`, `reparent`, `close`, `claim`, `archive`. P4b only adds `issues.delete` + UI/CLI surfaces for them.
- **Dense style; no broad biome reformat of pre-existing files.** Commits: conventional (`feat(web)`/`feat(tracker)`), one per task. Isolation: worktree only.

---

### Task 1: Backend `issues.delete` + full CLI/MCP verb parity

**Files:**
- Modify: `apps/server/src/issues.ts` — add `delete(id)`.
- Modify: `apps/server/src/router.ts` — add `issues.delete` (maintainer; `PROC_MIN_ROLE.delete='maintainer'` in `issue-roles.ts`).
- Modify: `apps/server/src/issue-roles.ts` — add `delete: 'maintainer'` (+ the new verbs' tiers).
- Modify: `apps/server/src/issue-commands.ts` — add the missing verbs.
- Test: `apps/server/src/issues.test.ts` (extend) + `apps/server/src/issue-commands.test.ts` (extend).

**Interfaces:**
- `IssueService.delete(id: string): void` — `rowOrThrow(id)`, `store.deleteIssue(id)` (which already cascades child rows), `this.rows.delete(id)`, broadcast `issuesChanged` (the removed issue drops off the list).
- New `ISSUE_COMMANDS` verbs: `delete`, `label` (set labels), `defer`/`undefer`, `supersede`, `duplicate`, `dep-remove`, `reparent`, `find-duplicates`, `graph`, `doctor`, `stale`, `orphans`, `lint`, `preflight`, `count`, `epic-status` — each a thin `run(client, args)` over the matching `issues.*` procedure.

- [ ] **Step 1: Write the failing tests**

In `issues.test.ts`:

```ts
describe('IssueService.delete (P4b)', () => {
  it('removes the issue from the list and broadcasts', () => {
    const { svc, store, deps } = harness()
    const a = svc.create({ repoPath: '/r', title: 'gone', startNow: false })
    svc.create({ repoPath: '/r', title: 'stays', startNow: false })
    ;(deps.broadcast as ReturnType<typeof vi.fn>).mockClear()
    svc.delete(a.id)
    expect(svc.get(a.id)).toBeNull()
    expect(svc.list('/r').map((w) => w.title)).toEqual(['stays'])
    expect(store.getIssue(a.id)).toBeNull()
    expect(deps.broadcast).toHaveBeenCalled()
  })
  it('throws on unknown id', () => {
    const { svc } = harness()
    expect(() => svc.delete('iss_missing')).toThrow()
  })
})
```

In `issue-commands.test.ts` add to the registry-shape test a check that the new verbs exist:

```ts
  it('includes the full verb set (P4b parity)', () => {
    const names = ISSUE_COMMANDS.map((c) => c.name)
    for (const v of ['delete', 'label', 'defer', 'undefer', 'supersede', 'duplicate', 'dep-remove', 'reparent', 'find-duplicates', 'graph', 'doctor', 'stale', 'orphans', 'lint', 'preflight', 'count', 'epic-status']) {
      expect(names, `missing verb ${v}`).toContain(v)
    }
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/src/issues.test.ts apps/server/src/issue-commands.test.ts`
Expected: FAIL — `svc.delete is not a function` / missing verbs.

- [ ] **Step 3: Implement**

In `issues.ts` (after `archive`):

```ts
  delete(id: string): void {
    this.rowOrThrow(id)
    this.deps.store.deleteIssue(id)
    this.rows.delete(id)
    this.deps.broadcast({ type: 'issuesChanged', issues: this.allWire() })
  }
```

In `issue-roles.ts` `PROC_MIN_ROLE`, add: `delete: 'maintainer'`, `setLabels: 'maintainer'` (already), `defer: 'worker'` (already), `undefer: 'worker'`, `supersede: 'maintainer'` (already), `duplicate: 'maintainer'` (already), `depRemove: 'maintainer'` (already), `reparent: 'maintainer'` (already). (Queries graph/doctor/stale/orphans/lint/preflight/count/epicStatus/findDuplicates stay reader by default.)

In `router.ts` `issues` router, add (using `issueProc`):

```ts
    delete: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.delete(input.id)),
```

(Confirm the read procedures graph/doctor/stale/orphans/lint/preflight/count/epicStatus/findDuplicates already exist on the router from P2 — they do; the CLI verbs below just call them.)

In `issue-commands.ts`, add the verbs (each follows the existing `IssueCommand` shape; full set, terse text output):

```ts
  {
    name: 'delete',
    summary: 'Delete an issue permanently (maintainer).',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      await c.issues.delete.mutate({ id: a.id as string })
      return `deleted ${a.id}`
    },
  },
  {
    name: 'label',
    summary: 'Set an issue\'s labels (replaces): --labels a,b,c.',
    args: z.object({ id: z.string(), labels: z.string() }),
    async run(c, a) {
      const labels = String(a.labels).split(',').map((s) => s.trim()).filter(Boolean)
      const w = (await c.issues.setLabels.mutate({ id: a.id as string, labels })) as { labels: string[] }
      return `labels: ${w.labels.join(', ') || '(none)'}`
    },
  },
  {
    name: 'defer',
    summary: 'Defer an issue until a date (--until 2026-07-01).',
    args: z.object({ id: z.string(), until: z.string() }),
    async run(c, a) {
      await c.issues.defer.mutate({ id: a.id as string, until: a.until as string })
      return `deferred ${a.id} until ${a.until}`
    },
  },
  {
    name: 'undefer',
    summary: 'Clear an issue\'s defer.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      await c.issues.defer.mutate({ id: a.id as string, until: null })
      return `undeferred ${a.id}`
    },
  },
  {
    name: 'supersede',
    summary: 'Supersede <old> with <new>: --oldId --newId.',
    args: z.object({ oldId: z.string(), newId: z.string() }),
    async run(c, a) {
      await c.issues.supersede.mutate({ oldId: a.oldId as string, newId: a.newId as string })
      return `${a.oldId} superseded by ${a.newId}`
    },
  },
  {
    name: 'duplicate',
    summary: 'Mark <id> a duplicate of <canonicalId>.',
    args: z.object({ id: z.string(), canonicalId: z.string() }),
    async run(c, a) {
      await c.issues.duplicate.mutate({ id: a.id as string, canonicalId: a.canonicalId as string })
      return `${a.id} marked duplicate of ${a.canonicalId}`
    },
  },
  {
    name: 'dep-remove',
    summary: 'Remove a dependency: --fromId --toId [--type].',
    args: z.object({ fromId: z.string(), toId: z.string(), type: z.string().optional() }),
    async run(c, a) {
      await c.issues.depRemove.mutate({ fromId: a.fromId as string, toId: a.toId as string, ...(a.type ? { type: a.type as string } : {}) })
      return `dep removed ${a.fromId} -> ${a.toId}`
    },
  },
  {
    name: 'reparent',
    summary: 'Set/clear an issue\'s parent: --id --parentId (omit parentId to clear).',
    args: z.object({ id: z.string(), parentId: z.string().optional() }),
    async run(c, a) {
      await c.issues.reparent.mutate({ id: a.id as string, parentId: (a.parentId as string) ?? null })
      return a.parentId ? `${a.id} parented to ${a.parentId}` : `${a.id} unparented`
    },
  },
  {
    name: 'find-duplicates',
    summary: 'Find likely duplicate issues (Jaccard) [--threshold].',
    args: z.object({ ...optRepo, threshold: z.coerce.number().optional() }),
    async run(c, a) {
      const ds = (await c.issues.findDuplicates.query(a as never)) as { a: string; b: string; score: number }[]
      return ds.length ? ds.map((d) => `${d.a} ~ ${d.b} (${d.score.toFixed(2)})`).join('\n') : '(no duplicates)'
    },
  },
  {
    name: 'graph',
    summary: 'Dependency graph (nodes + edges).',
    args: z.object(optRepo),
    async run(c, a) {
      const g = (await c.issues.graph.query(a as { repoPath?: string })) as { nodes: { seq: number; title: string }[]; edges: { from: string; to: string; type: string }[] }
      return `${g.nodes.length} nodes, ${g.edges.length} edges`
    },
  },
  {
    name: 'doctor',
    summary: 'Health check (cycles, dangling deps, lint/stale counts).',
    args: z.object(optRepo),
    async run(c, a) {
      const d = (await c.issues.doctor.query(a as { repoPath?: string })) as { cycles: string[][]; danglingDeps: unknown[]; lintCount: number; staleCount: number }
      return `cycles: ${d.cycles.length}, dangling: ${d.danglingDeps.length}, lint: ${d.lintCount}, stale: ${d.staleCount}`
    },
  },
  {
    name: 'preflight',
    summary: 'Pre-PR check (ok if no cycles/dangling deps).',
    args: z.object(optRepo),
    async run(c, a) {
      const p = (await c.issues.preflight.query(a as { repoPath?: string })) as { ok: boolean }
      return p.ok ? 'preflight: OK' : 'preflight: FAIL (run doctor)'
    },
  },
  {
    name: 'stale',
    summary: 'Issues with no activity in N days (--days 30).',
    args: z.object({ ...optRepo, days: z.coerce.number().optional() }),
    async run(c, a) {
      const rows = (await c.issues.stale.query(a as never)) as Array<Parameters<typeof line>[0]>
      return rows.length ? rows.map(line).join('\n') : '(none stale)'
    },
  },
  {
    name: 'orphans',
    summary: 'Open issues referenced in commits (implemented-but-open).',
    args: z.object(repoArg),
    async run(c, a) {
      const rows = (await c.issues.orphans.query({ repoPath: a.repoPath as string })) as { seq: number; title: string; ref: string }[]
      return rows.length ? rows.map((r) => `#${r.seq} ${r.title} (${r.ref})`).join('\n') : '(no orphans)'
    },
  },
  {
    name: 'lint',
    summary: 'Issues missing template sections.',
    args: z.object(optRepo),
    async run(c, a) {
      const rows = (await c.issues.lint.query(a as { repoPath?: string })) as { seq: number; findings: string[] }[]
      return rows.length ? rows.map((r) => `#${r.seq}: ${r.findings.join('; ')}`).join('\n') : '(lint clean)'
    },
  },
  {
    name: 'count',
    summary: 'Counts grouped by stage/priority/type/assignee.',
    args: z.object(optRepo),
    async run(c, a) {
      const ct = (await c.issues.count.query(a as { repoPath?: string })) as { byStage: Record<string, number>; byType: Record<string, number> }
      return `by stage: ${JSON.stringify(ct.byStage)}\nby type: ${JSON.stringify(ct.byType)}`
    },
  },
  {
    name: 'epic-status',
    summary: 'Epic completion: --id.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      const e = (await c.issues.epicStatus.query({ id: a.id as string })) as { childCount: number; childDoneCount: number; complete: boolean }
      return `${e.childDoneCount}/${e.childCount} done${e.complete ? ' (complete)' : ''}`
    },
  },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/issues.test.ts apps/server/src/issue-commands.test.ts apps/server/src/issue-roles-gate.test.ts` then `bun run typecheck`. `npx biome check apps/server/src/issue-commands.ts apps/server/src/issue-roles.ts` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issue-roles.ts apps/server/src/issue-commands.ts apps/server/src/issues.test.ts apps/server/src/issue-commands.test.ts
git commit -m "feat(tracker): issues.delete + full CLI/MCP verb parity"
```

---

### Task 2: CLI cwd→repo inference

**Files:**
- Modify: `apps/server/src/repo-registry.ts` — add `inferFromPath(cwd): string | undefined` (longest registered repo root that is a prefix of cwd).
- Modify: `apps/server/src/router.ts` — add `repos.inferFromPath` query.
- Modify: `apps/server/src/issue-commands.ts` — the commands' `run` accept a resolved `repoPath` (no change) — inference happens in the CLI layer.
- Modify: `scripts/issue-cli.ts` — when a command needs a repo and `--repoPath` is absent, call `repos.inferFromPath(process.cwd())`.
- Test: `apps/server/src/repo-registry.test.ts` (extend or create) + `scripts/issue-cli.test.ts` (extend).

**Interfaces:**
- `RepoRegistry.inferFromPath(path: string): string | undefined` — returns the longest registered repo root `r` such that `path === r || path.startsWith(r + '/')`, else undefined. (Pure over `list()`.)
- `repos.inferFromPath` tRPC query (input `{ path: string }`).
- In `issue-cli.ts`: `runIssueCli` (or `issueCliMain`) resolves the repo — if the parsed args lack `repoPath` and the command's schema has a `repoPath` field, fetch `repos.inferFromPath.query({ path: process.cwd() })` and inject it before running. (Make the resolution a small testable helper `resolveRepoArg(cmd, args, infer)`.)

- [ ] **Step 1: Write the failing test**

In `apps/server/src/repo-registry.test.ts` (mirror the existing repo-registry test harness; if none, create with a `:memory:` store + registry):

```ts
  it('inferFromPath returns the longest matching registered root', () => {
    // register /a and /a/b ; cwd inside /a/b/x resolves to /a/b
    repos.add('/a'); repos.add('/a/b')
    expect(repos.inferFromPath('/a/b/x/y')).toBe('/a/b')
    expect(repos.inferFromPath('/a/x')).toBe('/a')
    expect(repos.inferFromPath('/elsewhere')).toBeUndefined()
  })
```

In `scripts/issue-cli.test.ts`:

```ts
import { resolveRepoArg } from './issue-cli'
// … a command whose args include repoPath; infer fn returns '/inferred'
it('resolveRepoArg injects the inferred repo when --repoPath is absent', async () => {
  const args = await resolveRepoArg('ready', {}, async () => '/inferred')
  expect(args.repoPath).toBe('/inferred')
})
it('resolveRepoArg keeps an explicit --repoPath', async () => {
  const args = await resolveRepoArg('ready', { repoPath: '/explicit' }, async () => '/inferred')
  expect(args.repoPath).toBe('/explicit')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/src/repo-registry.test.ts scripts/issue-cli.test.ts`
Expected: FAIL — `inferFromPath`/`resolveRepoArg` not defined.

- [ ] **Step 3: Implement**

In `repo-registry.ts`:

```ts
  /** The longest registered repo root that contains `path` (cwd → repo inference). */
  inferFromPath(path: string, machineId?: string): string | undefined {
    return this.list(machineId)
      .filter((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`))
      .sort((a, b) => b.length - a.length)[0]
  }
```

In `router.ts` `repos` router:

```ts
    inferFromPath: t.procedure
      .input(z.object({ path: z.string() }))
      .query(({ ctx, input }) => ({ repoPath: ctx.repos.inferFromPath(input.path) ?? null })),
```

In `scripts/issue-cli.ts`, add the resolver + use it in `runIssueCli` (a command "needs a repo" if its zod `args` shape has a `repoPath` key):

```ts
export async function resolveRepoArg(
  command: string,
  args: Record<string, unknown>,
  infer: () => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
  const cmd = ISSUE_COMMANDS.find((c) => c.name === command)
  const wantsRepo = !!cmd && 'repoPath' in (((cmd.args as { shape?: Record<string, unknown> }).shape) ?? {})
  if (wantsRepo && args.repoPath == null) {
    const inferred = await infer()
    if (inferred) return { ...args, repoPath: inferred }
  }
  return args
}
```

In `runIssueCli`, before `cmd.args.safeParse(args)`, resolve the repo:

```ts
  const resolved = await resolveRepoArg(command, args, async () => {
    try {
      const r = (await client.repos.inferFromPath.query({ path: process.cwd() })) as { repoPath: string | null }
      return r.repoPath ?? undefined
    } catch {
      return undefined
    }
  })
  const parsed = cmd.args.safeParse(resolved)
```

(In tests that pass a mock client without `repos`, `resolveRepoArg` is exercised directly; `runIssueCli`'s infer-call is wrapped in try/catch so a missing `repos` on the mock degrades gracefully.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run apps/server/src/repo-registry.test.ts scripts/issue-cli.test.ts apps/server/src/issue-cli.e2e.test.ts` then `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repo-registry.ts apps/server/src/router.ts scripts/issue-cli.ts apps/server/src/repo-registry.test.ts scripts/issue-cli.test.ts
git commit -m "feat(tracker): CLI infers repo from cwd (no more --repoPath)"
```

---

### Task 3: Kanban drag-and-drop (stage change) + per-card delete

**Files:**
- Create: `apps/web/src/kanban-dnd.ts` — pure `dropTargetStage(stage)` validation helper.
- Modify: `apps/web/src/IssuesView.tsx` — make cards `draggable`; columns accept drops → `issues.update.mutate({ id, patch: { stage } })`; a delete affordance per card → confirm → `issues.delete.mutate`.
- Test: `apps/web/src/kanban-dnd.test.ts` (create).

**Interfaces:**
- `dropTargetStage(raw: string): IssueStage | null` — returns the stage if `raw` is a valid `ISSUE_STAGES` member, else null (guards a malformed drop). Pure.
- DnD: card `onDragStart` sets `e.dataTransfer.setData('text/issue-id', issue.id)`; column `onDragOver` `e.preventDefault()`; `onDrop` reads the id + the column's stage, calls `issues.update`. Optimistic: the store's `issueUpdated` broadcast reconciles; on mutation error show the existing error toast and the server state re-broadcasts.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/kanban-dnd.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { dropTargetStage } from './kanban-dnd'

describe('dropTargetStage', () => {
  it('accepts valid stages, rejects junk', () => {
    expect(dropTargetStage('in_progress')).toBe('in_progress')
    expect(dropTargetStage('done')).toBe('done')
    expect(dropTargetStage('nonsense')).toBeNull()
    expect(dropTargetStage('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/web/src/kanban-dnd.test.ts` → module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/kanban-dnd.ts`:

```ts
import { ISSUE_STAGES, type IssueStage } from '@podium/protocol'

const STAGES = new Set<string>(ISSUE_STAGES)
/** A drop target's stage, or null if the value isn't a real stage. */
export function dropTargetStage(raw: string): IssueStage | null {
  return STAGES.has(raw) ? (raw as IssueStage) : null
}
```

In `IssuesView.tsx`:
- On the card element, add `draggable` and `onDragStart={(e) => e.dataTransfer.setData('text/issue-id', issue.id)}`.
- On each `IssueColumn` container, add `onDragOver={(e) => e.preventDefault()}` and `onDrop={(e) => { const id = e.dataTransfer.getData('text/issue-id'); const s = dropTargetStage(stage); if (id && s) void trpc.issues.update.mutate({ id, patch: { stage: s } }) }}` (use the store's `trpc` as the existing card actions do). Add a subtle drop-highlight on `onDragEnter`/`onDragLeave` (CSS class toggle) — optional polish.
- Add a delete affordance: a small trash button on the card (or in its hover menu) → on click, confirm via the existing dialog/`window.confirm` (match the codebase's confirm pattern) → `void trpc.issues.delete.mutate({ id: issue.id })`. Stop propagation so it doesn't open the drawer.

(Match the existing `IssuesView.tsx` card markup + how it accesses `trpc` — read the file; the P4a badges were added to the same card.)

- [ ] **Step 4: typecheck + build**

Run: `npx vitest run apps/web/src/kanban-dnd.test.ts` then `bun run typecheck` and `bun run --filter @podium/web build`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/kanban-dnd.ts apps/web/src/kanban-dnd.test.ts apps/web/src/IssuesView.tsx
git commit -m "feat(web): kanban drag-and-drop stage change + per-card delete"
```

**Manual verification (you):** drag a card across columns → it lands and persists; trash → confirm → card disappears.

---

### Task 4: Board filter / search bar

**Files:**
- Create: `apps/web/src/issue-board-filter.ts` — pure `filterBoardIssues(issues, filter)`.
- Modify: `apps/web/src/IssuesView.tsx` — a filter bar above the columns; filtered issues feed the columns.
- Test: `apps/web/src/issue-board-filter.test.ts` (create).

**Interfaces:**
- `BoardFilter = { text?: string; priority?: number; type?: string; assignee?: string; label?: string; status?: 'open'|'closed'|'ready'|'blocked'|'deferred' }`.
- `filterBoardIssues(issues: IssueWire[], f: BoardFilter): IssueWire[]` — AND-composed; text over title/description; status derived from the wire flags (`ready`/`blocked`/`deferred`, closed = `stage==='done' || closedReason`). Pure.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { filterBoardIssues } from './issue-board-filter'
import { makeIssue } from './test-issue'

describe('filterBoardIssues', () => {
  const xs = [
    makeIssue({ id: 'a', title: 'Login bug', priority: 0, type: 'bug', labels: ['ui'] }),
    makeIssue({ id: 'b', title: 'Dark mode', priority: 2, type: 'feature', blocked: true, ready: false }),
  ]
  it('filters by text, priority, type, label, status', () => {
    expect(filterBoardIssues(xs, { text: 'login' }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(xs, { priority: 0 }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(xs, { type: 'feature' }).map((i) => i.id)).toEqual(['b'])
    expect(filterBoardIssues(xs, { label: 'ui' }).map((i) => i.id)).toEqual(['a'])
    expect(filterBoardIssues(xs, { status: 'blocked' }).map((i) => i.id)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/issue-board-filter.ts`:

```ts
import type { IssueWire } from '@podium/protocol'

export interface BoardFilter {
  text?: string
  priority?: number
  type?: string
  assignee?: string
  label?: string
  status?: 'open' | 'closed' | 'ready' | 'blocked' | 'deferred'
}

export function filterBoardIssues(issues: IssueWire[], f: BoardFilter): IssueWire[] {
  const text = f.text?.toLowerCase()
  return issues.filter((i) => {
    if (f.priority != null && i.priority !== f.priority) return false
    if (f.type && i.type !== f.type) return false
    if (f.assignee && i.assignee !== f.assignee) return false
    if (f.label && !i.labels.includes(f.label)) return false
    const closed = i.stage === 'done' || !!i.closedReason
    if (f.status === 'open' && closed) return false
    if (f.status === 'closed' && !closed) return false
    if (f.status === 'ready' && !i.ready) return false
    if (f.status === 'blocked' && !i.blocked) return false
    if (f.status === 'deferred' && !i.deferred) return false
    if (text && !`${i.title} ${i.description}`.toLowerCase().includes(text)) return false
    return true
  })
}
```

In `IssuesView.tsx`: hold a `BoardFilter` in component state; render a compact bar (text input + small selects for priority/type/status, and label/assignee if cheap) above the columns; apply `filterBoardIssues(allIssues, filter)` before splitting into columns. Match existing input/select styling (the New Issue dialog uses the same components).

- [ ] **Step 4: typecheck + build**

Run: `npx vitest run apps/web/src/issue-board-filter.test.ts` then `bun run typecheck` and `bun run --filter @podium/web build`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/issue-board-filter.ts apps/web/src/issue-board-filter.test.ts apps/web/src/IssuesView.tsx
git commit -m "feat(web): board filter/search bar"
```

---

### Task 5: Detail-drawer field editors (priority / type / assignee / labels)

**Files:**
- Modify: `apps/web/src/IssueDetail.tsx` — turn the P4a read-only meta section into editors.
- Test: covered by `issue-detail-fields` (unchanged) + typecheck/build (the editors are wiring).

**Interfaces:** the editors call existing procedures:
- priority → `trpc.issues.update.mutate({ id, patch: { priority } })` (select 0–4).
- type → `trpc.issues.update.mutate({ id, patch: { type } })` (select over the 9 `IssueType`s).
- assignee → `trpc.issues.update.mutate({ id, patch: { assignee } })` (text input, blur/enter to commit).
- labels → a chip editor: add via input → `trpc.issues.setLabels.mutate({ id, labels: [...current, new] })`; remove a chip → `setLabels` with it filtered out.

- [ ] **Step 1: Implement (no new unit test — it's component wiring over tested procedures)**

In `IssueDetail.tsx`, replace the P4a read-only meta row with editors:
- a priority `<Select>` (options `P0`..`P4`, value `issue.priority`) → on change, `update` with the numeric priority.
- a type `<Select>` (the 9 types) → `update`.
- an assignee `<Input>` (defaultValue `issue.assignee ?? ''`) committing on blur/Enter → `update`.
- a labels editor: render `issue.labels` as removable chips + an "add label" input; add/remove → `setLabels`.
Reuse the drawer's existing `<Select>`/`<Input>` components (the stage selector + New Issue dialog show the pattern). Keep the deps/comments/lifecycle sections from P4a (Task 6 makes those interactive).

- [ ] **Step 2: typecheck + build + lint**

Run: `bun run typecheck` and `bun run --filter @podium/web build`; `npx biome check apps/web/src/IssueDetail.tsx` (no NEW violations).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/IssueDetail.tsx
git commit -m "feat(web): edit priority/type/assignee/labels in the issue drawer"
```

**Manual verification (you):** change each field in the drawer → it persists (reopen / refresh) and the card badge updates.

---

### Task 6: Detail-drawer lifecycle + dependency + comment actions

**Files:**
- Modify: `apps/web/src/IssueDetail.tsx` — lifecycle buttons + dep add/remove + comment compose.
- Test: typecheck/build (wiring over tested procedures).

**Interfaces:** all over existing procedures:
- **Lifecycle:** Defer (date input → `issues.defer({id, until})`), Undefer (`defer({id, until:null})`), Close-with-reason (a small menu: done/wontfix → `issues.close({id, reason})`), Supersede (pick a target issue → `issues.supersede({oldId:id, newId})`), Duplicate (pick canonical → `issues.duplicate({id, canonicalId})`).
- **Deps:** a remove (×) on each dep row → `issues.depRemove({fromId:id, toId, type})`; an "add dependency" control (pick another issue in the repo + type) → `issues.depAdd({fromId:id, toId, type})`.
- **Comments:** a compose box under the comments thread → `issues.addComment({id, author, body})` (author = a sensible default, e.g. 'me' or the configured operator name) → the `issueUpdated` broadcast refreshes the thread.

- [ ] **Step 1: Implement** (component wiring over P1–P2 procedures; for "pick a target issue", reuse the issues already in the store — a `<Select>` of the repo's other issues by `#seq title`).

In `IssueDetail.tsx`, extend the P4a lifecycle/deps/comments sections with the controls above, calling the listed procedures via the store's `trpc`. Match the drawer's existing button/menu styling (the git-actions buttons + suggestion approve/dismiss show the pattern).

- [ ] **Step 2: typecheck + build + lint** — `bun run typecheck`; `bun run --filter @podium/web build`; biome on the file.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/IssueDetail.tsx
git commit -m "feat(web): lifecycle + dependency + comment actions in the issue drawer"
```

**Manual verification (you):** defer/close/supersede/duplicate; add+remove a dep (watch the blocked dot); post a comment.

---

## Phase Close (P4b)

- [ ] Tracker + web scope green: `npx vitest run apps/server/src/issues.test.ts apps/server/src/issue-commands.test.ts apps/server/src/issue-roles-gate.test.ts apps/server/src/repo-registry.test.ts scripts/issue-cli.test.ts apps/server/src/issue-cli.e2e.test.ts apps/web/src/kanban-dnd.test.ts apps/web/src/issue-board-filter.test.ts apps/web/src/issue-card.test.ts apps/web/src/issue-detail-fields.test.ts`
- [ ] `bun run typecheck` clean; `bun run --filter @podium/web build` OK; `biome check` clean on new files.
- [ ] **Build + install the `podium` binary** so the CLI is `podium issue …`: `bun scripts/build-bun.ts` (or the documented compile) → symlink `dist-bun/podium` onto PATH (e.g. `~/.local/bin/podium`). Verify `podium issue ready` works inside a registered repo (cwd-inferred, with `PODIUM_ISSUE_TOKEN` exported).
- [ ] Close `podium-hi7.4` (P4 fully done: P4a display + P4b interactive). Hardening (`podium-hi7.6`) remains.
- [ ] Hand off the **manual UI verification checklist** (drag-and-drop, delete, each editor, lifecycle/dep/comment actions, filter bar) for in-browser confirmation.

## Self-Review notes (author)

- **Coverage:** delete (Task 1) ✓; full CLI/MCP verb parity (Task 1) ✓; cwd→repo inference (Task 2) ✓; DnD stage change + delete (Task 3) ✓; board filter (Task 4) ✓; field editors (Task 5) ✓; lifecycle/dep/comment actions (Task 6) ✓; nicer CLI invocation via the compiled binary (Phase Close). All UI mutations reuse P1–P2 procedures; only `issues.delete` is new backend.
- **Placeholder scan:** pure helpers + the registry/backend have complete code; the React component edits are described as extensions of the existing `IssuesView`/`IssueDetail` markup with the EXACT procedure calls given (the established-codebase pattern) — implementers read the files and match the style.
- **Type-consistency:** new CLI verbs call the real `issues.*` procedures (cross-check names against the router as in P3a); `delete` is `PROC_MIN_ROLE.delete='maintainer'`; DnD/filter/editor helpers read existing `IssueWire` fields.
- **Risks:** (1) no new dependency (native DnD) — keeps the deploy clean. (2) The component edits are typecheck+build-verified ONLY; visual/drag correctness is the manual checklist — do NOT claim the UI is verified working from build alone. (3) The compiled-binary install is an ops convenience (Phase Close), not a code task.

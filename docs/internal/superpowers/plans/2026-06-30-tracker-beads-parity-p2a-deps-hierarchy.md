# Tracker → beads Parity — P2a: Hierarchy reconciliation + ready/blocked/graph + epic status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the issue **hierarchy** coherent (one edge-maintaining path for `parentId`, closing the P1 final-review finding I2 / `podium-hi7.5`), then expose **list-level** derivations agents and the UI need: `ready`, `blocked`, the dependency `graph`, and epic completion status.

**Architecture:** Builds directly on P1 (branch `worktree-tracker-beads-parity`, P1 closed at `672b55b`). P1 left per-issue `ready`/`blocked`/`deferred` + `childCount`/`childDoneCount` on the wire and a typed `issue_deps` graph in the store. P2a (1) routes every `parentId` change through one cycle-checked edge-maintaining helper so the `parent_id` column and the `parent-child` edge never diverge, then (2-4) adds server query procedures that compute ready/blocked lists, a graph projection, and epic status from the existing store + in-memory `rows` map. Still server-only; CLI/MCP/UI come in P3/P4.

**Tech Stack:** TypeScript, Bun, `node:sqlite` (`SessionStore`), zod (protocol), tRPC, vitest, biome.

## Global Constraints

- **Runtime/tests:** Bun; `npx vitest run <path>` from the worktree root; `:memory:` store via `new SessionStore(':memory:')`; the `issues.test.ts` `harness()` returns `{ store, deps, svc }` with `now: () => '<ISO date>'`.
- **Single source of truth for hierarchy:** the `parent-child` `issue_deps` edge is authoritative for cycle-detection and the `deps`/`dependents` wire arrays; the `parent_id` column is a denormalized mirror used for `childCount`/`childDoneCount`. They MUST stay in sync — every `parentId` change goes through ONE helper.
- **Only `blocks` deps gate `ready`/`blocked`** (unchanged from P1). `parent-child` never blocks.
- **`ready`** = open (stage≠done & no `closedReason`) & not deferred (`deferUntil` in future) & not blocked. **`blocked`** = open & ≥1 `blocks` dep on a non-closed target. These derivations already exist as `IssueService` private helpers `isClosed`/`isDeferred`/`computeBlocked` (issues.ts:50-68) and on the wire (`toWire`, issues.ts:70-114).
- **Additive protocol only** (server+web deploy together). New zod types/procedures; never break existing wire fields.
- **Commits:** conventional, one per task, scope `tracker`.
- **Isolation:** all work in worktree `worktree-tracker-beads-parity`; never edit the main checkout. Don't run the PTY/agent-spawning e2e suite.

---

### Task 1: Hierarchy reconciliation — one edge-maintaining `parentId` path (closes I2 / podium-hi7.5)

**Files:**
- Modify: `apps/server/src/issues.ts` — add `private setParent(...)`; route `reparent` (issues.ts:230-240), `create` (issues.ts:139-174), and `update` (issues.ts:~159) through it.
- Test: `apps/server/src/issues.test.ts` (extend).

**Problem (from P1 final review I2):** `reparent` maintains both the `parent_id` column and the `parent-child` edge, but `create({parentId})` and `update({parentId})` set only the column. So a child added via create/update is counted in `childCount` (column-read) but missing from the parent's `deps`/`dependents` arrays (edge-read), and bypasses cycle detection (edge-traversed).

**Interfaces:**
- Produces: `private setParent(row: IssueRow, newParentId: string | null): void` — removes the old `parent-child` edge, throws on a cycle (reusing `wouldCycle`), adds the new edge, and sets `row.parentId`. After this task, `create`, `update`, and `reparent` all maintain column+edge identically.
- Consumes: existing `wouldCycle` (issues.ts:194), store `addIssueDep`/`removeIssueDep`, `rowOrThrow`.

- [ ] **Step 1: Write the failing test**

Append to `issues.test.ts`:

```ts
describe('IssueService hierarchy reconciliation (P2a / I2)', () => {
  it('create({parentId}) maintains the parent-child edge AND childCount', () => {
    const { svc, store } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', startNow: false })
    const child = svc.create({ repoPath: '/r', title: 'C', parentId: epic.id, startNow: false })
    expect(store.listIssueDeps(child.id)).toEqual([{ toId: epic.id, type: 'parent-child' }])
    expect(svc.get(child.id)!.deps).toEqual([{ id: epic.id, type: 'parent-child' }])
    expect(svc.get(epic.id)!.dependents).toEqual([{ id: child.id, type: 'parent-child' }])
    expect(svc.get(epic.id)!.childCount).toBe(1)
  })

  it('update({parentId}) maintains the edge; changing parent moves the edge', () => {
    const { svc, store } = harness()
    const e1 = svc.create({ repoPath: '/r', title: 'E1', startNow: false })
    const e2 = svc.create({ repoPath: '/r', title: 'E2', startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    svc.update(c.id, { parentId: e1.id })
    expect(store.listIssueDeps(c.id)).toEqual([{ toId: e1.id, type: 'parent-child' }])
    svc.update(c.id, { parentId: e2.id })
    expect(store.listIssueDeps(c.id)).toEqual([{ toId: e2.id, type: 'parent-child' }])
    svc.update(c.id, { parentId: null })
    expect(store.listIssueDeps(c.id)).toEqual([])
  })

  it('a parentId change that forms a cycle is rejected via create or update', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', parentId: a.id, startNow: false })
    expect(() => svc.update(a.id, { parentId: b.id })).toThrow(/cycle/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `create`/`update` set only the column, so `store.listIssueDeps(child.id)` is `[]` and the cycle isn't detected.

- [ ] **Step 3: Implement `setParent` and route all three callers through it**

Add the helper to `IssueService` (next to `wouldCycle`/`reparent`):

```ts
  /** The single cycle-checked path that keeps the parent_id column and the
   *  parent-child edge in sync. Mutates row.parentId; caller persists. */
  private setParent(row: IssueRow, newParentId: string | null): void {
    if (newParentId === row.parentId) return
    if (row.parentId) this.deps.store.removeIssueDep(row.id, row.parentId, 'parent-child')
    if (newParentId) {
      this.rowOrThrow(newParentId)
      if (newParentId === row.id || this.wouldCycle(row.id, newParentId)) {
        throw new Error(`reparent ${row.id} -> ${newParentId} would create a cycle`)
      }
      this.deps.store.addIssueDep(row.id, newParentId, 'parent-child')
    }
    row.parentId = newParentId
  }
```

Rewrite `reparent` to use it:

```ts
  reparent(id: string, parentId: string | null): IssueWire {
    const row = this.rowOrThrow(id)
    this.setParent(row, parentId)
    return this.persist(row)
  }
```

In `update`, intercept `parentId` so the edge is maintained (it currently does a blanket `Object.assign(row, patch)`):

```ts
  update(id: string, patch: Partial<Pick<IssueRow, /* …unchanged Pick… */>>): IssueWire {
    const row = this.rows.get(id)
    if (!row) throw new Error(`unknown issue ${id}`)
    if ('parentId' in patch) {
      this.setParent(row, patch.parentId ?? null)
      const { parentId: _ignored, ...rest } = patch
      Object.assign(row, rest)
    } else {
      Object.assign(row, patch)
    }
    return this.persist(row)
  }
```

In `create`, replace the direct column set. The row isn't in `this.rows` until `persist`, and `setParent` needs the row registered for `wouldCycle`/`rowOrThrow`, so set the parent AFTER the base persist:

```ts
    // (existing) apply non-parent overrides before persist:
    if (input.priority != null) row.priority = input.priority
    if (input.type) row.type = input.type
    if (input.assignee) row.assignee = input.assignee
    // parentId now handled after persist via reparent (edge-maintaining):
    let wire = this.persist(row)
    if (input.parentId) wire = this.reparent(row.id, input.parentId)
    if (input.labels?.length) wire = this.setLabels(row.id, input.labels)
    return wire
```

(Remove the old `if (input.parentId) row.parentId = input.parentId` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts`
Expected: PASS (all, incl. the 3 new). The P1 derive test that did `svc.update(c1.id, { parentId: epic.id })` still passes (now it also writes the edge). Run `bun run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "fix(tracker): single edge-maintaining parentId path (column+edge in sync)"
```

Then close the tracking issue: `bd close podium-hi7.5 --reason="Reconciled: create/update/reparent all route parentId through setParent (cycle-checked, column+edge synced). Committed on worktree-tracker-beads-parity."` (run from the worktree; the `.beads` auto-export git-add warning is harmless.)

---

### Task 2: `ready` / `blocked` list endpoints

**Files:**
- Modify: `apps/server/src/issues.ts` — add `readyList`/`blockedList`.
- Modify: `apps/server/src/router.ts` — add `issues.ready`/`issues.blocked` queries.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces: `readyList(repoPath?: string): IssueWire[]` — issues whose derived `ready` is true, sorted by priority asc then seq asc. `blockedList(repoPath?: string): IssueWire[]` — issues whose derived `blocked` is true, with their blocker ids visible via the existing `deps`. Both reuse the per-issue derivation already in `toWire` (no new derivation logic).
- Consumes: `this.rows`, `toWire` (issues.ts:70), `isClosed`/`isDeferred`/`computeBlocked`.

- [ ] **Step 1: Write the failing test**

Append to `issues.test.ts`:

```ts
describe('IssueService ready/blocked lists (P2a)', () => {
  it('readyList returns only ready issues, priority then seq ordered', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', priority: 3, startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', priority: 0, startNow: false })
    const c = svc.create({ repoPath: '/r', title: 'C', startNow: false })
    store.addIssueDep(a.id, c.id, 'blocks') // a blocked by open c
    svc.update(c.id, {}) // no-op to ensure persisted
    const ready = svc.readyList('/r').map((w) => w.title)
    expect(ready).toEqual(['B', 'C']) // A is blocked; B(p0) before C(p2)
  })

  it('blockedList returns only blocked issues', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
    expect(svc.blockedList('/r').map((w) => w.title)).toEqual(['A'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.readyList is not a function`.

- [ ] **Step 3: Implement the lists + router procedures**

Add to `IssueService` (after `list`):

```ts
  readyList(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .map((r) => this.toWire(r))
      .filter((w) => w.ready)
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
  }

  blockedList(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => !repoPath || r.repoPath === repoPath)
      .map((r) => this.toWire(r))
      .filter((w) => w.blocked)
      .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.seq - b.seq))
  }
```

In `router.ts`, add to the `issues` router (after `list`):

```ts
    ready: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.readyList(input.repoPath)),
    blocked: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.blockedList(input.repoPath)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/issues.test.ts` then `bun run typecheck`.
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): ready/blocked list endpoints"
```

---

### Task 3: Dependency `graph` endpoint

**Files:**
- Modify: `packages/protocol/src/messages.ts` — add `IssueGraph` zod type.
- Modify: `apps/server/src/issues.ts` — add `graph(repoPath)`.
- Modify: `apps/server/src/router.ts` — add `issues.graph`.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces wire type `IssueGraph = { nodes: { id, seq, title, stage, priority, type, ready, blocked }[], edges: { from, to, type }[] }`. Service `graph(repoPath?: string): IssueGraph` builds nodes from `this.rows` (filtered by repo) and edges from `store.listIssueDeps(id)` for each node.
- Consumes: `store.listIssueDeps`, `toWire` (for `ready`/`blocked` per node).

- [ ] **Step 1: Write the failing test**

Append to `issues.test.ts`:

```ts
describe('IssueService graph (P2a)', () => {
  it('returns nodes for repo issues and edges from issue_deps', () => {
    const { svc, store } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const b = svc.create({ repoPath: '/r', title: 'B', startNow: false })
    svc.create({ repoPath: '/other', title: 'X', startNow: false })
    store.addIssueDep(a.id, b.id, 'blocks')
    const g = svc.graph('/r')
    expect(g.nodes.map((n) => n.title).sort()).toEqual(['A', 'B'])
    expect(g.edges).toEqual([{ from: a.id, to: b.id, type: 'blocks' }])
    expect(g.nodes.find((n) => n.title === 'A')!.blocked).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.graph is not a function`.

- [ ] **Step 3: Implement protocol type + service + router**

In `messages.ts` (near `IssueWire`):

```ts
export const IssueGraphNode = z.object({
  id: z.string(), seq: z.number().int(), title: z.string(), stage: IssueStage,
  priority: z.number().int(), type: IssueType, ready: z.boolean(), blocked: z.boolean(),
})
export const IssueGraphEdge = z.object({ from: z.string(), to: z.string(), type: z.string() })
export const IssueGraph = z.object({
  nodes: z.array(IssueGraphNode), edges: z.array(IssueGraphEdge),
})
export type IssueGraph = z.infer<typeof IssueGraph>
```

In `IssueService`:

```ts
  graph(repoPath?: string): IssueGraph {
    const rows = [...this.rows.values()].filter((r) => !repoPath || r.repoPath === repoPath)
    const nodes = rows.map((r) => {
      const w = this.toWire(r)
      return {
        id: r.id, seq: r.seq, title: r.title, stage: r.stage as IssueGraph['nodes'][number]['stage'],
        priority: r.priority, type: r.type as IssueGraph['nodes'][number]['type'],
        ready: w.ready, blocked: w.blocked,
      }
    })
    const edges = rows.flatMap((r) =>
      this.deps.store.listIssueDeps(r.id).map((d) => ({ from: r.id, to: d.toId, type: d.type })),
    )
    return { nodes, edges }
  }
```

Import `IssueGraph` type where needed (`issues.ts` already imports from `@podium/protocol`). In `router.ts` `issues` router:

```ts
    graph: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.graph(input.repoPath)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/issues.test.ts packages/protocol/src/issues.test.ts` then `bun run typecheck`.
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): dependency graph endpoint (nodes + edges)"
```

---

### Task 4: Epic status + close-eligible

**Files:**
- Modify: `packages/protocol/src/messages.ts` — add `EpicStatus` zod type.
- Modify: `apps/server/src/issues.ts` — add `epicStatus(id)` + `closeEligibleEpics(repoPath)`.
- Modify: `apps/server/src/router.ts` — add `issues.epicStatus` + `issues.closeEligibleEpics`.
- Test: `apps/server/src/issues.test.ts` (extend).

**Interfaces:**
- Produces wire type `EpicStatus = { id, childCount, childDoneCount, complete: boolean }`. `epicStatus(id): EpicStatus` (complete = childCount>0 && childDoneCount===childCount). `closeEligibleEpics(repoPath?): IssueWire[]` — open epics (`type==='epic'`, not closed) with ≥1 child and all children closed.
- Consumes: `this.rows`, `isClosed`.

- [ ] **Step 1: Write the failing test**

Append to `issues.test.ts`:

```ts
describe('IssueService epic status (P2a)', () => {
  it('epicStatus reports child completion; closeEligibleEpics lists fully-done epics', () => {
    const { svc } = harness()
    const epic = svc.create({ repoPath: '/r', title: 'E', type: 'epic', startNow: false })
    const c1 = svc.create({ repoPath: '/r', title: 'c1', parentId: epic.id, startNow: false })
    const c2 = svc.create({ repoPath: '/r', title: 'c2', parentId: epic.id, startNow: false })
    expect(svc.epicStatus(epic.id)).toEqual({ id: epic.id, childCount: 2, childDoneCount: 0, complete: false })
    expect(svc.closeEligibleEpics('/r')).toEqual([])
    svc.close(c1.id)
    svc.close(c2.id)
    expect(svc.epicStatus(epic.id)).toEqual({ id: epic.id, childCount: 2, childDoneCount: 2, complete: true })
    expect(svc.closeEligibleEpics('/r').map((w) => w.id)).toEqual([epic.id])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/issues.test.ts`
Expected: FAIL — `svc.epicStatus is not a function`.

- [ ] **Step 3: Implement protocol type + service + router**

In `messages.ts`:

```ts
export const EpicStatus = z.object({
  id: z.string(), childCount: z.number().int(), childDoneCount: z.number().int(), complete: z.boolean(),
})
export type EpicStatus = z.infer<typeof EpicStatus>
```

In `IssueService`:

```ts
  epicStatus(id: string): EpicStatus {
    const row = this.rowOrThrow(id)
    const children = [...this.rows.values()].filter((r) => r.parentId === row.id)
    const childDoneCount = children.filter((c) => this.isClosed(c)).length
    return {
      id: row.id, childCount: children.length, childDoneCount,
      complete: children.length > 0 && childDoneCount === children.length,
    }
  }

  closeEligibleEpics(repoPath?: string): IssueWire[] {
    return [...this.rows.values()]
      .filter((r) => (!repoPath || r.repoPath === repoPath) && r.type === 'epic' && !this.isClosed(r))
      .filter((r) => this.epicStatus(r.id).complete)
      .map((r) => this.toWire(r))
  }
```

In `router.ts` `issues` router:

```ts
    epicStatus: t.procedure
      .input(z.object({ id: z.string() }))
      .query(({ ctx, input }) => ctx.registry.issues.epicStatus(input.id)),
    closeEligibleEpics: t.procedure
      .input(z.object({ repoPath: z.string().optional() }))
      .query(({ ctx, input }) => ctx.registry.issues.closeEligibleEpics(input.repoPath)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/issues.test.ts packages/protocol/src/issues.test.ts` then `bun run typecheck`.
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issues.test.ts
git commit -m "feat(tracker): epic status + close-eligible endpoints"
```

---

## Phase Close (P2a)

- [ ] Full issue-tracker scope green: `npx vitest run apps/server/src/issues.test.ts apps/server/src/store.issues.test.ts apps/server/src/store-issues.test.ts apps/server/src/router.issues.test.ts packages/protocol/src/issues.test.ts apps/web/src/derive-issues.test.ts`
- [ ] `bun run typecheck` clean across all packages; `bun run lint` clean on changed files.
- [ ] `bd close podium-hi7.5` done (Task 1).
- [ ] Hand off to **P2b plan** (supersede/duplicate/find-duplicates/stale/orphans/lint/preflight + search/filter/count/stats/doctor), building on these endpoints.

## Self-Review notes (author)

- **Spec coverage (P2a slice):** I2 reconciliation (Task 1, closes podium-hi7.5) ✓; ready/blocked list endpoints (Task 2) ✓; dependency graph (Task 3) ✓; epic status + close-eligible (Task 4) ✓. Deferred to **P2b**: supersede/duplicate/find-duplicates, stale/orphans/lint/preflight, search/filter/count/stats/doctor. Deferred to P3: CLI/MCP/roles. P4: UI.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `setParent` is the sole writer of `parentId`+`parent-child` edge (Task 1); `readyList`/`blockedList`/`graph`/`epicStatus` reuse the P1 `toWire` derivation and `store.listIssueDeps`, so `ready`/`blocked`/`childCount` semantics are identical to P1. New protocol types (`IssueGraph`, `EpicStatus`) are additive.
- **Risk:** Task 1 changes the shared `update` path (parentId interception) — the P1 derive test that updates `parentId` must still pass (it now also writes the edge, which is the intended fix). Verified by re-running `issues.test.ts` in Task 1 Step 4.

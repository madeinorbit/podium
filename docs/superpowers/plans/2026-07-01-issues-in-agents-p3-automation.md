# Issues in Agents — P3: Hybrid Lifecycle Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the deterministic parts of the issue lifecycle so the board stays truthful without agent effort: when podium spawns an agent for an issue, auto-claim it (assignee = the agent, stage = in_progress); when an issue's worktree merges, auto-close it (stage = done). The judgment-based behaviors (file-discovered, checkpoint notes, close-on-non-merge) remain agent-driven via the P2 guidance — no code here.

**Architecture:** Both changes live in `IssueService` (`apps/server/src/issues.ts`) and reuse the existing `claim`/`close` helpers and the `persist` broadcast path, so the web UI updates live. `start(id)` gains the auto-claim; the `merge` branch of `action(id, kind)` gains the auto-close on success.

**Tech Stack:** TypeScript, Vitest, Bun. Single file (`apps/server/src/issues.ts`) + its test (`apps/server/src/issues.test.ts`).

## Global Constraints

- **Reuse existing helpers.** Auto-claim mirrors `claim(id, assignee)` (= `update(id, {assignee, stage:'in_progress'})`); auto-close mirrors `close(id, reason)` (= `update(id, {stage:'done', closedReason})`). Do not hand-roll parallel persistence — go through `update`/`persist` so `issueUpdated` + `issuesChanged` broadcast.
- **Assignee convention:** `agent:<defaultAgent>` (e.g. `agent:claude-code`), matching the existing test convention (`agent:claude`).
- **Auto-close only on a SUCCESSFUL merge** (`repoOp('mergeFfOnly', …)` returns `ok:true`). A failed/blocked merge must leave the stage unchanged.
- **TDD, DRY, YAGNI, frequent commits. Live-source safety:** work in worktree `issue/5-issues-in-agents`.

---

### Task 1: Auto-claim on `start`

**Files:**
- Modify: `apps/server/src/issues.ts` (`start`)
- Test: `apps/server/src/issues.test.ts`

**Interfaces:**
- Consumes: `row.defaultAgent`, `persistRow`. Produces: after `start(id)`, the issue has `assignee = 'agent:' + defaultAgent` and `stage = 'in_progress'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/issues.test.ts` (reuse the `harness()` / `started()` helpers already in the file):

```typescript
it('start auto-claims the issue (assignee = agent, stage = in_progress)', async () => {
  const { svc } = harness()
  const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
  const started = await svc.start(a.id)
  expect(started.assignee).toBe('agent:claude-code')
  expect(started.stage).toBe('in_progress')
})
```

(The default agent in the harness settings is `claude-code`, and `create` uses it as `defaultAgent`. If `create` in this harness yields a different `defaultAgent`, assert `agent:${that}` — the point is `assignee === 'agent:' + row.defaultAgent` and `stage === 'in_progress'`.)

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issues.test.ts -t "auto-claims"`
Expected: FAIL — `assignee` is null and `stage` is `'planning'`.

- [ ] **Step 3: Implement auto-claim in `start`**

In `apps/server/src/issues.ts` `start(id)`, replace the stage assignment and add the assignee so the row is claimed for the spawning agent before it's persisted:

```typescript
  row.branch = branch
  row.worktreePath = path
  row.stage = 'in_progress'
  row.assignee = `agent:${row.defaultAgent}`
  const wire = this.persistRow(row)
```

(Leave the rest of `start` — the `spawnSession(...)` call and `return wire` — unchanged.)

- [ ] **Step 4: Run to verify pass; regression**

Run: `bun run vitest run apps/server/src/issues.test.ts`
Expected: PASS. If a pre-existing `start`/`started()` test asserted `stage === 'planning'`, update it to `'in_progress'` (this is the intended behavior change: starting an issue = an agent is now working it). Report any such change.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "feat(issues): auto-claim on start (assignee = agent, stage = in_progress)"
```

---

### Task 2: Auto-close on successful merge

**Files:**
- Modify: `apps/server/src/issues.ts` (`action`, `merge` branch)
- Test: `apps/server/src/issues.test.ts`

**Interfaces:**
- Consumes: the `mergeFfOnly` `repoOp` result `{ ok }`, `this.close`. Produces: after `action(id, 'merge')` with `ok:true`, the returned issue has `stage = 'done'` and `closedReason = 'done'`; on `ok:false`, stage is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/issues.test.ts` (reuse `started()` + the `repoOp` mock pattern from the existing merge test):

```typescript
it('merge auto-closes the issue on success', async () => {
  const { svc, deps, id } = await started()
  ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => ({
    ok: true,
    output: op === 'status' ? '## main...origin/main' : '',
  }))
  const res = await svc.action(id, 'merge')
  expect(res.ok).toBe(true)
  expect(res.issue.stage).toBe('done')
  expect(res.issue.closedReason).toBe('done')
})

it('merge does NOT close the issue when the merge fails', async () => {
  const { svc, deps, id } = await started()
  ;(deps.repoOp as ReturnType<typeof vi.fn>).mockImplementation(async (op: string) => ({
    ok: op !== 'mergeFfOnly', // rebase/status ok, mergeFfOnly fails
    output: op === 'status' ? '## main...origin/main' : 'merge conflict',
  }))
  const res = await svc.action(id, 'merge')
  expect(res.ok).toBe(false)
  expect(res.issue.stage).not.toBe('done')
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issues.test.ts -t "auto-closes|does NOT close"`
Expected: FAIL — the success case leaves stage at `in_progress` (not `done`).

- [ ] **Step 3: Implement auto-close in the merge branch**

In `apps/server/src/issues.ts` `action(id, kind)`, change the final merge lines:

```typescript
  const r = await this.d.repoOp('mergeFfOnly', row.repoPath, { branch: row.branch })
  if (r.ok) {
    return { ...r, issue: this.close(id, 'done') }
  }
  return { ...r, issue: this.toWire(row) }
```

- [ ] **Step 4: Run to verify pass; regression**

Run: `bun run vitest run apps/server/src/issues.test.ts`
Expected: PASS, including the pre-existing `merge auto-rebases then ff-merges` test (it asserts the `repoOp` call sequence, which is unchanged — auto-close runs after, in-memory). Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/issues.test.ts
git commit -m "feat(issues): auto-close issue on successful ff-merge"
```

---

## Self-Review

**Spec coverage (P3 portion of the design §8):**
- Auto-claim on spawn (assignee + in_progress) → Task 1. ✓
- Auto-close on merge → Task 2. ✓
- Agent-driven behaviors (file-discovered, checkpoint, close-on-non-merge) → already delivered as guidance in P2 (`prime` + pointer + doc); no code here by design. ✓

**Placeholder scan:** none — both changes are concrete code with exact tests.

**Type consistency:** `assignee` is `string` (`agent:${row.defaultAgent}`); `close(id, 'done')` returns `IssueWire` matching `action`'s `{ok, output, issue}` return; the merge success/failure branches both return the same shape. Auto-claim reuses `persistRow` (broadcasts); auto-close reuses `close`→`update`→`persist` (broadcasts).

**Behavior-change note:** `start` now sets `stage='in_progress'` (was `'planning'`) and an assignee — Task 1 Step 4 explicitly updates any pre-existing test that asserted `'planning'`. This is the intended hybrid-automation behavior.

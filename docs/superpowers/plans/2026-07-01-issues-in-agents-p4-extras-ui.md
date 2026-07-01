# Issues in Agents — P4: Extras + Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the four v1 extras and surface them in the web UI. Two of the four already work end-to-end (dependency filing via `depAdd`; structured hand-back via `close --reason` + comments — both already rendered in the detail drawer). This phase adds the remaining pieces: expose `--parentId` on the CLI `create` (sub-issue decomposition), add a `needs_human` flag (+ optional question) end-to-end, and surface `needs_human` in the board card + detail drawer.

**Architecture:** `create` already accepts `parentId` in the service + tRPC proc (cycle-checked via `reparent`); only the CLI command omits it. `needs_human` follows the established additive-column pattern (`addIssueCol` + schema bump) → `IssueRow`/`mapIssueRow`/`upsertIssue` → `IssueWire`/`toWire` → `IssueService.setNeedsHuman`/`clearNeedsHuman` (mirroring `defer`/`close`) → tRPC procs + `PROC_ACTION` (`write`) + `SCOPED_TARGET` → CLI verbs → web UI. All mutations broadcast via the existing `persist` path.

**Tech Stack:** TypeScript, Zod, Vitest, Bun; React web (`apps/web`); Playwright e2e (`tests/e2e/browser`).

## Global Constraints

- **Additive migration only.** New columns via the `addIssueCol(name, ddl)` helper (ALTER TABLE ADD COLUMN with a default); bump `schema_version` 6 → 7. Never drop/rewrite. `needs_human INTEGER NOT NULL DEFAULT 0`, `human_question TEXT`.
- **New IssueWire fields are optional** (backward-compatible with older clients via the `...(x ? {x} : {})` toWire pattern and the lenient broadcast parse).
- **`needs_human` procs are `write`** (a worker may flag/clear its own issue) and MUST be added to `SCOPED_TARGET` (they target an existing issue id → scope-gated like `defer`/`close`).
- **Reuse `update`/`persist`** for the service mutations (broadcasts `issueUpdated` + `issuesChanged`). Don't hand-roll persistence.
- **UI is real-click-verified.** Per project convention, clickable UI needs runtime verification (Playwright harness `/?server=<RELAY>&e2e=1`, see `tests/e2e/browser/issues.browser.e2e.ts`). If the browser env is unavailable in this sandbox, ship the e2e test + unit tests and explicitly flag that a manual real-click run is required — do NOT claim UI-verified without evidence.
- **TDD, DRY, YAGNI, frequent commits. Live-source safety:** work in worktree `issue/5-issues-in-agents`.

---

### Task 1: CLI `create --parentId` (sub-issue decomposition)

**Files:**
- Modify: `apps/server/src/issue-commands.ts` (`create` command)
- Test: `apps/server/src/issue-commands.test.ts`

**Interfaces:**
- The `create` command's `args` gains `parentId: z.string().optional()`, passed through to `c.issues.create.mutate({ …, parentId })`. (Service + proc already accept `parentId`.)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/issue-commands.test.ts` (mirror the file's existing fake-client / `mockClient` pattern; assert the mutate payload carries `parentId`):

```typescript
it('create passes --parentId through to the mutation', async () => {
  const calls: unknown[] = []
  const fake = {
    issues: { create: { mutate: async (i: unknown) => { calls.push(i); return { seq: 2, title: 'child' } } } },
    repos: { inferFromPath: { query: async () => ({ repoPath: '/r' }) } },
  } as unknown as import('./issue-client').IssueTrpc
  const cmd = ISSUE_COMMANDS.find((c) => c.name === 'create')!
  await cmd.run(fake, { repoPath: '/r', title: 'child', parentId: 'iss_parent' })
  expect(calls[0]).toMatchObject({ parentId: 'iss_parent', title: 'child' })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issue-commands.test.ts -t "parentId"`
Expected: FAIL — `parentId` is stripped (not in the command's args schema, not passed to mutate).

- [ ] **Step 3: Implement**

In `apps/server/src/issue-commands.ts` `create` command, add to `args`:

```typescript
      parentId: z.string().optional(),
```

and in `run`, pass it through:

```typescript
      ...(a.parentId ? { parentId: a.parentId as string } : {}),
```

- [ ] **Step 4: Run to verify pass; commit**

Run: `bun run vitest run apps/server/src/issue-commands.test.ts`
Expected: PASS.

```bash
git add apps/server/src/issue-commands.ts apps/server/src/issue-commands.test.ts
git commit -m "feat(cli): create --parentId (sub-issue decomposition)"
```

---

### Task 2: `needs_human` data layer (migration + row + wire)

**Files:**
- Modify: `apps/server/src/store.ts`, `packages/protocol/src/messages.ts`, `apps/server/src/issues.ts` (`toWire`)
- Test: `apps/server/src/store.issues.test.ts` (or the store test file), `apps/server/src/issues.test.ts`

**Interfaces:**
- `IssueRow` gains `needsHuman: boolean` and `humanQuestion: string | null`.
- Store: two additive columns (`needs_human INTEGER NOT NULL DEFAULT 0`, `human_question TEXT`), mapped in `mapIssueRow`, written in `upsertIssue` (INSERT columns + values + ON CONFLICT SET), schema_version → 7.
- `IssueWire` gains `needsHuman: z.boolean()` and `humanQuestion: z.string().optional()`; `toWire` maps them.

- [ ] **Step 1: Write the failing tests**

Add a store round-trip test to the store test file (find the file that tests `upsertIssue`/`getIssue`, e.g. `apps/server/src/store.issues.test.ts`; mirror its setup):

```typescript
it('persists needsHuman + humanQuestion round-trip', () => {
  const store = new SessionStore(':memory:')
  const base = /* build a minimal IssueRow via the file's existing factory/helper */ makeRow({ id: 'iss_x', repoPath: '/r', seq: 1 })
  store.upsertIssue({ ...base, needsHuman: true, humanQuestion: 'which API key?' })
  const got = store.getIssue('iss_x')!
  expect(got.needsHuman).toBe(true)
  expect(got.humanQuestion).toBe('which API key?')
  // default when unset:
  store.upsertIssue({ ...base, id: 'iss_y', needsHuman: false, humanQuestion: null })
  const y = store.getIssue('iss_y')!
  expect(y.needsHuman).toBe(false)
  expect(y.humanQuestion).toBeNull()
})
```

(If the store test file builds rows via a helper, use it and add the two fields; if it constructs a full `IssueRow` inline, add `needsHuman: false, humanQuestion: null` to that literal so it compiles.)

Add a `toWire` test to `apps/server/src/issues.test.ts`:

```typescript
it('toWire surfaces needsHuman + humanQuestion', () => {
  const { svc } = harness()
  const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
  const wired = svc.setNeedsHuman(a.id, 'which key?') // implemented in Task 3; if not yet, assert via a direct row set
  expect(wired.needsHuman).toBe(true)
  expect(wired.humanQuestion).toBe('which key?')
})
```

NOTE: `setNeedsHuman` lands in Task 3. To keep Task 2 self-contained, in Task 2 assert the wire mapping by round-tripping through the store + `getIssue` + a fresh `IssueService` (or defer the `toWire` assertion to Task 3). Prefer: in Task 2, test the STORE round-trip (above) and add `needsHuman`/`humanQuestion` to `toWire`; assert `toWire` maps a row with `needsHuman:true` set directly. Use whichever the harness makes cleanest — the contract is: a row with needsHuman/humanQuestion set serializes them onto the wire.

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/store.issues.test.ts -t "needsHuman"`
Expected: FAIL — columns/fields don't exist (TS error or undefined).

- [ ] **Step 3: Implement the data layer**

In `apps/server/src/store.ts`:
- Add to `IssueRow`: `needsHuman: boolean` and `humanQuestion: string | null`.
- In the migration block, after the existing `addIssueCol(...)` calls, add:
  ```typescript
  addIssueCol('needs_human', 'needs_human INTEGER NOT NULL DEFAULT 0')
  addIssueCol('human_question', 'human_question TEXT')
  ```
- Bump the schema version marker: change the `< 6` guard and `'6'` value to `< 7` / `'7'`.
- In the `issues` CREATE TABLE literal, add `needs_human INTEGER NOT NULL DEFAULT 0,` and `human_question TEXT,` (so fresh DBs get them without relying only on ALTER).
- In `mapIssueRow`, add: `needsHuman: r.needs_human === 1,` and `humanQuestion: (r.human_question as string | null) ?? null,`.
- In `upsertIssue`: add `needs_human, human_question` to the INSERT column list, two `?` placeholders, `needs_human = excluded.needs_human, human_question = excluded.human_question` to the ON CONFLICT SET, and `row.needsHuman ? 1 : 0, row.humanQuestion` to the `.run(...)` args (in the matching positions).

In `packages/protocol/src/messages.ts` `IssueWire`, add:
```typescript
  needsHuman: z.boolean(),
  humanQuestion: z.string().optional(),
```

In `apps/server/src/issues.ts` `toWire`, add to the returned object:
```typescript
    needsHuman: row.needsHuman,
    ...(row.humanQuestion ? { humanQuestion: row.humanQuestion } : {}),
```
And ensure any place that constructs an `IssueRow` literal (e.g. `create`) initializes `needsHuman: false, humanQuestion: null`.

- [ ] **Step 4: Run to verify pass; regression**

Run: `bun run vitest run apps/server/src/store.issues.test.ts apps/server/src/issues.test.ts`
Expected: PASS. Then a broad regression: `bun run vitest run apps/server/src/issue-authz.test.ts apps/server/src/router.issues.test.ts apps/server/src/issue-commands.test.ts`. Typecheck clean (the new required `IssueWire.needsHuman`/`IssueRow.needsHuman` will surface any missed construction site — fix each: initialize `needsHuman:false`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts packages/protocol/src/messages.ts apps/server/src/issues.ts apps/server/src/store.issues.test.ts apps/server/src/issues.test.ts
git commit -m "feat(issues): needs_human + human_question data layer (additive migration + wire)"
```

---

### Task 3: `needs_human` service + procs + CLI

**Files:**
- Modify: `apps/server/src/issues.ts`, `apps/server/src/router.ts`, `apps/server/src/issue-authz.ts`, `apps/server/src/issue-commands.ts`
- Test: `apps/server/src/issues.test.ts`, `apps/server/src/router.issues.test.ts`, `apps/server/src/issue-commands.test.ts`

**Interfaces:**
- `IssueService.setNeedsHuman(id, question?: string | null): IssueWire` = `update(id, { needsHuman: true, humanQuestion: question ?? null })`; `clearNeedsHuman(id): IssueWire` = `update(id, { needsHuman: false, humanQuestion: null })`.
- tRPC: `issues.setNeedsHuman` (input `{ id, question? }`), `issues.clearNeedsHuman` (input `{ id }`).
- `PROC_ACTION`: `setNeedsHuman: 'write'`, `clearNeedsHuman: 'write'`. `SCOPED_TARGET`: both extract `i.id`.
- CLI: `needs-human --id [--question]`, `clear-needs-human --id`.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/issues.test.ts`:

```typescript
it('setNeedsHuman/clearNeedsHuman toggle the flag + question', () => {
  const { svc } = harness()
  const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
  const flagged = svc.setNeedsHuman(a.id, 'which key?')
  expect(flagged.needsHuman).toBe(true)
  expect(flagged.humanQuestion).toBe('which key?')
  const cleared = svc.clearNeedsHuman(a.id)
  expect(cleared.needsHuman).toBe(false)
  expect(cleared.humanQuestion).toBeUndefined()
})
```

`apps/server/src/router.issues.test.ts` (scope: a worker scoped to A may flag A; flagging B needs override) — reuse the existing scope-test setup:

```typescript
it('setNeedsHuman is scope-gated like other writes', async () => {
  const worker = { role: 'worker' as const, scope: { kind: 'subtree' as const, rootId: A.id } }
  const c = appRouter.createCaller({ registry, repos, superagent, capability: worker })
  await expect(c.issues.setNeedsHuman({ id: A.id, question: 'q' })).resolves.toBeTruthy()
  await expect(c.issues.setNeedsHuman({ id: B.id, question: 'q' })).rejects.toThrow(/outside your subtree/)
})
```

`apps/server/src/issue-commands.test.ts`: assert the `needs-human` command calls `issues.setNeedsHuman.mutate({id, question})` and `clear-needs-human` calls `clearNeedsHuman.mutate({id})` (mirror the file's fake-client pattern).

Also add `setNeedsHuman`/`clearNeedsHuman` to the SCOPED_TARGET↔PROC_ACTION coverage test's expectations implicitly (the existing coverage test will now REQUIRE them in SCOPED_TARGET — good, it enforces it).

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts apps/server/src/issue-commands.test.ts -t "needs.human|NeedsHuman|scope-gated"`
Expected: FAIL — methods/procs/commands don't exist; the coverage test also fails once PROC_ACTION gains the two write procs without SCOPED_TARGET entries (until Step 3 adds them).

- [ ] **Step 3: Implement**

`apps/server/src/issues.ts` (near `defer`/`close`):
```typescript
setNeedsHuman(id: string, question?: string | null): IssueWire {
  return this.update(id, { needsHuman: true, humanQuestion: question ?? null })
}
clearNeedsHuman(id: string): IssueWire {
  return this.update(id, { needsHuman: false, humanQuestion: null })
}
```
(Confirm `update` accepts these fields in its patch type — extend the `update` patch type/whitelist if it enumerates allowed fields.)

`apps/server/src/router.ts` (in the issues router):
```typescript
    setNeedsHuman: issueProc
      .input(z.object({ id: z.string(), question: z.string().optional() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.setNeedsHuman(input.id, input.question ?? null)),
    clearNeedsHuman: issueProc
      .input(z.object({ id: z.string() }))
      .mutation(({ ctx, input }) => ctx.registry.issues.clearNeedsHuman(input.id)),
```
Add to `SCOPED_TARGET`: `setNeedsHuman: (i) => i.id as string,` and `clearNeedsHuman: (i) => i.id as string,`.

`apps/server/src/issue-authz.ts` `PROC_ACTION`: `setNeedsHuman: 'write',` and `clearNeedsHuman: 'write',`.

`apps/server/src/issue-commands.ts`:
```typescript
  {
    name: 'needs-human',
    summary: 'Flag an issue as needing a human decision (--question optional).',
    args: z.object({ id: z.string(), question: z.string().optional() }),
    async run(c, a) {
      await c.issues.setNeedsHuman.mutate({ id: a.id as string, ...(a.question ? { question: a.question as string } : {}) })
      return `flagged ${a.id} for human`
    },
  },
  {
    name: 'clear-needs-human',
    summary: 'Clear the needs-human flag on an issue.',
    args: z.object({ id: z.string() }),
    async run(c, a) {
      await c.issues.clearNeedsHuman.mutate({ id: a.id as string })
      return `cleared needs-human on ${a.id}`
    },
  },
```

- [ ] **Step 4: Run to verify pass; regression + typecheck**

Run: `bun run vitest run apps/server/src/issue-authz.test.ts apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts apps/server/src/issue-commands.test.ts`
Expected: PASS (incl. the SCOPED_TARGET↔PROC_ACTION coverage test now that both procs are in SCOPED_TARGET). Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/issues.ts apps/server/src/router.ts apps/server/src/issue-authz.ts apps/server/src/issue-commands.ts apps/server/src/issues.test.ts apps/server/src/router.issues.test.ts apps/server/src/issue-commands.test.ts
git commit -m "feat(issues): needs-human set/clear (service + procs + scope + CLI)"
```

---

### Task 4: Web UI — needs-human badge + resolve

**Files:**
- Modify: `apps/web/src/issue-card.ts`, `apps/web/src/IssueDetail.tsx`
- Test: `apps/web/src/issue-card.test.ts`; e2e `tests/e2e/browser/issues.browser.e2e.ts`

**Interfaces:**
- `issueCardModel` returns `needsHuman: boolean` (from `issue.needsHuman`) so the card can render a distinct "needs human" badge.
- `IssueDetail` shows the `humanQuestion` (when set) prominently and offers: a "Flag for human" control (optional question input → `trpc.issues.setNeedsHuman`) and a "Resolve (clear)" button (`trpc.issues.clearNeedsHuman`) when flagged.

- [ ] **Step 1: Write the failing unit test**

Add to `apps/web/src/issue-card.test.ts` (uses the `makeIssue` factory — extend it to allow `needsHuman`):

```typescript
it('surfaces needsHuman on the card model', () => {
  expect(issueCardModel(makeIssue({ needsHuman: true })).needsHuman).toBe(true)
  expect(issueCardModel(makeIssue({ needsHuman: false })).needsHuman).toBe(false)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `bun run vitest run apps/web/src/issue-card.test.ts -t "needsHuman"`
Expected: FAIL — `needsHuman` not on the model (and possibly `makeIssue` needs the field; the Task-2 IssueWire change makes `needsHuman` required, so update the `makeIssue`/`test-issue` factory default to `needsHuman: false`).

- [ ] **Step 3: Implement the card model + badge**

In `apps/web/src/issue-card.ts`, add `needsHuman: boolean` to the return type and `needsHuman: issue.needsHuman` to the returned object. In the card render (find where `statusDot`/badges render in `IssuesView.tsx`/the card component), render a distinct badge (e.g. an amber "needs human" chip) when `model.needsHuman`.

- [ ] **Step 4: Implement the detail-drawer control**

In `apps/web/src/IssueDetail.tsx`, in the lifecycle section (near defer/close), add:
- When `fields.needsHuman`: a prominent banner showing `fields.humanQuestion` (or "Needs a human decision") + a "Resolve" button → `run(() => trpc.issues.clearNeedsHuman.mutate({ id: issue.id }))`.
- When not flagged: a "Flag for human" control — an optional question text input + button → `run(() => trpc.issues.setNeedsHuman.mutate({ id: issue.id, question: q || undefined }))`.
Use the existing `run(...)` helper + toast pattern.

- [ ] **Step 5: Unit tests pass; add + run the e2e**

Run: `bun run vitest run apps/web/src/issue-card.test.ts` → PASS. Web typecheck clean.

Add an e2e case to `tests/e2e/browser/issues.browser.e2e.ts` (mirror the existing create→drawer pattern): create an issue, open its drawer, click "Flag for human" (with a question), assert the card shows the needs-human badge (live via broadcast) and the drawer shows the question; click "Resolve", assert the badge disappears.

Attempt to run it: `bun run <the repo's e2e command for tests/e2e/browser>` (check `tests/e2e/playwright.config.ts` / package scripts for the exact invocation). 
- If it runs green: record the pass in the report (UI verified).
- If the browser environment is unavailable in this sandbox (headless Chromium can crash here): DO NOT claim UI-verified. Report the e2e as written-but-not-run and flag that a manual real-click verification (or a CI Playwright run) is REQUIRED before this task is considered done, per project convention.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/issue-card.ts apps/web/src/issue-card.test.ts apps/web/src/IssueDetail.tsx apps/web/src/IssuesView.tsx tests/e2e/browser/issues.browser.e2e.ts
git commit -m "feat(web): surface needs-human (card badge + drawer flag/resolve)"
```

---

## Self-Review

**Spec coverage (P4 = the four Q4 extras + UI):**
- Sub-issue decomposition → Task 1 (CLI `create --parentId`; service/proc already supported it). ✓
- Dependency filing → already works (`depAdd`) + rendered in the drawer; no new code (noted). ✓
- Structured hand-back → already works (`close --reason` + comments) + rendered in the drawer; no new code (noted). ✓
- Blocked / needs-human → `blocked` already surfaced (deps DAG + card statusDot + prime); needs-human added in Tasks 2 (data) + 3 (service/proc/CLI) + 4 (UI). ✓

**Placeholder scan:** none — every step has concrete code/commands. Task 2's test note gives a concrete fallback (store round-trip) so it's self-contained without depending on Task 3.

**Type consistency:** `needsHuman: boolean` + `humanQuestion: string|null` consistent across `IssueRow` (store), `mapIssueRow`/`upsertIssue`, `IssueWire` (`needsHuman: z.boolean()`, `humanQuestion` optional), `toWire`, `setNeedsHuman`/`clearNeedsHuman` (Task 3), and the card model (Task 4). `SCOPED_TARGET` entries for the two new write procs satisfy the P1b-server coverage test. Making `IssueWire.needsHuman` required forces every wire-construction + test factory to set it — Task 2 Step 4 / Task 4 Step 2 handle those compile errors.

**Migration safety:** additive columns with defaults via the established `addIssueCol` pattern + CREATE TABLE literal update for fresh DBs; schema_version 6→7. No drops.

**UI verification honesty:** Task 4 Step 5 requires either a green e2e run recorded as evidence, or an explicit "not runtime-verified — manual/CI run required" flag. No unverified UI-done claims.

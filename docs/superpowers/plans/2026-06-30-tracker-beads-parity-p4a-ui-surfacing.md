# Tracker → beads Parity — P4a: UI surfacing (credential fix + rich-field display) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rich tracker data **visible** in the web Issues UI and **unblock merge** — fix the web-client credential so the P3b role gate doesn't turn the Issues UI read-only, and surface priority/type/labels/ready-blocked on cards + the full rich-field set in the detail drawer (read-only display). Interactive editors/filters are P4b (they need in-browser verification).

**Architecture:** The display work goes through **pure derivations** (the codebase's web-test pattern — `issue-card.ts`, `derive.ts` are tested as pure functions, no component-render tests): extend `issueCardModel` and add an `issueDetailFields` derivation, unit-tested in happy-dom vitest; the React components render the derivations. The credential fix injects the maintainer token into the served `index.html` (`static-web.ts`) and has `makeTrpc` read it + send `x-podium-issue-token` — integration-tested via `static-web.test.ts` + a `makeTrpc` smoke.

**Tech Stack:** TypeScript, React, Bun, vitest + happy-dom (`apps/web`), Hono static serving.

## Global Constraints

- **`IssueWire` already carries** priority/type/labels/assignee/deps/dependents/comments/ready/blocked/deferred/childCount/childDoneCount/parentId/supersededBy/duplicateOf/closedReason (added in P1–P3; 116 tracker tests reference them). P4 SURFACES them — no protocol changes.
- **Test pattern:** unit-test pure derivations (`*.test.ts` in `apps/web/src`, vitest + happy-dom); do NOT add @testing-library component-render tests (not the established pattern). Component wiring is verified by `bun run typecheck` + `bun run --filter @podium/web build`; real-click verification is deferred to P4b runtime testing.
- **Credential model (from P3b):** the web UI is the operator surface ⇒ maintainer. The server injects the maintainer token into the page; this is consistent with the existing fully-trusted web control plane (all other tRPC procedures are unauthenticated). Closes the `podium-hi7.6` merge-blocker.
- **Dense style:** match the codebase; no broad biome reformat of pre-existing files; new derivations tidy + biome-clean.
- **Commits:** conventional, one per task, scope `web` (UI) / `tracker`. **Isolation:** worktree only; never the main checkout.

---

### Task 1: Web-client credential (closes the merge-blocker)

**Files:**
- Modify: `apps/server/src/static-web.ts` — `registerWebStatic(app, webDir, issueToken?)` injects `window.__PODIUM_ISSUE_TOKEN__` into served `index.html`.
- Modify: `apps/server/src/server.ts` — pass `maintainerToken` to `registerWebStatic`.
- Modify: `apps/web/src/trpc.ts` — `makeTrpc` reads `__PODIUM_ISSUE_TOKEN__` and sends `x-podium-issue-token`.
- Test: `apps/server/src/static-web.test.ts` (extend) + `apps/web/src/trpc.test.ts` (create or extend).

**Interfaces:**
- `registerWebStatic(app: Hono, webDir: string, issueToken?: string): boolean` — when `issueToken` is set, every served `index.html` (direct + SPA fallback) gets `<script>window.__PODIUM_ISSUE_TOKEN__=...</script>` injected before `</head>` (or prepended if no `</head>`).
- `makeTrpc(httpOrigin)` adds a per-request `headers` function returning `{ 'x-podium-issue-token': <global> }` when `window.__PODIUM_ISSUE_TOKEN__` is set.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/static-web.test.ts`, add a case (it already writes an `index.html` fixture and serves it):

```ts
  it('injects the issue token into served index.html when provided', async () => {
    const app = new Hono()
    registerWebStatic(app, dir, 'TOKEN123')
    const res = await app.request('/')
    const html = await res.text()
    expect(html).toContain('window.__PODIUM_ISSUE_TOKEN__')
    expect(html).toContain('TOKEN123')
  })

  it('does not inject when no token is given', async () => {
    const app = new Hono()
    registerWebStatic(app, dir)
    const html = await (await app.request('/')).text()
    expect(html).not.toContain('__PODIUM_ISSUE_TOKEN__')
  })
```

Create `apps/web/src/trpc.test.ts` (or extend an existing trpc test):

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { makeTrpc } from './trpc'

describe('makeTrpc credential', () => {
  afterEach(() => {
    delete (globalThis as { __PODIUM_ISSUE_TOKEN__?: string }).__PODIUM_ISSUE_TOKEN__
  })
  it('constructs a client with and without an injected token', () => {
    expect(makeTrpc('http://localhost:1')).toBeDefined()
    ;(globalThis as { __PODIUM_ISSUE_TOKEN__?: string }).__PODIUM_ISSUE_TOKEN__ = 'T'
    expect(makeTrpc('http://localhost:1')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/server/src/static-web.test.ts apps/web/src/trpc.test.ts`
Expected: FAIL — token not injected / `makeTrpc` extra arg or trpc.test missing.

- [ ] **Step 3: Implement**

In `static-web.ts`, change the signature to accept `issueToken?: string` and inject into the HTML. Add a helper and use it where `index.html` is read (both the direct-file path if it serves index.html, and the SPA fallback at the `readFileSync(join(webDir, 'index.html'))` return):

```ts
function injectIssueToken(html: string, token?: string): string {
  if (!token) return html
  const tag = `<script>window.__PODIUM_ISSUE_TOKEN__=${JSON.stringify(token)}</script>`
  return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html
}
```

For the SPA fallback return, replace the raw `readFileSync(...)` body with:

```ts
    const html = injectIssueToken(readFileSync(join(webDir, 'index.html'), 'utf8'), issueToken)
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
```

(If a direct request can also resolve to `index.html` via the file branch, route index.html through `injectIssueToken` there too; for a hashed-asset SPA the fallback path is the index.html path — confirm by reading the file and injecting wherever `index.html` is returned.)

In `server.ts`, pass the token: `if (webDir) registerWebStatic(app, webDir, maintainerToken)`.

In `apps/web/src/trpc.ts` `makeTrpc`:

```ts
export function makeTrpc(httpOrigin: string): Trpc {
  const token = (globalThis as { __PODIUM_ISSUE_TOKEN__?: string }).__PODIUM_ISSUE_TOKEN__
  const headers = (): Record<string, string> =>
    token ? { 'x-podium-issue-token': token } : {}
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${httpOrigin}/trpc`, headers })] })
}
```

- [ ] **Step 4: Run tests + typecheck + build**

Run: `npx vitest run apps/server/src/static-web.test.ts apps/web/src/trpc.test.ts` then `bun run typecheck` and `bun run --filter @podium/web build`. Expected: PASS; clean; build OK.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/static-web.ts apps/server/src/static-web.test.ts apps/server/src/server.ts apps/web/src/trpc.ts apps/web/src/trpc.test.ts
git commit -m "fix(web): web client presents maintainer issue token (unblock role gate)"
```

---

### Task 2: Card badges — priority / type / ready-blocked / labels

**Files:**
- Modify: `apps/web/src/issue-card.ts` — extend `issueCardModel` return with the new display bits.
- Modify: `apps/web/src/IssuesView.tsx` — render the new badges/dot on the card.
- Test: `apps/web/src/issue-card.test.ts` (extend).

**Interfaces:**
- `issueCardModel(issue)` return type gains: `priorityLabel: string` (`P0`..`P4`), `typeLabel: string` (the issue type), `statusDot: 'ready' | 'blocked' | 'deferred' | 'closed' | 'open'` (derived from `issue.ready`/`blocked`/`deferred`/stage/closedReason), and `labels: string[]`. Existing fields unchanged.

- [ ] **Step 1: Write the failing test**

Extend `apps/web/src/issue-card.test.ts` (mirror its existing mock-issue factory — it builds an `IssueWire`):

```ts
describe('issueCardModel rich badges (P4)', () => {
  it('derives priority/type labels, status dot, and labels', () => {
    const m = issueCardModel(makeIssue({ priority: 0, type: 'bug', ready: false, blocked: true, labels: ['ui', 'p1'] }))
    expect(m.priorityLabel).toBe('P0')
    expect(m.typeLabel).toBe('bug')
    expect(m.statusDot).toBe('blocked')
    expect(m.labels).toEqual(['ui', 'p1'])
  })
  it('a deferred issue shows the deferred dot; a done issue shows closed', () => {
    expect(issueCardModel(makeIssue({ deferred: true })).statusDot).toBe('deferred')
    expect(issueCardModel(makeIssue({ stage: 'done' })).statusDot).toBe('closed')
  })
})
```

(Use the file's existing issue factory; if it doesn't accept these fields, extend the factory's defaults to include the wire's required new fields — priority/type/pinned/labels/deps/dependents/comments/ready/blocked/deferred/childCount/childDoneCount — so `makeIssue` produces a valid `IssueWire`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/web/src/issue-card.test.ts`
Expected: FAIL — `m.priorityLabel` undefined.

- [ ] **Step 3: Implement**

In `issue-card.ts`, extend the return object:

```ts
  const statusDot: 'ready' | 'blocked' | 'deferred' | 'closed' | 'open' =
    issue.stage === 'done' || issue.closedReason
      ? 'closed'
      : issue.deferred
        ? 'deferred'
        : issue.blocked
          ? 'blocked'
          : issue.ready
            ? 'ready'
            : 'open'
  // … include in the returned object:
  //   priorityLabel: `P${issue.priority}`,
  //   typeLabel: issue.type,
  //   statusDot,
  //   labels: issue.labels,
```

Update the return type annotation accordingly. In `IssuesView.tsx`, render a small badge row on the card (a `P{n}` chip, the `typeLabel`, a colored `statusDot`, and label chips) using the model's new fields — match the existing badge markup style (`phaseBadges`).

- [ ] **Step 4: Run test + typecheck + build**

Run: `npx vitest run apps/web/src/issue-card.test.ts` then `bun run typecheck` and `bun run --filter @podium/web build`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/issue-card.ts apps/web/src/issue-card.test.ts apps/web/src/IssuesView.tsx
git commit -m "feat(web): priority/type/status/label badges on issue cards"
```

---

### Task 3: Detail drawer — rich-field display (read-only)

**Files:**
- Create: `apps/web/src/issue-detail-fields.ts` — pure `issueDetailFields(issue)` view-model.
- Modify: `apps/web/src/IssueDetail.tsx` — render the new read-only sections.
- Test: `apps/web/src/issue-detail-fields.test.ts` (create).

**Interfaces:**
- `issueDetailFields(issue: IssueWire)` returns a pure view-model:
  `{ priorityLabel, typeLabel, assignee?: string, labels: string[], deps: {id,type}[], dependents: {id,type}[], comments: {author,body,createdAt}[], parentId?: string, childSummary?: string (e.g. "2/3 done" when childCount>0), lifecycle?: string (e.g. "superseded by …" / "duplicate of …" / closedReason) }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/issue-detail-fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { issueDetailFields } from './issue-detail-fields'
import { makeIssue } from './issue-card.test' // reuse the factory if exported; else inline a minimal IssueWire

describe('issueDetailFields', () => {
  it('builds the rich-field view-model', () => {
    const v = issueDetailFields(makeIssue({
      priority: 1, type: 'feature', assignee: 'agent:claude', labels: ['ui'],
      deps: [{ id: 'iss_b', type: 'blocks' }], comments: [{ id: 'c1', author: 'mike', body: 'hi', createdAt: 't' }],
      childCount: 3, childDoneCount: 2,
    }))
    expect(v.priorityLabel).toBe('P1')
    expect(v.typeLabel).toBe('feature')
    expect(v.assignee).toBe('agent:claude')
    expect(v.labels).toEqual(['ui'])
    expect(v.deps).toEqual([{ id: 'iss_b', type: 'blocks' }])
    expect(v.comments[0].author).toBe('mike')
    expect(v.childSummary).toBe('2/3 done')
  })
  it('lifecycle reflects supersede/duplicate/closedReason', () => {
    expect(issueDetailFields(makeIssue({ supersededBy: 'iss_x' })).lifecycle).toMatch(/superseded/i)
    expect(issueDetailFields(makeIssue({ duplicateOf: 'iss_y' })).lifecycle).toMatch(/duplicate/i)
  })
})
```

(If `makeIssue` is not exported from `issue-card.test.ts`, factor a shared `apps/web/src/test-issue.ts` factory used by both tests, or inline a minimal valid `IssueWire` in this test. Keep it a real `IssueWire`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/web/src/issue-detail-fields.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/issue-detail-fields.ts`:

```ts
import type { IssueWire } from '@podium/protocol'

export interface IssueDetailFields {
  priorityLabel: string
  typeLabel: string
  assignee?: string
  labels: string[]
  deps: { id: string; type: string }[]
  dependents: { id: string; type: string }[]
  comments: { author: string; body: string; createdAt: string }[]
  parentId?: string
  childSummary?: string
  lifecycle?: string
}

export function issueDetailFields(issue: IssueWire): IssueDetailFields {
  const lifecycle = issue.supersededBy
    ? `superseded by ${issue.supersededBy}`
    : issue.duplicateOf
      ? `duplicate of ${issue.duplicateOf}`
      : issue.closedReason
        ? `closed: ${issue.closedReason}`
        : undefined
  return {
    priorityLabel: `P${issue.priority}`,
    typeLabel: issue.type,
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    labels: issue.labels,
    deps: issue.deps,
    dependents: issue.dependents,
    comments: issue.comments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt })),
    ...(issue.parentId ? { parentId: issue.parentId } : {}),
    ...(issue.childCount > 0 ? { childSummary: `${issue.childDoneCount}/${issue.childCount} done` } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  }
}
```

In `IssueDetail.tsx`, after the stage selector (around line 160) and before the description, render read-only sections from `issueDetailFields(issue)`: a meta row (priority chip, type, assignee, labels), a deps/dependents list, a parent/children summary, a lifecycle banner (if set), and a comments thread (author + body + time). Match the drawer's existing section markup.

- [ ] **Step 4: Run test + typecheck + build**

Run: `npx vitest run apps/web/src/issue-detail-fields.test.ts apps/web/src/issue-card.test.ts` then `bun run typecheck` and `bun run --filter @podium/web build`. Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/issue-detail-fields.ts apps/web/src/issue-detail-fields.test.ts apps/web/src/IssueDetail.tsx
git commit -m "feat(web): rich-field display in the issue detail drawer"
```

---

## Phase Close (P4a)

- [ ] Web tracker scope green: `npx vitest run apps/web/src/issue-card.test.ts apps/web/src/issue-detail-fields.test.ts apps/web/src/derive-issues.test.ts apps/web/src/trpc.test.ts apps/server/src/static-web.test.ts`
- [ ] `bun run typecheck` clean; `bun run --filter @podium/web build` succeeds; `biome check` clean on new files.
- [ ] Update `podium-hi7.6`: the web-UI credential merge-blocker (#1) is RESOLVED (Task 1); the hardening items (spawn-injection, per-issue scoping, MCP per-tier creds, cwd verification) remain.
- [ ] Hand off to **P4b** (runtime-verified): interactive editors (priority/type/assignee/labels in the detail drawer + NewIssueDialog), lifecycle action buttons (defer/supersede/duplicate/close-reason), dep add/remove + comment compose, and a board filter/search bar. P4b REQUIRES in-browser real-click verification (Playwright harness `tests/e2e/*.browser.e2e.ts` or manual), per the project's UI-verification convention.

## Self-Review notes (author)

- **Spec coverage (P4a):** web credential (Task 1, closes hi7.6 #1) ✓; rich-field VISIBILITY on cards (Task 2) ✓ + in the drawer (Task 3) ✓ — via pure derivations matching the codebase's web-test pattern. DEFERRED to P4b (needs browser verification): all INTERACTIVE editing — field editors, lifecycle buttons, dep/comment compose, board filters.
- **Placeholder scan:** none — every step has complete code.
- **Type-consistency:** the derivations read the existing `IssueWire` fields (priority/type/labels/assignee/deps/dependents/comments/ready/blocked/deferred/childCount/childDoneCount/parentId/supersededBy/duplicateOf/closedReason); `issueCardModel` + `issueDetailFields` are pure + unit-tested; components render them (typecheck+build verified). Credential header name `x-podium-issue-token` matches the server's `resolveRole` (P3b).
- **Risks:** (1) the `makeIssue`/issue factory in `issue-card.test.ts` may need its defaults extended to include the wire's now-required new fields so it produces a valid `IssueWire` — do that in Task 2 and reuse it in Task 3 (or extract a shared `test-issue.ts`). (2) `static-web.ts` may serve `index.html` via both a direct-file branch and the SPA fallback — inject in BOTH places index.html is returned. (3) component edits (IssuesView/IssueDetail render) are verified by typecheck+build only here; actual visual/click correctness is P4b runtime work — do not claim the UI is "verified working" from build alone.

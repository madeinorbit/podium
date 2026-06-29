# Issues Sidebar Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second sidebar tab — **Issues** — beside the existing **Worktrees** tree, listing all issues (flat, activity-sorted), each expandable to its sessions and clickable to open that issue's worktree in the main view.

**Architecture:** Pure derivation helpers turn the existing `store.issues` (`IssueWire[]`) plus the live `sessions` array into a sorted nav list. A persisted `sidebarTab` flag swaps the lower region of `Sidebar.tsx` between today's repo→worktree tree and a new flat `IssueBlock` list. Clicking an issue reuses the existing `selectWorktree` path; unstarted issues open the detail drawer, which is lifted from `IssuesView` local state into store state (`openIssueId`) and rendered once at the app-body level so both the kanban and the sidebar can trigger it. No server, protocol, or DB changes.

**Tech Stack:** React + TypeScript, Vite, Vitest, Tailwind (shadcn-on-Base-UI). All work is in `apps/web/src`.

## Global Constraints

- All changes confined to `apps/web/src`. No edits to `apps/server`, `packages/protocol`, or any DB/migration.
- `IssueWire` is the existing wire type from `@podium/protocol`; do not change it. Fields used: `id`, `title`, `repoPath`, `stage`, `worktreePath`, `updatedAt`, `archived`.
- The fixed top umbrella (`NEEDS YOUR ATTENTION` / `WORKING` / `PINNED PANELS`) must remain rendered regardless of which tab is active.
- Default sidebar tab is `'worktrees'`. Issues are **collapsed by default**.
- Run all commands from the worktree root: `/home/user/src/other/podium/.claude/worktrees/feat+issues-sidebar-tab`.
- Web unit tests: `cd apps/web && bun run vitest run <file>`. Web typecheck: `cd apps/web && bun run typecheck`. Web build: `cd apps/web && bun run build`.

---

## File Structure

- `apps/web/src/derive.ts` — add `IssueNavView`, `issueNavList`, `filterIssueNav` (pure; the brains).
- `apps/web/src/derive-issues.test.ts` — new unit tests for the above.
- `apps/web/src/store.tsx` — add `sidebarTab` (persisted) + `openIssueId` (ephemeral) state.
- `apps/web/src/IssueDetailHost.tsx` — new; renders the detail drawer for `store.openIssueId`.
- `apps/web/src/IssuesView.tsx` — use store `openIssueId`/`setOpenIssueId` instead of local state; stop rendering its own drawer.
- `apps/web/src/AppShell.tsx` — mount `<IssueDetailHost />` once in `AppBody`.
- `apps/web/src/Sidebar.tsx` — tab switcher, `IssueBlock`, Issues-tab rendering.

---

## Task 1: Derivation helpers (`issueNavList`, `filterIssueNav`)

**Files:**
- Modify: `apps/web/src/derive.ts`
- Test: `apps/web/src/derive-issues.test.ts` (create)

**Interfaces:**
- Consumes: `IssueWire`, `SessionMeta` from `@podium/protocol`; existing `sortSessionsForSidebar(sessions, now)` from `derive.ts`.
- Produces:
  - `interface IssueNavView { issue: IssueWire; repoName: string; sessions: SessionMeta[]; activityAt: number }`
  - `issueNavList(issues: IssueWire[], sessions: SessionMeta[], now?: number): IssueNavView[]`
  - `filterIssueNav(list: IssueNavView[], query: string): IssueNavView[]`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/derive-issues.test.ts`:

```ts
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { filterIssueNav, issueNavList } from './derive'

const NOW = Date.parse('2026-06-29T12:00:00.000Z')

function sess(
  id: string,
  cwd: string,
  hoursAgo: number,
  over: Partial<SessionMeta> = {},
): SessionMeta {
  return {
    sessionId: id,
    cwd,
    lastActiveAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    agentKind: 'claude-code',
    status: 'hibernated',
    busy: false,
    archived: false,
    agentState: { phase: 'idle', since: '', openTaskCount: 0, idle: { kind: 'done' } },
    ...over,
  } as unknown as SessionMeta
}

function issue(over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: 'i',
    repoPath: '/home/u/acme',
    seq: 1,
    title: 'Fix login',
    description: '',
    stage: 'in_progress',
    worktreePath: '/home/u/acme/.worktrees/issue-1',
    branch: 'issue/1',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedBy: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
    ...over,
  } as IssueWire
}

describe('issueNavList', () => {
  it('attaches live sessions whose cwd is the worktree or nested under it', () => {
    const sessions = [
      sess('a', '/home/u/acme/.worktrees/issue-1', 2),
      sess('b', '/home/u/acme/.worktrees/issue-1/packages/web', 1),
      sess('c', '/home/u/other', 1), // different worktree — excluded
    ]
    const [nav] = issueNavList([issue()], sessions, NOW)
    expect(nav.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('derives repoName from the repoPath basename', () => {
    const [nav] = issueNavList([issue()], [], NOW)
    expect(nav.repoName).toBe('acme')
  })

  it('gives an unstarted issue (no worktree) an empty session list', () => {
    const [nav] = issueNavList([issue({ worktreePath: null })], [], NOW)
    expect(nav.sessions).toEqual([])
  })

  it('excludes archived issues', () => {
    const list = issueNavList([issue({ id: 'keep' }), issue({ id: 'gone', archived: true })], [], NOW)
    expect(list.map((v) => v.issue.id)).toEqual(['keep'])
  })

  it('sorts by most-recent session activity, falling back to updatedAt', () => {
    const recent = issue({
      id: 'recent',
      worktreePath: '/wt/recent',
      updatedAt: '2026-01-01T00:00:00.000Z', // old issue, but a fresh session
    })
    const stale = issue({
      id: 'stale',
      worktreePath: '/wt/stale',
      updatedAt: '2026-06-25T00:00:00.000Z', // newer issue, no sessions
    })
    const sessions = [sess('s', '/wt/recent', 1)]
    const list = issueNavList([stale, recent], sessions, NOW)
    expect(list.map((v) => v.issue.id)).toEqual(['recent', 'stale'])
  })
})

describe('filterIssueNav', () => {
  const list = issueNavList(
    [
      issue({ id: 'a', title: 'Fix login', repoPath: '/home/u/acme', stage: 'in_progress' }),
      issue({ id: 'b', title: 'Add billing', repoPath: '/home/u/widgets', stage: 'backlog' }),
    ],
    [],
    NOW,
  )

  it('returns everything for an empty query', () => {
    expect(filterIssueNav(list, '  ').map((v) => v.issue.id).sort()).toEqual(['a', 'b'])
  })
  it('matches on issue title', () => {
    expect(filterIssueNav(list, 'login').map((v) => v.issue.id)).toEqual(['a'])
  })
  it('matches on repo name', () => {
    expect(filterIssueNav(list, 'widgets').map((v) => v.issue.id)).toEqual(['b'])
  })
  it('matches on stage', () => {
    expect(filterIssueNav(list, 'progress').map((v) => v.issue.id)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run vitest run src/derive-issues.test.ts`
Expected: FAIL — `issueNavList`/`filterIssueNav` are not exported from `./derive`.

- [ ] **Step 3: Implement the helpers**

In `apps/web/src/derive.ts`, ensure `IssueWire` is imported from `@podium/protocol` (add it to the existing protocol import). Then add, near the other sidebar helpers (e.g. just after `filterSidebarSections`):

```ts
export interface IssueNavView {
  issue: IssueWire
  repoName: string
  sessions: SessionMeta[]
  activityAt: number
}

/** Sessions living in an issue's worktree — exact cwd match or nested under it.
 *  Mirrors the server's sessionsForIssue membership so the sidebar count stays
 *  live between issuesChanged broadcasts. */
function sessionsForIssueWorktree(
  sessions: SessionMeta[],
  worktreePath: string | null,
): SessionMeta[] {
  if (!worktreePath) return []
  return sessions.filter((s) => s.cwd === worktreePath || s.cwd.startsWith(`${worktreePath}/`))
}

/** Flat, activity-sorted issue list for the sidebar Issues tab. Each issue carries
 *  its live sessions (from the session stream, not the wire snapshot) so badges and
 *  ordering stay fresh. Archived issues are dropped. Most-recently-active first;
 *  issues with no sessions fall back to their updatedAt. */
export function issueNavList(
  issues: IssueWire[],
  sessions: SessionMeta[],
  now: number = Date.now(),
): IssueNavView[] {
  const views = issues
    .filter((i) => !i.archived)
    .map((issue): IssueNavView => {
      const mine = sortSessionsForSidebar(
        sessionsForIssueWorktree(sessions, issue.worktreePath),
        now,
      )
      const lastSession = mine.reduce(
        (max, s) => Math.max(max, Date.parse(s.lastActiveAt) || 0),
        0,
      )
      const activityAt = lastSession || Date.parse(issue.updatedAt) || 0
      const repoName = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
      return { issue, repoName, sessions: mine, activityAt }
    })
  return views.sort((a, b) => b.activityAt - a.activityAt)
}

/** Narrow the issue list by the sidebar filter text — issue title, repo name, or stage. */
export function filterIssueNav(list: IssueNavView[], query: string): IssueNavView[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (v) =>
      v.issue.title.toLowerCase().includes(q) ||
      v.repoName.toLowerCase().includes(q) ||
      v.issue.stage.toLowerCase().includes(q),
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && bun run vitest run src/derive-issues.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/derive.ts apps/web/src/derive-issues.test.ts
git commit -m "feat(web): issueNavList + filterIssueNav derivation for sidebar issues tab"
```

---

## Task 2: Store state — `sidebarTab` and `openIssueId`

**Files:**
- Modify: `apps/web/src/store.tsx`

**Interfaces:**
- Produces (on the `Store` value):
  - `sidebarTab: 'worktrees' | 'issues'`
  - `setSidebarTab: (tab: 'worktrees' | 'issues') => void`
  - `openIssueId: string | null`
  - `setOpenIssueId: (id: string | null) => void`

This task is store plumbing with no isolated unit test; it is verified by typecheck and exercised by Tasks 3–4.

- [ ] **Step 1: Add the fields to the `Store` interface**

In `apps/web/src/store.tsx`, in the `Store` interface near `selectedWorktree`/`setSelectedWorktree`, add:

```ts
  /** Which sidebar tab is active: the repo/worktree tree or the issues list.
   *  Persisted so a reload lands on the same tab. */
  sidebarTab: 'worktrees' | 'issues'
  setSidebarTab: (tab: 'worktrees' | 'issues') => void
  /** The issue whose detail drawer is open (from the kanban card or the sidebar
   *  Issues tab), or null when closed. Ephemeral — not persisted. */
  openIssueId: string | null
  setOpenIssueId: (id: string | null) => void
```

- [ ] **Step 2: Add the persistence key + reader**

Near the other `*_KEY` constants and `readStoredView`, add:

```ts
const SIDEBAR_TAB_KEY = 'podium.sidebarTab'
function readStoredSidebarTab(): 'worktrees' | 'issues' {
  return lsGet(SIDEBAR_TAB_KEY) === 'issues' ? 'issues' : 'worktrees'
}
```

- [ ] **Step 3: Add the state + setters in `StoreProvider`**

Near the `selectedWorktree` state declaration, add:

```ts
  const [sidebarTab, setSidebarTabState] = useState<'worktrees' | 'issues'>(readStoredSidebarTab)
  const setSidebarTab = (tab: 'worktrees' | 'issues') => {
    setSidebarTabState(tab)
    lsSet(SIDEBAR_TAB_KEY, tab)
  }
  const [openIssueId, setOpenIssueId] = useState<string | null>(null)
```

- [ ] **Step 4: Expose them on the `value` object**

In the `const value: Store = { ... }` block, add (near `selectedWorktree`):

```ts
    sidebarTab,
    setSidebarTab,
    openIssueId,
    setOpenIssueId,
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store.tsx
git commit -m "feat(web): add sidebarTab + openIssueId to store"
```

---

## Task 3: Lift the issue-detail drawer into a global host

**Files:**
- Create: `apps/web/src/IssueDetailHost.tsx`
- Modify: `apps/web/src/IssuesView.tsx`
- Modify: `apps/web/src/AppShell.tsx`

**Interfaces:**
- Consumes: `store.openIssueId`, `store.setOpenIssueId`, `store.issues` (Task 2); existing `IssueDetail` component.
- Produces: `IssueDetailHost` component (no props) that renders the drawer for whatever issue is open.

- [ ] **Step 1: Create `IssueDetailHost.tsx`**

```tsx
import type { JSX } from 'react'
import { IssueDetail } from './IssueDetail'
import { useStore } from './store'

/** Renders the issue-detail drawer for whichever issue is open in the store, so the
 *  drawer can be triggered from the kanban board or the sidebar Issues tab alike.
 *  Mounted once at the app-body level; renders nothing when no issue is open. */
export function IssueDetailHost(): JSX.Element | null {
  const { issues, openIssueId, setOpenIssueId } = useStore()
  const issue = openIssueId ? (issues.find((i) => i.id === openIssueId) ?? null) : null
  if (!issue) return null
  return <IssueDetail issue={issue} onClose={() => setOpenIssueId(null)} />
}
```

- [ ] **Step 2: Switch `IssuesView` to store-driven open state**

In `apps/web/src/IssuesView.tsx`:
- Remove the `import { IssueDetail } from './IssueDetail'` line.
- Replace the component body's state wiring. Change:

```tsx
export function IssuesView(): JSX.Element {
  const { issues } = useStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const active = issues.filter((i) => !i.archived)
  const open = openId ? (issues.find((i) => i.id === openId) ?? null) : null
```

to:

```tsx
export function IssuesView(): JSX.Element {
  const { issues, setOpenIssueId } = useStore()
  const [creating, setCreating] = useState(false)
  const active = issues.filter((i) => !i.archived)
```

- Change the column's `onOpen={setOpenId}` to `onOpen={setOpenIssueId}`.
- Remove the drawer render line `{open && <IssueDetail issue={open} onClose={() => setOpenId(null)} />}` (the `IssueDetailHost` renders it now). Leave the `{creating && <NewIssueDialog .../>}` line intact.

- [ ] **Step 3: Mount `IssueDetailHost` in `AppBody`**

In `apps/web/src/AppShell.tsx`:
- Add the import: `import { IssueDetailHost } from './IssueDetailHost'`.
- In `AppBody`'s returned fragment, add `<IssueDetailHost />` as the last child inside the top-level `<> ... </>` (after the `{isMobile ? <MobileApp /> : <div className="desktop-shell">…</div>}` block), so it overlays whichever shell is active:

```tsx
  return (
    <>
      {isMobile ? (
        <MobileApp />
      ) : (
        <div className="desktop-shell">
          {/* …unchanged… */}
        </div>
      )}
      <IssueDetailHost />
    </>
  )
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && bun run typecheck`
Expected: PASS. (If `useState` is now unused in `IssuesView.tsx`, it still imports it for `creating` — leave the import.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/IssueDetailHost.tsx apps/web/src/IssuesView.tsx apps/web/src/AppShell.tsx
git commit -m "feat(web): drive issue-detail drawer from store via IssueDetailHost"
```

---

## Task 4: Sidebar tab switcher + `IssueBlock`

**Files:**
- Modify: `apps/web/src/Sidebar.tsx`

**Interfaces:**
- Consumes: `issueNavList`, `filterIssueNav`, `IssueNavView` (Task 1); `sidebarTab`, `setSidebarTab`, `issues`, `setOpenIssueId` (Task 2); existing `selectWorktree`, `selectPanel`, `PanelRow`, `partitionStaleSessions`, `StaleSection`, `useCollapsed`, `cn`, `ChevronRight`, `ChevronDown`.
- Produces: a tab switcher between the work-items umbrella and the tree; an `IssueBlock` component; Issues-tab rendering.

- [ ] **Step 1: Update imports and the `useStore` destructure**

In `apps/web/src/Sidebar.tsx`:
- Change the protocol import to also bring in `IssueWire`:

```ts
import type { IssueWire, SessionMeta } from '@podium/protocol'
```

- Add to the `./derive` import list: `issueNavList`, `filterIssueNav`, and `type IssueNavView`.
- In the `useStore()` destructure inside `Sidebar`, add `issues`, `sidebarTab`, `setSidebarTab`, `setOpenIssueId`.

- [ ] **Step 2: Compute the issue list and add a `selectIssue` handler**

After the existing `const sections = filterSidebarSections(...)` line, add:

```ts
  const issueList = filterIssueNav(issueNavList(issues, sessions, now), treeFilter)
```

Near the existing `selectWorktree`/`selectPanel` handlers, add:

```ts
  const selectIssue = (issue: IssueWire) => {
    if (issue.worktreePath) {
      setSelectedWorktree(issue.worktreePath)
      setView('workspace')
    } else {
      // Not started yet — open the detail drawer so the user can "Start work".
      setOpenIssueId(issue.id)
    }
  }
```

- [ ] **Step 3: Insert the tab switcher**

Immediately after the closing `</div>` of the WORK ITEMS umbrella block (the `{(workItems.attention.length > 0 || … ) && ( … )}` block) and before the `{/* ── WORKTREES ── */}` comment, insert:

```tsx
        {/* Tab switcher: repo/worktree tree vs. flat issues list. The work-items
            umbrella above stays fixed regardless of tab. */}
        <div className="flex gap-1 px-3 pt-3 pb-1">
          <button
            type="button"
            className={cn(
              'flex-1 rounded-md border px-2 py-1 text-[11px] font-medium',
              sidebarTab === 'worktrees'
                ? 'border-primary bg-secondary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={sidebarTab === 'worktrees'}
            onClick={() => setSidebarTab('worktrees')}
          >
            Worktrees
          </button>
          <button
            type="button"
            className={cn(
              'flex-1 rounded-md border px-2 py-1 text-[11px] font-medium',
              sidebarTab === 'issues'
                ? 'border-primary bg-secondary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            aria-pressed={sidebarTab === 'issues'}
            onClick={() => setSidebarTab('issues')}
          >
            Issues
          </button>
        </div>
```

- [ ] **Step 4: Gate the worktree tree behind the worktrees tab**

Wrap the existing worktree region in a `sidebarTab === 'worktrees'` conditional. The region runs from the `{/* ── WORKTREES ── */}` header block through the end of the `sortedRepos.map(...)` block **and** the `{!hasRows && …}` empty-state that follows it. Wrap them all:

```tsx
        {sidebarTab === 'worktrees' && (
          <>
            {/* ── WORKTREES ── */}
            {/* …existing WORKTREES header + sort Select… */}
            {/* …existing pinnedWorktrees / pinnedRepos / sortedRepos.map… */}
            {/* …existing {!hasRows && (…)} empty state… */}
          </>
        )}
```

Do not change the inner JSX — only add the `{sidebarTab === 'worktrees' && (<> … </>)}` wrapper around it.

- [ ] **Step 5: Add the Issues-tab rendering**

Immediately after the worktrees conditional you just added (and before the bottom `<HostIndicators />`), insert:

```tsx
        {sidebarTab === 'issues' && (
          <div className="min-w-0">
            <div className="px-3 pt-3 pb-1">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
                ISSUES
              </span>
            </div>
            {issueList.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground/60">
                {treeFilter ? 'No matching issues.' : 'No issues.'}
              </p>
            ) : (
              issueList.map((nav) => (
                <IssueBlock
                  key={nav.issue.id}
                  nav={nav}
                  active={selectedWorktree !== null && selectedWorktree === nav.issue.worktreePath}
                  paneA={paneA}
                  now={now}
                  onSelectIssue={() => selectIssue(nav.issue)}
                  onSelectPanel={selectPanel}
                  setPinned={setPinned}
                />
              ))
            )}
          </div>
        )}
```

- [ ] **Step 6: Add the `IssueBlock` component and stage labels**

Near `WorktreeBlock` (e.g. just before it), add:

```tsx
const ISSUE_STAGE_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  review: 'Review',
  verifying: 'Verifying',
  done: 'Done',
}

/** One issue row in the sidebar Issues tab. Default-collapsed (chevron toggles the
 *  attached sessions); the header shows the title, a session count, a muted repo
 *  name, and a stage pill. Clicking the header selects the issue's worktree (or
 *  opens the detail drawer for an unstarted issue). Mirrors WorktreeBlock. */
function IssueBlock({
  nav,
  active,
  paneA,
  now,
  onSelectIssue,
  onSelectPanel,
  setPinned,
}: {
  nav: IssueNavView
  active: boolean
  paneA: string | null
  now: number
  onSelectIssue: () => void
  onSelectPanel: (worktreePath: string, sessionId: string) => void
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
}): JSX.Element {
  const { issue, repoName, sessions } = nav
  const [collapsed, toggle] = useCollapsed(`podium:sidebar:issue-collapsed:${issue.id}`, true)
  const { visible, stale } = partitionStaleSessions(sessions, now)
  const renderRow = (session: SessionMeta) => (
    <PanelRow
      key={session.sessionId}
      session={session}
      pinned={false}
      active={active && paneA === session.sessionId}
      onSelect={() => {
        if (issue.worktreePath) onSelectPanel(issue.worktreePath, session.sessionId)
      }}
      onPinned={(p) => void setPinned('panel', session.sessionId, p)}
    />
  )
  return (
    <div className="min-w-0">
      <div className="group/iss flex min-w-0 items-stretch">
        <button
          type="button"
          className="flex-none px-1 text-muted-foreground/60 hover:text-foreground"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${issue.title}` : `Collapse ${issue.title}`}
        >
          {collapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className={cn(
            'flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-3 text-left text-sm',
            active
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground hover:bg-accent',
          )}
          onClick={onSelectIssue}
        >
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {issue.title}
          </span>
          {sessions.length > 0 && (
            <span className="flex-none text-[10px] text-muted-foreground/70 tabular-nums">
              {sessions.length}
            </span>
          )}
          <span className="max-w-[80px] flex-none overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground/70">
            {repoName}
          </span>
          <span className="flex-none rounded border border-input px-1 text-[10px] uppercase text-muted-foreground">
            {ISSUE_STAGE_LABELS[issue.stage] ?? issue.stage}
          </span>
        </button>
      </div>
      {!collapsed && (
        <>
          {visible.map(renderRow)}
          <StaleSection sessions={stale} render={renderRow} />
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Typecheck and build**

Run: `cd apps/web && bun run typecheck && bun run build`
Expected: PASS — no type errors, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/Sidebar.tsx
git commit -m "feat(web): issues sidebar tab with collapsible IssueBlock list"
```

---

## Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full web test suite + typecheck + build**

```bash
cd apps/web && bun run vitest run && bun run typecheck && bun run build
```
Expected: all tests pass, no type errors, build succeeds.

- [ ] **Step 2: Manual / Playwright UI check** (per the project's in-browser verification practice)

Verify in the running web app:
1. The sidebar shows a **Worktrees | Issues** switcher below the attention/working/pinned umbrella; the umbrella stays visible on both tabs.
2. Switching to **Issues** lists all non-archived issues, each collapsed by default, showing repo name + stage pill.
3. The chevron expands an issue to its sessions; collapse state survives a reload (localStorage), and the active tab survives a reload.
4. Clicking a **started** issue selects its worktree and the main view shows that worktree's sessions (active highlight on the row).
5. Clicking a session under an issue opens that session in the main view.
6. Clicking an **unstarted** issue (no worktree) opens the issue-detail drawer.
7. The filter input narrows the issue list by title/repo/stage on the Issues tab.
8. The kanban Issues board (tools-row button) still opens issue cards into the same drawer.

- [ ] **Step 3: Commit any fixes** found during verification, then this task is complete.

---

## Self-Review

- **Spec coverage:** tab switcher (Task 4) ✓; flat activity-sorted list with repo text + stage (Tasks 1, 4) ✓; all issues incl. unstarted (Task 1 keeps unstarted; Task 4 routes unstarted click to drawer) ✓; default-collapsed expandable sessions (Task 4 `useCollapsed(..., true)`) ✓; click reuses worktree workspace (Task 4 `selectIssue`) ✓; fixed top umbrella preserved (Task 4 inserts switcher *after* the umbrella) ✓; no server/protocol/DB changes ✓; drawer lift refactor (Task 3) ✓; kanban kept (Task 3 leaves `IssuesView` columns, only re-routes open state) ✓.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `IssueNavView`/`issueNavList`/`filterIssueNav` signatures identical across Tasks 1 and 4; `sidebarTab`/`openIssueId`/`setOpenIssueId` identical across Tasks 2, 3, 4; `IssueBlock` props match its call site in Task 4 Step 5.

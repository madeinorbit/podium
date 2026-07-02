# Linear-style Issues UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework Podium's issues UI to Linear's UX: Linear-anatomy cards and lanes, a new list view, a full issue page replacing the drawer, a pill composer, and core keyboard support.

**Architecture:** Evolve in place. All data flows stay as-is: tRPC `issues` router + `issuesChanged`/`issueUpdated` broadcasts into the store; mutations are fire-and-observe (no optimistic UI). New UX is built from pure, unit-tested view-model helpers plus React components in `apps/web/src`. **No server or protocol changes; no new npm dependencies** (new deps crash-loop the live redeploy).

**Tech Stack:** React 19 + TypeScript, shadcn-on-Base-UI components in `apps/web/src/components/ui/`, Tailwind v4, lucide-react icons, vitest (+happy-dom) unit tests, Playwright same-origin browser e2e (`tests/e2e/browser/`).

**Spec:** `docs/superpowers/specs/2026-07-02-linear-style-issues-ui-design.md`

## Global Constraints

- No new npm dependencies. No server/protocol changes.
- All paths below are relative to the worktree root `/home/user/src/other/podium/.worktrees/issue-9-linear-style-issues-ui`. Run everything from there (subagents may start in the MAIN checkout — `cd` to the worktree and verify `git branch --show-current` = `issue/9-linear-style-issues-ui` first).
- Unit tests: `bun run --cwd apps/web test -- --run <file>` (vitest). Full check: `bun run typecheck && bun run test`.
- Descriptions are never shown on cards. Delete lives only on the issue page `…` menu.
- Keep existing UI idioms: `cn()` from `@/lib/utils`, shadcn components, `text-[13px]`-style sizing, mutations wrapped so errors surface in a local toast/error line.
- Commit after every task (small commits are fine mid-task too), message style: `feat(web): … [podium #9]`.

---

### Task 1: Display options model (`issues-display.ts`)

Layout/ordering/visible-badge preferences + localStorage codec + ordering comparator.

**Files:**
- Create: `apps/web/src/issues-display.ts`
- Test: `apps/web/src/issues-display.test.ts`

**Interfaces:**
- Produces:
  - `type IssuesLayout = 'board' | 'list'`
  - `type IssuesOrdering = 'priority' | 'updated' | 'created'`
  - `interface IssuesDisplay { layout: IssuesLayout; ordering: IssuesOrdering; badges: { labels: boolean; type: boolean; estimate: boolean; due: boolean; sessions: boolean } }`
  - `DEFAULT_DISPLAY: IssuesDisplay` (board, updated, all badges on)
  - `readIssuesDisplay(raw: string | null): IssuesDisplay` — parse persisted JSON, tolerate garbage/partial
  - `writeIssuesDisplay(d: IssuesDisplay): string`
  - `orderIssues(issues: IssueWire[], ordering: IssuesOrdering): IssueWire[]` — pure, stable copy
  - `DISPLAY_KEY = 'podium.issues.display'`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/issues-display.test.ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPLAY,
  orderIssues,
  readIssuesDisplay,
  writeIssuesDisplay,
} from './issues-display'
import { makeIssue as issue } from './test-issue'

describe('readIssuesDisplay', () => {
  it('defaults on null/garbage/partial input', () => {
    expect(readIssuesDisplay(null)).toEqual(DEFAULT_DISPLAY)
    expect(readIssuesDisplay('not json')).toEqual(DEFAULT_DISPLAY)
    const d = readIssuesDisplay(JSON.stringify({ layout: 'list' }))
    expect(d.layout).toBe('list')
    expect(d.ordering).toBe(DEFAULT_DISPLAY.ordering)
    expect(d.badges).toEqual(DEFAULT_DISPLAY.badges)
  })
  it('rejects unknown enum values', () => {
    expect(readIssuesDisplay(JSON.stringify({ layout: 'gantt' })).layout).toBe('board')
  })
  it('round-trips through write', () => {
    const d = { ...DEFAULT_DISPLAY, layout: 'list' as const, ordering: 'priority' as const }
    expect(readIssuesDisplay(writeIssuesDisplay(d))).toEqual(d)
  })
})

describe('orderIssues', () => {
  it('priority: ascending priority, then seq', () => {
    const a = issue({ id: 'a', seq: 2, priority: 2 })
    const b = issue({ id: 'b', seq: 1, priority: 0 })
    const c = issue({ id: 'c', seq: 3, priority: 2 })
    expect(orderIssues([a, c, b], 'priority').map((i) => i.id)).toEqual(['b', 'a', 'c'])
  })
  it('updated: most recently updated first; created likewise', () => {
    const old = issue({ id: 'old', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-02T00:00:00Z' })
    const fresh = issue({ id: 'new', updatedAt: '2026-06-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' })
    expect(orderIssues([old, fresh], 'updated')[0]?.id).toBe('new')
    expect(orderIssues([old, fresh], 'created')[0]?.id).toBe('old')
  })
  it('does not mutate its input', () => {
    const list = [issue({ id: 'a', priority: 3 }), issue({ id: 'b', priority: 0 })]
    orderIssues(list, 'priority')
    expect(list[0]?.id).toBe('a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd apps/web test -- --run issues-display`
Expected: FAIL — module `./issues-display` not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/issues-display.ts
import type { IssueWire } from '@podium/protocol'

export type IssuesLayout = 'board' | 'list'
export type IssuesOrdering = 'priority' | 'updated' | 'created'

export interface IssuesDisplay {
  layout: IssuesLayout
  ordering: IssuesOrdering
  badges: { labels: boolean; type: boolean; estimate: boolean; due: boolean; sessions: boolean }
}

export const DISPLAY_KEY = 'podium.issues.display'

export const DEFAULT_DISPLAY: IssuesDisplay = {
  layout: 'board',
  ordering: 'updated',
  badges: { labels: true, type: true, estimate: true, due: true, sessions: true },
}

const LAYOUTS = new Set<string>(['board', 'list'])
const ORDERINGS = new Set<string>(['priority', 'updated', 'created'])

/** Parse a persisted display-options blob, falling back field-by-field so a
 *  stale or hand-edited value never breaks the view. */
export function readIssuesDisplay(raw: string | null): IssuesDisplay {
  if (!raw) return DEFAULT_DISPLAY
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return DEFAULT_DISPLAY
  }
  if (typeof v !== 'object' || v == null) return DEFAULT_DISPLAY
  const o = v as Record<string, unknown>
  const badges = (typeof o.badges === 'object' && o.badges != null ? o.badges : {}) as Record<
    string,
    unknown
  >
  const badge = (k: keyof IssuesDisplay['badges']): boolean =>
    typeof badges[k] === 'boolean' ? (badges[k] as boolean) : DEFAULT_DISPLAY.badges[k]
  return {
    layout: LAYOUTS.has(String(o.layout)) ? (o.layout as IssuesLayout) : DEFAULT_DISPLAY.layout,
    ordering: ORDERINGS.has(String(o.ordering))
      ? (o.ordering as IssuesOrdering)
      : DEFAULT_DISPLAY.ordering,
    badges: {
      labels: badge('labels'),
      type: badge('type'),
      estimate: badge('estimate'),
      due: badge('due'),
      sessions: badge('sessions'),
    },
  }
}

export function writeIssuesDisplay(d: IssuesDisplay): string {
  return JSON.stringify(d)
}

/** Stable ordering for board columns and list groups. Pure — returns a copy. */
export function orderIssues(issues: IssueWire[], ordering: IssuesOrdering): IssueWire[] {
  const c = [...issues]
  if (ordering === 'priority') c.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  else if (ordering === 'updated') c.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  else c.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return c
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd apps/web test -- --run issues-display`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/issues-display.ts apps/web/src/issues-display.test.ts
git commit -m "feat(web): issues display-options model (layout/ordering/badges) [podium #9]"
```

---

### Task 2: Glyphs — stage, priority, avatar (`issue-glyphs.tsx`)

Linear's visual vocabulary as small inline-SVG components + a pure initials helper.

**Files:**
- Create: `apps/web/src/issue-glyphs.tsx`
- Test: `apps/web/src/issue-glyphs.test.ts`

**Interfaces:**
- Produces:
  - `StageGlyph({ stage, size? }: { stage: IssueStage; size?: number }): JSX.Element` — dashed circle (backlog), open circle (planning), fractional-fill circles (in_progress ⅓, review ⅔, verifying ⅚), check circle (done). `aria-label` = stage label.
  - `PriorityGlyph({ priority, size? }: { priority: number; size?: number }): JSX.Element` — P0 filled square-exclamation ("urgent"), P1/P2/P3 = 3/2/1 signal bars, P4 = muted dashes ("no priority"). `aria-label` = `P${priority}`.
  - `AssigneeAvatar({ assignee, size? }: { assignee?: string; size?: number }): JSX.Element` — initials circle, dotted-outline circle when unassigned.
  - `assigneeInitials(name: string): string` — pure.

- [ ] **Step 1: Write the failing test (pure part)**

```ts
// apps/web/src/issue-glyphs.test.ts
import { describe, expect, it } from 'vitest'
import { assigneeInitials } from './issue-glyphs'

describe('assigneeInitials', () => {
  it('takes first letters of the first two words, uppercased', () => {
    expect(assigneeInitials('mike wirth')).toBe('MW')
    expect(assigneeInitials('claude')).toBe('C')
  })
  it('handles separators and noise', () => {
    expect(assigneeInitials('mike.wirth')).toBe('MW')
    expect(assigneeInitials('  spaced   out  ')).toBe('SO')
    expect(assigneeInitials('')).toBe('?')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd apps/web test -- --run issue-glyphs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/issue-glyphs.tsx
import type { IssueStage } from '@podium/protocol'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { STAGE_LABELS } from './issue-card'

/** First letters of the first two words ('.', '-', '_' count as separators). */
export function assigneeInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  const s = words
    .slice(0, 2)
    .map((w) => (w[0] ?? '').toUpperCase())
    .join('')
  return s || '?'
}

// Fill fraction per stage for the Linear-style progress-circle glyph family.
const STAGE_FILL: Record<IssueStage, number> = {
  backlog: 0,
  planning: 0,
  in_progress: 1 / 3,
  review: 2 / 3,
  verifying: 5 / 6,
  done: 1,
}

const STAGE_CLASS: Record<IssueStage, string> = {
  backlog: 'text-muted-foreground/70',
  planning: 'text-muted-foreground',
  in_progress: 'text-amber-500',
  review: 'text-sky-500',
  verifying: 'text-violet-500',
  done: 'text-green-500',
}

/**
 * Linear-style workflow-state glyph: dashed circle (backlog), open circle
 * (planning), pie-fill circles (in_progress/review/verifying), check (done).
 */
export function StageGlyph({ stage, size = 14 }: { stage: IssueStage; size?: number }): JSX.Element {
  const label = STAGE_LABELS[stage]
  const cls = cn('shrink-0', STAGE_CLASS[stage])
  if (stage === 'done') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className={cls} role="img" aria-label={label}>
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        <path d="M4.5 7.2 6.3 9l3.2-3.6" stroke="var(--background)" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  const fill = STAGE_FILL[stage]
  // Pie slice from 12 o'clock, clockwise, for the fractional stages.
  const angle = 2 * Math.PI * fill
  const x = 7 + 3.2 * Math.sin(angle)
  const y = 7 - 3.2 * Math.cos(angle)
  const largeArc = fill > 0.5 ? 1 : 0
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className={cls} role="img" aria-label={label}>
      <circle
        cx="7"
        cy="7"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeDasharray={stage === 'backlog' ? '2.2 2.2' : undefined}
      />
      {fill > 0 && (
        <path d={`M7 7 L7 3.8 A3.2 3.2 0 ${largeArc} 1 ${x} ${y} Z`} fill="currentColor" />
      )}
    </svg>
  )
}

/** Linear-style priority glyph: P0 urgent box, P1–P3 signal bars, P4 muted. */
export function PriorityGlyph({ priority, size = 14 }: { priority: number; size?: number }): JSX.Element {
  const label = `P${priority}`
  if (priority === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0 text-orange-500" role="img" aria-label={label}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.6v4.2" stroke="var(--background)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="7" cy="10.4" r="1" fill="var(--background)" />
      </svg>
    )
  }
  // Bars lit: P1=3, P2=2, P3=1, P4=0.
  const lit = Math.max(0, 4 - priority)
  const bar = (i: number): JSX.Element => (
    <rect
      key={i}
      x={1.5 + i * 4}
      y={9 - i * 3}
      width="2.6"
      height={3 + i * 3}
      rx="1"
      fill="currentColor"
      opacity={i < lit ? 1 : 0.25}
    />
  )
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0 text-muted-foreground" role="img" aria-label={label}>
      {[0, 1, 2].map(bar)}
    </svg>
  )
}

/** Initials avatar; dotted outline when unassigned (Linear's placeholder). */
export function AssigneeAvatar({ assignee, size = 18 }: { assignee?: string; size?: number }): JSX.Element {
  if (!assignee) {
    return (
      <span
        aria-label="Unassigned"
        title="Unassigned"
        className="inline-block shrink-0 rounded-full border border-muted-foreground/50 border-dashed"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      aria-label={`Assignee: ${assignee}`}
      title={assignee}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium text-[9px] text-primary"
      style={{ width: size, height: size }}
    >
      {assigneeInitials(assignee)}
    </span>
  )
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun run --cwd apps/web test -- --run issue-glyphs && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/issue-glyphs.tsx apps/web/src/issue-glyphs.test.ts
git commit -m "feat(web): Linear-style stage/priority/avatar glyphs [podium #9]"
```

---

### Task 3: Card view-model rework (`issue-card.ts`)

Linear card anatomy data: seq label, assignee, sub-issue progress, blocked/blocking flags, due label, session count. Keep old fields used elsewhere.

**Files:**
- Modify: `apps/web/src/issue-card.ts`
- Test: `apps/web/src/issue-card.test.ts` (extend; keep existing tests passing — `subtitle`, `statusDot`, `phaseBadges` remain until the sidebar/other callers stop using them)

**Interfaces:**
- Produces (added to `issueCardModel` return):
  - `seqLabel: string` (`#12`)
  - `assignee?: string`
  - `subProgress?: { done: number; total: number }` (present when `childCount > 0`)
  - `isBlocked: boolean` (wire `blocked`), `isBlocking: boolean` (`dependents.some(d => d.type === 'blocks')`)
  - `sessionCount: number`
  - `dueLabel?: string` (e.g. `Jul 12`, from `dueAt`)
  - `estimateLabel?: string` (e.g. `90m`, from `estimateMin`)

- [ ] **Step 1: Write the failing tests** (append to `issue-card.test.ts`)

```ts
describe('issueCardModel Linear anatomy', () => {
  it('derives seq label, assignee, session count', () => {
    const m = issueCardModel(issue({ seq: 12, assignee: 'mike' }))
    expect(m.seqLabel).toBe('#12')
    expect(m.assignee).toBe('mike')
    expect(m.sessionCount).toBe(2)
  })
  it('sub-issue progress only when children exist', () => {
    expect(issueCardModel(issue()).subProgress).toBeUndefined()
    expect(issueCardModel(issue({ childCount: 3, childDoneCount: 1 })).subProgress).toEqual({ done: 1, total: 3 })
  })
  it('blocked/blocking flags from wire state + dependents', () => {
    const m = issueCardModel(issue({ blocked: true, dependents: [{ id: 'x', type: 'blocks' }] }))
    expect(m.isBlocked).toBe(true)
    expect(m.isBlocking).toBe(true)
    expect(issueCardModel(issue()).isBlocking).toBe(false)
  })
  it('formats due date and estimate when present', () => {
    const m = issueCardModel(issue({ dueAt: '2026-07-12T00:00:00Z', estimateMin: 90 }))
    expect(m.dueLabel).toBe('Jul 12')
    expect(m.estimateLabel).toBe('90m')
    expect(issueCardModel(issue()).dueLabel).toBeUndefined()
  })
})
```

(If `makeIssue` lacks `dependents`/`dueAt`/`estimateMin` defaults, extend `apps/web/src/test-issue.ts` with pass-through overrides — check its shape first.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun run --cwd apps/web test -- --run issue-card`

- [ ] **Step 3: Implement** — extend the return object in `issueCardModel`:

```ts
const dueLabel = issue.dueAt
  ? new Date(issue.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  : undefined
return {
  // …existing fields stay…
  seqLabel: `#${issue.seq}`,
  ...(issue.assignee ? { assignee: issue.assignee } : {}),
  ...(issue.childCount > 0
    ? { subProgress: { done: issue.childDoneCount, total: issue.childCount } }
    : {}),
  isBlocked: issue.blocked,
  isBlocking: issue.dependents.some((d) => d.type === 'blocks'),
  sessionCount: issue.sessionSummary.total,
  ...(dueLabel ? { dueLabel } : {}),
  ...(issue.estimateMin != null ? { estimateLabel: `${issue.estimateMin}m` } : {}),
}
```

Update the declared return type accordingly (add the new optional/required fields).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun run --cwd apps/web test -- --run issue-card && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/issue-card.ts apps/web/src/issue-card.test.ts apps/web/src/test-issue.ts
git commit -m "feat(web): Linear card anatomy fields in issue card model [podium #9]"
```

---

### Task 4: Filter chips model

Extend `BoardFilter` with `stage` + `label` already exists; add chip descriptors so the UI can render/remove chips generically.

**Files:**
- Modify: `apps/web/src/issue-board-filter.ts`
- Test: `apps/web/src/issue-board-filter.test.ts` (extend)

**Interfaces:**
- Produces:
  - `BoardFilter` gains `stage?: IssueStage`
  - `filterChips(f: BoardFilter): { key: keyof BoardFilter; label: string }[]` — one chip per set field (text excluded; the search input stays its own control)
  - `clearChip(f: BoardFilter, key: keyof BoardFilter): BoardFilter`

- [ ] **Step 1: Failing tests** (append)

```ts
import { clearChip, filterChips } from './issue-board-filter'

describe('filter chips', () => {
  it('one chip per set dimension, text excluded', () => {
    const chips = filterChips({ text: 'x', priority: 1, type: 'bug', status: 'open', label: 'ui', stage: 'review' })
    expect(chips.map((c) => c.key).sort()).toEqual(['label', 'priority', 'stage', 'status', 'type'])
    expect(chips.find((c) => c.key === 'priority')?.label).toBe('Priority: P1')
    expect(chips.find((c) => c.key === 'stage')?.label).toBe('Stage: Review')
  })
  it('clearChip removes exactly that dimension', () => {
    const f = clearChip({ priority: 1, type: 'bug' }, 'priority')
    expect(f.priority).toBeUndefined()
    expect(f.type).toBe('bug')
  })
})
```

Also add a `stage` filtering test for `filterBoardIssues` (`{ stage: 'review' }` keeps only review issues).

- [ ] **Step 2: Run to verify fail** — `bun run --cwd apps/web test -- --run issue-board-filter`

- [ ] **Step 3: Implement**

```ts
// additions to apps/web/src/issue-board-filter.ts
import type { IssueStage, IssueWire } from '@podium/protocol'
import { STAGE_LABELS } from './issue-card'

export interface BoardFilter {
  text?: string
  priority?: number
  type?: string
  assignee?: string
  label?: string
  status?: 'open' | 'closed' | 'ready' | 'blocked' | 'deferred'
  stage?: IssueStage
}

// inside filterBoardIssues, add:
//   if (f.stage && i.stage !== f.stage) return false

/** Chip descriptors for every set dimension except free-text search. */
export function filterChips(f: BoardFilter): { key: keyof BoardFilter; label: string }[] {
  const chips: { key: keyof BoardFilter; label: string }[] = []
  if (f.priority != null) chips.push({ key: 'priority', label: `Priority: P${f.priority}` })
  if (f.type) chips.push({ key: 'type', label: `Type: ${f.type}` })
  if (f.assignee) chips.push({ key: 'assignee', label: `Assignee: ${f.assignee}` })
  if (f.label) chips.push({ key: 'label', label: `Label: ${f.label}` })
  if (f.status) chips.push({ key: 'status', label: `Status: ${f.status}` })
  if (f.stage) chips.push({ key: 'stage', label: `Stage: ${STAGE_LABELS[f.stage]}` })
  return chips
}

export function clearChip(f: BoardFilter, key: keyof BoardFilter): BoardFilter {
  const next = { ...f }
  delete next[key]
  return next
}
```

- [ ] **Step 4: Run tests** — PASS. `bun run typecheck`.
- [ ] **Step 5: Commit** — `feat(web): filter chips model + stage filter [podium #9]`

---

### Task 5: Board rework (header, lanes, Linear cards)

Rebuild `IssuesView.tsx`: header with `Filter` menu + `Display` menu + `New issue`; chip row; lanes with stage glyph/count/`+`; Linear-anatomy cards. Update the existing e2e selectors it breaks.

**Files:**
- Modify: `apps/web/src/IssuesView.tsx` (substantial rewrite of FilterBar/IssueColumn/IssueCard)
- Modify: `tests/e2e/browser/issues.browser.e2e.ts` (selector updates only, keep scenarios)
- Modify: `apps/web/src/NewIssueDialog.tsx` (accept optional `initialStage` prop — pass-through; full composer rework is Task 12)

**Interfaces:**
- Consumes: Task 1 (`IssuesDisplay`, `readIssuesDisplay`, `writeIssuesDisplay`, `orderIssues`, `DISPLAY_KEY`), Task 2 (glyphs), Task 3 (card model), Task 4 (chips).
- Produces: `IssuesView` renders `layout === 'board'` only for now (list lands in Task 6; keep a `{display.layout === 'list' ? <div/> : <Board…/>}` seam). Card click still calls `setOpenIssueId(id)`.

Implementation sketch (full component code — adapt state wiring as written):

- [ ] **Step 1: Header + display state**

```tsx
// inside IssuesView()
const [display, setDisplay] = useState<IssuesDisplay>(() =>
  readIssuesDisplay(localStorage.getItem(DISPLAY_KEY)),
)
const updateDisplay = (patch: Partial<IssuesDisplay>): void => {
  const next = { ...display, ...patch, badges: { ...display.badges, ...(patch.badges ?? {}) } }
  setDisplay(next)
  localStorage.setItem(DISPLAY_KEY, writeIssuesDisplay(next))
}
const [creating, setCreating] = useState<null | { stage?: IssueStage }>(null)
```

Header right side becomes: `FilterMenu` (a `DropdownMenu` listing Priority/Type/Status/Stage/Label submenus that set the corresponding `BoardFilter` field), `DisplayMenu` (a `DropdownMenu` with a Board/List radio group, ordering radio group, and badge visibility checkboxes via `DropdownMenuCheckboxItem`), and the `New issue` button (`onClick={() => setCreating({})}`). Below the header, render the search `Input` plus the chip row:

```tsx
{filterChips(filter).map((c) => (
  <button
    key={c.key}
    type="button"
    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[12px]"
    onClick={() => setFilter(clearChip(filter, c.key))}
    title="Remove filter"
  >
    {c.label} <X size={11} aria-hidden="true" />
  </button>
))}
```

- [ ] **Step 2: Lane header**

```tsx
<div className="flex items-center gap-1.5 px-1 py-0.5">
  <StageGlyph stage={stage} />
  <h3 className="font-medium text-[13px] text-foreground">{label}</h3>
  <span className="text-[11px] text-muted-foreground tabular-nums">{issues.length}</span>
  <Button
    type="button" variant="ghost" size="icon-sm" className="ml-auto size-5"
    title={`New issue in ${label}`} aria-label={`New issue in ${label}`}
    onClick={() => onCreateIn(stage)}
  >
    <Plus size={13} aria-hidden="true" />
  </Button>
</div>
```

`onCreateIn` bubbles to `setCreating({ stage })`; `NewIssueDialog` gets `initialStage` and, until Task 12, applies it after create via a `stage` patch (`create` has no stage input): after `create.mutate(...)` resolves with the new issue, if `initialStage && initialStage !== 'backlog'` run `trpc.issues.update.mutate({ id: created.id, patch: { stage: initialStage } })`. Verify what `create` returns (`registry.issues.createAndMaybeStart`) — if it doesn't return the row, find it after the next `issuesChanged` by seq/title is NOT reliable; in that case add nothing and leave the lane `+` presetting only the composer's stage pill for Task 12, creating in backlog for now (note it in the commit message).

- [ ] **Step 3: Linear card** — replace `IssueCard`'s content:

```tsx
const m = issueCardModel(issue)
<button type="button" className="flex w-full flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/60" onClick={() => onOpen(issue.id)}>
  <div className="flex items-center justify-between">
    <span className="text-[11px] text-muted-foreground">{m.seqLabel}</span>
    <span onClick={(e) => e.stopPropagation()}>
      <AssigneeMenu issue={issue} trigger={<AssigneeAvatar assignee={m.assignee} />} />
    </span>
  </div>
  <div className="line-clamp-2 min-w-0 break-words font-medium text-[13px] text-foreground">{m.title}</div>
  <div className="flex flex-wrap items-center gap-1.5">
    <PriorityGlyph priority={issue.priority} />
    {show.type && <Badge variant="outline" className="font-normal">{m.typeLabel}</Badge>}
    {show.labels && m.labels.slice(0, 3).map((l) => <Badge key={l} variant="secondary" className="font-normal">{l}</Badge>)}
    {show.labels && m.labels.length > 3 && <Badge variant="secondary" className="font-normal">+{m.labels.length - 3}</Badge>}
    {m.subProgress && <span className="text-[11px] text-muted-foreground tabular-nums">{m.subProgress.done}/{m.subProgress.total}</span>}
    {m.isBlocked && <Flag size={12} className="text-orange-500" aria-label="Blocked" />}
    {m.isBlocking && <Flag size={12} className="text-red-500" aria-label="Blocking" />}
    {m.needsHuman && <CircleUser size={12} className="text-amber-500" aria-label="Needs human" />}
    {show.due && m.dueLabel && <span className="text-[11px] text-muted-foreground">{m.dueLabel}</span>}
    {show.estimate && m.estimateLabel && <span className="text-[11px] text-muted-foreground">{m.estimateLabel}</span>}
    {show.sessions && m.sessionCount > 0 && <span className="text-[11px] text-muted-foreground tabular-nums">▣ {m.sessionCount}</span>}
  </div>
</button>
```

where `show = display.badges`. `AssigneeMenu` is a thin `DropdownMenu` whose items are the distinct assignees present in `issues` plus "Unassigned" and a free-text input row (see Task 7's `PropertyMenu` — until Task 7 lands, use a plain `DropdownMenu` with distinct-assignee items; swap to `PropertyMenu` in Task 9). Selecting fires `trpc.issues.update.mutate({ id, patch: { assignee } })` (empty string for unassign).

Remove: description/activityNotes preview, subtitle line, suggested-stage line, phase badges, status dot, hover trash button, `linearIdentifier` badge (moves to issue page). Keep: draggable + `CardBoundary` + drop handling unchanged.

- [ ] **Step 4: Update e2e selectors**

In `tests/e2e/browser/issues.browser.e2e.ts`: the two scenarios stay; update any selector that referenced removed card elements (e.g. "needs human" badge text is now an icon with `aria-label="Needs human"` — assert on `[aria-label="Needs human"]`; delete-button assertions if any move to the issue page in Task 8). Read the spec file first and keep its structure.

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run --cwd apps/web test -- --run` then build + browser e2e:
`bun run build && bun run test:e2e:browser -- issues` (use the repo's actual e2e script name — check `package.json` scripts; the browser harness serves web same-origin from the relay).
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(web): Linear-style board cards + lane headers + filter/display menus [podium #9]`

---

### Task 6: List view

**Files:**
- Create: `apps/web/src/issue-list.ts` (pure grouping) + `apps/web/src/issue-list.test.ts`
- Create: `apps/web/src/IssueListView.tsx`
- Modify: `apps/web/src/IssuesView.tsx` (render list when `display.layout === 'list'`; force list on mobile via `useIsMobile()`)

**Interfaces:**
- Produces:
  - `groupIssuesByStage(issues: IssueWire[], ordering: IssuesOrdering): { stage: IssueStage; issues: IssueWire[] }[]` — all 6 stages in `ISSUE_STAGES` order, each group internally ordered; empty groups included (board parity).
  - `flattenGroups(groups: { issues: IssueWire[] }[]): string[]` — ordered ids, used for prev/next + keyboard.
  - `IssueListView({ issues, display, onOpen, onCreateIn }): JSX.Element`

- [ ] **Step 1: Failing tests**

```ts
// apps/web/src/issue-list.test.ts
import { describe, expect, it } from 'vitest'
import { flattenGroups, groupIssuesByStage } from './issue-list'
import { makeIssue as issue } from './test-issue'

describe('groupIssuesByStage', () => {
  it('returns all stages in order with ordered members', () => {
    const g = groupIssuesByStage(
      [issue({ id: 'a', stage: 'review', priority: 3 }), issue({ id: 'b', stage: 'review', priority: 0 }), issue({ id: 'c', stage: 'backlog' })],
      'priority',
    )
    expect(g.map((x) => x.stage)).toEqual(['backlog', 'planning', 'in_progress', 'review', 'verifying', 'done'])
    expect(g[3]?.issues.map((i) => i.id)).toEqual(['b', 'a'])
    expect(g[1]?.issues).toEqual([])
  })
})

describe('flattenGroups', () => {
  it('yields ids in visual order', () => {
    const g = groupIssuesByStage([issue({ id: 'a', stage: 'done' }), issue({ id: 'b', stage: 'backlog' })], 'updated')
    expect(flattenGroups(g)).toEqual(['b', 'a'])
  })
})
```

- [ ] **Step 2: Run to verify fail**, then **Step 3: Implement**

```ts
// apps/web/src/issue-list.ts
import { ISSUE_STAGES, type IssueStage, type IssueWire } from '@podium/protocol'
import { type IssuesOrdering, orderIssues } from './issues-display'

export function groupIssuesByStage(
  issues: IssueWire[],
  ordering: IssuesOrdering,
): { stage: IssueStage; issues: IssueWire[] }[] {
  return ISSUE_STAGES.map((stage) => ({
    stage,
    issues: orderIssues(issues.filter((i) => i.stage === stage), ordering),
  }))
}

export function flattenGroups(groups: { issues: IssueWire[] }[]): string[] {
  return groups.flatMap((g) => g.issues.map((i) => i.id))
}
```

- [ ] **Step 4: IssueListView component**

```tsx
// apps/web/src/IssueListView.tsx
import type { IssueStage, IssueWire } from '@podium/protocol'
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { issueCardModel, STAGE_LABELS } from './issue-card'
import { AssigneeAvatar, PriorityGlyph, StageGlyph } from './issue-glyphs'
import { groupIssuesByStage } from './issue-list'
import type { IssuesDisplay } from './issues-display'

/** Linear-style list: rows grouped by stage under sticky group headers. */
export function IssueListView({
  issues,
  display,
  onOpen,
  onCreateIn,
}: {
  issues: IssueWire[]
  display: IssuesDisplay
  onOpen: (id: string) => void
  onCreateIn: (stage: IssueStage) => void
}): JSX.Element {
  const groups = groupIssuesByStage(issues, display.ordering)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="issues-list">
      {groups.map(({ stage, issues: members }) =>
        members.length === 0 ? null : (
          <section key={stage} aria-label={STAGE_LABELS[stage]}>
            <div className="group sticky top-0 z-10 flex items-center gap-1.5 border-border border-b bg-muted/60 px-4 py-1.5 backdrop-blur">
              <StageGlyph stage={stage} />
              <h3 className="font-medium text-[13px]">{STAGE_LABELS[stage]}</h3>
              <span className="text-[11px] text-muted-foreground tabular-nums">{members.length}</span>
              <Button
                type="button" variant="ghost" size="icon-sm"
                className="ml-auto size-5 opacity-0 group-hover:opacity-100"
                title={`New issue in ${STAGE_LABELS[stage]}`}
                onClick={() => onCreateIn(stage)}
              >
                <Plus size={13} aria-hidden="true" />
              </Button>
            </div>
            {members.map((issue) => {
              const m = issueCardModel(issue)
              return (
                <button
                  key={issue.id}
                  type="button"
                  className="flex w-full items-center gap-2 border-border/50 border-b px-4 py-2 text-left hover:bg-muted/40"
                  onClick={() => onOpen(issue.id)}
                >
                  <PriorityGlyph priority={issue.priority} />
                  <span className="w-10 shrink-0 text-[11px] text-muted-foreground tabular-nums">{m.seqLabel}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{m.title}</span>
                  {display.badges.labels &&
                    m.labels.slice(0, 2).map((l) => (
                      <Badge key={l} variant="secondary" className="hidden font-normal md:inline-flex">{l}</Badge>
                    ))}
                  {display.badges.due && m.dueLabel && (
                    <span className="hidden text-[11px] text-muted-foreground md:inline">{m.dueLabel}</span>
                  )}
                  <span className="hidden text-[11px] text-muted-foreground md:inline">
                    {new Date(issue.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <AssigneeAvatar assignee={m.assignee} />
                </button>
              )
            })}
          </section>
        ),
      )}
    </div>
  )
}
```

- [ ] **Step 5: Wire into IssuesView** — `const isMobile = useIsMobile()`; `const layout = isMobile ? 'list' : display.layout`; render `<IssueListView …/>` vs the board columns. The `Display` menu's layout radio hides on mobile.

- [ ] **Step 6: Verify + commit**

`bun run typecheck && bun run --cwd apps/web test -- --run && bun run build`
Commit: `feat(web): Linear-style list view + mobile issues layout [podium #9]`

---

### Task 7: `PropertyMenu` primitive

A dropdown with a type-ahead filter input and optional free-text commit — the building block for every property row and inline card edit.

**Files:**
- Create: `apps/web/src/PropertyMenu.tsx`
- Create: `apps/web/src/property-menu.ts` + `apps/web/src/property-menu.test.ts` (pure filter)

**Interfaces:**
- Produces:
  - `filterPropertyOptions<T extends { label: string }>(options: T[], query: string): T[]` — case-insensitive substring, query trimmed; empty query returns all.
  - `PropertyMenu({ trigger, options, onSelect, allowFreeText?, placeholder?, selectedValue? })` where `options: { value: string; label: string; icon?: JSX.Element }[]`, `onSelect(value: string)`. Renders `DropdownMenu` + `DropdownMenuTrigger asChild` + content whose first row is an `<Input>` (stopPropagation on keydown so menu typeahead doesn't steal keys); below, the filtered options as `DropdownMenuItem`s (icon + label, check on `selectedValue`); if `allowFreeText` and the query matches nothing exactly, a final `Use "<query>"` item commits the raw query.

- [ ] **Step 1: Failing test**

```ts
// apps/web/src/property-menu.test.ts
import { describe, expect, it } from 'vitest'
import { filterPropertyOptions } from './property-menu'

describe('filterPropertyOptions', () => {
  const opts = [{ label: 'Backlog' }, { label: 'In Progress' }, { label: 'Review' }]
  it('empty query returns all; matching is case-insensitive substring', () => {
    expect(filterPropertyOptions(opts, '')).toHaveLength(3)
    expect(filterPropertyOptions(opts, ' pro ').map((o) => o.label)).toEqual(['In Progress'])
    expect(filterPropertyOptions(opts, 'RE')).toHaveLength(2) // pRogress? no — Review + In PRogress? check: 'RE' in 'In Progress' false, 'Review' true, 'Backlog' false → adjust expectation to 1
  })
})
```

Correct that third assertion while writing it: `'re'` occurs in "In Progress" ("Prog**re**ss") — verify by hand and set the expected count accordingly (it is 2: Prog**re**ss and **Re**view). Keep the test honest.

- [ ] **Step 2–4: Implement pure helper + component, run tests, typecheck**

```ts
// apps/web/src/property-menu.ts
export function filterPropertyOptions<T extends { label: string }>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => o.label.toLowerCase().includes(q))
}
```

Component skeleton:

```tsx
// apps/web/src/PropertyMenu.tsx
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { filterPropertyOptions } from './property-menu'

export interface PropertyOption {
  value: string
  label: string
  icon?: ReactNode
}

/** Linear-style property picker: dropdown with type-ahead + optional free text. */
export function PropertyMenu({
  trigger,
  options,
  selectedValue,
  onSelect,
  allowFreeText = false,
  placeholder = 'Filter…',
}: {
  trigger: ReactNode
  options: PropertyOption[]
  selectedValue?: string
  onSelect: (value: string) => void
  allowFreeText?: boolean
  placeholder?: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = filterPropertyOptions(options, query)
  const exact = options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase())
  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setQuery('') }}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="p-1">
          <Input
            autoFocus
            value={query}
            placeholder={placeholder}
            className="h-7"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        {filtered.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            {o.icon}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {selectedValue === o.value && <Check size={13} aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        {allowFreeText && query.trim() && !exact && (
          <DropdownMenuItem onClick={() => onSelect(query.trim())}>
            Use “{query.trim()}”
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

Note: Base UI menus use typeahead on item labels; the `stopPropagation` on the input's keydown is what keeps typing in the box. Verify interactively in Step 5 of Task 9's e2e (property edit via dropdown) — if arrow-key navigation from the input into items doesn't work with Base UI, fall back to filtering only (no arrow handoff) and note it.

- [ ] **Step 5: Commit** — `feat(web): PropertyMenu type-ahead dropdown primitive [podium #9]`

---

### Task 8: Issue page — routing, header, banners, main column

Replace the drawer navigation with an in-view issue page. `IssueDetail`/`IssueDetailHost` stay mounted-but-unreachable until Task 10 deletes them.

**Files:**
- Create: `apps/web/src/IssuePage.tsx`
- Create: `apps/web/src/issue-page.ts` + test (pure: neighbors + breadcrumb model)
- Modify: `apps/web/src/IssuesView.tsx` — when `openIssueId` set and the issue exists, render `<IssuePage …/>` instead of board/list
- Modify: `apps/web/src/AppShell.tsx` + `apps/web/src/MobileApp.tsx` — remove `<IssueDetailHost />`
- Modify: `apps/web/src/Sidebar.tsx` — `selectIssue` for unstarted issues: `setOpenIssueId(id)` **and** `setView('issues')`

**Interfaces:**
- Consumes: `flattenGroups`/`groupIssuesByStage` (Task 6), `orderIssues` (Task 1), glyphs (Task 2).
- Produces:
  - `issueNeighbors(orderedIds: string[], id: string): { prev?: string; next?: string }`
  - `IssuePage({ issue, orderedIds, onBack, onNavigate }): JSX.Element` — `onNavigate(id)` re-points `openIssueId`.

- [ ] **Step 1: Failing test**

```ts
// apps/web/src/issue-page.test.ts
import { describe, expect, it } from 'vitest'
import { issueNeighbors } from './issue-page'

describe('issueNeighbors', () => {
  it('middle / first / last / absent', () => {
    expect(issueNeighbors(['a', 'b', 'c'], 'b')).toEqual({ prev: 'a', next: 'c' })
    expect(issueNeighbors(['a', 'b', 'c'], 'a')).toEqual({ next: 'b' })
    expect(issueNeighbors(['a', 'b', 'c'], 'c')).toEqual({ prev: 'b' })
    expect(issueNeighbors(['a', 'b', 'c'], 'zz')).toEqual({})
  })
})
```

```ts
// apps/web/src/issue-page.ts
export function issueNeighbors(
  orderedIds: string[],
  id: string,
): { prev?: string; next?: string } {
  const i = orderedIds.indexOf(id)
  if (i < 0) return {}
  return {
    ...(i > 0 ? { prev: orderedIds[i - 1] } : {}),
    ...(i < orderedIds.length - 1 ? { next: orderedIds[i + 1] } : {}),
  }
}
```

- [ ] **Step 2: Run test (fail → implement → pass)**

- [ ] **Step 3: `IssuePage` component** — two-column layout:

```tsx
// apps/web/src/IssuePage.tsx — structure (port section logic from IssueDetail.tsx)
export function IssuePage({ issue, orderedIds, onBack, onNavigate }: {
  issue: IssueWire
  orderedIds: string[]
  onBack: () => void
  onNavigate: (id: string) => void
}): JSX.Element {
  // …the run()/action()/mergeStyle plumbing is ported verbatim from IssueDetail.tsx:46-119
  const { prev, next } = issueNeighbors(orderedIds, issue.id)
  const repo = issue.repoPath.split('/').filter(Boolean).pop() ?? issue.repoPath
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="issue-page">
      <header className="flex items-center gap-2 border-border border-b px-4 py-2.5">
        <Button type="button" variant="ghost" size="icon-sm" title="Back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden="true" />
        </Button>
        <span className="text-[13px] text-muted-foreground">{repo}</span>
        <span className="text-[13px] text-muted-foreground">›</span>
        <span className="font-medium text-[13px]">#{issue.seq}</span>
        <Button type="button" variant="ghost" size="icon-sm" title="Copy issue id"
          onClick={() => void navigator.clipboard.writeText(`#${issue.seq}`)}>
          <Copy size={13} aria-hidden="true" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" title="Previous issue" disabled={!prev}
            onClick={() => prev && onNavigate(prev)}><ChevronUp size={15} aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" title="Next issue" disabled={!next}
            onClick={() => next && onNavigate(next)}><ChevronDown size={15} aria-hidden="true" /></Button>
          <IssueOverflowMenu issue={issue} onDeleted={onBack} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
          {/* banners → title → description → (sub-issues Task 11) → activity */}
        </div>
        <aside className="hidden w-[280px] shrink-0 overflow-y-auto border-border border-l px-4 py-4 md:block">
          {/* properties sidebar — Task 9; until then keep the existing Stage <Select> here */}
        </aside>
      </div>
    </div>
  )
}
```

Main column in this task:
1. **Banners** — port the suggested-stage block from `IssueDetail.tsx:172-200` verbatim; add the needs-human banner (port the resolve/flag logic from IssueDetail's Lifecycle section: banner with `issue.humanQuestion` + `Resolve` → `clearNeedsHuman`; when not flagged, no banner — flagging moves to the overflow menu as "Flag for human…" using `window.prompt` for the question).
2. **Title** — inline edit: render an `<h1>`-styled `<button>` that swaps to an `<Input defaultValue={issue.title}>` on click; commit on Enter/blur via `update.mutate({ id, patch: { title } })` when changed; Esc cancels.
3. **Description** — same pattern with `<Textarea>` (Cmd/Ctrl+Enter or blur commits, Esc cancels); render the read view through the existing `MarkdownPreview` component if its props fit (`grep -n "export function MarkdownPreview" apps/web/src/MarkdownPreview.tsx` to check the signature; if it needs file-scope props, render plain `whitespace-pre-wrap` text instead — do not force it).
4. **Activity** — port the comments section from `IssueDetail.tsx` (list + composer at the bottom, `addComment`, Cmd+Enter submits); render `issue.activityNotes` as one system-styled entry at the top of the feed with the Refresh button (`refreshAssistant`).
5. `IssueOverflowMenu` — `DropdownMenu` with: Copy branch name (`issue.branch` → clipboard, only when set), Open in Linear (when `issue.linearUrl`), Flag for human…, Supersede with… / Duplicate of… (submenu listing `targetIssues` — port from IssueDetail's selects), Delete (confirm → `delete.mutate` → `onDeleted()`).

- [ ] **Step 4: Routing swap**

In `IssuesView`: `const open = issues.find((i) => i.id === openIssueId)`; when set, render `<IssuePage issue={open} orderedIds={flattenGroups(groupIssuesByStage(active, display.ordering))} onBack={() => setOpenIssueId(null)} onNavigate={setOpenIssueId} />` instead of the header+board/list. Remove `<IssueDetailHost />` from `AppShell.tsx` and `MobileApp.tsx`. In `Sidebar.tsx` `selectIssue`, add `setView('issues')` next to `setOpenIssueId(id)` for the unstarted branch. Add an `Escape` keydown handler on the page (`useEffect` + window listener, skipped when an input/textarea/contenteditable has focus) calling `onBack`.

- [ ] **Step 5: Verify** — typecheck, unit tests, build, run the browser e2e (existing specs opened the drawer by clicking a card; update assertions to `data-testid="issue-page"`).

- [ ] **Step 6: Commit** — `feat(web): full issue page replaces detail drawer (header, banners, inline edit, activity) [podium #9]`

---

### Task 9: Issue page — properties sidebar

**Files:**
- Modify: `apps/web/src/IssuePage.tsx` (fill the `<aside>`)
- Create: `apps/web/src/issue-relations.ts` + test (pure grouping)

**Interfaces:**
- Consumes: `PropertyMenu` (Task 7).
- Produces: `groupRelations(issue: IssueWire): { section: string; entries: { id: string; type: string; direction: 'dep' | 'dependent' }[] }[]` — sections in order: "Blocked by" (deps type `blocks`? **verify semantics**: read `apps/server/src/issue-util.ts` / `issues.ts` to confirm whether `deps: [{id,type:'blocks'}]` means "this issue is blocked by id" (bd semantics: a dep FROM this TO id with type blocks usually means this blocks id — confirm against how `blockedBy[]` is computed) — then: "Blocked by" (whichever side matches `blockedBy`), "Blocks" (the other side), "Related", "Discovered from", everything else grouped by type label. Write the test to match the verified semantics.

- [ ] **Step 1: Verify dep semantics** — `grep -n "blockedBy\|'blocks'" apps/server/src/issues.ts apps/server/src/issue-util.ts | head -30`, read the relevant lines, and note the direction in a comment in `issue-relations.ts`.

- [ ] **Step 2: Failing test for `groupRelations`** (with the verified direction; cover: blocked-by vs blocks split, related, misc types, empty → `[]`).

- [ ] **Step 3: Implement `groupRelations`**, run tests.

- [ ] **Step 4: Sidebar rows.** Each property row is a labeled `PropertyMenu` trigger button showing the current value:

```tsx
function PropertyRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-20 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
```

Rows in order (all mutations via the existing `run()` wrapper):
1. **Status** — options = 6 stages (icon = `StageGlyph`) + separator + `Close: done` / `Close: wontfix` (→ `close.mutate({ id, reason })` — check the router input name: `sed -n '/close:/,/mutation/p' apps/server/src/router.ts`) + `Reopen` when closed (→ `update` patch `{ closedReason: '' , stage: 'backlog' }` — **verify** the service supports clearing `closedReason`; if not, surface reopen only via what `IssueService` supports and drop the item otherwise).
2. **Priority** — P0–P4 with `PriorityGlyph` icons → `update {priority}`.
3. **Assignee** — distinct assignees across `issues` + Unassigned + free text (`allowFreeText`) → `update {assignee}`.
4. **Type** — `IssueType.options` → `update {type}`.
5. **Labels** — multi-select behaves differently: keep chips inline with `x` to remove + a `PropertyMenu` (`allowFreeText`, options = distinct labels across `issues`) whose `onSelect` adds to the set → `setLabels.mutate({ id, labels })` (check exact input: `grep -n "setLabels" apps/server/src/router.ts`).
6. **Estimate** — small inline `Input type="number"` (minutes), commit on blur/Enter → `update {estimateMin}`.
7. **Due date** — `Input type="date"` → `update {dueAt}` (ISO from the date value); clear button when set.
8. **Defer** — `Input type="date"` + Defer button → `defer.mutate` (port exact call from `IssueDetail.tsx`'s defer section — read it before porting); `Undefer` when `issue.deferUntil`.
9. **Relations** — `groupRelations` sections; each entry: seq+title of the target (resolve id via `issues.find`), hover `x` → `depRemove` (check input shape in router); `+ Add relation` = type `PropertyMenu` (dep types minus `parent-child`/`supersedes`) then target `PropertyMenu` (repo-mates, labels `#seq title`) → `depAdd`.
10. **Parent** — row showing parent (`#seq title`, click → `onNavigate(parentId)`), `PropertyMenu` to change (→ `reparent.mutate` — check input) with a `No parent` option.
11. **Sessions** — port from `IssueDetail.tsx:776-828` unchanged (list + open, `+ Session` / `+ Shell` / `Start work`).
12. **Git** — port from `IssueDetail.tsx:830-891` unchanged (mergeStyle primary, Rebase, PR link).

- [ ] **Step 5: Mobile** — the `<aside>` is hidden on `<md`; add a `Details` disclosure (`<details>`) rendering the same rows above the activity feed on mobile.

- [ ] **Step 6: Verify** — typecheck, unit, build, then a manual-quality browser e2e: extend `issues.browser.e2e.ts` with "open issue page → change stage via Status dropdown → lane membership updates" and "add a comment" scenarios (real clicks).

- [ ] **Step 7: Commit** — `feat(web): issue page properties sidebar (Linear property rows + relations + sessions + git) [podium #9]`

---

### Task 10: Delete the drawer; sidebar polish

**Files:**
- Delete: `apps/web/src/IssueDetail.tsx`, `apps/web/src/IssueDetailHost.tsx`
- Modify: `apps/web/src/Sidebar.tsx` — `IssueBlock` stage pill → `StageGlyph` + label; keep the rest
- Modify: `apps/web/src/issue-detail-fields.ts` — delete if now unused, or trim to what `IssuePage` consumes (`grep -rn "issueDetailFields\|IssueDetail" apps/web/src tests/` first; delete `issue-detail-fields.test.ts` alongside if the module goes)

- [ ] **Step 1:** Grep for remaining references; remove/replace them.
- [ ] **Step 2:** `bun run typecheck && bun run --cwd apps/web test -- --run && bun run build`
- [ ] **Step 3:** Commit — `refactor(web): remove issue drawer; stage glyphs in sidebar issues tab [podium #9]`

---

### Task 11: Sub-issues section

**Files:**
- Modify: `apps/web/src/IssuePage.tsx` (main column, between description and activity)

**Interfaces:**
- Consumes: `issues` from store (children = `issues.filter(i => i.parentId === issue.id)`), `StageGlyph`, `AssigneeAvatar`.

- [ ] **Step 1: Section UI**

```tsx
<section className="flex flex-col gap-1">
  <div className="flex items-center gap-2">
    <h3 className="font-medium text-[13px]">Sub-issues</h3>
    {issue.childCount > 0 && (
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {issue.childDoneCount}/{issue.childCount}
      </span>
    )}
  </div>
  {children.map((c) => (
    <button key={c.id} type="button"
      className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/50"
      onClick={() => onNavigate(c.id)}>
      <StageGlyph stage={c.stage} />
      <span className="text-[11px] text-muted-foreground">#{c.seq}</span>
      <span className="min-w-0 flex-1 truncate">{c.title}</span>
      <AssigneeAvatar assignee={c.assignee || undefined} size={16} />
    </button>
  ))}
  {adding ? (
    <Input autoFocus placeholder="Sub-issue title…" value={subTitle}
      onChange={(e) => setSubTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && subTitle.trim()) {
          void run(() => trpc.issues.create.mutate({
            repoPath: issue.repoPath, title: subTitle.trim(), parentId: issue.id, startNow: false,
          }))
          setSubTitle('')
        }
        if (e.key === 'Escape') { setAdding(false); setSubTitle('') }
      }} />
  ) : (
    <Button type="button" variant="ghost" size="sm" className="justify-start text-muted-foreground"
      onClick={() => setAdding(true)}>
      <Plus size={13} aria-hidden="true" /> Add sub-issue
    </Button>
  )}
</section>
```

Render the section always when `children.length > 0`, otherwise just the add affordance.

- [ ] **Step 2:** Verify (typecheck/unit/build) + extend e2e: "add sub-issue inline → child row appears → parent shows 0/1".
- [ ] **Step 3:** Commit — `feat(web): sub-issues section on issue page [podium #9]`

---

### Task 12: Composer rework (`NewIssueDialog.tsx`)

Linear-style: title + description prominent, properties as a pill row, Create more toggle.

**Files:**
- Modify: `apps/web/src/NewIssueDialog.tsx`

**Interfaces:**
- Consumes: `PropertyMenu`, glyphs; `create` accepts `priority/type/assignee/labels/parentId` directly (verified in router).
- Produces: `NewIssueDialog({ onClose, initialStage? })`. On submit builds the create input; when `initialStage` and ≠ `'backlog'`, follow the resolution from Task 5 Step 2 (patch stage after create if `create` returns the row; otherwise composer creates in backlog and the stage pill is display-only preset — whatever Task 5 established).

- [ ] **Step 1: Rework layout** — keep Dialog; body becomes: borderless title `Input` (placeholder "Issue title", larger text), `Textarea` (placeholder "Add description…"), then the pill row:

```tsx
<div className="flex flex-wrap items-center gap-1.5">
  <PropertyMenu trigger={<PillButton icon={<StageGlyph stage={stage} />} label={STAGE_LABELS[stage]} />}
    options={stageOptions} selectedValue={stage} onSelect={(v) => setStage(v as IssueStage)} />
  <PropertyMenu trigger={<PillButton icon={<PriorityGlyph priority={priority} />} label={`P${priority}`} />}
    options={priorityOptions} selectedValue={String(priority)} onSelect={(v) => setPriority(Number(v))} />
  <PropertyMenu trigger={<PillButton label={type} />} options={typeOptions} selectedValue={type} onSelect={setType} />
  <PropertyMenu trigger={<PillButton label={labels.length ? labels.join(', ') : 'Labels'} />}
    options={labelOptions} allowFreeText onSelect={(v) => setLabels((ls) => ls.includes(v) ? ls.filter((x) => x !== v) : [...ls, v])} />
  <PropertyMenu trigger={<PillButton label={assignee || 'Assignee'} />} options={assigneeOptions} allowFreeText onSelect={setAssignee} />
  <PropertyMenu trigger={<PillButton label={repoLabel(repoPath) || 'Repo'} />} options={repoOptions} selectedValue={repoPath} onSelect={setRepoPath} />
  <PropertyMenu trigger={<PillButton label={agent || 'Agent'} />} options={agentOptions} selectedValue={agent} onSelect={setAgent} />
</div>
```

`PillButton` = small outlined button (`variant="outline" size="sm" className="h-6 gap-1 rounded-full px-2 text-[12px]"`). Keep: parent-branch `Input` (compact, under an "Advanced" `<details>` with the Linear import), Start-work `Checkbox`.

- [ ] **Step 2: Footer** — left: `Create more` `Switch` + label; right: Cancel / Create. On submit success: if createMore, reset title/description (+ keep properties), focus title; else `onClose()`. Add `onKeyDown` on the DialogContent: Cmd/Ctrl+Enter submits when valid.

- [ ] **Step 3: Submit** — extend the mutate input with `priority, type, assignee, labels` (omit when defaults: priority 2, type task, no assignee/labels).

- [ ] **Step 4:** Verify: typecheck/unit/build + e2e "create via composer with Create more stays open and creates two issues".
- [ ] **Step 5:** Commit — `feat(web): Linear-style issue composer (property pills, create-more) [podium #9]`

---

### Task 13: Keyboard core + multi-select bulk bar

**Files:**
- Create: `apps/web/src/issues-keys.ts` + `apps/web/src/issues-keys.test.ts`
- Modify: `apps/web/src/IssuesView.tsx` (key handling, focus ring, bulk bar)

**Interfaces:**
- Produces:

```ts
export interface IssuesKeyState { focusId: string | null; selected: string[] }
export type IssuesNav =
  | { kind: 'rows'; ids: string[] }
  | { kind: 'columns'; columns: string[][] }
export type IssuesKeyAction =
  | { kind: 'next' } | { kind: 'prev' }        // ↓/J, ↑/K
  | { kind: 'left' } | { kind: 'right' }        // board only: ←/→ across columns, keep index
  | { kind: 'toggleSelect' }                    // X on the focused issue
  | { kind: 'clear' }                           // Esc: selected → [], else focus → null
export function issuesKeyReduce(s: IssuesKeyState, a: IssuesKeyAction, nav: IssuesNav): IssuesKeyState
```

- [ ] **Step 1: Failing tests** — cover: next/prev over rows (wraps not required — clamp at ends; from `null` focus, `next` focuses the first id); left/right on columns moves to the same index in the adjacent non-empty column (clamped to its length); toggleSelect adds/removes focusId (no-op when focus null); clear drops selection first, focus second; focus vanishing from nav (issue moved/deleted) — reducer never returns a focusId not present in nav (normalize to null).

```ts
// representative cases
expect(issuesKeyReduce({ focusId: null, selected: [] }, { kind: 'next' }, rows(['a','b'])).focusId).toBe('a')
expect(issuesKeyReduce({ focusId: 'b', selected: [] }, { kind: 'next' }, rows(['a','b'])).focusId).toBe('b')
expect(issuesKeyReduce({ focusId: 'a', selected: [] }, { kind: 'right' }, cols([['a'],['x','y']])).focusId).toBe('x')
expect(issuesKeyReduce({ focusId: 'a', selected: ['a'] }, { kind: 'clear' }, rows(['a'])).selected).toEqual([])
expect(issuesKeyReduce({ focusId: 'gone', selected: [] }, { kind: 'next' }, rows(['a'])).focusId).toBe('a')
```

- [ ] **Step 2: Implement the reducer** (pure; flatten `columns` for next/prev).

- [ ] **Step 3: Wire into IssuesView** — a `useEffect` window keydown listener active when `view === 'issues'`, no dialog open, no issue page open, and `document.activeElement` is not an input/textarea/select/contenteditable:
  - `c` → open composer; `Escape` → dispatch clear; `j/ArrowDown`, `k/ArrowUp`, `ArrowLeft`, `ArrowRight` → dispatch; `Enter` → `setOpenIssueId(focusId)`; `x` → toggleSelect; `s`/`p`/`a`/`l` → open the corresponding `PropertyMenu` for the focused issue.
  - For `s/p/a/l` anchoring: render one shared controlled `PropertyMenu`-style `DropdownMenu` (`open` prop) positioned near the focused card/row (`document.querySelector(`[data-issue-id="${focusId}"]`)` + Base UI anchor or a fixed-position fallback near the element's rect). Cards/rows get `data-issue-id` and a focus ring class when `focusId` matches (`ring-2 ring-primary/60`); on the issue page, `s/p/a/l` open the sidebar row menus (pass a controlled-open flag down).
  - Multi-select visuals: selected cards/rows get `bg-primary/10`; hover checkbox optional (skip — X + click with the ring is enough for this pass; Shift+click adds the clicked issue to the selection).
  - **Bulk bar** (rendered when `selected.length > 0`, fixed bottom center): `N selected` + Stage `PropertyMenu` + Priority `PropertyMenu` (each loops `update.mutate` over selection) + Delete (confirm once, loops `delete.mutate`) + Clear.

- [ ] **Step 4:** Verify: unit + typecheck + build + e2e: "J/J/Enter opens the second issue", "X X on two issues → bulk bar shows 2 selected → bulk stage change moves both".
- [ ] **Step 5:** Commit — `feat(web): core keyboard nav + multi-select bulk bar for issues [podium #9]`

---

### Task 14: E2E consolidation, full verification, follow-ups

**Files:**
- Modify: `tests/e2e/browser/issues.browser.e2e.ts` (ensure scenarios from Tasks 5–13 are all present and green together)
- Verify: whole suite

- [ ] **Step 1:** Full run: `bun run typecheck && bun run test && bun run build`, then the browser e2e suite (same-origin harness; fresh worktrees need `bun run build` first or playwright collection fails).
- [ ] **Step 2:** Invoke the `verify` skill: drive the real UI in headless Chromium (board→list toggle, open issue, edit properties, comment, sub-issue, composer, keyboard) against an isolated Podium (see memory: isolated server via `PODIUM_PORT`/`PODIUM_STATE_DIR`).
- [ ] **Step 3:** File follow-up issues (`podium issue create … && podium issue dep-add --fromId <new> --toId <#9-id> --type discovered-from`): Cmd+K command palette; right-click context menu; composer draft persistence; manual within-column ordering; saved views.
- [ ] **Step 4:** Checkpoint notes on issue #9 (`podium issue …` comment) + final commit.

---

## Self-review notes (already applied)

- Spec coverage: header/chips (T5), board card/lanes (T2/3/5), list view + mobile (T6), issue page header/banners/main (T8), properties sidebar/relations/sessions/git (T9), sub-issues (T11), composer (T12), keyboard+bulk (T13), sidebar tab polish (T10), tests (throughout + T14), follow-up issues (T14). Drawer removal (T10).
- Known open verifications embedded as explicit steps: `create` return value (T5), dep direction semantics (T9), `close`/`setLabels`/`depAdd`/`reparent` exact input shapes (T9), MarkdownPreview props (T8), Base UI menu + input interplay (T7).
- Naming consistency: `IssuesDisplay`/`readIssuesDisplay`/`orderIssues` (T1) consumed in T5/T6; `flattenGroups` (T6) consumed in T8/T13; `PropertyMenu` (T7) consumed in T9/T12/T13; `issueCardModel` extensions (T3) consumed in T5/T6.

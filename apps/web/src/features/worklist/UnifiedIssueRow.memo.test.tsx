// @vitest-environment happy-dom
/** Pool-only row regression. An unrelated publication changes row B;
 * A and C retain their objects, scalars and callbacks. The last green legacy
 * control's identical text is frozen below; only B may render. */

import type { UnifiedIssueRow as UnifiedIssueRowView } from '@podium/client-core/values'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { issueDisplayRef } from '@podium/protocol'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { poolIssueDisplay } from './pool-row-data'
import { UnifiedIssueRow } from './UnifiedIssueRow'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const shellCounts = vi.hoisted(() => new Map<string, number>())

vi.mock('./WorkRowShell', async () => {
  const real = await vi.importActual<typeof import('./WorkRowShell')>('./WorkRowShell')
  return {
    ...real,
    WorkRowShell: (props: Parameters<typeof real.WorkRowShell>[0]) => {
      const mark = (props as { domMark?: string }).domMark ?? '?'
      shellCounts.set(mark, (shellCounts.get(mark) ?? 0) + 1)
      return real.WorkRowShell(props)
    },
  }
})

// UnifiedIssueRow picked up the pool-backed NotSavedMark after this suite was
// written (POD-5490). The mark is not under test here — the suite counts
// row commits — so it stays stubbed and the rows mount provider-free.
vi.mock('@/components/NotSavedMark', () => ({ NotSavedMark: () => null }))

afterEach(() => {
  cleanup()
  shellCounts.clear()
})

const NOW = Date.parse('2026-08-12T12:00:00.000Z')

const PROG_A = { total: 3, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_B = { total: 2, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_C = { total: 4, done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 2 }

it('preserves continuation text ahead of child progress and pending decisions', () => {
  const row = {
    ...baseRows(baseIssues()).rowA,
    continuation: 'continued · POD-2',
    missionRollup: { progress: PROG_A, fromChildren: true },
  }
  const props = {
    row,
    active: false,
    progress: PROG_A,
    origin: null,
    now: NOW,
    onSelectIssue: fixedSelect,
    onSelectPanelForIssue: fixedSelectPanel,
    onOpenIssue: fixedOpen,
    onRenameIssue: fixedRename,
  }
  const facts = {
    issue: row.issue,
    timing: { phase: 'queued', sinceMs: 1 },
    working: false,
    decision: 'review',
    unread: false,
    errorClass: null,
    draftAgentOnly: false,
    deferred: false,
    unsnoozed: false,
    awaitingFirstPrompt: false,
    statusFromChildren: true,
    progress: PROG_A,
    continuation: { kind: 'continued', ref: 'POD-2' },
    fleet: { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] },
  } as unknown as SidebarRowValues
  const pool = render(<UnifiedIssueRow {...props} display={poolIssueDisplay(facts)} />)
  expect(pool.getByText('continued · POD-2')).toBeTruthy()
  expect(pool.queryByText('1/3 subtasks done · 1 underway')).toBeNull()
})

function baseIssues() {
  const a = makeIssue({ id: 'a', seq: 1, displayRef: 'POD-1', title: 'Alpha' })
  const b = makeIssue({
    id: 'b',
    seq: 2,
    displayRef: 'POD-2',
    title: 'Bravo',
    deps: [{ id: 'a', type: 'discovered-from' }],
  })
  const c = makeIssue({ id: 'c', seq: 3, displayRef: 'POD-3', title: 'Charlie' })
  return { a, b, c }
}

function baseRows(issues: ReturnType<typeof baseIssues>): {
  rowA: UnifiedIssueRowView
  rowB: UnifiedIssueRowView
  rowC: UnifiedIssueRowView
} {
  return {
    rowA: {
      kind: 'issue',
      issue: issues.a,
      sessions: [],
      activityAt: 1,
      missionRollup: { progress: PROG_A, fromChildren: false },
    },
    rowB: {
      kind: 'issue',
      issue: issues.b,
      sessions: [],
      activityAt: 2,
      missionRollup: { progress: PROG_B, fromChildren: false },
    },
    rowC: {
      kind: 'issue',
      issue: issues.c,
      sessions: [],
      activityAt: 3,
      missionRollup: { progress: PROG_C, fromChildren: false },
    },
  }
}

/** Fixed list: narrow scalars + stable callbacks into the memoized row. */
const fixedSelect = vi.fn()
const fixedSelectPanel = vi.fn()
const fixedOpen = vi.fn()
const fixedRename = vi.fn()
const fixedResolvers = new Map<string, () => { single: unknown[]; all: unknown[] }>()

function FixedList({
  rows,
  titles,
  issues,
}: {
  rows: ReturnType<typeof baseRows>
  titles: Map<string, string>
  issues: unknown[]
}) {
  const list = [rows.rowA, rows.rowB, rows.rowC] as const
  return (
    <>
      {list.map((row) => {
        const id = row.issue.id
        let resolve = fixedResolvers.get(id)
        if (!resolve) {
          resolve = () => ({
            single: [],
            all: issues,
            poolInputs: { sessions: [], repos: [], machines: [] },
          })
          fixedResolvers.set(id, resolve)
        }
        const origin =
          id === 'b'
            ? {
                id: 'a' as never,
                seq: 1,
                title: 'Alpha',
                ref: issueDisplayRef(issues[0] as never),
              }
            : null
        return (
          <UnifiedIssueRow
            key={id}
            row={row as never}
            displayTitle={titles.get(id) ?? row.issue.title}
            progress={(id === 'a' ? PROG_A : id === 'b' ? PROG_B : PROG_C) as never}
            origin={origin}
            active={false}
            resolveMenuData={resolve as never}
            now={NOW}
            onSelectIssue={fixedSelect as never}
            onSelectPanelForIssue={fixedSelectPanel as never}
            onOpenIssue={fixedOpen as never}
            onRenameIssue={fixedRename as never}
          />
        )
      })}
    </>
  )
}

describe('worklist row memo (POD-4421)', () => {
  it('commits only the changed row on an unrelated publish with the last green text', () => {
    shellCounts.clear()
    fixedResolvers.clear()
    const fixedIssues = baseIssues()
    const fixedRows = baseRows(fixedIssues)
    const titles = new Map([
      ['a', 'Alpha'],
      ['b', 'Bravo'],
      ['c', 'Charlie'],
    ])
    const fixed = render(
      <FixedList
        rows={fixedRows}
        titles={titles}
        issues={[fixedIssues.a, fixedIssues.b, fixedIssues.c]}
      />,
    )
    shellCounts.clear()
    const fixedB2 = { ...fixedIssues.b, title: 'Bravo!' }
    const fixedRows2 = {
      ...fixedRows,
      rowB: { ...fixedRows.rowB, issue: fixedB2, activityAt: 4 },
    }
    const titles2 = new Map([
      ['a', 'Alpha'],
      ['b', 'Bravo!'],
      ['c', 'Charlie'],
    ])
    fixed.rerender(
      <FixedList
        rows={fixedRows2}
        titles={titles2}
        issues={[fixedIssues.a, fixedB2, fixedIssues.c]}
      />,
    )
    const fixedAfter = new Map(shellCounts)
    const fixedText = fixed.container.textContent ?? ''

    fixed.unmount()

    // Only the changed row committed.
    expect(fixedAfter.get('b')).toBe(1)
    expect(fixedAfter.get('a') ?? 0).toBe(0)
    expect(fixedAfter.get('c') ?? 0).toBe(0)

    // Frozen output from the last green parity control.
    expect(fixedText).toBe(
      'POD-11Alphain progressPOD-22Bravo!in progress⤷ 1POD-33Charliein progress',
    )
    for (const title of ['Alpha', 'Bravo!', 'Charlie']) {
      expect(fixedText).toContain(title)
    }
    // The addressed origin tick remains visible.
    expect(fixedText).toContain('⤷ 1')
  })
})

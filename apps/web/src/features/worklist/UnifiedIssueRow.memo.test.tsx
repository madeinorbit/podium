// @vitest-environment happy-dom
/**
 * ROW-LEVEL RENDER COUNTS (POD-4421).
 *
 * Every visible worklist row used to re-render on every publish: each row
 * received the whole `issues`/`sessions` arrays (fresh identities per
 * publish) plus fresh closures, and then ran its own `issues.find` on top.
 * The fix narrows each row to its row object (stable via
 * `reuseUnifiedWorkRows`) plus scalars with stable references, behind `memo`.
 *
 * This probe counts `WorkRowShell` renders per row (the shell renders exactly
 * once per row render, inside the memo boundary) across an unrelated publish
 * — a change to row B while A and C keep their object identities:
 *
 *   FIXED arm: only B commits (1 row render for 1 changed row).
 *   LEGACY arm (the pre-fix data flow — whole arrays + fresh closures into
 *   the unmemoized row): A and C commit too, so it FAILS the fixed assertion.
 *
 * The control dimension is the visible output: both arms must render
 * byte-identical text after the publish, so the win cannot come from doing
 * less work.
 */
import { issueDisplayRef } from '@podium/protocol'
import type { UnifiedIssueRow as UnifiedIssueRowView } from '@podium/client-core/viewmodels'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { UnifiedIssueRow, UnifiedIssueRowInner } from './UnifiedIssueRow'

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

afterEach(() => {
  cleanup()
  shellCounts.clear()
})

const NOW = Date.parse('2026-08-12T12:00:00.000Z')

const PROG_A = { total: 3, done: 1, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_B = { total: 2, done: 0, run: 1, review: 0, stall: 0, block: 0, wait: 1 }
const PROG_C = { total: 4, done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 2 }

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

/** Legacy list: the pre-fix data flow — whole arrays, fresh closures, no memo. */
function LegacyList({
  rows,
  issues,
  sessions,
  paths,
}: {
  rows: ReturnType<typeof baseRows>
  issues: unknown[]
  sessions: never[]
  paths: string[]
}) {
  const list = [rows.rowA, rows.rowB, rows.rowC] as const
  return (
    <>
      {list.map((row) => (
        <UnifiedIssueRowInner
          key={row.issue.id}
          row={row as never}
          sessions={sessions as never}
          issues={issues as never}
          allWorktreePaths={paths}
          selectedIssueId={null}
          paneA={null}
          now={NOW}
          onSelectIssue={(issue) => void issue}
          onSelectPanelForIssue={(issue, sid) => void [issue, sid]}
          onOpenIssue={(id) => void id}
          onRenameIssue={(id, title) => void [id, title]}
        />
      ))}
    </>
  )
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
          resolve = () => ({ single: [], all: issues })
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
            progress={
              (id === 'a' ? PROG_A : id === 'b' ? PROG_B : PROG_C) as never
            }
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
  it('commits only the changed row on an unrelated publish; legacy repaints all', () => {
    // ---- LEGACY arm ----
    const legacyIssues = baseIssues()
    const legacyRows = baseRows(legacyIssues)
    const legacy = render(
      <LegacyList
        rows={legacyRows}
        issues={[legacyIssues.a, legacyIssues.b, legacyIssues.c]}
        sessions={[]}
        paths={[]}
      />,
    )
    shellCounts.clear()
    // Unrelated publish: B's issue object changes; A and C keep theirs — but
    // the arrays themselves are fresh identities, as every store publish makes.
    const legacyB2 = { ...legacyIssues.b, title: 'Bravo!' }
    const legacyRows2 = {
      ...legacyRows,
      rowB: { ...legacyRows.rowB, issue: legacyB2, activityAt: 4 },
    }
    legacy.rerender(
      <LegacyList
        rows={legacyRows2}
        issues={[legacyIssues.a, legacyB2, legacyIssues.c]}
        sessions={[]}
        paths={[]}
      />,
    )
    const legacyAfter = new Map(shellCounts)
    const legacyText = legacy.container.textContent ?? ''
    legacy.unmount()

    // The control must FAIL the new assertion: unchanged rows committed.
    expect(legacyAfter.get('a')).toBeGreaterThan(0)
    expect(legacyAfter.get('c')).toBeGreaterThan(0)
    expect(legacyAfter.get('b')).toBeGreaterThan(0)

    // ---- FIXED arm ----
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

    // Control dimension: identical visible output in both arms.
    expect(fixedText).toBe(legacyText)
    for (const title of ['Alpha', 'Bravo!', 'Charlie']) {
      expect(fixedText).toContain(title)
    }
    // The origin tick survived the narrowing in both arms.
    expect(fixedText).toContain('⤷ 1')
  })
})

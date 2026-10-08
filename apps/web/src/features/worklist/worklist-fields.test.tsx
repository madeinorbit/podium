// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MobxPool } from '@podium/client-graph/pool'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { WorklistIssueRow, UnifiedIssueRow } from './UnifiedIssueRow'
import { poolIssueDisplay, poolIssueRow, sidebarExitSnapshot } from './pool-row-data'
const stamp = '2026-10-08T12:00:00Z'
afterEach(cleanup)
it('an archived resident merge row exits with its previous paint and supplies no live drawing row', async () => {
  const pool = new MobxPool({ selectedIssueId: 'merge', coarseNow: Date.parse(stamp) })
  const record = { id: 'merge', seq: 3, title: 'Ready to land', repoPath: '/synthetic', stage: 'done',
    createdAt: stamp, updatedAt: stamp, closedAt: stamp, audience: 'human', gitState: { ahead: 3, merged: false } }
  pool.apply({ type: 'replace', rows: [{ kind: 'issue', id: 'merge', value: record as never }] })
  const row = worklistView(pool).row(pool.issueObject('merge'))
  const callbacks = { now: Date.parse(stamp), onSelectIssue() {}, onSelectPanelForIssue() {}, onOpenIssue() {}, onRenameIssue() {} }
  try {
    expect(row.issue.awaitingMerge).toBe(true)
    const before = sidebarExitSnapshot(row)
    const rendered = render(<WorklistIssueRow model={row} {...callbacks} />)
    const paint = screen.getByTestId('unified-issue-row').textContent
    await act(async () => {
      pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'merge', value: { ...record, archived: true } as never }] })
      // This is the existing PoolMotionRow exit path: the last paint only.
      rendered.rerender(<UnifiedIssueRow row={poolIssueRow(before)} display={poolIssueDisplay(before)}
        displayTitle={before.title} progress={before.progress} {...callbacks} />)
    })
    expect(row.issue.inMemory).toBe(true)
    expect(row.issue.excluded).toBe(true)
    expect(row.ready).toBeUndefined()
    expect(sidebarView(pool).row('merge')).toBeUndefined()
    expect(screen.getByTestId('unified-issue-row').textContent).toBe(paint)
    expect(screen.getByTestId('awaiting-merge-status').textContent).toContain('ready to merge · 3')
  } finally { pool.dispose() }
})

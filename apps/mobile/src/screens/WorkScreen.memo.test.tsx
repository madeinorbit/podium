/** A worklist companion stays live; only the changed visible row commits. */
import { MobxPool } from '@podium/client-graph/pool'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import type { WorklistIssue } from '@podium/client-graph/worklist/issue'
import { act, cleanup, render } from '@testing-library/react'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
const pressCounts = vi.hoisted(() => new Map<string, number>())
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: React.ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})
vi.mock('../components/PressableScale', () => ({
  PressableScale: ({ children, accessibilityLabel }: never) => {
    const key = String((accessibilityLabel as string | undefined) ?? '?')
    pressCounts.set(key, (pressCounts.get(key) ?? 0) + 1)
    return <div data-label={key}>{children as never}</div>
  },
}))
vi.mock('../components/NotSavedMark', () => ({ NotSavedMark: () => null }))
const { WorkRow } = await import('./WorkListRow')
afterEach(() => pressCounts.clear())

const open = vi.fn(), longPress = vi.fn()
function List({ list }: { list: WorklistIssue[] }) {
  return <>{list.map(row => <WorkRow key={row.id} row={row} navPending={false}
    onOpen={open} onLongPress={longPress} />)}</>
}

describe('mobile worklist companion row', () => {
  it('commits only the changed row and keeps the accepted visible titles', () => {
    const stamp = '2026-10-01T12:00:00Z'
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
    const issues = ['Alpha', 'Bravo', 'Charlie'].map((title, index) => ({
      id: ['a', 'b', 'c'][index]!, seq: index + 1, title, stage: 'in_progress',
      audience: 'human', repoId: 'R', repoPath: '/repo', createdAt: stamp, updatedAt: stamp,
    }))
    runInAction(() => pool.apply({ type: 'replace', rows: [
      { kind: 'repo', id: 'R', value: { id: 'R', repoPath: '/repo', prefix: 'POD' } },
      ...issues.map(value => ({ kind: 'issue' as const, id: value.id, value })),
    ] }))
    const model = worklistView(pool)
    const list = issues.map(issue => model.row(pool.issueObject(issue.id)))
    const view = render(<List list={list} />)
    try {
      pressCounts.clear()
      act(() => runInAction(() => pool.apply({ type: 'update', rows: [
        { kind: 'issue', id: 'b', value: { ...issues[1]!, title: 'Bravo!' } },
      ] })))
      expect(pressCounts.get('POD-2 Bravo!')).toBe(1)
      expect(pressCounts.get('POD-1 Alpha') ?? 0).toBe(0)
      expect(pressCounts.get('POD-3 Charlie') ?? 0).toBe(0)
      for (const title of ['Alpha', 'Bravo!', 'Charlie']) expect(view.container.textContent).toContain(title)
    } finally { view.unmount(); pool.dispose() }
  })
})

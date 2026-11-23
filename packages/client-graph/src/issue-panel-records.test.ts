import { autorun, runInAction } from 'mobx'
import { expect, it } from 'vitest'
import { requireHere } from './lookup'
import { MobxPool } from './pool'

const stamp = '2026-11-10T00:00:00Z'
const task = {
  kind: 'issue' as const,
  id: 'issue',
  value: {
    id: 'issue',
    seq: 1,
    title: 'Task',
    stage: 'in_progress',
    audience: 'human',
    repoPath: '/fixture',
    createdAt: stamp,
    updatedAt: stamp,
  },
}
const todo = (id: string, position: number, done = false) => ({
  kind: 'issuePanelTodo' as const,
  id,
  value: { id, issueId: 'issue', position, text: 'Same', done },
})
it('holds one model per item, keeps lists stable on a tick and follows membership and ordering', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: [task, todo('b', 4), todo('a', 0)] })
  const issue = requireHere(pool.model('issue', 'issue'))
  let list = issue.panelTodos,
    panels = 0,
    done = false
  const stopList = autorun(() => {
    list = issue.panelTodos
    void issue.panel
    panels++
  })
  const stopDone = autorun(() => {
    done = issue.panelTodos[0]?.done ?? false
  })
  const first = list,
    firstItem = list[0]
  try {
    expect(list.map((r) => r.id)).toEqual(['a', 'b'])
    runInAction(() => pool.apply({ type: 'update', rows: [todo('a', 0, true)] }))
    expect(done).toBe(true)
    expect(list).toBe(first)
    expect(list[0]).toBe(firstItem)
    expect(panels).toBe(1)
    expect(requireHere(pool.model('issuePanelTodo', 'a'))).toBe(firstItem)
    runInAction(() =>
      pool.apply({
        type: 'update',
        rows: [{ kind: 'issuePanelTodo', id: 'a', value: undefined }, todo('c', 7)],
      }),
    )
    expect(list.map((r) => r.id)).toEqual(['b', 'c'])
    expect(list[0]).toBe(first[1])
    runInAction(() => pool.apply({ type: 'update', rows: [todo('c', 1)] }))
    expect(list.map((r) => r.id)).toEqual(['c', 'b'])
  } finally {
    stopList()
    stopDone()
    pool.dispose()
  }
})
it('reads state and artifacts independently from their own records', () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) })
  pool.apply({
    type: 'replace',
    rows: [
      task,
      {
        kind: 'issuePanelState',
        id: 'issue',
        value: { id: 'issue', text: 'Ready', updatedAt: stamp },
      },
      {
        kind: 'issuePanelArtifact',
        id: 'artifact',
        value: {
          id: 'artifact',
          issueId: 'issue',
          position: 3,
          path: 'index.html',
          addedAt: stamp,
        },
      },
    ],
  })
  const issue = requireHere(pool.model('issue', 'issue'))
  expect(issue.activityNotes).toBe('Ready')
  expect(issue.notesUpdatedAt).toBe(stamp)
  expect(issue.panel.artifacts[0]).toBe(requireHere(pool.model('issuePanelArtifact', 'artifact')))
  pool.dispose()
})

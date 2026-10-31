// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { observer } from 'mobx-react-lite'
import { expect, it } from 'vitest'
import { MobxPool } from '../pool'
import { worklistView } from './view-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const stamp = '2026-10-08T12:00:00Z'
const issue = (id: string) => ({ id, seq: 1, title: id, stage: 'planning',
  audience: 'human', repoPath: '/synthetic', createdAt: stamp, updatedAt: stamp })
function fixture() {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  pool.apply({ type: 'replace', rows: ['root', 'other', 'third'].map(id => ({ kind: 'issue' as const, id, value: issue(id) })) })
  return pool
}

it('a selection click redraws only the previous and next selected rows', async () => {
  const pool = fixture(), view = worklistView(pool), counts = new Map<string, number>()
  const Row = observer(({ id }: { id: string }) => {
    counts.set(id, (counts.get(id) ?? 0) + 1)
    return <button data-id={id} aria-pressed={view.row(pool.issueObject(id)).selected}
      onClick={() => view.select(id)}>{id}</button>
  })
  const container = document.createElement('div'), root = createRoot(container)
  try {
    await act(async () => root.render(<>{['root', 'other', 'third'].map(id => <Row key={id} id={id} />)}</>))
    expect([...counts.values()]).toEqual([1, 1, 1])
    await act(async () => container.querySelector<HTMLButtonElement>('[data-id="other"]')!.click())
    expect([...counts.entries()]).toEqual([['root', 2], ['other', 2], ['third', 1]])
    expect(container.querySelector('[data-id="root"]')!.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-id="other"]')!.getAttribute('aria-pressed')).toBe('true')
  } finally { await act(async () => root.unmount()); pool.dispose() }
})

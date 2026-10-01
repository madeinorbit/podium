import { chipPerf } from '@podium/client-core/perf'
import { MobxPool } from '@podium/client-graph'
import { act, type JSX, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({ pool: null as unknown, owner: {} }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => fixture.owner }))
vi.mock('@/app/store', () => ({ useReplicaIssues: () => { throw new Error('Pool chip called legacy list reader') } }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => fixture.pool }))
vi.mock('@/lib/chips-data-layer', () => ({ chipsDataLayer: () => 'pool' }))

describe('pool chip DOM boundary', () => {
  it('keeps unrelated anchors asleep, retargets in place, and releases removed anchors', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
    const row = (id: number, title = `Task ${id}`) => ({ id: `iss_${id}`, seq: id, prefix: 'POD', displayRef: `POD-${id}`, title, stage: 'review', deps: [], repoPath: '/r', createdAt: '2026-01-01', updatedAt: '2026-01-01' })
    pool.apply({ type: 'replace', rows: [1, 2, 3].map(id => ({ kind: 'issue', id: `iss_${id}`, value: row(id) as never })) })
    fixture.pool = pool
    chipPerf.enable(); chipPerf.reset()
    const container = document.createElement('div')
    document.body.append(container)
    const react = createRoot(container)
    function Host(): JSX.Element {
      const [root, setRoot] = useState<HTMLDivElement | null>(null)
      return <><IssueChipLiveness root={root} /><div ref={setRoot}>
        <a className="ref-link--issue" data-ref="POD-1">POD-1</a>
        <a className="ref-link--issue" data-ref="POD-2">POD-2</a>
      </div></>
    }
    try {
      await act(async () => { react.render(<Host />); await new Promise(resolve => setTimeout(resolve, 0)) })
      const anchors = container.querySelectorAll('a')
      expect(anchors[0]?.getAttribute('aria-label')).toContain('Task 1')
      const before = chipPerf.read(fixture.owner)
      const scans = vi.spyOn(container.firstElementChild!, 'querySelectorAll')
      await act(async () => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'iss_3', value: row(3, 'Elsewhere') as never }] }))
      expect(chipPerf.read(fixture.owner)).toEqual(before)
      await act(async () => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'iss_1', value: row(1, 'Changed') as never }] }))
      expect(chipPerf.read(fixture.owner).redraws - before.redraws).toBe(1)
      expect(anchors[1]?.getAttribute('aria-label')).toContain('Task 2')
      expect(scans).not.toHaveBeenCalled()
      await act(async () => { anchors[0]!.setAttribute('data-ref', 'POD-2'); await Promise.resolve() })
      expect(anchors[0]?.getAttribute('aria-label')).toContain('Task 2')
      await act(async () => { anchors[0]!.remove(); await Promise.resolve() })
      const removed = anchors[0]!.getAttribute('aria-label')
      await act(async () => pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'iss_2', value: row(2, 'Retargeted') as never }] }))
      expect(anchors[0]!.getAttribute('aria-label')).toBe(removed)
      expect(anchors[1]!.getAttribute('aria-label')).toContain('Retargeted')
      expect(chipPerf.read(fixture.owner).legacyScans).toBe(0)
      scans.mockRestore()
    } finally { act(() => react.unmount()); container.remove(); pool.dispose(); chipPerf.enable(false) }
  })
})

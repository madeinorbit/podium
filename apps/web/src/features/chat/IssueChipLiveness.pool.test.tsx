import { chipPerf } from '@podium/client-core/perf'
import { MobxPool } from '@podium/client-graph'
import { act, type JSX, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({ pool: null as unknown, owner: {} }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => fixture.owner }))
vi.mock('@/app/store', () => ({
  useReplicaIssues: () => {
    throw new Error('Pool chip called legacy list reader')
  },
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => fixture.pool }))

describe('pool chip DOM boundary', () => {
  for (const scale of [1, 4] as const)
    it(`bounds a single chip render at ${scale}x`, async () => {
      const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
      const count = 4887 * scale
      pool.apply({
        type: 'replace',
        rows: Array.from({ length: count }, (_, index) => ({
          kind: 'issue' as const,
          id: `iss_${index}`,
          value: {
            id: `iss_${index}`,
            seq: index + 1,
            prefix: 'POD',
            title: `Task ${index + 1}`,
            stage: 'review',
            repoPath: '/synthetic',
            createdAt: '2026-01-01',
            updatedAt: '2026-01-01',
            deps: [],
          } as never,
        })),
      })
      // Attachment seeds the resident identity index once. This census measures
      // a chip render after that startup work, matching the migration baseline.
      void pool.references
      fixture.pool = pool
      chipPerf.enable()
      chipPerf.reset()
      const row = vi.spyOn(pool, 'row')
      const scans = [
        vi.spyOn(pool.tables.issue, 'keys'),
        vi.spyOn(pool.tables.issue, 'values'),
        vi.spyOn(pool.tables.issue, 'entries'),
      ]
      const host = document.createElement('div')
      host.innerHTML = '<a class="ref-link--issue" data-ref="POD-1">POD-1</a>'
      document.body.append(host)
      const react = createRoot(host.appendChild(document.createElement('div')))
      try {
        await act(async () => react.render(<IssueChipLiveness root={host} />))
        const counts = chipPerf.read(fixture.owner)
        const measurement = {
          scale,
          issues: count,
          chips: 1,
          reads: counts.reads,
          rowCalls: row.mock.calls.length,
          enumerations: scans.reduce((total, scan) => total + scan.mock.calls.length, 0),
          redraws: counts.redraws,
        }
        expect(measurement).toEqual({
          scale,
          issues: count,
          chips: 1,
          reads: 1,
          rowCalls: 1,
          enumerations: 0,
          redraws: 1,
        })
        expect(host.querySelector('a')?.getAttribute('aria-label')).toBe('Review task POD-1: Task 1')
        console.log(`CHIP_RENDER_COUNTS ${JSON.stringify(measurement)}`)
      } finally {
        act(() => react.unmount())
        host.remove()
        row.mockRestore()
        for (const scan of scans) scan.mockRestore()
        pool.dispose()
        fixture.pool = null
        chipPerf.enable(false)
      }
    })

  it('keeps unrelated anchors asleep, retargets in place, and releases removed anchors', async () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
    const row = (id: number, title = `Task ${id}`) => ({
      id: `iss_${id}`,
      seq: id,
      prefix: 'POD',
      displayRef: `POD-${id}`,
      title,
      stage: 'review',
      deps: [],
      repoPath: '/r',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    })
    pool.apply({
      type: 'replace',
      rows: [1, 2, 3].map((id) => ({ kind: 'issue', id: `iss_${id}`, value: row(id) as never })),
    })
    fixture.pool = pool
    chipPerf.enable()
    chipPerf.reset()
    const container = document.createElement('div')
    document.body.append(container)
    const react = createRoot(container)
    function Host(): JSX.Element {
      const [root, setRoot] = useState<HTMLDivElement | null>(null)
      return (
        <>
          <IssueChipLiveness root={root} />
          <div ref={setRoot}>
            <a href="#POD-1" className="ref-link--issue" data-ref="POD-1">
              POD-1
            </a>
            <a href="#POD-2" className="ref-link--issue" data-ref="POD-2">
              POD-2
            </a>
          </div>
        </>
      )
    }
    try {
      await act(async () => {
        react.render(<Host />)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await act(async () => {
        await vi.dynamicImportSettled()
      })
      const anchors = container.querySelectorAll('a')
      expect(anchors[0]?.getAttribute('aria-label')).toContain('Task 1')
      const before = chipPerf.read(fixture.owner)
      const scans = vi.spyOn(container.firstElementChild!, 'querySelectorAll')
      await act(async () =>
        pool.apply({
          type: 'update',
          rows: [{ kind: 'issue', id: 'iss_3', value: row(3, 'Elsewhere') as never }],
        }),
      )
      expect(chipPerf.read(fixture.owner)).toEqual(before)
      await act(async () =>
        pool.apply({
          type: 'update',
          rows: [{ kind: 'issue', id: 'iss_1', value: row(1, 'Changed') as never }],
        }),
      )
      expect(chipPerf.read(fixture.owner).redraws - before.redraws).toBe(1)
      expect(anchors[1]?.getAttribute('aria-label')).toContain('Task 2')
      expect(scans).not.toHaveBeenCalled()
      await act(async () => {
        anchors[0]!.setAttribute('data-ref', 'POD-2')
        await Promise.resolve()
      })
      expect(anchors[0]?.getAttribute('aria-label')).toContain('Task 2')
      await act(async () => {
        anchors[0]!.remove()
        await Promise.resolve()
      })
      const removed = anchors[0]!.getAttribute('aria-label')
      await act(async () =>
        pool.apply({
          type: 'update',
          rows: [{ kind: 'issue', id: 'iss_2', value: row(2, 'Retargeted') as never }],
        }),
      )
      expect(anchors[0]!.getAttribute('aria-label')).toBe(removed)
      expect(anchors[1]!.getAttribute('aria-label')).toContain('Retargeted')
      expect(chipPerf.read(fixture.owner).legacyScans).toBe(0)
      scans.mockRestore()
    } finally {
      act(() => react.unmount())
      container.remove()
      pool.dispose()
      chipPerf.enable(false)
    }
  })
})

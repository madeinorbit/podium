import type { IssueReferenceSource } from '@podium/client-core/viewmodels'
import { MobxPool } from '@podium/client-graph'
import { parseAnyRef } from '@podium/protocol'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({
  layer: 'legacy' as 'legacy' | 'pool',
  pool: null as unknown,
  owner: {},
  issues: [] as IssueReferenceSource[],
}))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => fixture.owner }))
vi.mock('@/app/store', () => ({ useReplicaIssues: () => fixture.issues }))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => fixture.pool }))
vi.mock('@/lib/chips-data-layer', () => ({ chipsDataLayer: () => fixture.layer }))

describe('non-reference fallback labels', () => {
  it.each([
    'legacy',
    'pool',
  ] as const)('leaves #seq as plain text with the %s chip path', async (layer) => {
    fixture.layer = layer
    const fallback = {
      id: 'iss_orphan',
      seq: 17,
      displayRef: '#17',
      title: 'Orphan',
      stage: 'review',
    }
    const addressed = { ...fallback, id: 'iss_addressed', prefix: 'POD', displayRef: 'POD-17' }
    fixture.issues = [fallback, addressed] as IssueReferenceSource[]
    const pool =
      layer === 'pool' ? new MobxPool({ selectedIssueId: null, coarseNow: Date.now() }) : null
    pool?.apply({
      type: 'replace',
      rows: [fallback, addressed].map((row) => ({
        kind: 'issue',
        id: row.id,
        value: { ...row, repoPath: '/synthetic', deps: [] } as never,
      })),
    })
    fixture.pool = pool
    setKnownRefPrefixes(['POD'])
    const html = renderMarkdown('Fallback #17, and real POD-17.')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    function Host() {
      const [node, setNode] = useState<HTMLDivElement | null>(null)
      return (
        <>
          <IssueChipLiveness root={node} />
          <div ref={setNode} dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )
    }
    try {
      await act(async () => {
        root.render(<Host />)
      })
      await act(async () => {
        await vi.dynamicImportSettled()
      })
      expect(parseAnyRef('#17')).toBeNull()
      expect(host.textContent).toContain('Fallback #17')
      expect(host.querySelector('a[data-ref="#17"], [data-issue-reference="#17"]')).toBeNull()
      expect(host.querySelector('a[data-ref="POD-17"]')?.getAttribute('data-issue-stage')).toBe(
        'review',
      )
      expect(host.querySelectorAll('a.ref-link--issue')).toHaveLength(1)
    } finally {
      act(() => root.unmount())
      host.remove()
      pool?.dispose()
      fixture.pool = null
      setKnownRefPrefixes([])
    }
  })
})

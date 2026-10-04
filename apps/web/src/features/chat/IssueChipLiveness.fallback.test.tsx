import type { IssueReferenceSource } from '@podium/client-core/values'
import { MobxPool } from '@podium/client-graph'
import { parseAnyRef } from '@podium/protocol'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/lib/markdown'
import { setKnownRefPrefixes } from '@/lib/markdown-references'
import { IssueChipLiveness } from './IssueChipLiveness'

const fixture = vi.hoisted(() => ({
  pool: null as unknown,
  owner: {},
  issues: [] as IssueReferenceSource[],
}))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => fixture.owner }))
vi.mock('@/app/store', () => ({
  useReplicaIssues: () => {
    throw new Error('Legacy chip read')
  },
}))
vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => fixture.pool }))

describe('non-reference fallback labels', () => {
  it('leaves #seq as plain text with the pool chip path', async () => {
    const fallback = {
      id: 'iss_orphan',
      seq: 17,
      displayRef: '#17',
      title: 'Orphan',
      stage: 'review',
    }
    const addressed = { ...fallback, id: 'iss_addressed', prefix: 'POD', displayRef: 'POD-17' }
    fixture.issues = [fallback, addressed] as IssueReferenceSource[]
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.now() })
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
      return (
        <>
          <IssueChipLiveness root={host} />
          <div
            ref={(node) => {
              if (node) node.innerHTML = html
            }}
          />
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

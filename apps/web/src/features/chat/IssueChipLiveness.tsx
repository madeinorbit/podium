import { referenceView } from '@podium/client-graph/issue-reference'
import { recordChipWork } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import { reaction } from 'mobx'
import type { JSX } from 'react'
import { useLayoutEffect } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { bindIssueRefAnchors } from '@/lib/issue-chip-liveness'

/**
 * Live issue decoration is deliberately a leaf subscription outside the feed.
 * An issue delta runs the leaf reaction, which mutates attributes
 * on existing anchors. ChatView, TranscriptFeed, rows, anchors and text nodes
 * are not part of the update path. The host node is state, rather than a ref
 * object, so attachment re-runs this effect regardless of JSX mount order.
 */
export function IssueChipLiveness({ root }: { root: HTMLElement | null }): JSX.Element | null {
  return <PoolIssueChipLiveness root={root} />
}

function PoolIssueChipLiveness({ root }: { root: HTMLElement | null }): null {
  const pool = useWorklistPool()
  const owner = useStoreHandle()
  useLayoutEffect(() => {
    if (!pool || !root) return
    const stop = bindIssueRefAnchors(root, {
      watch(ref, paint) {
        return reaction(
          () => {
            recordChipWork(owner, 'reads')
            return referenceView(pool).read(ref)
          },
          (model) => {
            if (paint(typeof model === 'symbol' ? 'loading' : (model ?? null)))
              recordChipWork(owner, 'redraws')
          },
          { fireImmediately: true },
        )
      },
    })
    return stop
  }, [owner, pool, root])
  return null
}

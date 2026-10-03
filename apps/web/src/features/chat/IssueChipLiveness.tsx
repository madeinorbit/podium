import { recordChipWork } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { JSX } from 'react'
import { useLayoutEffect } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { bindIssueRefAnchors } from '@/lib/issue-chip-liveness'

/**
 * Live issue decoration is deliberately a leaf subscription outside the feed.
 * An issue delta re-renders this null component only, then mutates attributes
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
    let disposed = false
    let stop: (() => void) | undefined
    // The legacy startup imports neither MobX nor the pool's tracking module.
    void import('@podium/client-graph/runtime-pool').then(({ createPoolProjection }) => {
      if (disposed) return
      stop = bindIssueRefAnchors(root, {
        watch(ref, paint) {
          const view = createPoolProjection(pool, (pool) => {
            recordChipWork(owner, 'reads')
            return pool.references.read(ref)
          })
          paintValue(view.getSnapshot())
          function paintValue(model: ReturnType<typeof view.getSnapshot>): void {
            if (paint(typeof model === 'symbol' ? 'loading' : (model ?? null)))
              recordChipWork(owner, 'redraws')
          }
          return view.subscribe(() => paintValue(view.getSnapshot()))
        },
      })
    })
    return () => {
      disposed = true
      stop?.()
    }
  }, [owner, pool, root])
  return null
}

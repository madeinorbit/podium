import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { useStoreHandle } from '@podium/client-core/react'
import { recordChipWork } from '@podium/client-core/perf'
import { useReplicaIssues } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { bindIssueRefAnchors, decorateIssueRefAnchors } from '@/lib/issue-chip-liveness'
import { chipsDataLayer } from '@/lib/chips-data-layer'
import { createIssueChipRefsSelector } from './issue-chip-refs'

/**
 * Live issue decoration is deliberately a leaf subscription outside the feed.
 * An issue delta re-renders this null component only, then mutates attributes
 * on existing anchors. ChatView, TranscriptFeed, rows, anchors and text nodes
 * are not part of the update path. The host node is state, rather than a ref
 * object, so attachment re-runs this effect regardless of JSX mount order.
 */
export function IssueChipLiveness({ root }: { root: HTMLElement | null }): JSX.Element | null {
  return chipsDataLayer() === 'pool' ? <PoolIssueChipLiveness root={root} /> : <LegacyIssueChipLiveness root={root} />
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
            if (paint(typeof model === 'symbol' ? 'loading' : model ?? null)) recordChipWork(owner, 'redraws')
          }
          return view.subscribe(() => paintValue(view.getSnapshot()))
        },
      })
    })
    return () => { disposed = true; stop?.() }
  }, [owner, pool, root])
  return null
}

function LegacyIssueChipLiveness({ root }: { root: HTMLElement | null }): JSX.Element | null {
  const issues = useReplicaIssues()
  const owner = useStoreHandle()

  // Keyed on what the chips READ, not on the array's identity. The replica
  // rebuilds that array on session traffic too, so keying on it would re-arm the
  // observer and re-sweep the whole transcript, before paint, on every agent's
  // every phase flip — the per-delta cost this architecture exists to avoid.
  // A ref rather than useMemo: the selector must survive renders useMemo may drop.
  // The selector itself memoizes the signature string and the lookup behind a
  // material compare over the seven fields the signature can see, so an
  // immaterial publication costs a field scan with no string or model work.
  const selector = useRef<ReturnType<typeof createIssueChipRefsSelector> | null>(null)
  if (selector.current === null) selector.current = createIssueChipRefsSelector(owner)
  const { refs } = selector.current.select(issues)

  useLayoutEffect(() => {
    if (!root) return

    decorateIssueRefAnchors(root, refs)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        // A ref anchor React owns (MessageEnvelopeGroup's principal labels) can
        // be RETARGETED in place: same element, new `data-ref`, no childList
        // record. Unwatched, that chip keeps the previous issue's stage and
        // announces the previous issue's title.
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLElement) decorateIssueRefAnchors(record.target, refs)
          continue
        }
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) decorateIssueRefAnchors(node, refs)
        }
      }
    })
    // `data-ref` only. This pass writes `data-issue-*` and `aria-label`, so a
    // broader filter would observe its own writes and never settle.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ref'],
    })
    return () => observer.disconnect()
  }, [refs, root])

  return null
}

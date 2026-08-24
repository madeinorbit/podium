import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { useReplicaIssues } from '@/app/store'
import {
  decorateIssueRefAnchors,
  type IssueReferenceLookup,
  issueReferenceLookup,
  issueReferenceSignature,
} from '@/lib/issue-chip-liveness'

/**
 * Live issue decoration is deliberately a leaf subscription outside the feed.
 * An issue delta re-renders this null component only, then mutates attributes
 * on existing anchors. ChatView, TranscriptFeed, rows, anchors and text nodes
 * are not part of the update path. The host node is state, rather than a ref
 * object, so attachment re-runs this effect regardless of JSX mount order.
 */
export function IssueChipLiveness({ root }: { root: HTMLElement | null }): JSX.Element | null {
  const issues = useReplicaIssues()

  // Keyed on what the chips READ, not on the array's identity. The replica
  // rebuilds that array on session traffic too, so keying on it would re-arm the
  // observer and re-sweep the whole transcript, before paint, on every agent's
  // every phase flip — the per-delta cost this architecture exists to avoid.
  // A ref rather than useMemo: the cache must survive renders useMemo may drop.
  const signature = issueReferenceSignature(issues)
  const cache = useRef<{ signature: string; refs: IssueReferenceLookup } | null>(null)
  if (cache.current === null || cache.current.signature !== signature) {
    cache.current = { signature, refs: issueReferenceLookup(issues) }
  }
  const refs = cache.current.refs

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

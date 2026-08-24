import type { JSX } from 'react'
import { useLayoutEffect, useMemo } from 'react'
import { useReplicaIssues } from '@/app/store'
import { decorateIssueRefAnchors, issueReferenceLookup } from '@/lib/issue-chip-liveness'

/**
 * Live issue decoration is deliberately a leaf subscription outside the feed.
 * An issue delta re-renders this null component only, then mutates attributes
 * on existing anchors. ChatView, TranscriptFeed, rows, anchors and text nodes
 * are not part of the update path. The host node is state, rather than a ref
 * object, so attachment re-runs this effect regardless of JSX mount order.
 */
export function IssueChipLiveness({ root }: { root: HTMLElement | null }): JSX.Element | null {
  const issues = useReplicaIssues()
  const refs = useMemo(() => issueReferenceLookup(issues), [issues])

  useLayoutEffect(() => {
    if (!root) return

    decorateIssueRefAnchors(root, refs)
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) decorateIssueRefAnchors(node, refs)
        }
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [refs, root])

  return null
}

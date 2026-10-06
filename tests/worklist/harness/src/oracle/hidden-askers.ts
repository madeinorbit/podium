/**
 * POD-4549 (L1d) — the bubbling rule on the fixture's hidden askers.
 *
 * An ask bubbles through the VISIBLE formal subtree only (spec R-SUM, "The
 * roll-up is the visible formal subtree"). The fixture mints asking sessions
 * on archived and proposed children of visible roots (`corpus.edgedAskers`,
 * POD-4551); the legacy derivation gives those children no row, so their asks
 * detach and the roots stay quiet.
 *
 * Two helpers, used by `oracle.test.ts` (1x corpus) and `hidden-askers.test.ts`
 * (isolated cases):
 * - {@link rootsAskingOverHiddenAskers}: the check. It must return nothing on
 *   the oracle snapshot.
 * - {@link plantFormalSubtreeBubbling}: the planted mistake that the check must
 *   catch. It is the rule the round-two hand and MobX bubbling diffs used: OR
 *   into each row's `asking` any waiting session in its formal subtree, hidden
 *   members included (decision doc, "the bubbling contradiction, adjudicated").
 */

import { dedupeSessions } from '../../../diagnostics/reference-state'
import { motionPhase } from '@podium/client-core/values'
import type { SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { FixtureCorpus } from '../fixture/index'

/** Roots of `corpus.edgedAskers` whose row in `snapshot` reads asking, sorted. */
export function rootsAskingOverHiddenAskers(
  corpus: FixtureCorpus,
  snapshot: SliceSnapshot,
): string[] {
  const roots = new Set(corpus.edgedAskers.map((asker) => asker.rootId))
  return [...roots].filter((id) => snapshot.rowsById[id]?.asking === true).sort()
}

/**
 * The planted rule: `snapshot` with every row's `asking` also set when any
 * formal descendant, visible or not, owns a waiting session. Nothing else on
 * the row changes, so a parity diff against the oracle names exactly the rows
 * the wrong rule turns amber.
 */
export function plantFormalSubtreeBubbling(
  corpus: FixtureCorpus,
  snapshot: SliceSnapshot,
): SliceSnapshot {
  const issueById = new Map(corpus.issues.map((issue) => [issue.id as string, issue]))
  const childrenOf = new Map<string, string[]>()
  for (const issue of corpus.issues) {
    if (!issue.parentId) continue
    const siblings = childrenOf.get(issue.parentId) ?? []
    siblings.push(issue.id)
    childrenOf.set(issue.parentId, siblings)
  }
  const waitingIssueIds = new Set<string>()
  for (const session of dedupeSessions(corpus.sessions)) {
    if (session.archived || !session.issueId) continue
    const issue = issueById.get(session.issueId)
    if (issue !== undefined && motionPhase(session, issue) === 'waiting') {
      waitingIssueIds.add(issue.id)
    }
  }
  const descendantWaits = (rootId: string): boolean => {
    const seen = new Set<string>([rootId])
    const stack = [...(childrenOf.get(rootId) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      if (waitingIssueIds.has(id)) return true
      stack.push(...(childrenOf.get(id) ?? []))
    }
    return false
  }
  const rowsById: SliceSnapshot['rowsById'] = {}
  for (const [id, row] of Object.entries(snapshot.rowsById)) {
    rowsById[id] = row.asking || !descendantWaits(id) ? row : { ...row, asking: true }
  }
  return { order: snapshot.order, rowsById }
}

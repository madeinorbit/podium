import { shallowEqual } from '@podium/client-core/store'
import { issueReferenceModel } from '@podium/client-core/viewmodels'
import { isAgentComputing } from '@podium/model'
import type { JSX } from 'react'
import { IssueReference } from '@/components/IssueReference'
import { ConnectionIndicator, useStableConnection } from '@/features/machines/ConnectionIndicator'
import { AgentConcurrencyHistory } from './AgentConcurrencyHistory'
import { StatusPerformanceStats } from './StatusPerformanceStats'
import { useReplicaIssues, useStoreSelector } from './store'

/**
 * THE STATUS STRIP (POD-365) — 24px, the bottom edge of the frame.
 *
 * Websites end by scrolling off into nothing; applications close their frame.
 * The strip is that edge, and it gives the machine voice a second, calmer home
 * so the command bar never has to grow again.
 *
 * WHAT IS ALLOWED IN IT is the same test the toolbar slot uses: window scope,
 * and not already stated by a column. The facts that qualify are —
 *
 *   · how many agents are computing right now (fleet-wide; nothing else states
 *     it at window scope — the sidebar shows only rows you can see),
 *   · which task the shell is pointed at, which is the one fact that says what
 *     this WINDOW is about,
 *   · the fleet's API-equivalent token burn and confirmed-merge velocity — two
 *     rolling rates whose traces make sudden changes visible without opening
 *     analytics,
 *   · whether the link is healthy, and only while it is not.
 *
 * The "⌘K commands" hint is gone with it. It failed the same test: a keycap is
 * not a window-scoped FACT, it is instruction, and instruction shown all day to
 * an operator who learned the key on their first session is the definition of
 * noise on a 24px edge. The palette teaches its own keys now, in its own footer,
 * at the only moment they are useful — while it is open.
 *
 * Branch and commit state deliberately do NOT appear. `GitStamp` (POD-98) owns
 * that in four prescribed densities and its whole design rule is that one git
 * fact is not restated in two places at once — a strip readout would be a fifth,
 * shown unconditionally, against POD-279's "two counters for one fact read as
 * two problems".
 */
export function StatusStrip(): JSX.Element {
  const { sessions, selectedIssueId, trpc } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      selectedIssueId: s.selectedIssueId,
      trpc: s.trpc,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { health, visible: connVisible } = useStableConnection()

  // Liveness is part of the question, not just the phase: a session that exited
  // mid-turn keeps `phase: 'working'` (the server preserves the final turn
  // diagnosis) and a parked one keeps it too, so counting raw phase gives a
  // number that only ratchets up — it read "13 agents working" for hours with
  // four alive (POD-730). `isAgentComputing` asks both, and 'compacting' counts
  // because the harness is still computing, just about its own context.
  const working = sessions.filter(isAgentComputing).length
  const issue = selectedIssueId
    ? issues.find((candidate) => candidate.id === selectedIssueId && !candidate.deletedAt)
    : undefined

  return (
    <footer className="status-strip" data-testid="status-strip">
      <AgentConcurrencyHistory working={working} trpc={trpc} />
      <span className="status-strip-seam" aria-hidden="true" />
      <StatusPerformanceStats trpc={trpc} />
      {issue && (
        <>
          <span className="status-strip-seam" aria-hidden="true" />
          <span className="status-strip-issue" title={issue.title}>
            <IssueReference
              model={issueReferenceModel(issue)}
              size={11}
              refClassName="status-strip-ref"
              titleClassName="status-strip-issue-title"
            />
          </span>
        </>
      )}
      {/* Only while degraded or down — a permanent "linked" is noise, the same
          reason the header's connection glyph hides itself when healthy. */}
      {connVisible && (
        <>
          <span className="status-strip-seam" aria-hidden="true" />
          <ConnectionIndicator health={health} />
        </>
      )}
    </footer>
  )
}

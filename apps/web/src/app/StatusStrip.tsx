import { issueReferenceModel, type IssueReferenceSource } from '@podium/client-core/values'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { IssueReference } from '@/components/IssueReference'
import { ConnectionIndicator, useStableConnection } from '@/features/machines/ConnectionIndicator'
import { MobileHandoffChip } from '@/features/mobile-handoff/MobileHandoffChip'
import { UpdateIndicator } from '@/features/updates/UpdateIndicator'
import { useUpdates } from '@/features/updates/updates-panel-context'
import { AgentConcurrencyHistory } from './AgentConcurrencyHistory'
import { useHeaderActions, useHeaderSelectedIssue, useHeaderWorkingCount } from './header-data'
import { StatusPerformanceStats } from './StatusPerformanceStats'

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
 *   · the fleet's recent API-equivalent token burn, whose trace makes sudden
 *     changes visible without opening analytics,
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
  const { trpc } = useHeaderActions()
  const { health, visible: connVisible } = useStableConnection()
  // The update affordance (POD-2102). It passes the same test as the rest of
  // the strip: window-scoped, stated nowhere else, and present only while it is
  // a FACT — there is an update, or one is running, or one failed.
  const updates = useUpdates()

  return (
    <footer className="status-strip" data-testid="status-strip">
      <WorkingHistory />
      <span className="status-strip-seam" aria-hidden="true" />
      <StatusPerformanceStats trpc={trpc} />
      <SelectedHeaderIssue />
      {updates.indicator !== 'none' && (
        <>
          <span className="status-strip-seam" aria-hidden="true" />
          <UpdateIndicator
            state={updates.indicator}
            label={updates.indicatorLabel}
            open={updates.open}
            onToggle={updates.toggle}
          />
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
      {/* Everything above is the machine's voice, read left to right. The phone
          chip is an OFFER, not a reading, so it takes the far end on its own —
          the slot the "⌘K commands" hint used to hold. */}
      <span className="status-strip-spacer" aria-hidden="true" />
      <MobileHandoffChip />
    </footer>
  )
}

function WorkingHistory() {
  return <AgentConcurrencyHistory working={useHeaderWorkingCount()} />
}

const SelectedHeaderIssue = observer(function SelectedHeaderIssue() {
  const issue = useHeaderSelectedIssue()
  if (typeof issue === 'symbol') return (
    <span className="status-strip-issue" role="status">Loading task…</span>
  )
  if (!issue) return null
  return (
    <>
      <span className="status-strip-seam" aria-hidden="true" />
      <span className="status-strip-issue" title={issue.title}>
        <IssueReference
          model={issueReferenceModel(issue as IssueReferenceSource)}
          size={11}
          refClassName="status-strip-ref"
          titleClassName="status-strip-issue-title"
        />
      </span>
    </>
  )
})

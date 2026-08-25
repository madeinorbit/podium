import { shallowEqual } from '@podium/client-core/store'
import { issueReferenceModel } from '@podium/client-core/viewmodels'
import { isAgentComputing } from '@podium/model/browser'
import type { JSX } from 'react'
import { IssueReference } from '@/components/IssueReference'
import { ConnectionIndicator, useStableConnection } from '@/features/machines/ConnectionIndicator'
import { MobileHandoffChip } from '@/features/mobile-handoff/MobileHandoffChip'
import { UpdateIndicator } from '@/features/updates/UpdateIndicator'
import { useUpdates } from '@/features/updates/updates-panel-context'
import { useFeature } from '@/lib/use-feature'
import { AgentConcurrencyHistory } from './AgentConcurrencyHistory'
import { commandShortcutLabel } from './desktop-commands'
import { StatusPerformanceStats } from './StatusPerformanceStats'
import { useReplicaIssues, useStoreSelector } from './store'
import { useThemeAppearance } from './theme'

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
  // The update affordance (POD-2102). It passes the same test as the rest of
  // the strip: window-scoped, stated nowhere else, and present only while it is
  // a FACT — there is an update, or one is running, or one failed.
  const updates = useUpdates()
  // THE OMARCHY TAIL (POD-1531). Two readings the design puts at the strip's far
  // end, and both exist ONLY under that appearance — see the note below.
  const appearance = useThemeAppearance()
  const paletteEnabled = useFeature('command-palette')
  const omarchy = appearance === 'omarchy'

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
      {/* WHICH DESKTOP APPEARANCE THIS WINDOW IS WEARING. It passes the strip's
          admission test above — window scope, said nowhere else, and a fact
          rather than an instruction — and it is drawn only under the profile
          that makes it true: on the Podium appearance there is one appearance,
          so a readout naming it would be a label on the only option there is. */}
      {omarchy && (
        <>
          <span className="status-strip-profile" data-testid="status-strip-profile">
            omarchy · tokyo-night
          </span>
          <span className="status-strip-seam" aria-hidden="true" />
        </>
      )}
      {/* THE PALETTE KEY, BACK, AND ONLY HERE. The strip's own doctrine cut this
          hint years ago: a keycap is instruction, not a window-scoped fact, and
          instruction shown all day is noise on a 30px edge. That still stands
          for Podium. The Omarchy design puts it back for a reason particular to
          this desktop — an Omarchy session is driven from the keyboard and its
          bar is where every other application in the session publishes its
          binds — so the hint is part of what the window owes that desktop, not a
          reversal of the rule. It goes when the palette does. */}
      {omarchy && paletteEnabled && (
        <>
          <span className="status-strip-hint">
            {commandShortcutLabel('command-palette')} commands
          </span>
          <span className="status-strip-seam" aria-hidden="true" />
        </>
      )}
      <MobileHandoffChip />
    </footer>
  )
}

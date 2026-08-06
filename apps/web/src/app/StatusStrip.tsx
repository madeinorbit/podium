import { shallowEqual } from '@podium/client-core/store'
import { issueReferenceModel } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { IssueReference } from '@/components/IssueReference'
import { ConnectionIndicator, useStableConnection } from '@/features/machines/ConnectionIndicator'
import { useFeature } from '@/lib/use-feature'
import { AgentConcurrencyHistory } from './AgentConcurrencyHistory'
import { useReplicaIssues, useStoreSelector } from './store'

/**
 * THE STATUS STRIP (POD-365) — 24px, the bottom edge of the frame.
 *
 * Websites end by scrolling off into nothing; applications close their frame.
 * The strip is that edge, and it gives the machine voice a second, calmer home
 * so the command bar never has to grow again.
 *
 * WHAT IS ALLOWED IN IT is the same test the toolbar slot uses: window scope,
 * and not already stated by a column. Three facts qualify —
 *
 *   · how many agents are computing right now (fleet-wide; nothing else states
 *     it at window scope — the sidebar shows only rows you can see),
 *   · which task the shell is pointed at, which is the one fact that says what
 *     this WINDOW is about,
 *   · whether the link is healthy, and only while it is not.
 *
 * Branch and commit state deliberately do NOT appear. `GitStamp` (POD-98) owns
 * that in four prescribed densities and its whole design rule is that one git
 * fact is not restated in two places at once — a strip readout would be a fifth,
 * shown unconditionally, against POD-279's "two counters for one fact read as
 * two problems".
 */
export function StatusStrip(): JSX.Element {
  const { sessions, selectedIssueId, paletteOpen, setPaletteOpen, trpc } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      selectedIssueId: s.selectedIssueId,
      paletteOpen: s.paletteOpen,
      setPaletteOpen: s.setPaletteOpen,
      trpc: s.trpc,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const { health, visible: connVisible } = useStableConnection()
  const commandPaletteEnabled = useFeature('command-palette')

  // 'compacting' is the harness still computing, just about its own context —
  // the same reading SessionContextMenu takes.
  const working = sessions.filter(
    (session) =>
      session.agentState?.phase === 'working' || session.agentState?.phase === 'compacting',
  ).length
  const issue = selectedIssueId
    ? issues.find((candidate) => candidate.id === selectedIssueId && !candidate.deletedAt)
    : undefined

  return (
    <footer className="status-strip" data-testid="status-strip">
      {/* The braille spinner and its count are the shell's only perpetual motion,
          and only while an agent is actually computing. Stillness means nothing
          is running, which is information. */}
      {working > 0 ? (
        <span className="status-strip-live" data-testid="status-strip-working">
          <span className="status-strip-spinner" aria-hidden="true" />
          {working} {working === 1 ? 'agent' : 'agents'} working
        </span>
      ) : (
        <span className="status-strip-idle" data-testid="status-strip-working">
          no agents working
        </span>
      )}
      <AgentConcurrencyHistory working={working} trpc={trpc} />
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
      {commandPaletteEnabled && (
        <button
          data-pressable
          type="button"
          className="status-strip-hint"
          onClick={() => setPaletteOpen(!paletteOpen)}
        >
          <kbd>⌘K</kbd> commands
        </button>
      )}
    </footer>
  )
}

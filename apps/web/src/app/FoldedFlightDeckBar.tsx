import { shallowEqual } from '@podium/client-core/store'
import { buildFlightDeckRows, missionRootFor } from '@podium/client-core/viewmodels'
import { ChevronRight, MessageCircleQuestion, Users } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { BrailleSpinner, StatusBadge } from '@/lib/motion'
import { useReplicaIssues, useStoreSelector } from './store'

/** The Flight Deck's compact state keeps its operational payload visible. */
export function FoldedFlightDeckBar({ onExpand }: { onExpand: () => void }): JSX.Element {
  const { sessions, selectedIssueId } = useStoreSelector(
    (store) => ({ sessions: store.sessions, selectedIssueId: store.selectedIssueId }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  // This bar is mounted for as long as the deck is folded, so the mission walk
  // is memoized here exactly as the open column memoizes it.
  const rows = useMemo(() => {
    const root = missionRootFor(issues, selectedIssueId)
    return root ? buildFlightDeckRows(issues, sessions, root.id) : []
  }, [issues, sessions, selectedIssueId])
  const live = rows[0]?.liveAgentCount ?? 0
  const working = rows[0]?.workingAgentCount ?? 0
  const needs = rows[0]?.actionableCount ?? 0
  return (
    <aside
      className="folded-superagent"
      data-flight-deck-mode="folded"
      aria-label="Folded Flight Deck"
    >
      <button
        data-pressable
        type="button"
        className="folded-superagent-control"
        aria-label="Expand Flight Deck"
        title="Expand Flight Deck"
        onClick={onExpand}
      >
        <ChevronRight size={12} aria-hidden="true" />
      </button>
      <button
        data-pressable
        type="button"
        className="folded-superagent-cell"
        data-testid="flight-deck-activity"
        aria-label={`Expand Flight Deck · ${live} live${working ? `, ${working} working` : ''}`}
        title={`${live} live agents${working ? ` · ${working} working` : ''}`}
        onClick={onExpand}
      >
        {/* Presence and activity share this cell; obligation gets its own below.
            The spinner replaces the static fleet glyph only while an agent is
            genuinely computing, while the neutral count continues to say how
            many agents are present. */}
        {working > 0 ? <BrailleSpinner size={11} /> : <Users size={13} aria-hidden="true" />}
        {live > 0 && (
          <span
            className="absolute -right-[5px] -bottom-[5px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-engraved bg-chip px-[3px] font-mono text-[9px] leading-none font-bold text-text-strong"
            role="img"
            aria-label={`${live} agents live`}
          >
            {live}
          </span>
        )}
      </button>
      <button
        data-pressable
        type="button"
        className="folded-superagent-cell"
        data-testid="flight-deck-attention"
        aria-label={`Expand Flight Deck · ${needs} need you`}
        title={needs ? `${needs} need you` : 'Nothing needs you'}
        onClick={onExpand}
      >
        <MessageCircleQuestion size={13} aria-hidden="true" />
        <StatusBadge kind="count" count={needs} ringColor="var(--engraved)" />
      </button>
      <span className="folded-superagent-label">FLIGHT DECK</span>
    </aside>
  )
}

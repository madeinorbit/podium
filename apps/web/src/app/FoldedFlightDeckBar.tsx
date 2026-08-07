import { shallowEqual } from '@podium/client-core/store'
import { ChevronRight, Users } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { BrailleSpinner } from '@/lib/motion'
import { buildFlightDeckRows, missionRootFor } from '@/lib/mission'
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
    <aside className="folded-superagent" data-flight-deck-mode="folded" aria-label="Folded Flight Deck">
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
        aria-label={`Expand Flight Deck · ${live} live${working ? `, ${working} working` : ''}${needs ? ` · ${needs} need you` : ''}`}
        title={`${live} live agents${working ? ` · ${working} working` : ''}${needs ? ` · ${needs} need you` : ''}`}
        onClick={onExpand}
      >
        {/* MOTION FOR ACTIVITY, COLOUR FOR OBLIGATION. The spinner replaces the
            static glyph only while an agent is genuinely computing — never off
            the LIVE count, which includes idle and waiting sessions and would
            leave the app's only perpetual motion turning over a quiet mission.
            The count beside it stays neutral: agents being present asks nothing
            of the operator, so amber belongs to the needs-you cell alone. */}
        {working > 0 ? (
          <BrailleSpinner size={11} />
        ) : (
          <Users size={13} aria-hidden="true" />
        )}
        {live > 0 && (
          <span className="absolute -top-[5px] -right-[5px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-engraved bg-chip px-[3px] font-mono text-[7.5px] font-bold text-text-strong">
            {live}
          </span>
        )}
      </button>
      {needs > 0 && (
        <button
          data-pressable
          type="button"
          className="shell-type-micro folded-superagent-cell font-mono font-semibold text-attention"
          aria-label={`Expand Flight Deck · ${needs} need you`}
          title={`${needs} tasks need you`}
          onClick={onExpand}
        >
          {needs}
        </button>
      )}
      <span className="folded-superagent-label">FLIGHT DECK</span>
    </aside>
  )
}

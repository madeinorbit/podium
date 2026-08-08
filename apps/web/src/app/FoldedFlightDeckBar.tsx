import { shallowEqual } from '@podium/client-core/store'
import { ChevronRight, Users } from 'lucide-react'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { buildFlightDeckRows, missionRootFor } from '@podium/client-core/viewmodels'
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
        {working > 0 ? <BrailleSpinner size={11} /> : <Users size={13} aria-hidden="true" />}
        {/* NEEDS YOU IS THE YELLOW PILL ON THE ICON (POD-516 round 3 §1).
            It used to be a SECOND cell below this one carrying a bare amber
            digit — the right colour token in a shape the app uses nowhere else,
            which is why it did not read as "needs you" from across a 44px rail.
            It is now the same corner badge the right rail hangs off the
            Superagent icon (`RightRail.tsx`, `StatusBadge kind="count"`): one
            geometry, one amber, one "N waiting on you" phrasing, and the same
            one-shot pop when the number goes up. `ringColor` names the surface
            it punches out of — this bar is `--engraved`, not the rail's `--bar`.
            Merging it into the icon also removes a cell: both buttons only ever
            expanded the deck, so the rail was carrying two targets for one act. */}
        <StatusBadge kind="count" count={needs} ringColor="var(--engraved)" />
        {live > 0 && (
          // Presence, opposite the ask: agents being here is not a request, so
          // it stays the neutral chip and takes the free corner rather than
          // crowding the amber. 9px/700 is DESIGN.md §3's own figure for a badge
          // count — the one scale below the 10.5px micro floor, and that floor
          // is for ordinary information, which a 13px corner mark is not.
          <span
            className="absolute -bottom-[5px] -left-[5px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-engraved bg-chip px-[3px] font-mono text-[9px] leading-none font-bold text-text-strong"
            role="img"
            aria-label={`${live} agents live`}
          >
            {live}
          </span>
        )}
      </button>
      <span className="folded-superagent-label">FLIGHT DECK</span>
    </aside>
  )
}

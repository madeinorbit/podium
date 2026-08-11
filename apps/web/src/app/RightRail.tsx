import { portfolioActionableCount } from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { StatusBadge } from '@/lib/motion'
import { useFeature } from '@/lib/use-feature'
import { RIGHT_PANELS } from './RightDock'
import { type RightPanelTab, rightPanelAllowed } from './shell-state'
import { useReplicaIssues, useStoreSelector } from './store'

/** The rail sits on the flat --bar tier (POD-516 item 9: the right dock is a
 *  dark default surface, not the selected issue's tint) — corner badges punch
 *  out of it, so this must name the rail's ACTUAL surface. */
const RAIL_SURFACE = 'var(--rail)'

/**
 * The 44px right rail (handoff §2.5): one cell per dock panel — Tasks,
 * Superagent, Git, Files, Shell, Messages, Queues.
 *
 * The Tasks cell used to be the SELECTED ISSUE'S ID SQUARE, wearing that
 * issue's colour and its working/waiting corner badge, because the panel it
 * opened was one issue's inspector. It opens an explorer over every task in the
 * repo now (POD-743), so it is an ordinary rail cell with a list glyph: a
 * coloured square would name a task this panel is not about, and a status badge
 * would report on an agent it is not showing. Recolouring an issue was the ID
 * square's other job here; the Colour submenu on every issue's context menu
 * (POD-380) is where that lives.
 *
 * The Superagent is a rail cell now that the Flight Deck owns the center
 * column it used to live in. Its cell carries the PORTFOLIO attention count —
 * how many tasks anywhere need a decision — so that number stays visible in
 * the chrome without the panel open, and matches what the copilot says when
 * you do open it ("N tasks across your portfolio need a decision").
 *
 * It used to come from `trayCount`; POD-516 removed the web Tray, so it comes
 * from `portfolioActionableCount` — the same module, and the same attention
 * predicate, the Flight Deck's "Needs you" filter runs on.
 *
 * The rail carries NO issue tint (POD-516 item 9). It hosts Superagent, Git,
 * Files, Shell and Messages alongside the task cell, so a tint pulled from the
 * selected issue asserted a relationship most of these cells do not have. The
 * ID square keeps its own colour — it identifies one specific issue, and it is
 * how the operator finds their place here.
 */
export function RightRail({
  rightPanel,
  onPanelChange,
}: {
  rightPanel: RightPanelTab | null
  onPanelChange: (panel: RightPanelTab | null) => void
}): JSX.Element {
  const sessions = useStoreSelector((store) => store.sessions)
  const allIssues = useReplicaIssues()
  // Walks every issue, so it is memoized: this rail re-renders on every issue
  // mutation. The selector lives in mission.ts so this badge and the Flight
  // Deck's "Needs you" filter can never disagree about what a decision is —
  // an inline version here resolved sessions through memberSessionIds only and
  // undercounted every agent attached by `session.issueId` alone.
  const pending = useMemo(
    () => portfolioActionableCount(allIssues, sessions),
    [allIssues, sessions],
  )
  const gitPanelEnabled = useFeature('git-panel')
  const messagesPanelEnabled = useFeature('messages-panel')
  const mergeQueueEnabled = useFeature('merge-queue')
  const panelAllowed = (panel: RightPanelTab): boolean =>
    rightPanelAllowed(panel, {
      git: gitPanelEnabled,
      messages: messagesPanelEnabled,
      mergeQueue: mergeQueueEnabled,
    })
  return (
    <nav aria-label="Panels" className="right-rail" data-testid="right-rail">
      {RIGHT_PANELS.filter((panel) => panelAllowed(panel.id)).map((panel) => (
        <button
          data-pressable
          key={panel.id}
          type="button"
          aria-label={panel.label}
          aria-pressed={rightPanel === panel.id}
          title={panel.label}
          onClick={() => onPanelChange(rightPanel === panel.id ? null : panel.id)}
          // `.right-rail-cell` is unlayered and sets no `position`, so the
          // utility `relative` is safe here (unlike a border — see above).
          // The open panel's raised, ringed, issue-coloured cell lives in
          // `.right-rail-cell[aria-pressed="true"]` (styles.css), so the rail's
          // one "you are here" recipe is written in one place.
          className="right-rail-cell relative"
        >
          <panel.icon size={17} strokeWidth={1.7} aria-hidden="true" />
          {/* The same corner badge the ID square above renders, from the same
                component — one geometry, one colour, one morph, one phrasing
                for "N waiting on you" across the whole rail. */}
          {panel.id === 'superagent' && (
            <StatusBadge kind="count" count={pending} ringColor={RAIL_SURFACE} />
          )}
        </button>
      ))}
    </nav>
  )
}

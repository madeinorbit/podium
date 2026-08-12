import type { JSX } from 'react'
import { useFeature } from '@/lib/use-feature'
import { RIGHT_PANELS } from './RightDock'
import { type RightPanelTab, rightPanelAllowed } from './shell-state'

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
 * The Superagent cell used to carry a numbered badge: the PORTFOLIO attention
 * count, every task anywhere waiting on a decision. Sitting on the superagent
 * glyph, the number read as a fact about the superagent — the one thing it
 * never was — so the rail now names panels and reports on nothing. The count
 * itself is unchanged and still readable where it belongs to something: the
 * explorer's Needs tab and the Flight Deck's "Needs you" filter, both on
 * `issueIsActionable`, the predicate that badge summed.
 *
 * The rail carries NO issue tint (POD-516 item 9). It hosts Superagent, Git,
 * Files, Shell and Messages alongside the task cell, so a tint pulled from the
 * selected issue asserted a relationship most of these cells do not have.
 */
export function RightRail({
  rightPanel,
  onPanelChange,
}: {
  rightPanel: RightPanelTab | null
  onPanelChange: (panel: RightPanelTab | null) => void
}): JSX.Element {
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
          // The open panel's raised, ringed cell lives in
          // `.right-rail-cell[aria-pressed="true"]` (styles.css), so the rail's
          // one "you are here" recipe is written in one place.
          className="right-rail-cell"
        >
          <panel.icon size={17} strokeWidth={1.7} aria-hidden="true" />
        </button>
      ))}
    </nav>
  )
}

import { shallowEqual } from '@podium/client-core/store'
import {
  cwdInWorktree,
  issueForCwd,
  reposToViews,
  resolveActiveWorktree,
  shippingPanelModel,
} from '@podium/client-core/viewmodels'
import type { JSX } from 'react'
import { useMemo } from 'react'
import { useFeature } from '@/lib/use-feature'
import { RIGHT_PANELS } from './RightDock'
import { type RightPanelTab, rightPanelAllowed } from './shell-state'
import { useReplicaIssues, useStoreSelector } from './store'

/**
 * The 44px right rail (handoff §2.5): one cell per dock panel — Tasks,
 * Superagent, Git, Files, Shell, Messages, Queues, Shipping.
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
 * `issueIsActionable`, the predicate that badge summed. The explorer runs it
 * over board scope (POD-1581), so a draft vessel whose agent is waiting is
 * counted by neither — its sidebar row IS the agent, and carries the pill.
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
  const shippingEnabled = useFeature('shipping')
  const { paneA, fileTabs, sessions, repos, shipOrders } = useStoreSelector(
    (state) => ({
      paneA: state.paneA,
      fileTabs: state.fileTabs,
      sessions: state.sessions,
      repos: state.repos,
      shipOrders: state.shipOrders,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const active = useMemo(
    () => resolveActiveWorktree({ paneA, fileTabs, sessions }),
    [fileTabs, paneA, sessions],
  )
  const repoId = useMemo(() => {
    if (!active) return null
    for (const repo of reposToViews(repos)) {
      const worktree = repo.worktrees
        .filter(
          (candidate) =>
            (!active.machineId ||
              !candidate.machineId ||
              candidate.machineId === active.machineId) &&
            cwdInWorktree(active.cwd, candidate.path),
        )
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (worktree) return repo.repoId ?? worktree.repoId ?? null
    }
    const activeIssueId =
      active.issueId ?? sessions.find((session) => session.sessionId === active.sessionId)?.issueId
    const issue = activeIssueId
      ? issues.find((candidate) => candidate.id === activeIssueId)
      : issueForCwd(issues, active.cwd)
    return issue?.repoId ?? null
  }, [active, issues, repos, sessions])
  const shipping = useMemo(
    () => shippingPanelModel(shipOrders, issues, repoId),
    [issues, repoId, shipOrders],
  )
  const panelAllowed = (panel: RightPanelTab): boolean =>
    rightPanelAllowed(panel, {
      git: gitPanelEnabled,
      messages: messagesPanelEnabled,
      mergeQueue: mergeQueueEnabled,
      shipping: shippingEnabled,
    })
  return (
    <nav aria-label="Panels" className="right-rail" data-testid="right-rail">
      {RIGHT_PANELS.filter((panel) => panelAllowed(panel.id)).map((panel) => {
        const isShipping = panel.id === 'shipping'
        const shippingLabel =
          shipping.unfinishedCount === 0
            ? 'Shipping, no unfinished deliveries'
            : `Shipping, ${shipping.unfinishedCount} unfinished ${shipping.unfinishedCount === 1 ? 'delivery' : 'deliveries'}${
                shipping.decisionCount > 0
                  ? `, ${shipping.decisionCount} ${shipping.decisionCount === 1 ? 'needs' : 'need'} your decision`
                  : ''
              }`
        const label = isShipping ? shippingLabel : panel.label
        return (
          <button
            data-pressable
            key={panel.id}
            type="button"
            aria-label={label}
            aria-pressed={rightPanel === panel.id}
            data-attention={isShipping && shipping.decisionCount > 0 ? 'true' : undefined}
            title={label}
            onClick={() => onPanelChange(rightPanel === panel.id ? null : panel.id)}
            // The open panel's raised, ringed cell lives in
            // `.right-rail-cell[aria-pressed="true"]` (styles.css), so the rail's
            // one "you are here" recipe is written in one place.
            className="right-rail-cell relative"
          >
            <panel.icon size={17} strokeWidth={1.7} aria-hidden="true" />
            {isShipping && shipping.unfinishedCount > 0 && (
              <span
                className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full border border-border bg-secondary px-1 font-mono text-[8px] leading-[14px] tabular-nums text-text-dim"
                aria-hidden="true"
              >
                {shipping.unfinishedCount > 99 ? '99+' : shipping.unfinishedCount}
              </span>
            )}
            {isShipping && shipping.decisionCount > 0 && (
              <span
                className="absolute top-1/2 -left-1 h-3 w-0.5 -translate-y-1/2 rounded-full bg-destructive"
                aria-hidden="true"
              />
            )}
          </button>
        )
      })}
    </nav>
  )
}

import { useCommands, useRequestClient } from '@podium/client-core/react'
import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import {
  type ProposalAction,
  type ProposalPorts,
  type ProposalProvenance,
  pendingLabel,
  type Submission,
  submissionsFor,
  successLabel,
} from '@podium/client-graph/mission-proposals'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { Check, X } from 'lucide-react'
import { issueWrites } from '@podium/commands/issues-synced'
import { type JSX, type MouseEvent, useMemo, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTipAnchorVisible, useTipMoment, useTipUnseen } from '@/features/tips'
import { openMiniview } from '@/lib/ref-activation'
import type { Trpc } from './trpc'

export { ProposalSubmissions, submissionsFor } from '@podium/client-graph/mission-proposals'

/** The desktop's bindings of the shared proposal verbs: the synced promote
 *  write, a declined close, and the `issue.begin` start record (POD-6526). */
function useProposalPorts(): ProposalPorts {
  const trpc = useRequestClient<Trpc>()
  const startIssueSession = useCommands<Trpc>().sessions.startIssueSession
  return useMemo(
    () => ({
      promote: (input) => issueWrites(trpc).promote.mutate(input),
      decline: (input) => trpc.issues.close.mutate({ ...input, reason: 'declined' }),
      startIssueSession,
    }),
    [trpc, startIssueSession],
  )
}

const FIRST_PROPOSAL_ANCHOR = 'first-proposal'
const firstProposalCards = [
  {
    anchor: FIRST_PROPOSAL_ANCHOR,
    title: 'Your agent found more work.',
    body: 'Start it now, backlog it so agents can start it later, or dismiss it.',
  },
]

type ProposalNavigation = {
  onMenu: (task: FullDeckTask, event: MouseEvent) => void
}

export const FlightDeckProposals = observer(function FlightDeckProposals({
  full,
  ...navigation
}: { full: FullDeck } & ProposalNavigation): JSX.Element | null {
  const submissions = submissionsFor(full)
  const ports = useProposalPorts()
  const ids = submissions.ids
  // First Flights: the first proposal the operator has not acted on yet. A receipt
  // (or a pending/failed command) is acted on, so the tip skips it. Once the
  // moment is seen, the anchor (kept for guide replay) skips the task reads.
  const unseen = useTipUnseen('first-proposal')
  const firstId = unseen
    ? ids.find((id) => !submissions.byId.has(id) && settled(() => full.task(id).proposed) === true)
    : ids.find((id) => !submissions.byId.has(id))
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  // Proposals sink below the tree, so the row is often scrolled out of the
  // deck. The moment waits until the row is fully in view instead of skipping.
  const inView = useTipAnchorVisible(unseen && firstId ? anchor : null)
  useTipMoment('first-proposal', { active: !!firstId && inView, cards: firstProposalCards })
  if (!ids.length) return null
  return (
    <section className="flight-proposals" data-testid="flight-proposed" aria-label="Proposed">
      <div className="flight-proposals-heading">
        <h2>Proposed</h2>
        <span>{ids.length}</span>
        <i aria-hidden="true" />
      </div>
      {ids.map((id) => (
        <FullProposal
          key={id}
          provenance={submissions.provenance(full.task(id))}
          task={full.task(id)}
          status={submissions.byId.get(id)}
          onSubmit={(verb) => void submissions.submit(id, verb, ports)}
          tipAnchor={id === firstId ? setAnchor : undefined}
          {...navigation}
        />
      ))}
    </section>
  )
})

/**
 * THE SAME ROWS FOR WORK THIS TASK FILED ON ITS OWN (POD-2043).
 *
 * A proposal filed as its own issue is not in the mission's tree, so the deck
 * never lists it. When the conversation moved, the pane names it beside where
 * the chat went, and it is still a proposal: same ring, same Backlog / Start /
 * dismiss, same receipts, so it reads as it does everywhere else.
 */
export const SpinOffProposals = observer(function SpinOffProposals({
  full,
  ...navigation
}: { full: FullDeck } & ProposalNavigation): JSX.Element | null {
  const submissions = submissionsFor(full)
  const ports = useProposalPorts()
  const ids = submissions.spinOffIds
  if (!ids.length) return null
  return (
    <section
      className="flight-proposals flight-proposals-inline"
      data-testid="spin-off-proposed"
      aria-label="Proposed"
    >
      <div className="flight-proposals-heading">
        <h2>Proposed</h2>
        <span>{ids.length}</span>
        <i aria-hidden="true" />
      </div>
      {ids.map((id) => (
        <FullProposal
          key={id}
          provenance={submissions.provenance(full.task(id))}
          task={full.task(id)}
          status={submissions.byId.get(id)}
          onSubmit={(verb) => void submissions.submit(id, verb, ports)}
          {...navigation}
        />
      ))}
    </section>
  )
})

const FullProposal = observer(function FullProposal({
  task,
  provenance,
  status,
  onSubmit,
  onMenu,
  tipAnchor,
}: {
  task: FullDeckTask
  provenance: ProposalProvenance
  status: Submission | undefined
  onSubmit: (verb: ProposalAction) => void
  tipAnchor?: (element: HTMLDivElement | null) => void
} & ProposalNavigation): JSX.Element | null {
  const drawable = settled(() => task.row.drawable) === true
  // A publication can beat the command response. Until that response arrives,
  // show only pending/error; never infer success from a changed stage.
  const proposed = settled(() => task.proposed) === true
  const receipt = !proposed
  if (!proposed && !status) return null
  const ref = drawable ? task.row.displayRef : ''
  const tooltip = settled(() => provenance.tooltip)
  const description = typeof tooltip === 'string' ? tooltip : undefined
  const pending = status?.phase === 'pending'
  const success = status?.phase === 'success'
  return (
    <div
      className={receipt ? 'flight-proposal-receipt' : 'flight-proposal'}
      data-flight-issue={receipt ? undefined : task.id}
      data-proposal-receipt={receipt ? task.id : undefined}
      aria-busy={pending || undefined}
      ref={tipAnchor}
      data-tip-anchor={tipAnchor ? FIRST_PROPOSAL_ANCHOR : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu covers the line; its buttons provide keyboard actions. */}
      <div className="flight-proposal-line" onContextMenu={(event) => onMenu(task, event)}>
        {!receipt && <span className="flight-proposal-ring" aria-hidden="true" />}
        <Tooltip>
          <TooltipTrigger
            render={<button data-pressable type="button" className="flight-proposal-details" />}
            aria-description={description}
            aria-label={`Open ${ref}: ${drawable ? task.row.title : 'proposal details'}`}
            aria-haspopup="dialog"
            onClick={(event) => {
              if (!ref) return
              const rect = event.currentTarget.getBoundingClientRect()
              openMiniview(ref, { x: rect.left, y: rect.bottom })
            }}
          >
            <span className="flight-proposal-ref">{ref}</span>
            {drawable && <span className="flight-proposal-title">{task.row.title}</span>}
          </TooltipTrigger>
          {/* The row truncates the title; hovering reads it whole. Provenance stays
              on the trigger's aria-description for assistive tech. */}
          {drawable && <TooltipContent>{task.row.title}</TooltipContent>}
        </Tooltip>
        {success || (receipt && pending) ? (
          <span className="flight-proposal-result" role="status">
            {success && <Check size={12} aria-hidden="true" />}
            {success ? successLabel[status.action] : pendingLabel[status.action]}
          </span>
        ) : !receipt ? (
          <div className="flight-proposal-actions">
            <button
              data-pressable
              type="button"
              className="flight-proposal-backlog"
              disabled={pending}
              onClick={() => onSubmit('backlog')}
            >
              Backlog
            </button>
            <button
              data-pressable
              type="button"
              className="flight-proposal-start"
              disabled={pending}
              onClick={() => onSubmit('start')}
            >
              Start
            </button>
            <button
              data-pressable
              type="button"
              className="flight-proposal-dismiss"
              disabled={pending}
              aria-label={`Dismiss ${ref}`}
              title="Dismiss proposal"
              onClick={() => onSubmit('dismiss')}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      {pending && !receipt && (
        <p className="flight-proposal-message" role="status">
          {pendingLabel[status.action]}
        </p>
      )}
      {status?.phase === 'error' && (
        <div className="flight-proposal-message flight-proposal-error" role="alert">
          <span>{status.error}</span>
          <button data-pressable type="button" onClick={() => onSubmit(status.action)}>
            Retry{' '}
            {status.action === 'dismiss'
              ? 'Dismiss'
              : status.action === 'start'
                ? 'Start'
                : 'Backlog'}
          </button>
        </div>
      )}
    </div>
  )
})

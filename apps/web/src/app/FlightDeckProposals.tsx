import { issueWrites } from '@podium/commands/issues-synced'
import { discoveredPlacement } from '@podium/client-core/values'
import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { requireLoaded, settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { companion, lazy } from '@podium/mobx-helpers'
import { asIssueId, asMutationId } from '@podium/model'
import { Check, X } from 'lucide-react'
import { action, compareShallow, observable, runInAction } from 'mobx'
import { type JSX, type MouseEvent, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTipAnchorVisible, useTipMoment, useTipUnseen } from '@/features/tips'
import { openMiniview } from '@/lib/ref-activation'
import { useRuntimeSelector } from './store'
import type { Trpc } from './trpc'

type ProposalAction = 'backlog' | 'start' | 'dismiss'
type Submission = {
  action: ProposalAction
  mutationId: ReturnType<typeof asMutationId>
  phase: 'pending' | 'success' | 'error'
  error?: string
}
const pendingLabel = { backlog: 'Adding to backlog…', start: 'Starting…', dismiss: 'Dismissing…' }
const successLabel = { backlog: 'In backlog', start: 'Started', dismiss: 'Dismissed' }

class ProposalProvenance {
  constructor(readonly task: FullDeckTask) {}
  @lazy get tooltip(): string {
    const issue = requireLoaded(this.task.deck.screen.reader.catalogIssue(this.task.id))
    // The shared stage-independent placement reader keeps provenance on a receipt
    // after the proposal has joined the accepted tree or left for its own issue.
    const placement = issue ? discoveredPlacement(issue)?.placement : null
    return `Proposed by ${this.task.proposalAuthor ?? 'an agent'} · ${placement === 'own' ? 'Own issue' : placement === 'mission' ? 'Here in this mission' : 'Placement not specified'}`
  }
}

/** UI state for this mission opening only. The pool remains the sole record store.
 * Receipts keep only the command outcome and its ID, including across publication. */
class ProposalSubmissions {
  constructor(readonly full: FullDeck) {}
  readonly provenance = companion((task: FullDeckTask) => new ProposalProvenance(task))
  readonly byId = observable.map<string, Submission>([], { deep: false })

  @lazy({ equals: compareShallow }) get ids(): readonly string[] {
    return this.listed(settled(() => this.full.proposalIds))
  }
  /** Proposals the mission's root filed as their own issues (POD-2043): the
   * moved-conversation pane offers them in the same rows. */
  @lazy({ equals: compareShallow }) get spinOffIds(): readonly string[] {
    return this.listed(settled(() => this.full.screen.spinOffProposalIds))
  }
  /** Still proposed, or acted on in this opening and not dismissed: a receipt
   * outlives the stage change it caused. */
  private listed(proposed: readonly string[] | symbol): string[] {
    return [
      ...new Set([...(typeof proposed === 'symbol' ? [] : proposed), ...this.byId.keys()]),
    ].filter((id) => {
      const status = this.byId.get(id)
      return (
        !(status?.action === 'dismiss' && status.phase === 'success') &&
        settled(() => this.full.task(id).abandoned) !== true
      )
    })
  }

  @action async submit(id: string, verb: ProposalAction, trpc: Trpc): Promise<void> {
    const previous = this.byId.get(id)
    // Synchronous guard: even two clicks in the same React turn issue one command.
    if (previous?.phase === 'pending' || previous?.phase === 'success') return
    const mutationId =
      previous?.action === verb ? previous.mutationId : asMutationId(crypto.randomUUID())
    this.byId.set(id, { action: verb, mutationId, phase: 'pending' })
    try {
      const input = { id: asIssueId(id), mutationId }
      // The operator-authenticated client uses the existing commands. In particular,
      // start owns promotion, placement and proposal → parent → mission profiles.
      if (verb === 'backlog') await issueWrites(trpc).promote.mutate(input)
      else if (verb === 'start') await trpc.issues.start.mutate(input)
      else await trpc.issues.close.mutate({ ...input, reason: 'declined' })
      runInAction(() => this.byId.set(id, { action: verb, mutationId, phase: 'success' }))
    } catch (error) {
      runInAction(() =>
        this.byId.set(id, {
          action: verb,
          mutationId,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
}

// The opening's Full view model owns this companion's lifetime. A temporary
// loading screen or mode switch must not discard an in-flight command/receipt.
const submissionsFor = companion((full: FullDeck) => new ProposalSubmissions(full))

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
  const trpc = useRuntimeSelector((store) => store.trpc)
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
          onSubmit={(verb) => void submissions.submit(id, verb, trpc)}
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
  const trpc = useRuntimeSelector((store) => store.trpc)
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
          onSubmit={(verb) => void submissions.submit(id, verb, trpc)}
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
            render={<button type="button" className="flight-proposal-details" />}
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
              type="button"
              className="flight-proposal-backlog"
              disabled={pending}
              onClick={() => onSubmit('backlog')}
            >
              Backlog
            </button>
            <button
              type="button"
              className="flight-proposal-start"
              disabled={pending}
              onClick={() => onSubmit('start')}
            >
              Start
            </button>
            <button
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
          <button type="button" onClick={() => onSubmit(status.action)}>
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

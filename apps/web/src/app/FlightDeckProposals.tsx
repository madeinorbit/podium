import type { FullDeck, FullDeckTask } from '@podium/client-graph/mission-full-deck'
import { settled } from '@podium/client-graph/mission-view'
import { observer } from '@podium/client-graph/react'
import { asIssueId, asMutationId } from '@podium/model'
import { Check, X } from 'lucide-react'
import { action, observable, runInAction } from 'mobx'
import { useState, type JSX, type MouseEvent } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClickIntent } from './click-intent'
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

/** UI state for this Full opening only. The pool remains the sole record store.
 * Receipts keep only the command outcome and its ID, including across publication. */
class ProposalSubmissions {
  readonly byId = observable.map<string, Submission>([], { deep: false })

  @action async submit(id: string, verb: ProposalAction, trpc: Trpc): Promise<void> {
    const previous = this.byId.get(id)
    // Synchronous guard: even two clicks in the same React turn issue one command.
    if (previous?.phase === 'pending' || previous?.phase === 'success') return
    const mutationId = previous?.action === verb ? previous.mutationId : asMutationId(crypto.randomUUID())
    this.byId.set(id, { action: verb, mutationId, phase: 'pending' })
    try {
      const input = { id: asIssueId(id), mutationId }
      // The operator-authenticated client uses the existing commands. In particular,
      // start owns promotion, placement and proposal → parent → mission profiles.
      if (verb === 'backlog') await trpc.issues.promote.mutate(input)
      else if (verb === 'start') await trpc.issues.start.mutate(input)
      else await trpc.issues.close.mutate({ ...input, reason: 'declined' })
      runInAction(() => this.byId.set(id, { action: verb, mutationId, phase: 'success' }))
    } catch (error) {
      runInAction(() => this.byId.set(id, {
        action: verb, mutationId, phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }
}

type ProposalNavigation = {
  onSelect: (task: FullDeckTask, permanent: boolean) => void
  onMenu: (task: FullDeckTask, event: MouseEvent) => void
}

export const FlightDeckProposals = observer(function FlightDeckProposals({
  full, ...navigation
}: { full: FullDeck } & ProposalNavigation): JSX.Element | null {
  const [submissions] = useState(() => new ProposalSubmissions())
  const trpc = useRuntimeSelector(store => store.trpc)
  const ids = [...new Set([...full.proposalIds, ...submissions.byId.keys()])].filter(id => {
    const status = submissions.byId.get(id)
    return !(status?.action === 'dismiss' && status.phase === 'success')
  })
  if (!ids.length) return null
  return (
    <section className="flight-proposals" data-testid="flight-proposed" aria-label="Proposed">
      <div className="flight-proposals-heading">
        <h2>Proposed</h2><span>{ids.length}</span><i aria-hidden="true" />
      </div>
      {ids.map(id => (
        <FullProposal key={id} task={full.task(id)} status={submissions.byId.get(id)}
          onSubmit={verb => void submissions.submit(id, verb, trpc)} {...navigation} />
      ))}
    </section>
  )
})

const FullProposal = observer(function FullProposal({ task, status, onSubmit, onSelect, onMenu }: {
  task: FullDeckTask
  status: Submission | undefined
  onSubmit: (verb: ProposalAction) => void
} & ProposalNavigation): JSX.Element | null {
  const intent = useClickIntent()
  const drawable = settled(() => task.row.drawable) === true
  // A publication can beat the command response. Until that response arrives,
  // show only pending/error; never infer success from a changed stage.
  const proposed = settled(() => task.proposed) === true
  const receipt = !proposed
  if (!proposed && !status) return null
  const ref = drawable ? task.row.displayRef : ''
  const provenance = proposed
    ? `Proposed by ${task.proposalAuthor ?? 'an agent'} · ${task.placement === 'own' ? 'Own issue' : task.placement === 'mission' ? 'Here in this mission' : 'Placement not specified'}`
    : undefined
  const pending = status?.phase === 'pending'
  const success = status?.phase === 'success'
  return (
    <div className={receipt ? 'flight-proposal-receipt' : 'flight-proposal'}
      data-flight-issue={receipt ? undefined : task.id}
      data-proposal-receipt={receipt ? task.id : undefined}
      aria-busy={pending || undefined}>
      <div className="flight-proposal-line" onContextMenu={event => onMenu(task, event)}>
        {!receipt && <span className="flight-proposal-ring" aria-hidden="true" />}
        <Tooltip>
          <TooltipTrigger render={<button type="button" className="flight-proposal-details" />}
            aria-label={`Open ${ref}: ${drawable ? task.row.title : 'proposal details'}`}
            onClick={() => intent.press(() => onSelect(task, false), () => onSelect(task, true))}
            onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              intent.commit(() => onSelect(task, true))
            }}>
            <span className="flight-proposal-ref">{ref}</span>
            {drawable && <span className="flight-proposal-title">{task.row.title}</span>}
          </TooltipTrigger>
          {provenance && <TooltipContent>{provenance}</TooltipContent>}
        </Tooltip>
        {success || (receipt && pending) ? (
          <span className="flight-proposal-result" role="status">
            {success && <Check size={12} aria-hidden="true" />}
            {success ? successLabel[status.action] : pendingLabel[status.action]}
          </span>
        ) : !receipt ? (
          <div className="flight-proposal-actions">
            <button type="button" className="flight-proposal-backlog" disabled={pending}
              onClick={() => onSubmit('backlog')}>Backlog</button>
            <button type="button" className="flight-proposal-start" disabled={pending}
              onClick={() => onSubmit('start')}>Start</button>
            <button type="button" className="flight-proposal-dismiss" disabled={pending}
              aria-label={`Dismiss ${ref}`} title="Dismiss proposal"
              onClick={() => onSubmit('dismiss')}><X size={13} aria-hidden="true" /></button>
          </div>
        ) : null}
      </div>
      {pending && !receipt && <p className="flight-proposal-message" role="status">{pendingLabel[status.action]}</p>}
      {status?.phase === 'error' && <div className="flight-proposal-message flight-proposal-error" role="alert">
        <span>{status.error}</span>
        <button type="button" onClick={() => onSubmit(status.action)}>Retry {status.action === 'dismiss' ? 'Dismiss' : status.action === 'start' ? 'Start' : 'Backlog'}</button>
      </div>}
    </div>
  )
})

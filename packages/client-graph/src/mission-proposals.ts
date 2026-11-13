import { discoveredPlacement } from '@podium/client-core/values'
import { companion, lazy } from '@podium/mobx-helpers'
import { asIssueId, asMutationId } from '@podium/model'
import {
  action,
  compareShallow,
  compareStructural,
  observable,
  observableRef,
  runInAction,
} from 'mobx'
import type { FullDeck, FullDeckTask } from './mission-full-deck'
import { requireLoaded, settled } from './mission-view'
import { RowWindow } from './row-window'

type ProposalInput = {
  id: ReturnType<typeof asIssueId>
  mutationId: ReturnType<typeof asMutationId>
}
export interface ProposalCommands {
  issues: {
    promote: { mutate(input: ProposalInput): Promise<unknown> }
    start: { mutate(input: ProposalInput): Promise<unknown> }
    close: { mutate(input: ProposalInput & { reason: 'declined' }): Promise<unknown> }
  }
}

export type ProposalAction = 'backlog' | 'start' | 'dismiss'
export type Submission = {
  action: ProposalAction
  mutationId: ReturnType<typeof asMutationId>
  phase: 'pending' | 'success' | 'error'
  error?: string
  expiresAt?: number
}
export const pendingLabel = {
  backlog: 'Adding to backlog…',
  start: 'Starting…',
  dismiss: 'Dismissing…',
}
export const successLabel = { backlog: 'In backlog', start: 'Started', dismiss: 'Dismissed' }

export class ProposalProvenance {
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
export class ProposalSubmissions {
  constructor(
    readonly full: FullDeck,
    readonly receipts: 'desktop' | 'brief' = 'desktop',
  ) {}
  readonly provenance = companion((task: FullDeckTask) => new ProposalProvenance(task))
  readonly byId = observable.map<string, Submission>([], { deep: false })
  private readonly expired = observable.set<string>()
  // Capture row identities at the action, not record facts. Publication must
  // not move the brief confirmation out from under the operator's finger.
  @observableRef private accessor receiptOrder: readonly string[] = []
  readonly window = new RowWindow(
    () => this.ids,
    (id) => id,
  )

  /** A single UI timer owns the next receipt deadline for this opening. */
  @lazy get receiptDeadline(): number | null {
    let next: number | null = null
    for (const [id, status] of this.byId) {
      if (status.expiresAt !== undefined && !this.expired.has(id)) {
        next = Math.min(next ?? Infinity, status.expiresAt)
      }
    }
    return next
  }

  @action expireReceipts(now = Date.now()): void {
    for (const [id, status] of this.byId) {
      if (status.expiresAt !== undefined && status.expiresAt <= now) this.expired.add(id)
    }
  }

  @lazy({ equals: compareShallow }) get ids(): readonly string[] {
    return this.listed(settled(() => this.full.proposalIds))
  }
  /** A brief receipt occupies the proposal's place until it collapses. Drawing
   * its accepted row above Proposed sooner would move the entire section. */
  @lazy({ equals: compareStructural }) get acceptedTree(): {
    readonly rowIds: readonly string[]
    readonly filterable: boolean
  } {
    if (!this.holdingReceipts) return { rowIds: this.full.rowIds, filterable: this.full.filterable }
    const rowIds: string[] = []
    let heldDepth: number | null = null
    for (const id of this.full.rowIds) {
      if (heldDepth !== null && this.full.task(id).depth > heldDepth) continue
      heldDepth = null
      if (this.holdsReceipt(id)) heldDepth = this.full.task(id).depth
      else rowIds.push(id)
    }
    return {
      rowIds,
      filterable: this.full.root.childIds.some((id) => !this.holdsReceipt(id)),
    }
  }

  @lazy private get holdingReceipts(): boolean {
    return this.receipts === 'brief' && [...this.byId.keys()].some((id) => this.holdsReceipt(id))
  }

  private holdsReceipt(id: string): boolean {
    const status = this.byId.get(id)
    return !!status && status.phase !== 'error' && !this.expired.has(id)
  }
  /** Proposals the mission's root filed as their own issues (POD-2043): the
   * moved-conversation pane offers them in the same rows. */
  @lazy({ equals: compareShallow }) get spinOffIds(): readonly string[] {
    return this.listed(settled(() => this.full.screen.spinOffProposalIds))
  }
  /** Still proposed, or acted on in this opening and not dismissed: a receipt
   * outlives the stage change it caused. */
  private listed(proposed: readonly string[] | symbol): string[] {
    const ids = [
      ...new Set([...(typeof proposed === 'symbol' ? [] : proposed), ...this.byId.keys()]),
    ].filter((id) => {
      const status = this.byId.get(id)
      if (this.receipts === 'brief' && status && status.phase !== 'error')
        return !this.expired.has(id)
      return (
        !(status?.action === 'dismiss' && status.phase === 'success') &&
        settled(() => this.full.task(id).abandoned) !== true
      )
    })
    if (!this.holdingReceipts) return ids
    const remaining = new Set(ids)
    return [...this.receiptOrder.filter((id) => remaining.delete(id)), ...remaining]
  }

  @action async submit(id: string, verb: ProposalAction, trpc: ProposalCommands): Promise<void> {
    const previous = this.byId.get(id)
    // Synchronous guard: even two clicks in the same React turn issue one command.
    if (previous?.phase === 'pending' || previous?.phase === 'success') return
    const mutationId =
      previous?.action === verb ? previous.mutationId : asMutationId(crypto.randomUUID())
    if (this.receipts === 'brief') this.receiptOrder = this.ids
    this.byId.set(id, { action: verb, mutationId, phase: 'pending' })
    try {
      const input = { id: asIssueId(id), mutationId }
      // The operator-authenticated client uses the existing commands. In particular,
      // start owns promotion, placement and proposal → parent → mission profiles.
      if (verb === 'backlog') await trpc.issues.promote.mutate(input)
      else if (verb === 'start') await trpc.issues.start.mutate(input)
      else await trpc.issues.close.mutate({ ...input, reason: 'declined' })
      runInAction(() =>
        this.byId.set(id, {
          action: verb,
          mutationId,
          phase: 'success',
          ...(this.receipts === 'brief' ? { expiresAt: Date.now() + 1800 } : {}),
        }),
      )
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
export const submissionsFor = companion((full: FullDeck) => new ProposalSubmissions(full))

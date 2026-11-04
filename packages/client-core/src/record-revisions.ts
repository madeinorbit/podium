/**
 * ONE DEVICE'S CHAIN OF EDITS ON ONE RECORD (POD-6403).
 *
 * An edit of an `exp-rev` field names the revision it was made against, and the
 * server refuses it as `conflict` when the record has moved since. Two such
 * edits queued on one device for one record (a stop, then a resume, offline)
 * were both made against the same revision: the first one's write moves the
 * revision, and the second would be refused for a change this device made
 * itself.
 *
 * THE RULE. When an own edit made against revision B is applied and its reply
 * says the record is now at R, a later own edit of the same record that was
 * ALSO made against B is sent against R. Only that: an edit made against any
 * other revision is sent as made, and another writer's change still conflicts,
 * because R is the revision after THIS device's write and nobody else's.
 *
 * Only edits that name a revision take part. A plain-field edit (`field-LWW`)
 * names none, so it neither starts nor extends a chain.
 *
 * In memory, per queue: a reload between the reply and the next send forgets
 * the chain, and that next edit is refused `conflict` and offered for retry on
 * fresh truth (ADR 3 D13.3), as any stale edit is.
 */

import { isRecordOutboxKind } from './records'

interface Link {
  /** The revision the chained edits were made against. */
  readonly base: number
  /** The record's revision after this device's latest applied edit of them. */
  readonly revision: number
}

type RecordInput = {
  readonly kind?: unknown
  readonly id?: unknown
  readonly expectedRevision?: unknown
}

function keyOf(input: RecordInput): string | undefined {
  return typeof input.kind === 'string' && typeof input.id === 'string'
    ? `${input.kind}\u0000${input.id}`
    : undefined
}

export class RecordRevisionChain {
  private readonly links = new Map<string, Link>()

  /** The revision to send a queued record write against: its own, or the
   *  revision its own applied predecessor made against the same base wrote. */
  sendAgainst(kind: string, input: RecordInput): number | undefined {
    const made = input.expectedRevision
    if (!isRecordOutboxKind(kind) || typeof made !== 'number') return undefined
    const key = keyOf(input)
    const link = key === undefined ? undefined : this.links.get(key)
    return link !== undefined && link.base === made ? link.revision : made
  }

  /** An own record write was applied; `result` is its reply. */
  applied(kind: string, input: RecordInput, result: unknown): void {
    const made = input.expectedRevision
    const revision = (result as { revision?: unknown } | null | undefined)?.revision
    if (!isRecordOutboxKind(kind) || typeof made !== 'number' || typeof revision !== 'number') {
      return
    }
    const key = keyOf(input)
    if (key !== undefined) this.links.set(key, { base: made, revision })
  }
}

const chains = new WeakMap<object, RecordRevisionChain>()

/** The chain of the queue that sends through `owner` (its API client). */
export function recordRevisionChainFor(owner: object): RecordRevisionChain {
  let chain = chains.get(owner)
  if (chain === undefined) {
    chain = new RecordRevisionChain()
    chains.set(owner, chain)
  }
  return chain
}

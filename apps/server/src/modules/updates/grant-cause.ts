/**
 * WHO AUTHORIZED THIS GRANT, WRITTEN DOWN WHERE IT SURVIVES (POD-2907).
 *
 * A grant is the only thing in this system that can replace a running process,
 * and until this file existed it was issued anonymously: {@link
 * UpdatesService.issueGrants} took a channel, a target and a list of machine
 * ids, and every caller — an operation's `machines` step, a per-row Apply, the
 * standing reconciliation, the operation's one automatic retry — arrived
 * indistinguishable from the others.
 *
 * That is not a tidiness complaint. On 2026-08-31 a publication finished at
 * 06:14:56Z and this host's parent launched a successor at 06:14:58Z. There was
 * no `updates.start`, no converge action, and the operations table's last
 * terminal transition was the previous evening — so the only way to name what
 * had authorized the restart was to read the code and eliminate paths, because
 * the process logs were filtered to `warn` and the one line that would have said
 * it was `info`. A cause that exists only as a log line is a cause that exists
 * only when somebody set the level correctly yesterday.
 *
 * TWO PROPERTIES, and the type is shaped by both:
 *
 *  1. **It cannot be omitted.** {@link GrantCause} is a REQUIRED parameter of
 *     every method that can grant. A new call site cannot compile without
 *     answering "on whose authority", which is the half a log line can never
 *     enforce.
 *  2. **It is durable.** {@link GrantRecord} is appended to the server's own
 *     event log, not only logged, so the answer outlives the process the grant
 *     replaces and the log level the operator happened to be running.
 */

/** What set a grant in motion. Every arm names something a human can point at. */
export type GrantInitiator =
  /** The `machines` step of a durable update operation — a click, with a record. */
  | { kind: 'operation'; operationId?: string; step: string }
  /** That same operation's one automatic retry after a stall (§3.3). */
  | { kind: 'operation-retry'; operationId?: string; step: string }
  /** A person pressed Apply on one fleet row. */
  | { kind: 'operator-apply' }
  /** A person pressed Repair on one fleet row. */
  | { kind: 'operator-repair' }
  /**
   * The standing reconciliation (§3.6) — background convergence with no
   * operation and nobody watching. `event` is the edge that woke it.
   */
  | { kind: 'reconciliation'; event: 'machine-connected' | 'operation-settled' }
  /**
   * A `fleet()` read continuing an authorized wave, because a machine's
   * directory version proved the canary. Authorized by the operation that set
   * the consent, but issued from a READ — which is why it is named separately.
   */
  | { kind: 'wave-continuation' }

/**
 * One grant, and everything needed to answer "why did that machine restart?"
 * without a second source.
 */
export interface GrantRecord {
  at: number
  grantId: string
  machineId: string
  /** The machine's display name at grant time, when the directory carried one. */
  machineName?: string
  channel: string
  targetVersion: string
  /** The version the machine was on. What the grant is moving it FROM. */
  fromVersion?: string
  initiator: GrantInitiator
  /** Why this machine was eligible, in the vocabulary of the deciding path. */
  eligibility: string
  /** Repair re-delivers equal bytes; an ordinary grant never does. */
  repair?: boolean
  /**
   * IS THIS THE COORDINATOR REPLACING ITSELF?
   *
   * The single fact the incident turned on. A grant to the host's own machine
   * id lands on the in-process local update participant, which asks the parent
   * to swap and hand over — so this row, alone, means "this server is about to
   * become a different process".
   */
  handover: boolean
}

/** The seam the composition root fills with a durable append. */
export type RecordGrant = (record: GrantRecord) => void

/** The event-log kind these records are written under. */
export const GRANT_EVENT_KIND = 'update.grant'

/** A one-line English rendering, for the log line that accompanies the record. */
export function describeGrantCause(record: GrantRecord): string {
  switch (record.initiator.kind) {
    case 'operation':
      return `the "${record.initiator.step}" step of update operation ${record.initiator.operationId ?? '(unrecorded)'}`
    case 'operation-retry':
      return `the automatic retry of update operation ${record.initiator.operationId ?? '(unrecorded)'}`
    case 'operator-apply':
      return 'a person pressing Apply on this machine'
    case 'operator-repair':
      return 'a person pressing Repair on this machine'
    case 'reconciliation':
      return `background convergence woken by ${record.initiator.event}`
    case 'wave-continuation':
      return 'an authorized wave continuing from a fleet read'
  }
}

/** The cause a caller states; the record adds what only the service knows. */
export interface GrantCause {
  initiator: GrantInitiator
  eligibility: string
}

/**
 * THE SYNC WRITE ENTRY POINT (ADR 12 D2, POD-6273).
 *
 * Every write to synced data from outside the server enters here, through a thin
 * transport adapter (`sync.submit` over tRPC today; the CLI, MCP and the daemon
 * relay later). The steps run in this order, and the order is the contract:
 *
 *   1. the principal, from the transport (the adapter passes it in);
 *   2. the contract, looked up by name and version, and a COARSE permission check
 *      (exposure on this transport, role floor, the action's role) BEFORE any
 *      parsing, so a refused caller learns nothing from validation errors (ADR 3
 *      `errorConsistency`);
 *   3. the input, parsed with the contract's schema;
 *   4. a TARGET permission check on the record the parsed input names (owner,
 *      grant, delegation: ADR 3 D8/D16), live, through the registration's
 *      resolver;
 *   5. dedup by `mutationId` (`MutationLedger`), after both checks, so a replay
 *      is still refused once a grant is revoked;
 *   6. the provenance scope: every change row the handler appends carries
 *      `mutationId` and `causationId`;
 *   7. the handler in ONE unit of work: its data writes, its change-log appends and
 *      the dedup record commit together (ADR 2 D10). Non-database work waits for
 *      the commit through `afterCommit`;
 *   8. the reply, with a receipt whose `seq` is the change-log head after the
 *      commit (plan Decision 1: it also covers a no-op, which appends nothing).
 *
 * A REFUSAL IS A REPLY; A FAILURE IS NOT. Steps 2 to 4, and a handler that throws
 * {@link SyncWriteRefused}, answer `{ outcome: 'rejected' }`: a definitive verdict
 * the outbox dead-letters. Any other throw propagates as a transport error. The
 * unit rolled back and nothing was recorded, so the outbox's retry runs the
 * handler again; answering `rejected` there would turn a transient failure into a
 * permanent one.
 */

import { createLogger, describeError } from '@podium/logger'
import type { Capability, MutationId } from '@podium/model'
import { authorize } from '@podium/model'
import type {
  SyncSubmitInput,
  SyncSubmitRefusal,
  SyncSubmitReply,
  WriteReceipt,
} from '@podium/protocol'
import type { AuthorityRefusal, MutationLedger, OutboxEnvelope } from '@podium/sync'
import { type CommandPrincipal, onBehalfOfUser } from '../../command-principal'
import { outsideWriteProvenance, withWriteProvenance } from '../../write-provenance'
import { coarselyPermitted, parseCommandInput } from '../front-door'
import {
  isNoTarget,
  type SyncCommand,
  type SyncWriteContext,
  type SyncWriteLedger,
  type SyncWriteRegistry,
  type SyncWriteTarget,
  type SyncWriteTransport,
} from './registry'

// The wire shapes in `@podium/protocol` and the kernel's types in `@podium/sync`
// name the same envelope and the same refusal; the protocol package cannot import
// the kernel, so this is where the two are held together. Checked in the
// directions the data travels: the client sends its `OutboxEnvelope` as the
// submit input, and reads a reply refusal as an `AuthorityRefusal`. The kinds are
// held EQUAL, so neither side can grow an arm the other has not.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const envelopeIsSubmitInput = (envelope: OutboxEnvelope): SyncSubmitInput => envelope
const replyRefusalIsAuthorityRefusal = (refusal: SyncSubmitRefusal): AuthorityRefusal => refusal
const refusalKindsAgree: Same<SyncSubmitRefusal['kind'], AuthorityRefusal['kind']> = true
void [refusalKindsAgree, envelopeIsSubmitInput, replyRefusalIsAuthorityRefusal]

/**
 * A handler's definitive refusal, such as a stale `expectedRevision` (`conflict`).
 * Thrown from inside the unit of work: the unit rolls back, nothing is recorded,
 * and the caller gets `{ outcome: 'rejected', refusal }`.
 */
export class SyncWriteRefused extends Error {
  /**
   * `cause` is the family's own error, when the refusal translates one (an
   * `IssueNotFound`, a 409 conflict). It never reaches the wire: the reply
   * carries the refusal kind alone. An old per-command route reads it through
   * {@link SyncWriteEntry.submitDetailed} to answer exactly as it did before it
   * became an adapter (POD-6350).
   */
  constructor(
    readonly refusal: SyncSubmitRefusal,
    options?: { cause?: unknown },
  ) {
    super(`sync write refused: ${refusal.kind}`, options)
    this.name = 'SyncWriteRefused'
  }
}

/** A reply, and the family error behind a refusal when there is one. */
export interface DetailedSubmit {
  readonly reply: SyncSubmitReply
  readonly cause?: unknown
}

export interface SyncWriteEntryDeps {
  readonly registry: SyncWriteRegistry
  /** THE process's one dedup ledger (`relay.ts`); a second instance would be a
   *  second in-flight map over one table. */
  readonly mutations: Pick<MutationLedger, 'apply'>
  /** One unit of work: the store's `transact`. */
  readonly unitOfWork: <T>(fn: () => Promise<T>) => Promise<T>
  /** Register work to run after the outermost commit: the store's `effect`. */
  readonly afterCommit: (step: () => void | Promise<void>, label: string) => void
  /** Whether a unit of work is already open in the caller's context. */
  readonly spanOpen: () => boolean
  /** The write-seam Ledger, whose Authority reads the provenance scope. */
  readonly ledger: SyncWriteLedger
  /** The feed identity and the change-log head, read now (`relay.writeReceiptNow`). */
  readonly receipt: () => Promise<WriteReceipt>
}

const log = createLogger('server:sync-write')

/**
 * THE CALLER'S OWN PER-USER ROW (POD-6404): a read mark, a snooze, a tuck is
 * a fact about the person, keyed by them (ADR 9 D3 rule 4), so it is written
 * under the caller's SELF scope whatever scope the capability carries for
 * shared records. A member's owner-or-grant capability reaches nobody's
 * per-user rows (issue-authz §3.3), which refused every member's read mark on
 * this path; an agent writes its human's row, as it acts for them. Anyone
 * else's row is unchanged: still refused.
 */
function capabilityFor(
  principal: Exclude<CommandPrincipal, { kind: 'system' }>,
  target: Exclude<SyncWriteTarget, undefined>,
): Capability {
  if (isNoTarget(target) || target.kind !== 'per-user-row') return principal.capability
  const human = onBehalfOfUser(principal)
  if (human === null || target.userId !== human) return principal.capability
  return { ...principal.capability, scope: { kind: 'self', userId: human } }
}

const rejected = (refusal: SyncSubmitRefusal): SyncSubmitReply => ({ outcome: 'rejected', refusal })
const UNAUTHORIZED: SyncSubmitRefusal = { kind: 'unauthorized' }

export class SyncWriteEntry {
  constructor(private readonly deps: SyncWriteEntryDeps) {}

  get registry(): SyncWriteRegistry {
    return this.deps.registry
  }

  async submit(
    envelope: SyncSubmitInput,
    principal: CommandPrincipal,
    transport: SyncWriteTransport,
  ): Promise<SyncSubmitReply> {
    return (await this.submitDetailed(envelope, principal, transport)).reply
  }

  /**
   * {@link submit}, keeping the error behind a handler's refusal. For the old
   * per-command routes, which stay as thin adapters onto this entry until
   * POD-6359 removes them: their callers still read the message and the HTTP
   * code they always got. Nothing else may use the cause; the wire is the reply.
   */
  async submitDetailed(
    envelope: SyncSubmitInput,
    principal: CommandPrincipal,
    transport: SyncWriteTransport,
  ): Promise<DetailedSubmit> {
    const answer = (reply: SyncSubmitReply): DetailedSubmit => ({ reply })
    // The receipt is the head after THIS call's commit. Inside a caller's open
    // unit our commit is only a savepoint, and a receipt read there could name
    // rows that the caller then rolls back.
    if (this.deps.spanOpen()) {
      throw new Error(`sync write: ${envelope.command} was submitted inside an open unit of work`)
    }

    // 2. Contract lookup and the coarse check, before the input is looked at.
    const command = this.deps.registry.lookup(envelope.command)
    if (command === undefined) return answer(rejected({ kind: 'invalid', details: ['command'] }))
    if (!coarselyPermitted(command, principal, transport)) return answer(rejected(UNAUTHORIZED))
    if (envelope.version !== command.version)
      return answer(rejected({ kind: 'invalid', details: ['version'] }))

    // 3. Parse.
    const parsed = parseCommandInput(command.input, envelope.input)
    if (!parsed.ok) return answer(rejected({ kind: 'invalid', details: parsed.details }))
    const input: unknown = parsed.input

    // 4. The target check, live, on the parsed input.
    const denied = await this.targetRefusal(command, input, principal, envelope.confirmed === true)
    if (denied !== undefined) return answer(rejected(denied))

    // 5–7. Dedup; then provenance around one unit holding the handler and the record.
    const mutationId = envelope.mutationId
    const provenance = { mutationId, causationId: mutationId }
    const ctx = this.contextFor(
      principal,
      mutationId,
      envelope.expectedRevision,
      envelope.confirmed === true,
    )
    let application: { outcome: 'applied' | 'replayed'; value: unknown }
    try {
      application = await this.deps.mutations.apply(
        mutationId,
        command.name,
        async () => await command.handle(ctx, input),
        {
          unit: async (fn) =>
            await withWriteProvenance(provenance, async () => await this.deps.unitOfWork(fn)),
        },
      )
    } catch (error) {
      // The unit has rolled back. A family that keeps a trail of refusals (the
      // settings audit) writes it now, outside the write it is about.
      try {
        await command.rolledBack?.({ principal }, input, error)
      } catch (trailError) {
        log.warn('sync write: a rolled-back hook failed', {
          command: command.name,
          error: describeError(trailError),
        })
      }
      if (error instanceof SyncWriteRefused) {
        return { reply: rejected(error.refusal), cause: error.cause }
      }
      throw error
    }

    // 8. The reply; the head is read after the commit has completed.
    return answer({
      outcome: 'applied',
      result: application.value,
      receipt: await this.deps.receipt(),
      replayed: application.outcome === 'replayed',
    })
  }

  private async targetRefusal(
    command: SyncCommand,
    input: unknown,
    principal: CommandPrincipal,
    confirmed: boolean,
  ): Promise<SyncSubmitRefusal | undefined> {
    if (principal.kind === 'system') return UNAUTHORIZED
    const target = await command.target(input, { principal })
    if (target === undefined) return UNAUTHORIZED
    const decision = authorize(
      capabilityFor(principal, target),
      command.action,
      isNoTarget(target) ? undefined : target,
      { override: confirmed },
    )
    switch (decision) {
      case 'allow':
        return undefined
      case 'confirm-required':
        return { kind: 'confirmation-required' }
      case 'forbidden':
        return UNAUTHORIZED
    }
  }

  private contextFor(
    principal: CommandPrincipal,
    mutationId: MutationId,
    expectedRevision: number | undefined,
    confirmed: boolean,
  ): SyncWriteContext {
    const afterCommit = this.deps.afterCommit
    return {
      principal,
      mutationId,
      expectedRevision,
      confirmed,
      ledger: this.deps.ledger,
      afterCommit: (step, label) => afterCommit(() => outsideWriteProvenance(step), label),
    }
  }
}

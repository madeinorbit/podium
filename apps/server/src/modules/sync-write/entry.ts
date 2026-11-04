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

import type { MutationId } from '@podium/model'
import { authorize } from '@podium/model'
import type {
  SyncSubmitInput,
  SyncSubmitRefusal,
  SyncSubmitReply,
  WriteReceipt,
} from '@podium/protocol'
import type { AuthorityRefusal, MutationLedger, OutboxEnvelope } from '@podium/sync'
import type { CommandPrincipal } from '../../command-principal'
import { outsideWriteProvenance, withWriteProvenance } from '../../write-provenance'
import {
  isNoTarget,
  type SyncCommand,
  type SyncWriteContext,
  type SyncWriteLedger,
  type SyncWriteRegistry,
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
  constructor(readonly refusal: SyncSubmitRefusal) {
    super(`sync write refused: ${refusal.kind}`)
    this.name = 'SyncWriteRefused'
  }
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
    // The receipt is the head after THIS call's commit. Inside a caller's open
    // unit our commit is only a savepoint, and a receipt read there could name
    // rows that the caller then rolls back.
    if (this.deps.spanOpen()) {
      throw new Error(`sync write: ${envelope.command} was submitted inside an open unit of work`)
    }

    // 2. Contract lookup and the coarse check, before the input is looked at.
    const command = this.deps.registry.lookup(envelope.command)
    if (command === undefined) return rejected({ kind: 'invalid', details: ['command'] })
    if (!coarselyPermitted(command, principal, transport)) return rejected(UNAUTHORIZED)
    if (envelope.version !== command.version)
      return rejected({ kind: 'invalid', details: ['version'] })

    // 3. Parse.
    const parsed = command.input.safeParse(envelope.input)
    if (!parsed.success) {
      return rejected({
        kind: 'invalid',
        details: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
      })
    }
    const input: unknown = parsed.data

    // 4. The target check, live, on the parsed input.
    const denied = await this.targetRefusal(command, input, principal, envelope.confirmed === true)
    if (denied !== undefined) return rejected(denied)

    // 5–7. Dedup; then provenance around one unit holding the handler and the record.
    const mutationId = envelope.mutationId
    const provenance = { mutationId, causationId: mutationId }
    const ctx = this.contextFor(principal, mutationId, envelope.expectedRevision)
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
      if (error instanceof SyncWriteRefused) return rejected(error.refusal)
      throw error
    }

    // 8. The reply; the head is read after the commit has completed.
    return {
      outcome: 'applied',
      result: application.value,
      receipt: await this.deps.receipt(),
      replayed: application.outcome === 'replayed',
    }
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
      principal.capability,
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
  ): SyncWriteContext {
    const afterCommit = this.deps.afterCommit
    return {
      principal,
      mutationId,
      expectedRevision,
      ledger: this.deps.ledger,
      afterCommit: (step, label) => afterCommit(() => outsideWriteProvenance(step), label),
    }
  }
}

/**
 * Step 2's question: may this principal use this command at all, over this
 * transport? It reads only the contract and the principal, never the input.
 *
 * A system principal is unreachable from every transport (ADR 3 Amendment D21):
 * server-originated writes go to the Authority directly, not through here.
 */
function coarselyPermitted(
  command: SyncCommand,
  principal: CommandPrincipal,
  transport: SyncWriteTransport,
): boolean {
  if (principal.kind === 'system') return false
  if (!command.exposedOn(transport)) return false
  const capability = principal.capability
  if (command.roleFloor === 'admin' && capability.role !== 'admin') return false
  // With no target, `authorize` answers the role question alone: may this role
  // perform this action at all.
  return authorize(capability, command.action) !== 'forbidden'
}

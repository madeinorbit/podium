import { AsyncLocalStorage } from 'node:async_hooks'
import { ROW, type IssueId } from '@podium/model'
import type { MetadataChange, MetadataEntityKind } from '@podium/protocol'
import {
  AuthorityArbitrationRejected,
  type EntityChangeSpec,
  type Ledger,
  type LedgerCommitOp,
  type LedgerCommitResult,
} from '@podium/sync'
import { throwIssueRevisionConflict } from './conflict'
import { maskChangeSpecs, maskCommitOp, maskReconcileRows } from './shared-payload-mask'

export interface IssueArbitrationInput {
  command: string
  issueId: IssueId
  expectedRevision?: number
  /** Read through the issue service while the ledger transaction is active. */
  currentRevision: () => number | undefined | Promise<number | undefined>
}

interface IssueArbitrationScope {
  readonly input: IssueArbitrationInput
  commitClaimed: boolean
  actualRevision?: number
}

/**
 * Binds one exp-rev command to the issue Ledger commit it performs.
 *
 * The dispatcher owns command policy and this bridge owns transaction placement:
 * it carries the request across async command work, then adds the Authority
 * arbitration hook to the first issue commit in that request. A replay that is
 * satisfied by MutationLedger performs no commit and therefore is not
 * re-arbitrated; authorization has already run at the dispatcher boundary.
 */
export class IssueAuthorityArbitration {
  private readonly scope = new AsyncLocalStorage<IssueArbitrationScope>()

  readonly ledger: {
    commit<T>(op: LedgerCommitOp<T>): Promise<LedgerCommitResult<T>>
    capture(specs: EntityChangeSpec[]): Promise<MetadataChange[]>
    reconcile(
      entity: MetadataEntityKind,
      rows: { id: string; value: unknown }[],
    ): Promise<MetadataChange[]>
  }

  constructor(private readonly source: Ledger) {
    this.ledger = {
      commit: async (op) => await this.commit(op),
      // THE BROADCAST PAYLOAD IS MASKED HERE, AND ONLY HERE [PDM-415, for
      // PDM-387]. Every `entity: 'issue'` and `'issueProjection'` producer in
      // the service reaches the change log through these two lambdas, so the
      // private execution keys come off by construction rather than by a list
      // of call sites somebody keeps complete. See `shared-payload-mask.ts` on
      // why the chokepoint is here and not at the eight producers.
      // Specs and rows for every other kind pass through by identity.
      capture: async (specs) => await this.source.capture(maskChangeSpecs(specs)),
      reconcile: async (entity, rows) =>
        await this.source.reconcile(entity, maskReconcileRows(entity, rows)),
    }
  }

  run<T>(input: IssueArbitrationInput, operation: () => T): T {
    if (this.scope.getStore() !== undefined) {
      throw new Error('nested issue arbitration scopes are not supported')
    }
    return this.scope.run({ input, commitClaimed: false }, operation)
  }

  // Composed from the facade's own op rather than restated, so a caller's
  // `apply` arm reaches the real ledger instead of being dropped at this
  // wrapper's type boundary [POD-3366]. The spread below always carried it at
  // runtime; only the type refused it, which is the quietest way for a
  // post-commit install to go missing.
  private async commit<T>(op: LedgerCommitOp<T>): Promise<LedgerCommitResult<T>> {
    // MASKED BEFORE EITHER BRANCH [PDM-415]. `commit` is the THIRD door of this
    // wrapper and the one the ordinary write path uses — `crud.ts`'s
    // `changes: () => [{ entity: 'issue', ... }]` arms never reach `capture`.
    // Applied here rather than in each branch so the early return below cannot
    // become an unmasked path.
    op = maskCommitOp(op)
    const active = this.scope.getStore()
    if (active === undefined || active.commitClaimed) return await this.source.commit(op)
    active.commitClaimed = true

    try {
      return await this.source.commit({
        ...op,
        arbitrate: {
          rowId: ROW.issueCore,
          attempt:
            active.input.expectedRevision === undefined
              ? {}
              : { expectedRevision: active.input.expectedRevision },
          // Current shipped CLI, MCP and UI mutations omit expectedRevision.
          // Keep that product behavior, but make the compatibility decision in
          // the Authority instead of bypassing the stricter kernel.
          omittedExpectedRevision: 'accept',
          current: async () => {
            const revision = await active.input.currentRevision()
            active.actualRevision = revision
            return revision === undefined ? undefined : { revision }
          },
        },
      })
    } catch (error) {
      if (!(error instanceof AuthorityArbitrationRejected)) throw error
      throwIssueRevisionConflict({
        command: active.input.command,
        issueId: active.input.issueId,
        expectedRevision: active.input.expectedRevision,
        actualRevision: active.actualRevision,
        rejection: error.reason,
      })
    }
  }
}

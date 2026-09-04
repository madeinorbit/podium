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

export interface IssueArbitrationInput {
  command: string
  issueId: IssueId
  expectedRevision?: number
  /** Read through the issue service while the ledger transaction is active. */
  currentRevision: () => number | undefined
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
    commit<T>(op: LedgerCommitOp<T>): LedgerCommitResult<T>
    capture(specs: EntityChangeSpec[]): MetadataChange[]
    reconcile(
      entity: MetadataEntityKind,
      rows: { id: string; value: unknown }[],
    ): MetadataChange[]
  }

  constructor(private readonly source: Ledger) {
    this.ledger = {
      commit: (op) => this.commit(op),
      capture: (specs) => this.source.capture(specs),
      reconcile: (entity, rows) => this.source.reconcile(entity, rows),
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
  private commit<T>(op: LedgerCommitOp<T>): LedgerCommitResult<T> {
    const active = this.scope.getStore()
    if (active === undefined || active.commitClaimed) return this.source.commit(op)
    active.commitClaimed = true

    try {
      return this.source.commit({
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
          current: () => {
            const revision = active.input.currentRevision()
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

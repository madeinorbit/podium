/**
 * WRITE SCOPES (ADR 12 D9, POD-6592).
 *
 * Every synced write names who is making it. There are two answers:
 *
 *  - `sync`: a client command, on the sync write entry point. The entry point
 *    mints one per call; its `cause` is the command's `mutationId`.
 *  - `system`: a write the server makes on its own account (ADR 12 D2): a daemon
 *    report, a job, a feed mirror. Its `cause` names the declared origin.
 *
 * `Ledger.commit` and `Ledger.capture` take a scope, so a synced write without
 * one does not typecheck. A scope cannot be written by hand: its brand is a
 * `unique symbol` this module does not export. The only way to get one is the
 * {@link WriteScopeMint}, which a Ledger hands out exactly once, to the
 * composition root. A cast can still forge the shape, so the Ledger also
 * remembers what it issued and refuses anything else at runtime.
 */

declare const writeScopeBrand: unique symbol

export type WriteScopeOrigin = 'sync' | 'system'

export interface WriteScope {
  readonly [writeScopeBrand]: true
  readonly origin: WriteScopeOrigin
  /** The command's `mutationId` for `sync`; the declared origin for `system`. */
  readonly cause: string
}

/** The one source of scopes, held by the composition root. */
export interface WriteScopeMint {
  /** A client command's scope, for the sync write entry point. */
  sync(mutationId: string): WriteScope
  /** A server-originated write's scope, for a declared origin. */
  system(origin: string): WriteScope
}

/** A scope reached the Ledger that this Ledger never issued. */
export class ForeignWriteScope extends Error {
  constructor() {
    super('write scope: this scope was not issued by this ledger')
    this.name = 'ForeignWriteScope'
  }
}

/** The issuing half, kept inside the Ledger. */
export class WriteScopeIssuer {
  private readonly issued = new WeakSet<object>()
  private handedOut = false

  /** The mint, once. A second caller is a second composition root. */
  takeMint(): WriteScopeMint {
    if (this.handedOut) throw new Error('write scope: the mint is handed out once')
    this.handedOut = true
    return {
      sync: (mutationId) => this.issue('sync', mutationId),
      system: (origin) => this.issue('system', origin),
    }
  }

  /** Throw unless `scope` came from this issuer. */
  check(scope: WriteScope): void {
    if (typeof scope !== 'object' || scope === null || !this.issued.has(scope)) {
      throw new ForeignWriteScope()
    }
  }

  private issue(origin: WriteScopeOrigin, cause: string): WriteScope {
    const scope = Object.freeze({ origin, cause }) as unknown as WriteScope
    this.issued.add(scope)
    return scope
  }
}

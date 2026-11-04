/**
 * THE PLAIN COMMAND SCOPE (ADR 12 D8, POD-6360).
 *
 * A plain command (sign-in, accounts, setup, secrets, logs, telemetry, perf,
 * model refresh) has no synced effect, so it gets NO access to the Authority: it
 * cannot write synced data, even by accident. Its handler runs inside this
 * scope, and the write-seam Ledger's `ProvenancePort` — which the Authority reads
 * once, synchronously, before every `commit` and `capture` — refuses while the
 * scope is open ({@link syncedWriteProvenance}). A synced write from a plain
 * handler therefore throws before it opens a transaction, and appends nothing.
 *
 * Async context rather than a flag for `write-provenance.ts`'s reason: two
 * requests run concurrently in one process, and a plain call must not refuse a
 * sync write that another request is making at the same moment.
 *
 * THE SCOPE CLOSES WHEN THE CALL SETTLES, as the provenance scope does. Work a
 * handler leaves running past its reply (a timer, a background refresh) still
 * sits in the async context the scope was opened in. It is not part of the
 * command, so after the call settles the box is shut and that later work is no
 * longer refused.
 *
 * {@link asSystemWrite} is the one sanctioned way through: a server-originated
 * write (ADR 12 D2) that a plain command's work triggers, such as republishing a
 * machine's display projection after setup enrolls it. It names itself at the
 * call site, so every such write is visible in a diff.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChangeProvenanceFields } from '@podium/model'
import { currentWriteProvenance } from './write-provenance'

interface OpenPlainCommand {
  readonly command: string
  open: boolean
}

const storage = new AsyncLocalStorage<OpenPlainCommand>()

/** A synced write was attempted inside a plain command (ADR 12 D8). */
export class PlainCommandWroteSyncedData extends Error {
  constructor(readonly command: string) {
    super(`${command} is a plain command and may not write synced data`)
    this.name = 'PlainCommandWroteSyncedData'
  }
}

/** Run `fn` as the plain command `command` until it settles. */
export async function withPlainCommand<T>(command: string, fn: () => Promise<T>): Promise<T> {
  const scope: OpenPlainCommand = { command, open: true }
  try {
    return await storage.run(scope, fn)
  } finally {
    scope.open = false
  }
}

/** The plain command now running in this context, or `undefined`. */
export function currentPlainCommand(): string | undefined {
  const scope = storage.getStore()
  return scope?.open === true ? scope.command : undefined
}

/** Throw when a plain command is running in this context. */
export function refuseInsidePlainCommand(): void {
  const command = currentPlainCommand()
  if (command !== undefined) throw new PlainCommandWroteSyncedData(command)
}

/**
 * Run a server-originated synced write outside any plain command scope.
 *
 * For writes the server makes on its own account (ADR 12 D2's system writes),
 * never for a write that carries the caller's input into a synced record: that is
 * a sync command and belongs on `sync.submit`.
 */
export function asSystemWrite<T>(fn: () => T): T {
  return storage.exit(fn)
}

/**
 * The write-seam Ledger's provenance port: the ambient command's provenance, and
 * a refusal inside a plain command. `relay.ts` passes this to the Ledger.
 */
export const syncedWriteProvenance = {
  current(): ChangeProvenanceFields | undefined {
    refuseInsidePlainCommand()
    return currentWriteProvenance()
  },
}

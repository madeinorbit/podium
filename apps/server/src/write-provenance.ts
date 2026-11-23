/**
 * THE WRITE PROVENANCE SCOPE (ADR 2 D8, ADR 12 D2 step 6; POD-6273).
 *
 * The sync write entry point opens one scope per submitted command, around its
 * unit of work. The Ledger's `ProvenancePort` reads {@link currentWriteProvenance}
 * once per `commit`/`capture`, so every change row the handler appends carries the
 * command's `mutationId` and `causationId` without the handler naming either.
 *
 * WHY ASYNC CONTEXT AND NOT A FIELD. Two submits in one HTTP batch run
 * concurrently in one process. A field set by one would be read by the other's
 * append; an `AsyncLocalStorage` scope belongs to the call that opened it and to
 * nothing else (plan Review Focus 1).
 *
 * THE SCOPE CLOSES WHEN THE CALL SETTLES. Work a handler leaves running past its
 * call (a timer, an unawaited promise) still sits in the async context the scope
 * was opened in, and would otherwise stamp its later writes with a command that
 * has already replied. So the scope is a box that is shut in `finally`: after the
 * call settles, `currentWriteProvenance()` answers `undefined` everywhere it was
 * visible.
 *
 * {@link outsideWriteProvenance} runs a step with no scope at all. The entry point
 * wraps after-commit work in it: an effect is not part of the command's write, and
 * anything it writes later is not covered by the command's receipt.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ChangeProvenanceFields } from '@podium/model'

interface OpenProvenance {
  readonly provenance: ChangeProvenanceFields
  open: boolean
}

const storage = new AsyncLocalStorage<OpenProvenance>()

/** Run `fn` with `provenance` as the ambient write provenance until it settles. */
export async function withWriteProvenance<T>(
  provenance: ChangeProvenanceFields,
  fn: () => Promise<T>,
): Promise<T> {
  const scope: OpenProvenance = { provenance, open: true }
  try {
    return await storage.run(scope, fn)
  } finally {
    scope.open = false
  }
}

/** The provenance of the command now writing, or `undefined` outside every open scope. */
export function currentWriteProvenance(): ChangeProvenanceFields | undefined {
  const scope = storage.getStore()
  return scope?.open === true ? scope.provenance : undefined
}

/** Run `fn` outside any write provenance scope. */
export function outsideWriteProvenance<T>(fn: () => T): T {
  return storage.exit(fn)
}

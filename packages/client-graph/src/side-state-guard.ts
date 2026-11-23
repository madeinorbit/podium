/**
 * The MobX half of the side-state guard (POD-7454; the collections and the
 * hook are `@podium/sync/side-state`).
 *
 * A `SideMap`/`SideSet` read inside a derivation is a read the derivation
 * cannot depend on: when the collection changes, nothing re-runs it (the
 * POD-7422 shape). A read outside a derivation, in an action or inside
 * `untracked` is maintenance and passes. So is a read inside `signalledRead`,
 * a reviewed boundary where the reader observed a signal that carries the
 * change; only the derivation that opened the boundary is covered, not a
 * computed evaluated inside it.
 *
 * Development warns once per call site. Tests throw, and also RECORD the
 * violation: the pool reads through defensive catches (a failed replica read
 * reads as absent, a listener's error is logged, MobX reports a reaction's
 * error and carries on), so the test setup fails the test from the record
 * (`takeSideStateViolations`), whatever caught the throw. Production installs
 * nothing.
 */
import { createLogger } from '@podium/logger'
import { currentDerivation } from '@podium/mobx-helpers'
import { installSideStateHook, type SideStateHook } from '@podium/sync/side-state'

const log = createLogger('client-graph:side-state')

export type SideStateGuardMode = 'warn' | 'throw'

/** A guarded collection read inside a derivation, outside a reviewed boundary. */
export class SideStateReadError extends Error {
  override readonly name = 'SideStateReadError'
  constructor(
    readonly collection: string,
    readonly site: string,
  ) {
    super(
      `side state ${collection} was read inside a MobX derivation at ${site}: ` +
        'nothing re-runs the derivation when it changes. Read a tracked value instead, ' +
        'or, where a signal the reader observes already carries this change, wrap the read in signalledRead (POD-7454).',
    )
  }
}

export interface SideStateViolation {
  readonly collection: string
  readonly site: string
}

/** Recorded since the last take, one per collection and site. */
const recorded: SideStateViolation[] = []
const RECORD_LIMIT = 50

/** The violations recorded since the last call, oldest first (the test hook drains them). */
export function takeSideStateViolations(): SideStateViolation[] {
  return recorded.splice(0)
}

/** The first stack frame outside the guard: where the derivation read the collection. */
function callSite(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    if (/side-state(?:-guard)?\.[cm]?[jt]s/.test(line)) continue
    const frame = line.trim().replace(/^at\s+/, '')
    if (frame) return frame
  }
  return 'unknown site'
}

/**
 * Install the guard; returns the uninstall. `warn` for development builds,
 * `throw` for tests. Installing twice replaces the first.
 */
export function installSideStateGuard(mode: SideStateGuardMode): () => void {
  /** The derivations that opened a `signalledRead`, innermost last. */
  const covering: (object | undefined)[] = []
  const warned = new Set<string>()
  const hook: SideStateHook = {
    read(collection) {
      const derivation = currentDerivation()
      if (derivation === undefined) return
      if (covering.length > 0 && covering[covering.length - 1] === derivation) return
      // Read the stack now: an unread stack may be formatted differently later.
      const site = callSite(new Error().stack)
      if (
        recorded.length < RECORD_LIMIT &&
        !recorded.some((seen) => seen.collection === collection && seen.site === site)
      )
        recorded.push({ collection, site })
      if (mode === 'throw') throw new SideStateReadError(collection, site)
      const key = `${collection}\u0000${site}`
      if (warned.has(key)) return
      warned.add(key)
      log.warn(new SideStateReadError(collection, site).message)
    },
    signalled(read) {
      covering.push(currentDerivation())
      try {
        return read()
      } finally {
        covering.pop()
      }
    },
  }
  const previous = installSideStateHook(hook)
  return () => {
    installSideStateHook(previous)
  }
}

/** Whether `error` is the guard's: defensive catches rethrow it. */
export function isSideStateReadError(error: unknown): error is SideStateReadError {
  return error instanceof SideStateReadError
}

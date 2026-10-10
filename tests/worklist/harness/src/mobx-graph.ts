/**
 * POD-4945 — MobX-graph spelunking for the pool's tests: count what the pool
 * built WITHOUT asking the pool (the product modules expose no counts).
 *
 * - `collectReactions(run)`: every MobX reaction constructed while `run`
 *   runs (patches `Reaction.prototype.track`, restored after). The pool's
 *   filing reactions are named `pool.file.<id>`.
 * - `objectsBehind(roots)`: the distinct owners behind those derivations,
 *   by object identity. The measurement transform supplies `scope_`; a
 *   worklist companion also owns its shared record model even when it reads
 *   no computed on that model. Debug names are labels, not identities.
 */

import { Reaction } from 'mobx'

interface Derivation {
  readonly name_: string
  readonly observing_?: readonly Derivation[]
  readonly scope_?: object
}

/** Every reaction MobX tracks while `run` runs. */
export function collectReactions(run: () => void): Set<Derivation> {
  const seen = new Set<Derivation>()
  const proto = Reaction.prototype as unknown as { track: (fn: () => void) => void }
  const original = proto.track
  proto.track = function (this: Derivation, fn: () => void) {
    seen.add(this)
    return original.call(this, fn)
  }
  try {
    run()
  } finally {
    proto.track = original
  }
  return seen
}

/** The pool's filing reactions among `reactions` (`pool.file.<id>`). */
export function filingReactions(reactions: Iterable<Derivation>): Derivation[] {
  return [...reactions].filter((r) => r.name_.startsWith('pool.file.'))
}

/** Distinct owners and their shared record models reachable through MobX's graph. */
export function objectsBehind(roots: Iterable<Derivation>): Record<string, number> {
  const visited = new Set<Derivation>()
  const objects = new Set<object>()
  const stack = [...roots]
  while (stack.length > 0) {
    const next = stack.pop() as Derivation
    if (visited.has(next)) continue
    visited.add(next)
    const owner = next.scope_
    if (owner !== undefined && owner !== null) {
      objects.add(owner)
      // These are constructor-owned references, not derived field reads.
      // Filing observes the companion; the shared model need not itself own
      // an observed computed (for example, an excluded issue's filing).
      const field = owner.constructor.name === 'WorklistIssue' ? 'issue'
        : owner.constructor.name === 'WorklistSession' ? 'session' : undefined
      if (field !== undefined) {
        const record = Object.getOwnPropertyDescriptor(owner, field)?.value as object | undefined
        if (record !== undefined) objects.add(record)
      }
    }
    for (const dependency of next.observing_ ?? []) stack.push(dependency)
  }
  const byClass: Record<string, number> = {}
  for (const owner of objects) {
    const cls = owner.constructor.name
    byClass[cls] = (byClass[cls] ?? 0) + 1
  }
  return byClass
}

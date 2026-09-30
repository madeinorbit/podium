/**
 * POD-4945 — MobX-graph spelunking for the pool's tests: count what the pool
 * built WITHOUT asking the pool (the product modules expose no counts).
 *
 * - `collectReactions(run)`: every MobX reaction constructed while `run`
 *   runs (patches `Reaction.prototype.track`, restored after). The pool's
 *   filing reactions are named `pool.file.<id>`.
 * - `objectsBehind(roots)`: the distinct `Class@n` objects behind those
 *   derivations, by class: each derivation's `observing_` dependency list is
 *   walked to the `IssueModel@n` / `SessionModel@n` objects behind them.
 */

import { Reaction } from 'mobx'

interface Derivation {
  readonly name_: string
  readonly observing_?: readonly Derivation[]
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

/** Distinct `Class@n` objects behind the derivations reachable from `roots` (MobX's graph). */
export function objectsBehind(roots: Iterable<Derivation>): Record<string, number> {
  const visited = new Set<Derivation>()
  const objects = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const next = stack.pop() as Derivation
    if (visited.has(next)) continue
    visited.add(next)
    // `Class@n.key` (declared) or `Class@<id>.group` (a cached group).
    const owner = /^(\w+@[^.]+)\./.exec(next.name_ ?? '')?.[1]
    if (owner !== undefined) objects.add(owner)
    for (const dependency of next.observing_ ?? []) stack.push(dependency)
  }
  const byClass: Record<string, number> = {}
  for (const owner of objects) {
    const cls = owner.split('@')[0] as string
    byClass[cls] = (byClass[cls] ?? 0) + 1
  }
  return byClass
}

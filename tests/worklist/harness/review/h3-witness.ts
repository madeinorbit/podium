/**
 * POD-4598 (H3) — the reviewer's instruments for the hand pool's relation
 * upkeep, shared by the `h3-*` probes. Nothing here is the pool's.
 *
 * - {@link elementOps}: a verbatim copy of the hand F1 guard's counter
 *   (`arms/hand/pool/relations.test.ts` `elementOps`), so a probe can show
 *   what that counter sees and what it misses.
 * - {@link held} / {@link replaced}: M3's identity check
 *   (`m3-index-identity.test.ts` §7 G4) ported to the hand engine: every
 *   container the engine holds, top-level and nested, and which of them a
 *   change replaced by another object.
 */

import { appendFileSync } from 'node:fs'
import type { HandPool } from '../../arms/hand/pool/pool'

/** Where the numbers go: `H3_PROBE_OUT` (the runner hides console output), else the console. */
export function report(line: string): void {
  const out = process.env['H3_PROBE_OUT']
  if (out === undefined) console.info(line)
  else appendFileSync(out, `${line}\n`)
}

/** The hand F1 guard's counter, verbatim: elements any `Set`, `Map` or sort touched while `run` ran. */
export function elementOps(run: () => void): number {
  type Method = (this: unknown, ...args: unknown[]) => unknown
  type Patched = { [name: string]: Method }
  const targets: [Patched, string, (self: unknown) => number][] = [
    [Set.prototype as unknown as Patched, 'add', () => 1],
    [Set.prototype as unknown as Patched, 'delete', () => 1],
    [Object.getPrototypeOf(new Set<unknown>().values()) as Patched, 'next', () => 1],
    [Map.prototype as unknown as Patched, 'set', () => 1],
    [Map.prototype as unknown as Patched, 'delete', () => 1],
    [Object.getPrototypeOf(new Map<unknown, unknown>().entries()) as Patched, 'next', () => 1],
    [Array.prototype as unknown as Patched, 'sort', (self) => (self as unknown[]).length],
  ]
  let ops = 0
  const saved = targets.map(([proto, name, weight]) => {
    const original = proto[name] as Method
    proto[name] = function (this: unknown, ...args: unknown[]) {
      ops += weight(this)
      return original.apply(this, args)
    }
    return () => {
      proto[name] = original
    }
  })
  try {
    run()
  } finally {
    for (const restore of saved) restore()
  }
  return ops
}

/** The engine's private containers, as the probes read them. */
export interface EngineInside {
  links: Map<
    string,
    {
      forward: Map<string, string>
      buckets: Map<string, Set<string>>
      under: Map<string, Set<string>> | null
      placed: Map<string, string> | null
    }
  >
  collapses: Map<
    string,
    { groups: Map<string, Set<string>>; groupOf: Map<string, string>; collapsed: Set<string> }
  >
  place(link: unknown, id: string, normalized: string | null): void
  point(link: unknown, id: string, target: string | null): void
}

type Sized = { readonly size: number }
export type Held = Map<string, { object: object; size: number }>

/** Every container the engine holds, top-level and nested, by path: the object and its size. */
export function held(pool: HandPool): Held {
  const engine = pool.engine as unknown as EngineInside
  const out: Held = new Map()
  const one = (label: string, object: Sized | null | undefined): void => {
    if (object === null || object === undefined) return
    out.set(label, { object: object as object, size: object.size })
  }
  const nested = (label: string, map: Map<string, Set<string>> | null): void => {
    if (map === null) return
    one(label, map)
    for (const [key, set] of map) one(`${label}:${key}`, set)
  }
  for (const [name, link] of engine.links) {
    one(`${name}.forward`, link.forward)
    one(`${name}.placed`, link.placed)
    nested(`${name}.buckets`, link.buckets)
    nested(`${name}.under`, link.under)
  }
  for (const [entity, collapse] of engine.collapses) {
    nested(`${entity}.groups`, collapse.groups)
    one(`${entity}.groupOf`, collapse.groupOf)
    one(`${entity}.collapsed`, collapse.collapsed)
  }
  return out
}

/** Containers held before and after that are different objects: elements re-copied. */
export function replaced(
  before: Held,
  after: Held,
): { keys: number; elements: number; where: string[] } {
  let keys = 0
  let elements = 0
  const where: string[] = []
  for (const [key, was] of before) {
    const now = after.get(key)
    if (now === undefined || now.object === was.object) continue
    keys += 1
    elements += now.size
    if (where.length < 4) where.push(key)
  }
  return { keys, elements, where }
}

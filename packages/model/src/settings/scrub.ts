/**
 * THE SCRUB — removing server-owned secret material from stored JSON (POD-419, 3.7b).
 *
 * POD-418 classified every settings leaf; POD-420 made a secret write refusable
 * at the command surface. Neither touched what is ALREADY AT REST. This module
 * is the one derivation both halves of the scrub run on: the server migration
 * that lifts the five secrets out of the `meta['settings']` blob, and the
 * one-shot client pass over replica and outbox rows written by earlier builds.
 *
 * ---------------------------------------------------------------------------
 * IT CONSUMES THE CLASSIFICATION; IT DOES NOT RESTATE IT
 * ---------------------------------------------------------------------------
 *
 * {@link SETTINGS_SECRET_PATHS} is `settingsPathsInTier('server-secret')` —
 * derived by walking the split shapes, exactly like every other column of the
 * table. A second hand-written key list is the fork this programme exists to
 * end: it would go stale the first time a secret is added to the model, and a
 * scrub that misses one key fails OPEN, leaving material at rest that every
 * gate then certifies as absent.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MATCHES AT EVERY DEPTH, NOT ONLY AT THE ROOT
 * ---------------------------------------------------------------------------
 *
 * The settings blob does not only appear as itself. An outbox entry holds the
 * author's intent verbatim under `input`, a dead-letter record holds the same
 * under its own key, and a tRPC-shaped cache row may hold it under a wrapper.
 * A scrub anchored at the root would be correct for the one shape it was
 * written against and blind to every other, which is the POD-1180 shape: an
 * instrument that scans one address reports a clean result about the whole
 * store.
 *
 * So {@link scrubSecretMaterial} walks the entire tree and, at EVERY object
 * node, removes any member reachable at a classified secret path. It
 * over-reaches by construction — a non-settings object that happens to carry
 * `apiKeys.openai` loses it — and that is the correct direction for this rule:
 * refusing to keep an unclassified `apiKeys.openai` costs nothing, keeping a
 * real one is ADR 1 D6 violated.
 *
 * ---------------------------------------------------------------------------
 * IT REMOVES THE KEY RATHER THAN BLANKING IT
 * ---------------------------------------------------------------------------
 *
 * `''` is the legacy blob's spelling of "not configured", so blanking would
 * leave a scrubbed row indistinguishable from a row that never held anything —
 * and would leave a key for a later write to fill. Removing it is the same
 * instinct as `SecretPresenceWire` being a different shape rather than an
 * omit-list: no key to put material in. `normalizeSettings` fills the legacy
 * defaults back in on read, so a scrubbed blob still parses.
 *
 * ---------------------------------------------------------------------------
 * A SCRUB THAT FINDS NOTHING PASSES EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * POD-363's rule applies squarely: an instrument whose job is to FIND things is
 * indistinguishable, from the outside, from a broken one when it finds none. So
 * this returns {@link ScrubResult.removed} — the ADDRESSES it actually removed,
 * from the root of the value it was given — and every caller asserts on that
 * list rather than on "it did not throw". `scrub.test.ts` plants material at
 * four depths and requires each address to be named, and pairs every removal
 * with a preference sibling that must SURVIVE.
 */

import { settingsPathsInTier } from './classification'

/**
 * Every server-owned secret leaf, by its dotted path — DERIVED from the shipped
 * classification. Five today (`apiKeys.openrouter`, `apiKeys.anthropic`,
 * `apiKeys.openai`, `integrations.linearApiKey`,
 * `notifications.telegramBotToken`); whatever the classification says tomorrow.
 */
export const SETTINGS_SECRET_PATHS: readonly string[] = settingsPathsInTier('server-secret')

/** Segments of each secret path, split once at module load rather than per node
 *  of every walked tree. */
const SECRET_SEGMENTS: readonly (readonly string[])[] = SETTINGS_SECRET_PATHS.map((p) =>
  p.split('.'),
)

/**
 * DEFENSIVE, and the reason is the same one that makes the list derived: a
 * classification that computed to an empty tier would make this module a no-op
 * whose every downstream "no secret material" assertion passes vacuously. That
 * is the POD-305 "fails FIRST if the matrix imports empty" guard, applied to the
 * one input this module has.
 */
if (SETTINGS_SECRET_PATHS.length === 0) {
  throw new Error(
    'settingsPathsInTier("server-secret") is empty — the scrub would be a no-op and every ' +
      'zero-secret-material assertion downstream would pass vacuously',
  )
}

/**
 * A PLAIN object, and the prototype check is load-bearing rather than pedantic.
 * IndexedDB rows arrive through structured clone, which preserves `Date`, `Map`,
 * `Set` and `ArrayBuffer` — every one of which satisfies a naive
 * `typeof v === 'object'`. Spreading a `Date` yields `{}`, so a walker using the
 * naive test would DESTROY the rows it was sent to protect while reporting a
 * clean scrub. Caught by `scrub.test.ts`'s opaque-leaf case, not by review.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export interface ScrubResult<T = unknown> {
  /** The value with every classified secret member removed. A fresh structure
   *  when anything was removed; the SAME reference when nothing was, so a caller
   *  can skip a durable write it does not need to make. */
  readonly value: T
  /** Where material was found, addressed from the root of the input (e.g.
   *  `input.apiKeys.openai`). Empty means the value was already clean — and it
   *  is the only way a caller can tell that apart from a scrub that is broken. */
  readonly removed: readonly string[]
}

/** Does `node` carry the whole of `segments`, ending at a member that exists? */
function resolveParent(
  node: Record<string, unknown>,
  segments: readonly string[],
): Record<string, unknown> | undefined {
  let current: Record<string, unknown> = node
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!isPlainObject(next)) return undefined
    current = next
  }
  const last = segments[segments.length - 1] as string
  return Object.hasOwn(current, last) ? current : undefined
}

/**
 * Remove every classified secret member from `value`, at any depth.
 *
 * Pure: the input is never mutated. Non-JSON values (a `Date`, a `Map`, a class
 * instance) are walked as opaque leaves rather than reconstructed — the stores
 * this runs against hold structured-clone or JSON data, and rebuilding a type
 * this module does not understand is how a scrub corrupts the rows it was
 * supposed to protect.
 */
export function scrubSecretMaterial<T>(value: T): ScrubResult<T> {
  const removed: string[] = []
  const scrubbed = walk(value, '', removed)
  return { value: scrubbed as T, removed }
}

function walk(value: unknown, address: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item, i) => {
      const next = walk(item, address ? `${address}.${i}` : String(i), removed)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (!isPlainObject(value)) return value

  let out: Record<string, unknown> | undefined

  // The secret members OF THIS NODE first, so a removal is addressed at the node
  // that carried it rather than at whichever child the walk reached later.
  for (const segments of SECRET_SEGMENTS) {
    const parent = resolveParent(value, segments)
    if (!parent) continue
    out ??= structuredCloneish(value)
    // Re-resolve against the copy: `parent` points into the input, which this
    // function may not mutate.
    const copyParent = resolveParent(out, segments)
    if (!copyParent) continue
    delete copyParent[segments[segments.length - 1] as string]
    removed.push(address ? `${address}.${segments.join('.')}` : segments.join('.'))
  }

  const source = out ?? value
  for (const [key, child] of Object.entries(source)) {
    const next = walk(child, address ? `${address}.${key}` : key, removed)
    if (next !== child) {
      out ??= { ...source }
      out[key] = next
    }
  }
  return out ?? value
}

/** A shallow-along-the-path copy: every object the walk will edit is copied, and
 *  everything else keeps its reference. `structuredClone` would deep-copy rows
 *  that are never touched, and would throw on a value it cannot clone. */
function structuredCloneish(node: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...node }
  for (const [key, child] of Object.entries(copy)) {
    if (isPlainObject(child)) copy[key] = structuredCloneish(child)
  }
  return copy
}

/**
 * Does this value carry any classified secret material? The AUDIT half — it asks
 * the question the scrub answers, so a store can be inspected without being
 * rewritten.
 *
 * Deliberately the same walk rather than a second predicate: two implementations
 * of "is there a secret here" is the fork that lets a scrub and its gate agree
 * with each other and disagree with reality.
 */
export function findSecretMaterial(value: unknown): readonly string[] {
  return scrubSecretMaterial(value).removed
}

/**
 * POD-7609 — AN ANSWER NEED NOT RESEND THE ROWS A DEVICE ALREADY HOLDS.
 *
 * Two collections can select the same records by the same rule and differ
 * only in what those records come with: a flight deck's tree
 * (`issueProjection.tree`, with the sessions it shows) and its archive
 * (`issueProjection.treeArchive`, with the archived ones). A device that
 * holds the tree complete asks for the archive naming it (`rowsHeld`): the
 * server then sends only the members that changed after the device's feed
 * number, and still answers what the archive comes with. Both sides read the
 * rule check from here, so they agree on when it applies.
 */

import { COLLECTIONS, instanceParams } from './index'

/** What a request names: the device holds this collection's instance (same arguments) complete as of `seq`. */
export interface RowsHeld {
  readonly collection: string
  readonly seq: number
}

/** A value with its object keys sorted, so two equal rules print the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  )
}

const ruleText = new Map<string, string | undefined>()

/**
 * The collection's rule as text, when its members are a held set another
 * collection can share: a rule, at the main part, with no page. `undefined`
 * for any other.
 */
function heldRule(collectionId: string): string | undefined {
  if (ruleText.has(collectionId)) return ruleText.get(collectionId)
  const collection = COLLECTIONS.get(collectionId)
  const text =
    collection === undefined ||
    collection.where === undefined ||
    collection.page !== undefined ||
    collection.part !== 'main'
      ? undefined
      : JSON.stringify([
          collection.of,
          canonical(collection.where),
          [...instanceParams(collection)].sort(),
        ])
  ruleText.set(collectionId, text)
  return text
}

/**
 * Whether `held`'s instance holds exactly the records `asked`'s instance with
 * the same arguments selects: the same record type and the same rule, both at
 * the main part and unpaged. What each comes with may differ.
 */
export function sameRows(asked: string, held: string): boolean {
  if (asked === held) return false
  const text = heldRule(asked)
  return text !== undefined && text === heldRule(held)
}

const sources = new Map<string, readonly string[]>()

/** The collections whose instances hold the same records as `collectionId`'s, in declaration order. */
export function rowsHeldSources(collectionId: string): readonly string[] {
  const known = sources.get(collectionId)
  if (known !== undefined) return known
  const found =
    heldRule(collectionId) === undefined
      ? []
      : [...COLLECTIONS.keys()].filter((id) => sameRows(collectionId, id))
  sources.set(collectionId, found)
  return found
}

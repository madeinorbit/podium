/**
 * Default-closed reads over the ownership matrix.
 *
 * This module imports the matrix explicitly. Keeping these reads out of the
 * vocabulary module means importing a type or constant from `ownership.ts`
 * does not require `matrix.ts` to mutate a late-bound global during module
 * initialization.
 */

import { assertUnreachable } from '../exhaustive'
import { OWNERSHIP_MATRIX_INDEX } from './matrix'
import type { GrantVerb, MatrixRow, VisibilityClass } from './ownership'

/** The visibility class of an entity class, resolved default-closed. */
export function visibilityClassOf(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = OWNERSHIP_MATRIX_INDEX,
): VisibilityClass {
  return index.get(rowId)?.visibility ?? 'personal'
}

/** Only an explicitly declared deployment-substrate class is tenant-visible. */
export function isTenantVisible(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = OWNERSHIP_MATRIX_INDEX,
): boolean {
  return visibilityClassOf(rowId, index) === 'deployment-substrate'
}

/** Whether a class participates in grants at all, resolved through inheritance. */
export function grantVerbsOf(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = OWNERSHIP_MATRIX_INDEX,
  seen: ReadonlySet<string> = new Set(),
): readonly GrantVerb[] {
  const row = index.get(rowId)
  if (!row || seen.has(rowId)) return []
  const rule = row.grants
  switch (rule.kind) {
    case 'verbs':
      return rule.verbs
    case 'none':
      return []
    case 'inherits':
      return grantVerbsOf(rule.from, index, new Set([...seen, rowId]))
    default:
      return assertUnreachable(rule)
  }
}

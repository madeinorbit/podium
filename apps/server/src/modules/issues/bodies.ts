/**
 * AN ISSUE'S BODIES, FETCHED BY ID (POD-6767, design POD-6253 §2).
 *
 * The synced issue record carries only the headers of `brief`, `panel`,
 * `description` and `activityNotes` (the `issueBodies` row); a screen that shows
 * one asks for it here. Each body is answered with the digest its header names,
 * so the client caches it by content and asks again only when the header moves.
 *
 * The panel leaves as the feed shaped it before the split (design §4.2,
 * POD-6288): a reader who may not see the task's worktree gets its artifact
 * paths reduced, through the same rule and the same facts as every command
 * result.
 *
 * Reads, whatever the number of ids: the rows in one statement, then the
 * custodian and session-owner facts in one grouped read per table.
 */

import {
  ISSUE_BODY_FIELDS,
  type IssueBodyField,
  type IssueBodyWire,
  type IssueProjection,
  issueExecutionAccess,
  type UserId,
  withoutHiddenExecutionFields,
} from '@podium/model'
import type { IssueRow } from '../../store/types'
import {
  type ExecutionFactsStore,
  executionPointersOf,
  readExecutionFacts,
} from './execution-visibility'
import { issueBodyHeaderOf, issueBodyValuesOfRow } from './projection'

export interface IssueBodiesRead {
  /** The issues by id; a missing id is absent. */
  rows(ids: readonly string[]): Promise<ReadonlyMap<string, IssueRow>>
  readonly store: ExecutionFactsStore
}

/**
 * The bodies of `ids` that `viewer` may read, for the fields asked (every field
 * when `fields` is absent). A field with no content has no body and is not in
 * the answer, exactly as it has no header. Missing issues are left out.
 */
export async function readIssueBodies(
  read: IssueBodiesRead,
  viewer: UserId | null,
  ids: readonly string[],
  fields: readonly IssueBodyField[] = ISSUE_BODY_FIELDS,
): Promise<IssueBodyWire[]> {
  const rows = await read.rows([...new Set(ids)])
  if (rows.size === 0) return []
  const facts = fields.includes('panel')
    ? await readExecutionFacts(
        read.store,
        [...rows.values()].map((row) => executionPointersOf(row)),
      )
    : undefined
  const out: IssueBodyWire[] = []
  for (const row of rows.values()) {
    // A deleted issue has left the feed, record and headers both.
    if (row.deletedAt) continue
    let values: Partial<Record<IssueBodyField, unknown>>
    try {
      values = issueBodyValuesOfRow(row)
    } catch {
      // A row the feed cannot project has no record and no headers either.
      continue
    }
    for (const field of fields) {
      let value: unknown = values[field]
      const header = issueBodyHeaderOf(field, value)
      if (!header) continue
      if (field === 'panel' && facts) {
        // The panel's machine paths, as the reader may receive them.
        const access = issueExecutionAccess(viewer, executionPointersOf(row), facts)
        value = withoutHiddenExecutionFields(
          { worktreePath: row.worktreePath ?? undefined, panel: value } as Partial<IssueProjection>,
          access,
        ).panel
      }
      out.push({ issueId: row.id, field, digest: header.digest, value })
    }
  }
  return out
}

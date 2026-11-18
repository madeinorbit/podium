/**
 * THE WORKSPACE OF A CAPTURED ROW (POD-7021, POD-6959 design 2.7, contract C9).
 *
 * Every source on a workspace table captures its rows with `workspace_id` as
 * the first key column, so each captured row says whose it is, and its mapping
 * is handed the key without it. Shared by the declarations in
 * `record-sources.ts` and the one-row bindings in `row-records.ts`, which
 * `record-sources.ts` imports, so the rule lives in neither.
 */
import { type Column, getTableColumns, type Table } from 'drizzle-orm'
import type { RecordSource, SourceChange } from './record-sources'

/** The column every workspace table carries (POD-7012). */
export const WORKSPACE_COLUMN = 'workspace_id'

/** The `workspace_id` column of a workspace table; undefined for an install table. */
export function workspaceColumnOf(table: Table): Column | undefined {
  const column = (getTableColumns(table) as Record<string, Column | undefined>).workspaceId
  return column?.name === WORKSPACE_COLUMN ? column : undefined
}

/**
 * The declared keys of a source on `table`: its `workspace_id` first on a
 * workspace table, so the capture carries the row's workspace (contract C9).
 */
export function capturedKeys(table: Table, keys: readonly Column[]): readonly Column[] {
  const workspace = workspaceColumnOf(table)
  return workspace === undefined ? keys : [workspace, ...keys]
}

/**
 * These changes with the workspace taken off each key: what a mapping reads.
 *
 * An update that moves a row to another workspace leaves one workspace's reads
 * and enters the other's, so it reaches the mapping as a delete of the old key
 * and an insert of the new one. Without the workspace the two keys look alike,
 * and a mapping that compares them (the issue-event window) would see no move.
 */
export function withoutWorkspace(changes: readonly SourceChange[]): SourceChange[] {
  return changes.flatMap((change): SourceChange[] => {
    const old = change.old === null ? null : change.old.slice(1)
    const now = change.new === null ? null : change.new.slice(1)
    if (change.old !== null && change.new !== null && change.old[0] !== change.new[0]) {
      return [
        { op: 'd', old, new: null },
        { op: 'i', old: null, new: now },
      ]
    }
    return [{ op: change.op, old, new: now }]
  })
}

/**
 * A source's declaration with its keys led by the workspace, and its mapping
 * handed the keys it names (`keys`, in order) without it.
 */
export function source(
  table: Table,
  keys: readonly Column[],
  ids: RecordSource['ids'],
  more: Partial<Pick<RecordSource, 'reads' | 'rows' | 'derived' | 'ops' | 'pg'>>,
): RecordSource {
  const scoped = workspaceColumnOf(table) !== undefined
  return {
    table,
    keys: capturedKeys(table, keys),
    ...more,
    ids: scoped ? (changes, reads) => ids(withoutWorkspace(changes), reads) : ids,
  }
}

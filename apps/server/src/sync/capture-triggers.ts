/**
 * THE CAPTURE TRIGGERS, GENERATED FROM THE KIND DECLARATIONS (POD-6920).
 *
 * One trigger per (kind, declared source, operation), named
 * `sync_capture__<kind>__<source>__<i|u|d>`. Each adds a row to
 * `sync_capture` when a row the kind reads is inserted or deleted, or updated
 * in a column (or derived value) the kind reads: `WHEN OLD.c IS NOT NEW.c OR
 * ...`. A row filter (`RecordSource.rows`) keeps rows no record can be built
 * from (another event kind, another meta key) out entirely.
 *
 * Nothing here is hand-written per table, and the triggers are not part of
 * the migration chain: the store drops them before it migrates (so a data
 * migration or boot repair captures nothing; it bumps `sync_kind` instead)
 * and creates them from the declarations once the boot is done, so a changed
 * declaration takes effect at the next start. The same statements exist in
 * Postgres (a row trigger per source calling one INSERT); this generator
 * writes the SQLite dialect the store runs today.
 */

import type { MetadataEntityKind } from '@podium/protocol'
import type { DriverSession } from '../store/executor/driver'
import {
  RECORD_SOURCES,
  type RecordSource,
  type RecordSources,
  sourceTableName,
  watchedColumns,
} from './record-sources'

export const CAPTURE_TRIGGER_PREFIX = 'sync_capture__'

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`
const over = (sql: string, row: 'OLD' | 'NEW'): string => sql.replaceAll('{row}', row)

function keyArray(source: RecordSource, row: 'OLD' | 'NEW'): string {
  return `json_array(${source.keys.map((column) => `${row}.${quote(column.name)}`).join(', ')})`
}

/** The CREATE TRIGGER statements of one source of one kind. */
export function sourceTriggers(kind: MetadataEntityKind, index: number, source: RecordSource): string[] {
  const table = quote(sourceTableName(source))
  const name = (op: string) => quote(`${CAPTURE_TRIGGER_PREFIX}${kind}__${index}__${op}`)
  const insert = (op: 'i' | 'u' | 'd', oldKey: string, newKey: string) =>
    `INSERT INTO sync_capture (kind, source, op, old_key, new_key) VALUES (${literal(kind)}, ${index}, '${op}', ${oldKey}, ${newKey});`
  const rowsOf = (row: 'OLD' | 'NEW') => (source.rows === undefined ? undefined : `(${over(source.rows, row)})`)
  const changed = [
    ...watchedColumns(source).map((column) => `OLD.${quote(column)} IS NOT NEW.${quote(column)}`),
    ...(source.derived ?? []).map((value) => `(${over(value, 'OLD')}) IS NOT (${over(value, 'NEW')})`),
  ]
  const updateWhen = [
    ...(source.rows === undefined ? [] : [`(${rowsOf('OLD')} OR ${rowsOf('NEW')})`]),
    `(${changed.join(' OR ')})`,
  ].join(' AND ')
  const when = (condition: string | undefined) => (condition === undefined ? '' : ` WHEN ${condition}`)
  return [
    `CREATE TRIGGER ${name('i')} AFTER INSERT ON ${table} FOR EACH ROW${when(rowsOf('NEW'))} BEGIN ${insert('i', 'NULL', keyArray(source, 'NEW'))} END`,
    `CREATE TRIGGER ${name('u')} AFTER UPDATE ON ${table} FOR EACH ROW${when(updateWhen)} BEGIN ${insert('u', keyArray(source, 'OLD'), keyArray(source, 'NEW'))} END`,
    `CREATE TRIGGER ${name('d')} AFTER DELETE ON ${table} FOR EACH ROW${when(rowsOf('OLD'))} BEGIN ${insert('d', keyArray(source, 'OLD'), 'NULL')} END`,
  ]
}

/** Every capture trigger the declarations call for. */
export function captureTriggerStatements(sources: RecordSources = RECORD_SOURCES): string[] {
  return (Object.entries(sources) as [MetadataEntityKind, readonly RecordSource[]][]).flatMap(
    ([kind, list]) => list.flatMap((source, index) => sourceTriggers(kind, index, source)),
  )
}

const statement = (sql: string) =>
  ({ sql, params: [], method: 'run', intent: 'write' }) as const

/** Drop every capture trigger, whatever declarations made it. */
export async function dropChangeCapture(session: DriverSession): Promise<void> {
  const found = await session.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ${CAPTURE_TRIGGER_PREFIX.length}) = '${CAPTURE_TRIGGER_PREFIX}'`,
    params: [],
    method: 'all',
    intent: 'read',
  })
  const names = (found.rows as { name: string }[]).map((row) => row.name)
  if (names.length === 0) return
  await session.executeBatch(names.map((name) => statement(`DROP TRIGGER IF EXISTS ${quote(name)}`)))
}

/**
 * Replace the capture triggers with the ones the declarations call for, and
 * empty the capture table (a transaction can only have left rows in it with
 * foreign keys off). One atomic batch.
 */
export async function installChangeCapture(
  session: DriverSession,
  sources: RecordSources = RECORD_SOURCES,
): Promise<void> {
  await dropChangeCapture(session)
  await session.executeBatch([
    statement('DELETE FROM sync_capture'),
    ...captureTriggerStatements(sources).map(statement),
  ])
}

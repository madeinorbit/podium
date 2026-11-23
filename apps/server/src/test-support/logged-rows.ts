/** Fold only a test fixture's emissions, to assert what it published. Never a current-state read. */
import type { ChangeLogReadRow } from '@podium/sync'
import type { SessionStore } from '../store'

export async function loggedRows(
  store: SessionStore,
  entity?: string,
): Promise<ChangeLogReadRow[]> {
  const rows = new Map<string, ChangeLogReadRow>()
  let cursor = 0
  while (true) {
    const page = await store.sync.changesSince(cursor)
    if (page.length === 0) break
    for (const row of page) {
      const key = `${row.entity}\u0000${row.entityId}`
      if (row.op === 'remove' || row.payload === null) rows.delete(key)
      else rows.set(key, row)
    }
    cursor = page[page.length - 1]!.seq
  }
  return [...rows.values()].filter((row) => entity === undefined || row.entity === entity)
}

export async function loggedRowsFor(
  store: SessionStore,
  keys: readonly { entity: string; entityId: string }[],
): Promise<ChangeLogReadRow[]> {
  const wanted = new Set(keys.map((key) => `${key.entity}\u0000${key.entityId}`))
  return (await loggedRows(store)).filter((row) => wanted.has(`${row.entity}\u0000${row.entityId}`))
}

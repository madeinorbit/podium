/**
 * The installed-world reads of `ChangeLogStore` for an in-memory test double,
 * all derived from its `latestChangeStates` (POD-6156).
 *
 * The Authority reads the stored rows of a commit's keys, and a kind's rows for
 * a reconcile or a snapshot, where it used to fold an in-memory baseline. A
 * double that keeps its log as an array derives both reads from its latest row
 * per key, keeping only live upserts: a remove means "not installed", as the
 * real table deletes the row.
 */
import type { ChangeLogReadRow } from '../authority/change-lifecycle'

/** A log row as a double holds it: kinds and ops may be typed as plain strings. */
interface HeldRow {
  readonly seq: number
  readonly entity: string
  readonly entityId: string
  readonly op: string
  readonly payload: string | null
}

export function installedWorldOver(held: () => Promise<readonly HeldRow[]>) {
  const latest = async () => (await held()) as unknown as readonly ChangeLogReadRow[]
  const live = async () =>
    (await latest())
      .filter((row) => row.op === 'upsert' && row.payload !== null)
      .sort((a, b) => a.seq - b.seq)
  return {
    latestChangeStates: latest,
    installedStates: async (
      keys: readonly { readonly entity: string; readonly entityId: string }[],
    ): Promise<ChangeLogReadRow[]> => {
      const wanted = new Set(keys.map((key) => `${key.entity}\u0000${key.entityId}`))
      return (await live()).filter((row) => wanted.has(`${row.entity}\u0000${row.entityId}`))
    },
    installedStatesOf: async (entity: string): Promise<ChangeLogReadRow[]> =>
      (await live()).filter((row) => row.entity === entity),
  }
}

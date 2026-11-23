import type { MetadataEntityKind } from '@podium/protocol'
import type { Ledger } from '@podium/sync'
import { expect } from 'vitest'
import type { SessionStore } from '../store'
import { serverRecordBuilders } from '../sync/record-builders'
import { atParity, kindParity, type PublishedRow } from '../sync/record-parity'

/** Compare a device's folded catch-up log with both database record reads.
 * Tests only: production never reads the log to learn current state. */
export async function expectRecordLogParity(
  store: SessionStore,
  ledger: Ledger,
  kind: MetadataEntityKind,
  options: { eventWindow?: number; confirmedPerSession?: number } = {},
): Promise<void> {
  const held = new Map<string, PublishedRow>()
  for (const change of (await ledger.changesSince(0)) ?? []) {
    if (change.entity !== kind) continue
    if (change.op === 'remove') held.delete(change.id)
    else held.set(change.id, { entityId: change.id, payload: JSON.stringify(change.value) })
  }
  const report = await kindParity(
    serverRecordBuilders(),
    { store, now: Date.now, effectExecutors: { get: () => undefined }, ...options },
    kind,
    [...held.values()],
  )
  expect(atParity(report), JSON.stringify(report)).toBe(true)
}

/**
 * THE DRIFT GUARD for POD-377's captured replica snapshot.
 *
 * `packages/sync/src/adapters/legacy-replica/migrate.test.ts` tests the migration
 * against a fixture produced by the REAL writer, which is the whole point of
 * capturing it. But a captured fixture has a failure mode a synthetic one does not:
 * it silently becomes HISTORICAL FICTION. Rename a collection key, change how the
 * outbox is persisted, alter the awaiting-truth marker, and the fixture keeps
 * passing — it just stops describing anything that exists, and the migration is
 * then certified against a store no device has.
 *
 * So this file re-runs the capture and compares it to what was checked in. It lives
 * in `packages/client-core` because that is where the writer is, and `packages/sync`
 * is L2 and may not import L3 — the same split, and the same reason, as
 * `legacy-keys.test.ts`.
 *
 * WHAT IS COMPARED, AND WHY NOT THE BYTES. TanStack DB stamps every row with a
 * random `versionKey`, and the transcript window carries a `savedAt` wall clock, so
 * two runs of the same capture are never byte-identical. Comparing bytes would give
 * a guard that fails every run — which is a guard that gets deleted. So the
 * comparison is over the STRUCTURE that the migration actually reads: which keys
 * exist, and the decoded payload of each row with those two volatile fields
 * stripped. Everything the importer looks at is in that set; nothing that changes
 * on its own is.
 *
 * THE CONTROL COMES FIRST. Before either direction is believed, the freshly
 * captured store is checked to be non-empty and to contain queued entries — because
 * a capture function that had silently started returning `{}` would make every
 * comparison below trivially true against a fixture that was also `{}`.
 */

import { describe, expect, it } from 'vitest'
import fixture from '../../../sync/src/adapters/legacy-replica/__fixtures__/captured-legacy-replica.json' with { type: 'json' }
import {
  captureLegacyReplicaSnapshot,
  type LegacyReplicaSnapshot,
  MIGRATION_PROBE_TEXT,
} from './legacy-snapshot'

/**
 * Decode a store into the shape the importer reads, with the two fields that change
 * on every run removed. Values that are not JSON (the cursor is a bare integer as
 * text) come through as themselves.
 */
function normalize(snapshot: LegacyReplicaSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(snapshot)) {
    out[key] = strip(safeParse(raw))
  }
  return out
}

const safeParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Drop `versionKey` (a fresh uuid per row) and `savedAt` (a wall clock). */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'versionKey' || k === 'savedAt') continue
    out[k] = strip(v)
  }
  return out
}

describe('the captured legacy snapshot still describes what the writer produces', () => {
  it('the capture WRITES, and writes queued entries — the control', async () => {
    // Without this, a capture that had degraded to an empty store would satisfy
    // both comparisons below perfectly, against a fixture regenerated from the
    // same degraded capture.
    const fresh = await captureLegacyReplicaSnapshot()
    expect(Object.keys(fresh.collections).length).toBeGreaterThan(5)
    expect(fresh.collections['podium.replica.outbox.v1']).toContain(MIGRATION_PROBE_TEXT)
    expect(fresh.preReplica['podium.outbox.v1']).toContain(MIGRATION_PROBE_TEXT)
  })

  it('the KEY SET has not drifted — a renamed collection fails here, not in production', async () => {
    const fresh = await captureLegacyReplicaSnapshot()
    expect(
      Object.keys(fresh.collections).sort(),
      'the writer produces different keys than the checked-in capture; re-run `bun scripts/capture-legacy-replica-snapshot.ts` and re-read the migration tests',
    ).toEqual(Object.keys(fixture.collections).sort())
  })

  it('every DECODED payload still matches, volatile fields aside', async () => {
    const fresh = await captureLegacyReplicaSnapshot()
    expect(normalize(fresh.collections)).toEqual(normalize(fixture.collections))
    expect(normalize(fresh.preReplica)).toEqual(normalize(fixture.preReplica))
  })

  it('the awaiting-truth entry still carries the marker the importer branches on', async () => {
    // Named separately from the payload comparison above because this one field
    // decides `accepted` versus `queued`, and a re-sent accepted mutation is the
    // bug that split the two legacy outbox homes apart. If the writer stops
    // emitting it, the equality assertion would also fail — but it would fail as
    // "some payload changed", and this says which one and why it matters.
    const fresh = await captureLegacyReplicaSnapshot()
    expect(fresh.collections['podium.replica.outbox-awaiting.v1']).toContain('awaiting-truth')
  })
})

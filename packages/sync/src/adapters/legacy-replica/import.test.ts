/**
 * `readLegacyReplica` — the decisions ADR 6 D6 leaves to the implementation, each
 * asserted with the counterfactual that proves the assertion is not vacuous.
 *
 * These cases build their own blobs, which means they certify a FORMAT this file
 * also authored. That is why they are not the only coverage: the round-trip in
 * `packages/client-core/src/replica/legacy-keys.test.ts` reads bytes produced by
 * TanStack DB's own writer through the shipping replica. This file owns the
 * branches that writer cannot reach — a corrupt blob, an unknown command, an
 * empty store.
 */

import { describe, expect, it } from 'vitest'
import type { OutboxAttribution, OutboxCommand } from '../../outbox/records'
import {
  LEGACY_CURSOR_KEY,
  LEGACY_IMPORT_PARTITION,
  LEGACY_OUTBOX_AWAITING_KEY,
  LEGACY_OUTBOX_KEY,
  LEGACY_STANDALONE_OUTBOX_KEY,
  LEGACY_UI_STATE_KEY,
  type LegacyKeyValueSource,
  readLegacyReplica,
} from './index'

const COMMAND: OutboxCommand = {
  name: 'sessions.rename',
  version: 3,
  delivery: 'offline-eligible',
}
const ATTRIBUTION: OutboxAttribution = {
  actor: { kind: 'user', userId: 'u_1' },
  onBehalfOf: 'u_1',
}
const OPTIONS = { resolveCommand: () => COMMAND, attribution: ATTRIBUTION }

const source = (entries: Record<string, string>): LegacyKeyValueSource => ({
  getItem: (key) => entries[key] ?? null,
})

/** A TanStack `localStorageCollectionOptions` blob. */
const blob = (rows: readonly unknown[]): string =>
  JSON.stringify(
    Object.fromEntries(rows.map((data, i) => [`k${i}`, { versionKey: `v${i}`, data }])),
  )

const entry = (mutationId: string, queuedAt: number, extra: object = {}) => ({
  mutationId,
  kind: 'sessions.rename',
  input: { title: mutationId },
  queuedAt,
  ...extra,
})

describe('verdicts', () => {
  it('nothing-to-do on a store with no legacy keys at all', () => {
    const plan = readLegacyReplica(source({}), OPTIONS)
    expect(plan.verdict).toBe('nothing-to-do')
    expect(plan.retireKeys).toEqual([])
  })

  it('import when an outbox entry survives', () => {
    const plan = readLegacyReplica(source({ [LEGACY_OUTBOX_KEY]: blob([entry('m1', 1)]) }), OPTIONS)
    expect(plan.verdict).toBe('import')
    expect(plan.outbox).toHaveLength(1)
  })

  it('discard when legacy state exists but nothing survives — and STILL retires keys', () => {
    // D6 clause 4: never leave the client stuck. A discard that left the keys in
    // place would re-run the failed migration on every boot forever.
    const plan = readLegacyReplica(source({ [LEGACY_CURSOR_KEY]: '42' }), OPTIONS)
    expect(plan.verdict).toBe('discard')
    expect(plan.retireKeys).toEqual([LEGACY_CURSOR_KEY])
  })
})

describe('what crosses and what does not', () => {
  it('never returns a cursor, and reports that one was dropped', () => {
    const plan = readLegacyReplica(source({ [LEGACY_CURSOR_KEY]: '42' }), OPTIONS)
    expect(plan.cursorDiscarded).toBe(true)
    expect(plan).not.toHaveProperty('cursor')
  })

  it('reports cursorDiscarded FALSE when there was none — the counterfactual', () => {
    // Without this the flag could be hardcoded true and every case above would
    // still pass.
    const plan = readLegacyReplica(source({ [LEGACY_OUTBOX_KEY]: blob([entry('m1', 1)]) }), OPTIONS)
    expect(plan.cursorDiscarded).toBe(false)
  })

  it('leaves the ui-state PREFERENCE key alone', () => {
    const plan = readLegacyReplica(
      source({ [LEGACY_UI_STATE_KEY]: blob([{ key: 'podium.view', value: 'home' }]) }),
      OPTIONS,
    )
    expect(plan.retireKeys).not.toContain(LEGACY_UI_STATE_KEY)
    expect(plan.verdict).toBe('nothing-to-do')
  })

  it('maps the awaiting-truth stage to `accepted`, not `queued`', () => {
    // Re-queueing an entry the Authority already accepted re-sends it. The
    // legacy stage means "resolved, holding the overlay until covering truth" —
    // D9's `accepted`.
    const plan = readLegacyReplica(
      source({
        [LEGACY_OUTBOX_KEY]: blob([entry('m1', 1)]),
        [LEGACY_OUTBOX_AWAITING_KEY]: blob([entry('m2', 2, { state: 'awaiting-truth' })]),
      }),
      OPTIONS,
    )
    expect(plan.outbox.map((e) => [e.mutationId, e.state])).toEqual([
      ['m1', 'queued'],
      ['m2', 'accepted'],
    ])
  })

  it('puts every imported entry in ONE partition, so FIFO across rows survives', () => {
    const plan = readLegacyReplica(
      source({ [LEGACY_OUTBOX_KEY]: blob([entry('m1', 1), entry('m2', 2)]) }),
      OPTIONS,
    )
    expect(new Set(plan.outbox.map((e) => e.partitionKey))).toEqual(
      new Set([LEGACY_IMPORT_PARTITION]),
    )
  })

  it('orders by authored time across the three outbox homes', () => {
    const plan = readLegacyReplica(
      source({
        [LEGACY_OUTBOX_KEY]: blob([entry('newer', 30)]),
        [LEGACY_STANDALONE_OUTBOX_KEY]: JSON.stringify([entry('oldest', 10)]),
        [LEGACY_OUTBOX_AWAITING_KEY]: blob([entry('middle', 20)]),
      }),
      OPTIONS,
    )
    expect(plan.outbox.map((e) => e.mutationId)).toEqual(['oldest', 'middle', 'newer'])
  })
})

describe('refusals — each reported, none silent', () => {
  it('an unreadable blob is discarded and NAMED', () => {
    const plan = readLegacyReplica(source({ [LEGACY_OUTBOX_KEY]: '{not json' }), OPTIONS)
    expect(plan.rejected).toEqual([
      { key: LEGACY_OUTBOX_KEY, reason: 'unreadable-blob', detail: expect.any(String) },
    ])
    expect(plan.verdict).toBe('discard')
  })

  it('a malformed entry is dropped WITHOUT taking its siblings with it', () => {
    const plan = readLegacyReplica(
      source({ [LEGACY_OUTBOX_KEY]: blob([{ nope: true }, entry('m1', 1)]) }),
      OPTIONS,
    )
    expect(plan.outbox.map((e) => e.mutationId)).toEqual(['m1'])
    expect(plan.rejected.map((r) => r.reason)).toEqual(['malformed-entry'])
  })

  it('an unresolvable command is refused rather than replayed under a guess', () => {
    const plan = readLegacyReplica(source({ [LEGACY_OUTBOX_KEY]: blob([entry('m1', 1)]) }), {
      ...OPTIONS,
      resolveCommand: () => undefined,
    })
    expect(plan.outbox).toEqual([])
    expect(plan.rejected[0]).toMatchObject({ mutationId: 'm1', reason: 'unknown-command' })
  })

  it('a throwing store reads as a cold start, not a boot failure', () => {
    // D4.5: never wedge boot. Private mode and a revoked origin both throw here.
    const throwing: LegacyKeyValueSource = {
      getItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readLegacyReplica(throwing, OPTIONS).verdict).toBe('nothing-to-do')
  })
})

/**
 * Store-fidelity probes against the in-memory instantiation (POD-1130).
 * Shared laws plus the physical old-installer probe for downgrade compatibility.
 */
import { describe, expect, it, vi } from 'vitest'
import { InMemoryReplicaStore } from '../replica/memory-store'
import type { Cursor, EntityRecord } from '../replica/types'
import { inMemoryInstantiation } from './in-memory'
import { describePersonalRowCompleteness } from './personal-row-completeness'
import { describeStoreFidelity } from './store-fidelity'

describeStoreFidelity(inMemoryInstantiation)

describePersonalRowCompleteness(inMemoryInstantiation)

describe('memory adapter — downgrade then upgrade (Amendment 1 D10)', () => {
  const cursor: Cursor = { feedId: 'shared-feed', epoch: 'shared-epoch', seq: 7 }
  const session: EntityRecord = {
    entity: 'session',
    entityId: 's',
    value: { sessionId: 's' },
    provenance: { seq: 7 },
  }
  const personal: EntityRecord = {
    entity: 'sessionUserState',
    entityId: 'personal',
    value: { readAt: 'read' },
    provenance: { seq: 7 },
  }

  it.each([
    'rebootstrap',
    'rescope',
    'discard then bootstrap',
  ])('rejects a surviving marker after an older %s installs the SAME cursor', (cause) => {
    const { cache } = new InMemoryReplicaStore()
    cache.installSnapshot([session, personal], cursor, [])
    const survivingMarker: unknown = Reflect.get(cache, 'personalRowsCompleteAt')
    expect(survivingMarker).toMatchObject({
      ...cursor,
      scopeFingerprint: expect.stringMatching(/.+/),
    })
    expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor)

    // Today's old memory/durable installers replace rows and the cursor value,
    // ignoring the unknown marker key. Bootstrap constructs a fresh plain triple,
    // even when the shared feed identity and snapshot seq have not changed.
    if (cause === 'discard then bootstrap') {
      Reflect.set(cache, 'rows', new Map())
      Reflect.set(cache, 'cursorValue', null)
      expect(cache.readPersonalRowsCompleteAt()).toBeNull()
    }
    Reflect.set(cache, 'rows', new Map([[`${session.entity}\u0000${session.entityId}`, session]]))
    Reflect.set(cache, 'cursorValue', {
      feedId: cursor.feedId,
      epoch: cursor.epoch,
      seq: cursor.seq,
    })
    expect(cache.readCursor()).toEqual(cursor)
    expect(cache.readEntities()).toEqual([session])
    expect(Reflect.get(cache, 'personalRowsCompleteAt')).toEqual(survivingMarker)
    expect(cache.readPersonalRowsCompleteAt()).toBeNull()

    cache.installSnapshot([session], cursor, [])
    expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor)
    expect(Reflect.get(cache, 'personalRowsCompleteAt')).not.toEqual(survivingMarker)
  })

  it('rejects another scope’s fingerprint even at the SAME triple', () => {
    const { cache } = new InMemoryReplicaStore()
    cache.installSnapshot([session, personal], cursor, [])
    const survivingMarker: unknown = Reflect.get(cache, 'personalRowsCompleteAt')
    Reflect.set(cache, 'cursorValue', { ...cursor, scopeFingerprint: 'another-scope' })
    expect(cache.readCursor()).toEqual(cursor)
    expect(Reflect.get(cache, 'personalRowsCompleteAt')).toEqual(survivingMarker)
    expect(cache.readPersonalRowsCompleteAt()).toBeNull()
  })

  it('can certify without a platform crypto object, without a new boot refusal', () => {
    vi.stubGlobal('crypto', undefined)
    try {
      const { cache } = new InMemoryReplicaStore()
      cache.installSnapshot([session], cursor, [])
      expect(cache.readCursor()).toEqual(cursor)
      expect(cache.readPersonalRowsCompleteAt()).toEqual(cursor)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

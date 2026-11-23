import { asMutationId, OWNERSHIP_MATRIX } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { memoryChangeLog } from '../conformance/ledger-writer'
import { ModelAuthority } from '../conformance/model-records'
import {
  DEVICE_GRADE_PRINCIPAL,
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
} from '../feed/visibility'
import type { AuthorityDeps } from './authority'
import type { StagedChangeSpec } from './change-lifecycle'

const upsert = (entityId: string, value: unknown): StagedChangeSpec => ({
  entity: 'session',
  entityId,
  op: 'upsert',
  value,
})
const build = (extra: Partial<AuthorityDeps> = {}) =>
  new ModelAuthority({
    store: memoryChangeLog(),
    now: () => 1_000,
    transact: (fn) => fn(),
    visibility: new DeviceGradeUnscopedPolicy(),
    anchors: new DeviceGradeNoAnchors(),
    ...extra,
  })
const rowWith = (conflict: string) => {
  const row = OWNERSHIP_MATRIX.find((row) => row.conflict === conflict)
  if (!row) throw new Error(`missing ${conflict}`)
  return row.id
}

describe('authority write funnel', () => {
  it('authorizes, arbitrates inside the transaction, writes, appends and broadcasts in order', async () => {
    const order: string[] = []
    let inside = false
    const followUps: (() => Promise<void>)[] = []
    const store = memoryChangeLog()
    const append = store.appendChanges.bind(store)
    store.appendChanges = async (...args) => {
      order.push('append')
      return await append(...args)
    }
    const authority = build({
      store,
      postCommit: (step) => {
        followUps.push(step)
      },
      transact: async (fn) => {
        inside = true
        try {
          return await fn()
        } finally {
          inside = false
        }
      },
    })
    authority.subscribe(DEVICE_GRADE_PRINCIPAL, () => {
      expect(inside).toBe(false)
      order.push('broadcast')
    })
    const spec = upsert('s', { a: 1 })
    const outcome = await authority.commit({
      authorize: async () => {
        order.push('authorize')
      },
      arbitrate: {
        rowId: rowWith('exp-rev'),
        attempt: { expectedRevision: 1 },
        current: async () => {
          expect(inside).toBe(true)
          order.push('arbitrate')
          return { revision: 1 }
        },
      },
      write: async () => {
        order.push('write')
        authority.models.set([spec])
        return 42
      },
    })
    expect(outcome).toMatchObject({ outcome: 'committed', result: 42, changes: [{ seq: 1 }] })
    for (const step of followUps) await step()
    expect(order).toEqual(['authorize', 'arbitrate', 'write', 'append', 'broadcast'])
  })

  it('refuses an unauthorized write before arbitration or data reads', async () => {
    const authority = build()
    const current = vi.fn(async () => ({ revision: 1 }))
    const write = vi.fn(async () => undefined)
    await expect(
      authority.commit({
        authorize: async () => {
          throw new Error('denied')
        },
        arbitrate: { rowId: rowWith('exp-rev'), attempt: { expectedRevision: 1 }, current },
        write,
      }),
    ).rejects.toThrow('denied')
    expect(current).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(await authority.cursor()).toBe(0)
  })

  it('rejects stale arbitration before writing', async () => {
    const authority = build()
    const write = vi.fn(async () => undefined)
    const result = await authority.commit({
      arbitrate: {
        rowId: rowWith('exp-rev'),
        attempt: { expectedRevision: 1 },
        current: async () => ({ revision: 2 }),
      },
      write,
    })
    expect(result.outcome).toBe('rejected')
    expect(write).not.toHaveBeenCalled()
    expect(await authority.cursor()).toBe(0)
  })

  it('waits for the source write and broadcasts no rows when it throws', async () => {
    const authority = build()
    const delivered = vi.fn()
    authority.subscribe(DEVICE_GRADE_PRINCIPAL, delivered)
    const spec = upsert('s', 1)
    await expect(
      authority.commit({
        write: async () => {
          authority.models.set([spec])
          await Promise.resolve()
          throw new Error('failed')
        },
      }),
    ).rejects.toThrow('failed')
    expect(delivered).not.toHaveBeenCalled()
    expect(await authority.snapshot('session')).toEqual([])
    expect(await authority.save([spec])).toHaveLength(1)
  })

  it('delivers reentrant writes after every subscriber receives the causing batch', async () => {
    const authority = build()
    const seen: string[] = []
    let nested: Promise<unknown> | undefined
    authority.subscribe(DEVICE_GRADE_PRINCIPAL, (delivery) => {
      seen.push(`a${delivery.throughSeq}`)
      if (delivery.throughSeq === 1) nested = authority.save([upsert('second', 2)])
    })
    authority.subscribe(DEVICE_GRADE_PRINCIPAL, (delivery) => {
      seen.push(`b${delivery.throughSeq}`)
    })
    await authority.save([upsert('first', 1)])
    await nested
    expect(seen).toEqual(['a1', 'b1', 'a2', 'b2'])
  })

  it('isolates subscriber failures and stops delivery after unsubscribe', async () => {
    const authority = build()
    authority.subscribe(DEVICE_GRADE_PRINCIPAL, () => {
      throw new Error('subscriber')
    })
    const delivered = vi.fn()
    const off = authority.subscribe(DEVICE_GRADE_PRINCIPAL, delivered)
    await authority.save([upsert('s', 1)])
    off()
    await authority.save([upsert('s', 2)])
    expect(delivered).toHaveBeenCalledTimes(1)
  })

  // A commit names no records (POD-6920), so its rows carry the ambient
  // command's provenance, read once at the call; there is no per-row group.
  it('stamps ambient provenance once at the call', async () => {
    let ambient: { mutationId?: ReturnType<typeof asMutationId>; originId?: string } = {
      mutationId: asMutationId('first'),
      originId: 'ambient',
    }
    const current = vi.fn(() => ambient)
    const store = memoryChangeLog()
    const authority = build({ store, provenance: { current } })
    const spec = upsert('s', 1)
    await authority.commit({
      write: async () => {
        ambient = { mutationId: asMutationId('later'), originId: 'ambient' }
        authority.models.set([spec])
      },
    })
    ambient = {}
    await authority.save([upsert('t', 2)])
    expect(current).toHaveBeenCalledTimes(2)
    expect((await store.changesSince(0))[0]).toMatchObject({
      mutationId: 'first',
      originId: 'ambient',
    })
    const second = (await store.changesSince(1))[0]!
    expect(second).not.toHaveProperty('mutationId')
    expect(second).not.toHaveProperty('originId')
    expect(await authority.save([spec])).toEqual([])
  })

  it('bootstraps from model rows after the entire catch-up log is deleted', async () => {
    const store = memoryChangeLog()
    const authority = build({ store })
    await authority.save([upsert('old', 1), upsert('new', 2)])
    store.minChangeSeq = async () => null
    store.changesInRange = async () => []
    const snapshot = await authority.bootstrap(DEVICE_GRADE_PRINCIPAL)
    expect(snapshot.throughSeq).toBe(2)
    expect(snapshot.changes.map((row) => row.entityId)).toEqual(['old', 'new'])
    expect(snapshot.changes.map((row) => row.seq)).toEqual([2, 2])
    expect(await authority.changesSince(0, DEVICE_GRADE_PRINCIPAL)).toBeNull()
  })
})

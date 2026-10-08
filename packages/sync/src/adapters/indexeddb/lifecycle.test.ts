import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { OutboxRecord } from '../../outbox/records'
import type { Cursor } from '../../replica/types'
import { ENTITY_STORE, META_STORE, OUTBOX_STORE } from './schema'
import { type DurabilityDegradation, IndexedDbSyncStore } from './store'
import { freshFactory, readDurable } from './test-support'

const PRINCIPAL = asUserId('ada')
const CURSOR: Cursor = { feedId: 'feed', epoch: 'e1', seq: 1 }
const RECORD: OutboxRecord = {
  mutationId: 'pending' as MutationId,
  command: { name: 'issues.close', version: 1, delivery: 'offline-eligible' },
  input: { entityId: 'ADA-1' },
  partitionKey: 'issue:ADA-1',
  attribution: { actor: actorUser(PRINCIPAL), onBehalfOf: PRINCIPAL },
  state: 'queued',
  queuedAt: 1_700_000_000_000,
  attempts: 0,
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('IndexedDB connection lifecycle', () => {
  it.each([
    'native close',
    'versionchange',
    'teardown',
  ] as const)('preserves a pending atomic span after %s', async (boundary) => {
    const factory = freshFactory()
    const opens = vi.spyOn(factory, 'open')
    const degradations: DurabilityDegradation[] = []
    const store = await IndexedDbSyncStore.open({
      factory,
      onDegraded: (event) => {
        degradations.push(event)
      },
    })
    const db = opens.mock.results[0]!.value.result
    const staged = deferred()
    const resume = deferred()
    const adopted: string[] = []
    const view = store.viewFor(PRINCIPAL)
    const pending = store.unitOfWork.transact(async (span) => {
      view.cache.applyAtomic(
        {
          operations: [
            { kind: 'upsert', entity: 'issue', entityId: 'ADA-1', value: { title: 'saved' } },
          ],
          cursor: CURSOR,
        },
        span,
      )
      await view.outbox.apply(
        {
          put: [RECORD],
          expect: [{ mutationId: RECORD.mutationId, expect: 'absent' }],
        },
        span,
      )
      span.onCommit(() => {
        adopted.push('first')
      })
      span.onCommit(() => {
        adopted.push('second')
      })
      staged.resolve()
      await resume.promise
    })
    // Attach immediately so the baseline failure is an assertion, not an orphan.
    const result = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await staged.promise
    if (boundary === 'native close') db.close()
    if (boundary === 'versionchange') db.onversionchange?.call(db, {})
    if (boundary === 'teardown') store.close()
    expect(adopted).toEqual([])
    expect(view.cache.readCursor()).toBeNull()
    expect((await readDurable(factory))[OUTBOX_STORE]).toEqual([])
    resume.resolve()
    try {
      expect(await result).toBeUndefined()
      expect(adopted).toEqual(['first', 'second'])
      expect(view.cache.readCursor()).toEqual(CURSOR)
      expect(degradations).toEqual([])
      const durable = await readDurable(factory)
      expect(durable[ENTITY_STORE]).toMatchObject([
        { entityId: 'ADA-1', value: { title: 'saved' } },
      ])
      expect(durable[META_STORE]).toMatchObject([{ key: 'cursor', value: CURSOR }])
      expect(durable[OUTBOX_STORE]).toMatchObject([{ record: RECORD }])
    } finally {
      store.close()
    }
  })
})

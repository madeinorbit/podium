import { describe, expect, it } from 'vitest'
import { Outbox } from './outbox'
import type { OutboxAttribution, OutboxCommand } from './records'
import {
  InMemoryOutboxStore,
  InMemoryUnitOfWork,
  ManualClock,
  ScriptedAuthority,
  sequentialMutationIds,
} from './test-doubles'

const CLOSE: OutboxCommand = { name: 'issues.close', version: 1, delivery: 'offline-eligible' }
const att = (u: string): OutboxAttribution => ({
  actor: { kind: 'user', userId: u },
  onBehalfOf: u,
})

const open = async (
  store: InMemoryOutboxStore,
  principal: string,
  prefix: string,
  uow?: InMemoryUnitOfWork,
) =>
  await Outbox.open({
    store,
    submit: new ScriptedAuthority(() => ({ kind: 'applied' })),
    principal,
    now: new ManualClock().now,
    maxAgeMs: 1e12,
    newMutationId: sequentialMutationIds(prefix),
    onStoreUnreadable: () => {},
    ...(uow ? { unitOfWork: uow } : {}),
  })

describe('reviewer probes', () => {
  it('P1: two instances on one store must not clobber each other', async () => {
    const store = new InMemoryOutboxStore()
    const ada = await open(store, 'u-ada', 'ada-')
    const grace = await open(store, 'u-grace', 'grace-')
    await ada.enqueue({ command: CLOSE, input: { i: 1 }, attribution: att('u-ada') })
    await grace.enqueue({ command: CLOSE, input: { i: 2 }, attribution: att('u-grace') })
    expect(
      store
        .durable()
        .map((r) => r.mutationId)
        .sort(),
    ).toEqual(['ada-1', 'grace-1'])
    expect(ada.all()).toHaveLength(1)
  })

  it('P2: two retirements in one span must both stick', async () => {
    const uow = new InMemoryUnitOfWork()
    const store = new InMemoryOutboxStore()
    const outbox = await open(store, 'u-ada', 'm', uow)
    const a = await outbox.enqueue({
      command: CLOSE,
      input: { i: 1 },
      attribution: att('u-ada'),
      partitionKey: 'p1',
    })
    const b = await outbox.enqueue({
      command: CLOSE,
      input: { i: 2 },
      attribution: att('u-ada'),
      partitionKey: 'p2',
    })
    await outbox.drain()
    await uow.transact(async (span) => {
      await outbox.retireApplied(a.mutationId, span)
      await outbox.retireApplied(b.mutationId, span)
    })
    expect(store.durable()).toEqual([])
    expect(outbox.all()).toEqual([])
  })
})

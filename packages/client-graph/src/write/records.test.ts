/**
 * A GENERIC RECORD WRITE IN THE POOL (ADR 12 D3, POD-6392): it paints at once,
 * keeps painting until its outbox entry retires by confirmation, and drops on a
 * refusal, with no per-kind display code anywhere on the way.
 */

import type { OverlayTarget } from '@podium/client-core/command-reducers'
import { foldRowOverlays } from '@podium/client-core/command-reducers'
import type { OutboxOutcome } from '@podium/client-core/engine'
import type { OutboxEntry } from '@podium/client-core/outbox'
import { createRecordsApi } from '@podium/client-core/records'
import { asMutationId, asSessionId, asUserId, sessionUserStateRowId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createPoolTransactions } from './transactions'

const ISSUE = 'iss_00000000-0000-4000-8000-000000000001'
const USER = asUserId('u-1')
const SESSION = asSessionId('00000000-0000-4000-8000-0000000000aa')
const READ_ROW = sessionUserStateRowId(USER, SESSION)

/** A pool over a fake outbox and a fake replica: `truth` is the server row,
 *  `apply` is the reply, `retire` is the replica's confirmation. */
function pool(
  entity: OverlayTarget,
  id: string,
  initial: Record<string, unknown> | undefined,
  boot: { awaiting?: OutboxEntry[] } = {},
) {
  let truth = initial
  let queue: OutboxEntry[] = []
  let awaiting: OutboxEntry[] = boot.awaiting ?? []
  let outcome: (o: OutboxOutcome) => void = () => {}
  let publish: (size: number) => void = () => {}
  let serial = 0
  const tx = createPoolTransactions({
    userId: USER,
    outbox: {
      pending: () => queue,
      awaiting: () => awaiting,
      deadLetters: () => [],
      subscribe: (listener) => {
        publish = listener
        return () => {}
      },
    },
    outcomes: (listener) => {
      outcome = listener
      return () => {}
    },
    addressed: () => () => {},
    mintId: () => asMutationId(`m-${++serial}`),
    enqueue: async (kind, input, opts) => {
      queue = [...queue, { kind, input, ...opts }]
      publish(queue.length)
    },
  })
  const source = (e: OverlayTarget, rowId: string) =>
    e === entity && rowId === id ? truth : undefined
  tx.bind({
    truth: (e, rowId) => source(e, rowId) ?? (e === 'sessions' ? { id: SESSION } : undefined),
    repaint: () => null,
  })
  return {
    records: createRecordsApi((kind, input) => tx.write(kind, input)),
    shown: () => foldRowOverlays(truth, tx.pending.byRow(entity).get(id) ?? []),
    painted: () => tx.pending.byRow(entity).get(id)?.length ?? 0,
    truth(next: Record<string, unknown> | undefined) {
      truth = next
    },
    apply(mutationId: string) {
      const entry = queue.find((e) => e.mutationId === mutationId)!
      queue = queue.filter((e) => e !== entry)
      awaiting = [...awaiting, { ...entry, state: 'awaiting-truth' }]
      outcome({ type: 'applied', mutationId: entry.mutationId, entry })
      publish(queue.length)
    },
    refuse(mutationId: string) {
      const entry = queue.find((e) => e.mutationId === mutationId)!
      queue = queue.filter((e) => e !== entry)
      outcome({ type: 'rejected', mutationId: entry.mutationId, entry, parked: false })
      publish(queue.length)
    },
    retire(mutationId: string) {
      awaiting = awaiting.filter((e) => e.mutationId !== mutationId)
      publish(queue.length)
    },
    dispose: () => tx.dispose(),
  }
}

describe('a generic edit in the pool (POD-6392)', () => {
  it('paints at once, with no per-kind code', async () => {
    const p = pool('issueProjections', ISSUE, { id: ISSUE, title: 'Old', revision: 3 })
    await p.records.edit({ kind: 'issueProjection', id: ISSUE }, { title: 'Mine' }, 3)
    expect(p.shown()).toMatchObject({ title: 'Mine' })
    p.dispose()
  })

  it('keeps painting after the reply until its receipt is covered, then shows server truth', async () => {
    const p = pool('issueProjections', ISSUE, { id: ISSUE, title: 'Old', revision: 3 })
    await p.records.edit({ kind: 'issueProjection', id: ISSUE }, { title: 'Mine' }, 3)
    p.apply('m-1')
    // The reply came back; the replica has not caught up yet.
    expect(p.shown()).toMatchObject({ title: 'Mine' })
    // Another device's write landed after mine: still mine until my entry retires.
    p.truth({ id: ISSUE, title: 'Theirs', revision: 5 })
    expect(p.shown()).toMatchObject({ title: 'Mine' })
    p.retire('m-1')
    expect(p.painted()).toBe(0)
    expect(p.shown()).toMatchObject({ title: 'Theirs' })
    p.dispose()
  })

  it('a refused edit drops its paint', async () => {
    const p = pool('issueProjections', ISSUE, { id: ISSUE, title: 'Old', revision: 3 })
    await p.records.edit({ kind: 'issueProjection', id: ISSUE }, { title: 'Mine' }, 2)
    expect(p.shown()).toMatchObject({ title: 'Mine' })
    p.refuse('m-1')
    expect(p.painted()).toBe(0)
    expect(p.shown()).toMatchObject({ title: 'Old' })
    p.dispose()
  })

  it('a reload while waiting keeps the paint and retires on catch-up', () => {
    const waiting: OutboxEntry = {
      mutationId: asMutationId('m-boot'),
      kind: 'recordEdit',
      input: { kind: 'issueProjection', id: ISSUE, patch: { title: 'Mine' }, expectedRevision: 3 },
      queuedAt: 0,
      state: 'awaiting-truth',
    }
    const p = pool('issueProjections', ISSUE, { id: ISSUE, title: 'Old' }, { awaiting: [waiting] })
    expect(p.shown()).toMatchObject({ title: 'Mine' })
    p.truth({ id: ISSUE, title: 'Mine', revision: 4 })
    p.retire('m-boot')
    expect(p.painted()).toBe(0)
    expect(p.shown()).toMatchObject({ title: 'Mine', revision: 4 })
    p.dispose()
  })

  it('a remove hides the row until confirmed', async () => {
    const row = { userId: USER, sessionId: SESSION, readAt: '2026-11-01T00:00:00.000Z' }
    const p = pool('sessionUserStates', SESSION, row)
    await p.records.remove({ kind: 'sessionUserState', id: READ_ROW })
    expect(p.shown()).toBeUndefined()
    p.apply('m-1')
    expect(p.shown()).toBeUndefined()
    // The removal landed: the server holds no row either.
    p.truth(undefined)
    p.retire('m-1')
    expect(p.painted()).toBe(0)
    expect(p.shown()).toBeUndefined()
    p.dispose()
  })

  it('a per-user edit on a never-written row paints over the absent row', async () => {
    const p = pool('sessionUserStates', SESSION, undefined)
    await p.records.edit(
      { kind: 'sessionUserState', id: READ_ROW },
      {
        readAt: '2026-11-03T00:00:00.000Z',
      },
    )
    expect(p.shown()).toEqual({
      userId: USER,
      sessionId: SESSION,
      readAt: '2026-11-03T00:00:00.000Z',
    })
    p.dispose()
  })

  it('an issue create paints nothing, and its row shows when it lands', async () => {
    const p = pool('issueProjections', ISSUE, undefined)
    await p.records.create('issueProjection', ISSUE, { title: 'New', repoPath: '/repo' })
    expect(p.shown()).toBeUndefined()
    p.apply('m-1')
    p.truth({ id: ISSUE, title: 'New', seq: 12 })
    expect(p.shown()).toMatchObject({ title: 'New', seq: 12 })
    p.retire('m-1')
    expect(p.shown()).toMatchObject({ title: 'New', seq: 12 })
    p.dispose()
  })
})

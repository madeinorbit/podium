/**
 * Old/new parity for pending-message counts (POD-6155 step 4).
 *
 * OLD: the world index's counters (`WorldIndex.reader.pendingCount`), kept
 * current by every committed message write. NEW: the indexed count in SQL
 * (`MessagesRepository.countPending`), the read the delivery scheduler's
 * trigger makes instead. Compared for every delivery target (issue and
 * session) over the benchmark corpus's ids (POD-6146: cell h1a1, seed 4443)
 * with messages in every delivery status — queued, on its way, delivered, read,
 * failed, cancelled, expired — then after a second wave of transitions; and
 * operator (chat) messages, which are never delivery targets, must not move
 * an issue or session count.
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { asSessionId, asThreadId, type MessageDeliveryStatus } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageRow, SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { seedMessage } from '../../test-support/seed-message'
import { WorldIndex } from '../world-index'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const at = '2026-10-15T00:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest().readUInt32BE(0)
const STATUSES: MessageDeliveryStatus[] = ['stored', 'dispatched', 'typed', 'confirmed', 'failed', 'cancelled', 'expired']

function message(id: string, toKind: MessageRow['toKind'], toId: string | null, status: MessageDeliveryStatus) {
  const deliveredTo = status === 'typed' || status === 'dispatched' ? asSessionId(`delivered-${id}`) : null
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: null,
    fromIssue: null,
    toKind,
    toId,
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: id,
    expiresAt: null,
    createdAt: at,
    deliveryStatus: status,
    deliveredAt: null,
    deliveredTo,
    readAt: null,
    injectedAt: null,
    deadLetteredAt: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
  } as unknown as MessageRow
}

async function corpusTargets(): Promise<{ kind: 'issue' | 'session'; id: string }[]> {
  const module = fileURLToPath(new URL('../../../../../scripts/server-data-bench/corpus-export.ts', import.meta.url))
  const { exportCorpus } = (await import(module)) as {
    exportCorpus(cell: string, seed: number): Promise<{ issues: { id: string }[]; sessions: { id: string }[] }>
  }
  const corpus = await exportCorpus('h1a1', 4443)
  return [
    ...corpus.issues.map((row) => ({ kind: 'issue' as const, id: `iss_${row.id}` })),
    ...corpus.sessions.map((row) => ({ kind: 'session' as const, id: row.id })),
  ]
}

async function expectParity(store: SessionStore, index: WorldIndex, targets: readonly { kind: 'issue' | 'session'; id: string }[]) {
  for (const target of targets) {
    expect(await store.messages.countPending(target), `${target.kind} ${target.id}`).toBe(index.reader.pendingCount(target))
  }
}

describe('pending counts: old counters and new SQL counts give the same answers', () => {
  it('over the benchmark corpus, every status, and a second wave of transitions', async () => {
    const store = await openTestStore(':memory:')
    stores.push(store)
    const index = await WorldIndex.load(store)
    const targets = [
      ...(await corpusTargets()),
      { kind: 'issue' as const, id: 'iss_never-addressed' },
      { kind: 'session' as const, id: 'session-never-addressed' },
    ]
    expect(targets.length).toBeGreaterThan(9000)
    const seeded: { id: string; target: (typeof targets)[number] }[] = []
    const writes: (() => Promise<void>)[] = []
    for (const target of targets.slice(0, -2)) {
      const n = hash(`${target.kind}:${target.id}`) % 4
      for (let i = 0; i < n; i++) {
        const id = `msg-${target.kind}-${target.id}-${i}`
        const status = STATUSES[hash(id) % STATUSES.length]!
        seeded.push({ id, target })
        writes.push(async () => await seedMessage(store.messages, message(id, target.kind, target.id, status)))
      }
    }
    // Operator (chat) messages: never a delivery target, never in an issue or session count.
    for (let i = 0; i < 50; i++) {
      writes.push(async () => await seedMessage(store.messages, message(`op-${i}`, 'operator', null, i % 3 ? 'stored' : 'confirmed')))
    }
    for (let i = 0; i < writes.length; i += 500) {
      await store.transact(async () => {
        for (const write of writes.slice(i, i + 500)) await write()
      })
    }
    expect(seeded.length).toBeGreaterThan(5000)
    await expectParity(store, index, targets)

    // Second wave: move a slice of the rows on, through the production moves.
    await store.transact(async () => {
      for (const { id } of seeded.filter(({ id }) => hash(`wave:${id}`) % 3 === 0)) {
        switch (hash(`move:${id}`) % 5) {
          case 0: await store.messages.markDelivered(id, null, at); break
          case 1: await store.messages.markDispatched(id, asSessionId(`delivered-${id}`), at); break
          case 2: await store.messages.markDeadLetter(id, at); break
          case 3: await store.messages.expireObserved({ id, createdAt: at, lifecycle: 'wait', expiresAt: null }); break
          case 4: await store.messages.markRead(id, null, at); break
        }
      }
    })
    await expectParity(store, index, targets)

    // A rolled-back wave moves neither.
    const before = await Promise.all(targets.slice(0, 50).map(async (target) => await store.messages.countPending(target)))
    await expect(store.transact(async () => {
      for (const { id } of seeded.slice(0, 200)) await store.messages.markCancelled(id)
      throw new Error('roll back')
    })).rejects.toThrow('roll back')
    expect(await Promise.all(targets.slice(0, 50).map(async (target) => await store.messages.countPending(target)))).toEqual(before)
    await expectParity(store, index, targets)
  }, 300_000)
})

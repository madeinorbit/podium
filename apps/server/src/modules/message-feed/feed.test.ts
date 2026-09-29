/**
 * THE CHAT MESSAGE FEED, AGAINST THE REAL DATABASE AND LEDGER (POD-4764).
 *
 * A person's chat message reaches every device's feed from the write that
 * moved it, inside that write's transaction:
 *   1. an open message is carried with its current status,
 *   2. a confirmed one stays for a bounded window of its session's
 *      confirmations (so devices learn the history entry it became) and then
 *      leaves; a busy session never pushes out another session's,
 *   3. a failed one stays until its sender dismisses it; a cancelled one leaves,
 *   4. a rolled-back write never reaches the feed,
 *   5. boot reconciles the open set from the table and catches writes made
 *      before the feed went live,
 *   6. nobody else's traffic rides the feed.
 */

import {
  actorAgent,
  actorUser,
  asAgentIdentityId,
  asSessionId,
  asThreadId,
  asUserId,
  type MessageRecordWire,
  messageRecordRowId,
} from '@podium/model'
import { Ledger } from '@podium/sync'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import type { MessageRow } from '../../store/types'
import { openTestStore } from '../../test-support/open-test-store'
import { MessageFeedPublisher } from './feed'

const S1 = asSessionId('ses_one')
const S2 = asSessionId('ses_two')
const ALICE = asUserId('usr_alice')

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function harness(opts: { window?: number; live?: boolean } = {}) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const ledger = new Ledger({
    repo: store.sync,
    now: Date.now,
    transact: async (fn) => await store.transact(fn),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  })
  const feed = new MessageFeedPublisher({
    ledger,
    snapshot: async () => await ledger.authority.snapshot('message'),
    listOpen: async () => await store.messages.listOpenChat(),
    transact: async (fn) => await store.transact(fn),
    ...(opts.window === undefined ? {} : { confirmedPerSession: opts.window }),
  })
  store.messages.setFeedCapture(feed.capture)
  if (opts.live !== false) await feed.resolve()
  /** What a device bootstrapping now would receive, keyed by message id. */
  const carried = async (): Promise<Map<string, MessageRecordWire>> =>
    new Map(
      ((await ledger.authority.snapshot('message')) as MessageRecordWire[]).map((r) => [r.id, r]),
    )
  /** A second publisher over the same table and log — the next boot. */
  const reboot = async (window?: number): Promise<MessageFeedPublisher> => {
    const next = new MessageFeedPublisher({
      ledger,
      snapshot: async () => await ledger.authority.snapshot('message'),
      listOpen: async () => await store.messages.listOpenChat(),
      transact: async (fn) => await store.transact(fn),
      ...(window === undefined ? {} : { confirmedPerSession: window }),
    })
    store.messages.setFeedCapture(next.capture)
    await next.resolve()
    return next
  }
  return { store, ledger, feed, carried, reboot }
}

/** Store a message and confirm it. */
async function confirm(
  store: SessionStore,
  id: string,
  sessionId = S1,
): Promise<void> {
  await store.messages.addMessage(chat(id, { toId: sessionId }))
  await store.messages.markDelivered(id, sessionId, 't')
}

let clock = 0
function chat(id: string, over: Partial<MessageRow> = {}): MessageRow {
  clock += 1
  return {
    id,
    threadId: asThreadId(id),
    inReplyTo: null,
    fromKind: 'operator',
    fromSession: null,
    fromIssue: null,
    attribution: { actor: actorUser(ALICE), onBehalfOf: ALICE },
    toKind: 'session',
    toId: S1,
    kind: 'message',
    urgency: 'next-turn',
    lifecycle: 'wait',
    body: `text of ${id}`,
    expiresAt: null,
    createdAt: `2026-09-29T00:00:${String(clock).padStart(2, '0')}.000Z`,
    deliveryStatus: 'stored',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    expectsResponse: false,
    ...over,
  }
}

describe('the chat message feed', () => {
  it('carries a message from the write that stores it, then each status it moves to', async () => {
    const { store, carried } = await harness()
    await store.messages.addMessage(chat('msg_a'))
    expect((await carried()).get('msg_a')).toEqual({
      id: 'msg_a',
      sessionId: S1,
      senderUserId: ALICE,
      body: 'text of msg_a',
      createdAt: expect.any(String),
      status: 'stored',
    } satisfies MessageRecordWire)
    await store.messages.markDispatched('msg_a', S1, 't1')
    expect((await carried()).get('msg_a')?.status).toBe('dispatched')
    await store.messages.markTyped('msg_a', S1, 't2')
    expect((await carried()).get('msg_a')?.status).toBe('typed')
  })

  it('keys the row by session, sender and id, so visibility needs no read', async () => {
    const { store, ledger } = await harness()
    await store.messages.addMessage(chat('msg_k'))
    const changes = await ledger.changesSince(0)
    expect(changes?.map((c) => c.id)).toEqual([
      messageRecordRowId({ sessionId: S1, senderUserId: ALICE, messageId: 'msg_k' }),
    ])
  })

  it('keeps a confirmed message, with the history entry it became, until the window moves past it', async () => {
    const { store, carried } = await harness({ window: 2 })
    for (const id of ['msg_1', 'msg_2', 'msg_3']) {
      await store.messages.addMessage(chat(id))
      await store.messages.markDispatched(id, S1, 't1')
    }
    await store.messages.markDelivered('msg_1', S1, 't2')
    await store.messages.nameTranscriptItem('msg_1', S1, { id: 'entry-1', cursor: 'c1' })
    expect((await carried()).get('msg_1')).toMatchObject({
      status: 'confirmed',
      transcriptItem: { id: 'entry-1', cursor: 'c1' },
    })
    await store.messages.markDelivered('msg_2', S1, 't3')
    expect([...(await carried()).keys()].sort()).toEqual(['msg_1', 'msg_2', 'msg_3'])
    // The third confirmation pushes the oldest out: the table keeps it, the
    // transcript shows it, the feed lets it go.
    await store.messages.markDelivered('msg_3', S1, 't4')
    expect([...(await carried()).keys()].sort()).toEqual(['msg_2', 'msg_3'])
    expect((await store.messages.getMessage('msg_1'))?.deliveryStatus).toBe('confirmed')
  })

  it('keeps each session’s confirmations in its own window: a busy session pushes out only its own', async () => {
    const { store, carried } = await harness({ window: 2 })
    await confirm(store, 'msg_quiet', S2)
    for (const id of ['msg_b1', 'msg_b2', 'msg_b3', 'msg_b4']) await confirm(store, id)
    expect([...(await carried()).keys()].sort()).toEqual(['msg_b3', 'msg_b4', 'msg_quiet'])
    // The quiet session's own confirmations are what move its window.
    await confirm(store, 'msg_q2', S2)
    await confirm(store, 'msg_q3', S2)
    expect([...(await carried()).keys()].sort()).toEqual(['msg_b3', 'msg_b4', 'msg_q2', 'msg_q3'])
  })

  it('rebuilds each session’s window at boot from what the feed carries', async () => {
    const { store, carried, reboot } = await harness({ window: 2 })
    await confirm(store, 'msg_a1')
    await confirm(store, 'msg_a2')
    await confirm(store, 'msg_z1', S2)
    await reboot(1)
    expect([...(await carried()).keys()].sort()).toEqual(['msg_a2', 'msg_z1'])
    // The rebuilt windows are per session too.
    await confirm(store, 'msg_z2', S2)
    expect([...(await carried()).keys()].sort()).toEqual(['msg_a2', 'msg_z2'])
  })

  it('does not bring back a confirmed message a later stamp touches once it left', async () => {
    const { store, carried } = await harness({ window: 1 })
    for (const id of ['msg_old', 'msg_new']) {
      await store.messages.addMessage(chat(id))
      await store.messages.markDelivered(id, S1, 't1')
    }
    expect([...(await carried()).keys()]).toEqual(['msg_new'])
    await store.messages.markAcked('msg_old', 'msg_ack')
    expect([...(await carried()).keys()]).toEqual(['msg_new'])
  })

  it('keeps a failed message until its sender dismisses it', async () => {
    const { store, carried } = await harness()
    await store.messages.addMessage(chat('msg_f'))
    await store.messages.markDispatched('msg_f', S1, 't1')
    await store.messages.markDeliveryAbandoned('msg_f', S1, 't2', 'never-live')
    expect((await carried()).get('msg_f')).toMatchObject({ status: 'failed', reason: 'never-live' })
    expect(await store.messages.dismissNotice('msg_f', 't3')).toBe(true)
    expect((await carried()).has('msg_f')).toBe(false)
    // A repeat changes nothing; the status still says what happened.
    expect(await store.messages.dismissNotice('msg_f', 't4')).toBe(false)
    expect((await store.messages.getMessage('msg_f'))?.deliveryStatus).toBe('failed')
  })

  it('refuses to dismiss a message that has no notice', async () => {
    const { store, carried } = await harness()
    await store.messages.addMessage(chat('msg_p'))
    expect(await store.messages.dismissNotice('msg_p', 't1')).toBe(false)
    expect((await carried()).get('msg_p')?.status).toBe('stored')
  })

  it('keeps a message nobody can vouch for, and lets a cancelled one go', async () => {
    const { store, carried } = await harness()
    await store.messages.addMessage(chat('msg_u'))
    await store.messages.markDispatched('msg_u', S1, 't1')
    await store.messages.markUnknown('msg_u', S1)
    expect((await carried()).get('msg_u')?.status).toBe('unknown')
    await store.messages.addMessage(chat('msg_c'))
    await store.messages.markCancelled('msg_c')
    expect((await carried()).has('msg_c')).toBe(false)
  })

  it('never publishes a write that rolls back', async () => {
    const { store, carried } = await harness()
    await store.messages.addMessage(chat('msg_r'))
    await expect(
      store.transact(async () => {
        await store.messages.markDispatched('msg_r', S1, 't1')
        throw new Error('the enclosing work failed')
      }),
    ).rejects.toThrow('the enclosing work failed')
    expect((await store.messages.getMessage('msg_r'))?.deliveryStatus).toBe('stored')
    expect((await carried()).get('msg_r')?.status).toBe('stored')
  })

  it('carries only people’s messages into sessions', async () => {
    const { store, carried } = await harness()
    await store.messages.addMessage(
      chat('msg_agent', {
        fromKind: 'agent',
        fromSession: asSessionId('ses_other'),
        attribution: { actor: actorAgent(asAgentIdentityId('agt_1')), onBehalfOf: null },
      }),
    )
    await store.messages.addMessage(chat('msg_issue', { toKind: 'issue', toId: 'iss_1' }))
    expect((await carried()).size).toBe(0)
  })

  it('carries at boot the messages that predate the feed (an upgrade), and none that ended', async () => {
    const { store, feed, carried } = await harness({ live: false })
    // Written with no capture installed at all, as on the release before this.
    const uninstall = store.messages.setFeedCapture(async () => {})
    await store.messages.addMessage(chat('msg_waiting'))
    await store.messages.addMessage(chat('msg_lost'))
    await store.messages.markDispatched('msg_lost', S1, 't1')
    await store.messages.markUnknown('msg_lost', S1)
    await store.messages.addMessage(chat('msg_done'))
    await store.messages.markDelivered('msg_done', S1, 't2')
    uninstall()
    store.messages.setFeedCapture(feed.capture)
    await feed.resolve()
    expect([...(await carried()).keys()].sort()).toEqual(['msg_lost', 'msg_waiting'])
  })

  it('reconciles the open set at boot and publishes what was written before it went live', async () => {
    const { store, feed, carried } = await harness({ live: false })
    await store.messages.addMessage(chat('msg_before'))
    await store.messages.addMessage(chat('msg_gone'))
    await store.messages.markCancelled('msg_gone')
    expect((await carried()).size).toBe(0)
    await feed.resolve()
    expect([...(await carried()).keys()]).toEqual(['msg_before'])
    await store.messages.markDispatched('msg_before', S1, 't1')
    expect((await carried()).get('msg_before')?.status).toBe('dispatched')
  })
})

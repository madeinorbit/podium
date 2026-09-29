/**
 * A DEVICE'S OWN MESSAGES, BY ID (POD-4811).
 *
 * The catch-up read beside the feed answers, in one request:
 *   1. each record exactly as the feed would carry it — including one the feed
 *      has long let go (confirmed and pushed out of its session's window), and
 *      one whose notice its sender dismissed, which says so;
 *   2. only to the feed's own readers: the sender and the target session's
 *      owner; anyone else, and an id with no row, gets nothing back — the same
 *      nothing;
 *   3. only to a person: an agent has no feed of chat records to catch up on.
 */

import {
  actorAgent,
  actorUser,
  asAgentIdentityId,
  asSessionId,
  asThreadId,
  asUserId,
  type Capability,
  type UserId,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import type { MessageRow, SessionRow } from '../../store/types'
import { openTestStore } from '../../test-support/open-test-store'
import { mailHarness } from '../messages/characterization-support'
import { readMessageRecords } from './records'

const S1 = asSessionId('ses_one')
const ALICE = asUserId('usr_alice')
const BOB = asUserId('usr_bob')
const CAROL = asUserId('usr_carol')

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

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

/** The real messages table; session owners as the feed reads them. */
async function harness(owners: Record<string, UserId> = { [S1]: BOB }) {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const reads: string[][] = []
  const deps = {
    messages: store.messages,
    sessions: {
      getSessions: async (ids: readonly string[]) => {
        reads.push([...ids])
        return new Map(
          ids.flatMap((id) =>
            owners[id] ? [[id, { id, ownerUserId: owners[id] } as unknown as SessionRow]] : [],
          ),
        )
      },
    },
  }
  const read = async (user: UserId, ids: string[]) =>
    (await readMessageRecords(deps, user, ids)).map((record) => record.id).sort()
  return { store, deps, read, reads }
}

describe('a device’s own messages, by id', () => {
  it('answers a confirmed message the feed no longer carries, and one whose notice was dismissed', async () => {
    const { store, deps } = await harness()
    await store.messages.addMessage(chat('msg_done'))
    await store.messages.markDispatched('msg_done', S1, 't1')
    await store.messages.markDelivered('msg_done', S1, 't2')
    await store.messages.nameTranscriptItem('msg_done', S1, { id: 'entry-1', cursor: 'c1' })
    await store.messages.addMessage(chat('msg_lost'))
    await store.messages.markDispatched('msg_lost', S1, 't3')
    await store.messages.markDeliveryAbandoned('msg_lost', S1, 't4', 'never-live')
    expect(await store.messages.dismissNotice('msg_lost', '2026-09-29T01:00:00.000Z')).toBe(true)
    const records = await readMessageRecords(deps, ALICE, ['msg_done', 'msg_lost'])
    expect(records.find((record) => record.id === 'msg_done')).toMatchObject({
      status: 'confirmed',
      transcriptItem: { id: 'entry-1', cursor: 'c1' },
    })
    expect(records.find((record) => record.id === 'msg_lost')).toMatchObject({
      status: 'failed',
      noticeDismissedAt: '2026-09-29T01:00:00.000Z',
    })
  })

  it('answers the sender and the session’s owner, and nobody else', async () => {
    const { store, read } = await harness()
    await store.messages.addMessage(chat('msg_a'))
    expect(await read(ALICE, ['msg_a'])).toEqual(['msg_a'])
    expect(await read(BOB, ['msg_a'])).toEqual(['msg_a'])
    expect(await read(CAROL, ['msg_a'])).toEqual([])
  })

  it('leaves out an id with no row, and a row that is not a person’s chat message', async () => {
    const { store, read } = await harness()
    await store.messages.addMessage(chat('msg_mine'))
    await store.messages.addMessage(
      chat('msg_agent', {
        fromKind: 'agent',
        fromSession: asSessionId('ses_other'),
        attribution: { actor: actorAgent(asAgentIdentityId('agt_1')), onBehalfOf: ALICE },
      }),
    )
    expect(await read(ALICE, ['msg_mine', 'msg_agent', 'msg_never'])).toEqual(['msg_mine'])
  })

  it('asks for the owners of the sessions only for messages the reader did not send, all at once', async () => {
    const S2 = asSessionId('ses_two')
    const { store, read, reads } = await harness({ [S1]: BOB, [S2]: BOB })
    await store.messages.addMessage(chat('msg_1'))
    await store.messages.addMessage(chat('msg_2', { toId: S2 }))
    await store.messages.addMessage(chat('msg_3', { toId: S2 }))
    expect(await read(ALICE, ['msg_1', 'msg_2'])).toEqual(['msg_1', 'msg_2'])
    expect(reads).toEqual([])
    expect(await read(BOB, ['msg_1', 'msg_2', 'msg_3'])).toEqual(['msg_1', 'msg_2', 'msg_3'])
    expect(reads.map((ids) => [...ids].sort())).toEqual([[S1, S2]])
  })
})

describe('mail.records, through the gate the tRPC router reaches', () => {
  const person = (user: UserId): Capability => ({
    role: 'worker',
    scope: { kind: 'owned', userId: user },
    actorUser: user,
    onBehalfOf: user,
  })

  it('answers a person their own messages by id, in one request', async () => {
    const h = await mailHarness()
    await h.store.messages.addMessage(chat('msg_g1'))
    await h.store.messages.addMessage(chat('msg_g2'))
    const answer = (await h.gate.dispatch(person(ALICE), undefined, 'records', {
      ids: ['msg_g1', 'msg_g2', 'msg_unknown'],
    }, 'trpc')) as { records: { id: string }[] }
    expect(answer.records.map((record) => record.id).sort()).toEqual(['msg_g1', 'msg_g2'])
    const stranger = (await h.gate.dispatch(person(CAROL), undefined, 'records', {
      ids: ['msg_g1'],
    }, 'trpc')) as { records: unknown[] }
    expect(stranger.records).toEqual([])
  })

  it('answers an agent nothing, even one acting for the sender', async () => {
    const h = await mailHarness()
    await h.store.messages.addMessage(chat('msg_g3'))
    const agent: Capability = { ...person(ALICE), actorSessionId: asSessionId('ses_agent') }
    const answer = (await h.gate.dispatch(agent, undefined, 'records', {
      ids: ['msg_g3'],
    }, 'trpc')) as { records: unknown[] }
    expect(answer.records).toEqual([])
  })

  it('refuses a read naming no id, or more than one request may', async () => {
    const h = await mailHarness()
    await expect(h.gate.dispatch(person(ALICE), undefined, 'records', { ids: [] }, 'trpc')).rejects.toThrow()
    const many = Array.from({ length: 101 }, (_, i) => `msg_${i}`)
    await expect(
      h.gate.dispatch(person(ALICE), undefined, 'records', { ids: many }, 'trpc'),
    ).rejects.toThrow()
  })
})

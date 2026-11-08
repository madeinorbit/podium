/**
 * AN EFFECT COMMAND AS THE KERNEL QUEUE SENDS IT IS ONE ITS CONTRACT TAKES
 * (POD-6622).
 *
 * The kernel queue wrote the envelope's `mutationId` into every command's
 * input (`commandInput`). The effect contracts are strict, and stay so: the id
 * belongs on the envelope (POD-6621). While it rode in the input, every start
 * an app queued (`session.launch`, `issue.start`, `issue.begin`, …) and every
 * dismiss was refused `invalid` with nothing written, while the same create
 * sent by hand without the key was applied. So this parses the input the
 * queue actually sends against the contract the server parses it with.
 */

import { effectsCreateContract, effectsDismissContract } from '@podium/commands'
import { asMutationId } from '@podium/model'
import type { SyncSubmitInput } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { OutboxEntry, OutboxStorage } from '../outbox'
import type { Replica } from '../replica/contract'
import { openKernelEngineOutbox } from './kernel-outbox'
import type { StoreNotices } from './types'
import type { EngineOutboxCallbacks } from './wiring'

const EFFECT = 'eff_00000000-0000-4000-8000-000000000001'
const SESSION = '00000000-0000-4000-8000-0000000000aa'
const ISSUE = 'iss_00000000-0000-4000-8000-0000000000bb'

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

async function sent(): Promise<{
  outbox: ReturnType<Awaited<ReturnType<typeof openKernelEngineOutbox>>>
  submits: SyncSubmitInput[]
}> {
  const submits: SyncSubmitInput[] = []
  const api = {
    sync: {
      submit: {
        mutate: async (envelope: SyncSubmitInput) => {
          submits.push(envelope)
          return {
            outcome: 'applied',
            result: { id: EFFECT, status: 'pending', cancelRequested: false },
            receipt: { feedId: 'feed-1', epoch: 'epoch-1', seq: 1 },
            replayed: false,
          }
        },
      },
    },
  } as unknown as PodiumClientApi
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: 'user-1',
    api,
    onDegraded: () => {},
    now: () => 5_000,
    confirmedThrough: () => null,
  })
  const callbacks: EngineOutboxCallbacks = {
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: { error: () => {}, info: () => {} } as unknown as StoreNotices,
    isOnline: () => true,
  }
  return { outbox: create(callbacks), submits }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('an effect command on the kernel queue', () => {
  it('sends a draft start (session.launch) that effects.create takes', async () => {
    const { outbox, submits } = await sent()
    await outbox.enqueue(
      'effectCreate',
      {
        id: EFFECT,
        kind: 'session.launch',
        target: { kind: 'session', id: SESSION },
        input: {
          agentKind: 'codex',
          cwd: '/home/u/src/AlmChat',
          draftIssue: { repoPath: '/home/u/src/AlmChat', issueId: ISSUE },
        },
      },
      { mutationId: asMutationId('11111111-1111-4111-8111-111111111111') },
    )
    await outbox.drain()
    await settle()

    expect(submits.map((s) => s.command)).toEqual(['effects.create'])
    const parsed = effectsCreateContract.input.safeParse(submits[0]?.input)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('sends a dismiss that effects.dismiss takes', async () => {
    const { outbox, submits } = await sent()
    await outbox.enqueue(
      'effectDismiss',
      { id: EFFECT },
      { mutationId: asMutationId('22222222-2222-4222-8222-222222222222') },
    )
    await outbox.drain()
    await settle()

    expect(submits.map((s) => s.command)).toEqual(['effects.dismiss'])
    const parsed = effectsDismissContract.input.safeParse(submits[0]?.input)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })
})

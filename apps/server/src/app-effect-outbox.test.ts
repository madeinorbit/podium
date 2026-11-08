/** The app's actual queue against the composed server, including strict parsing. */
import { asIssueId, asMachineId, asMutationId, asSessionId, mintDeviceId } from '@podium/model'
import type { SyncSubmitInput, SyncSubmitReply } from '@podium/protocol'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { afterEach, describe, expect, it } from 'vitest'
import type { PodiumClientApi } from '../../../packages/client-core/src/api'
import { openKernelEngineOutbox } from '../../../packages/client-core/src/engine/kernel-outbox'
import type { StoreNotices } from '../../../packages/client-core/src/engine/types'
import type { OutboxEntry, OutboxStorage } from '../../../packages/client-core/src/outbox'
import type { Replica } from '../../../packages/client-core/src/replica/contract'
import {
  draftLaunchEffect,
  type EffectCreateInput,
  issueSessionEffect,
  issueStartEffect,
} from '../../../packages/client-core/src/spawn-agent'
import { disposeOracles, makeOracle, type Oracle } from './modules/sessions/oracle-support'

afterEach(() => disposeOracles())

const OFFLINE = asMachineId('mach_6621_offline')
const TARGET = { path: '/repo', repoPath: '/repo', machineId: OFFLINE }

function memoryStorage(): OutboxStorage {
  let entries: OutboxEntry[] = []
  return {
    load: () => entries,
    save: (next) => {
      entries = [...next]
    },
  }
}

async function fixture() {
  const o = await makeOracle({ offlineMachines: [{ id: OFFLINE, name: 'Away' }] })
  await o.store.repos.addRepo('/repo', OFFLINE)
  const issue = await o.reg.issues.crud.create(o.reg.issues.reports.store.serverWriter, {
    repoPath: '/repo',
    machineId: OFFLINE,
    title: 'A top-level proposal',
    startNow: false,
  })
  return { o, issue }
}

async function engine(o: Oracle) {
  const envelopes: SyncSubmitInput[] = []
  const replies: SyncSubmitReply[] = []
  const errors: string[] = []
  const api = {
    sync: {
      submit: {
        mutate: async (envelope: SyncSubmitInput) => {
          envelopes.push(envelope)
          const reply = await o.call.sync.submit(envelope)
          replies.push(reply)
          return reply
        },
      },
    },
  } as unknown as PodiumClientApi
  const create = await openKernelEngineOutbox({
    store: new InMemoryOutboxStore([]),
    principal: 'operator',
    api,
    onDegraded: (error) => {
      throw error
    },
  })
  let online = false
  const outbox = create({
    api,
    replica: {
      outboxStorage: memoryStorage,
      outboxAwaitingStorage: memoryStorage,
      outboxDeadLetterStorage: memoryStorage,
    } as unknown as Replica,
    notices: {
      error: (message: string) => errors.push(message),
      info: () => {},
    } as unknown as StoreNotices,
    isOnline: () => online,
  })
  return {
    outbox,
    envelopes,
    replies,
    errors,
    send: async () => {
      online = true
      await outbox.drain()
    },
  }
}

describe('app effect actions on sync.submit', () => {
  it.each([
    'issue.begin',
    'issue.start',
    'session.launch',
  ] as const)('admits %s from the app queue with mutationId only on the envelope', async (kind) => {
    const { o, issue } = await fixture()
    const ids = {
      effectId: mintDeviceId('eff_'),
      issueId: asIssueId(mintDeviceId('iss_')),
      sessionId: asSessionId(crypto.randomUUID()),
    }
    const create: EffectCreateInput =
      kind === 'issue.begin'
        ? issueSessionEffect({ ...ids, issueId: asIssueId(issue.id), mode: 'begin' })
        : kind === 'issue.start'
          ? issueStartEffect({
              ...ids,
              target: TARGET,
              agentKind: 'codex',
              title: 'New task',
              description: 'Keep my instructions.',
            })
          : draftLaunchEffect({ ...ids, target: TARGET, agentKind: 'codex', firstPrompt: 'Hello' })
    const { outbox, envelopes, replies, errors, send } = await engine(o)
    try {
      const mutationId = asMutationId('m-app-effect')
      await outbox.enqueue('effectCreate', create, { mutationId })
      await send()
      expect(replies).toEqual([expect.objectContaining({ outcome: 'applied' })])
      expect(envelopes).toEqual([
        { command: 'effects.create', version: 1, mutationId, input: create },
      ])
      expect(await o.store.effects.get(create.id)).toMatchObject({ id: create.id, kind })
      expect(errors).toEqual([])
      expect(outbox.deadLetters()).toEqual([])
    } finally {
      outbox.dispose()
    }
  })

  it('dismisses an ended effect from the app queue', async () => {
    const { o, issue } = await fixture()
    const id = mintDeviceId('eff_')
    const create = issueSessionEffect({
      effectId: id,
      issueId: asIssueId(issue.id),
      sessionId: asSessionId(crypto.randomUUID()),
      mode: 'begin',
    })
    expect(
      await o.call.sync.submit({
        mutationId: asMutationId('m-create'),
        command: 'effects.create',
        version: 1,
        input: create,
      }),
    ).toMatchObject({ outcome: 'applied' })
    expect(
      await o.call.sync.submit({
        mutationId: asMutationId('m-cancel'),
        command: 'effects.cancel',
        version: 1,
        input: { id },
      }),
    ).toMatchObject({ outcome: 'applied' })
    const { outbox, replies, errors, send } = await engine(o)
    try {
      await outbox.enqueue('effectDismiss', { id })
      await send()
      expect(replies).toEqual([expect.objectContaining({ outcome: 'applied' })])
      expect((await o.store.effects.get(id))?.deletedAt).toBeDefined()
      expect(errors).toEqual([])
    } finally {
      outbox.dispose()
    }
  })

  it('still refuses unrelated unknown input fields for the operator', async () => {
    const { o, issue } = await fixture()
    const create = issueSessionEffect({
      effectId: mintDeviceId('eff_'),
      issueId: asIssueId(issue.id),
      sessionId: asSessionId(crypto.randomUUID()),
      mode: 'begin',
    })
    const reply = await o.call.sync.submit({
      mutationId: asMutationId('m-envelope'),
      command: 'effects.create',
      version: 1,
      input: { ...create, unexpectedField: true },
    })
    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'invalid' } })
    expect(await o.store.effects.get(create.id)).toBeUndefined()
  })
})

/**
 * ONE BROWSER, TWO WORKSPACES (POD-7312; POD-6954 design 4.2).
 *
 * A person signs in to workspace A, leaves a record, a draft, an unsent write
 * and a chat history behind, and then signs in to workspace B on the same
 * browser. Nothing of A may be visible in B, and B's queue may send nothing of
 * A's. The worst case is used on purpose: the SAME member id in both
 * workspaces, so only the boundary the server reports for each workspace keeps
 * them apart (apps/server/src/identity/replica-boundary.ts).
 *
 * The stores are the web's own: the IndexedDB replica (records, cursor and
 * outbox), localStorage below the principal root (drafts and screen state),
 * and the per-principal IndexedDB chat history. The counterfactual is the
 * switch back to A, which must find every piece where A left it.
 */

import type { PodiumClientApi } from '@podium/client-core/api'
import { DraftStore } from '@podium/client-core/conversation'
import type { NoticeSink } from '@podium/client-core/notices'
import { classifyAuthStatus } from '@podium/client-core/replica-assembly'
import type { TranscriptStore } from '@podium/client-core/transcript-store'
import { openLegacyDeviceKeys } from '@podium/client-core/ui'
import { asMutationId, asSessionId } from '@podium/model'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type KernelAssembly, openKernelAssembly, webTranscriptDatabases } from './kernelReplica'

const MEMBER = 'member-1'
const DRAFT_KEY = 'podium.drafts.v1'

/** The principal a device derives from `/auth/status` of one workspace. */
function principalOf(syncBoundaryId: string): string {
  const decision = classifyAuthStatus({ memberId: MEMBER, syncBoundaryId })
  if (!('principal' in decision)) throw new Error('status names no principal')
  return decision.principal
}

/** Records every call that would leave the device. */
function recordingApi() {
  const sent: unknown[] = []
  const api = {
    sync: {
      submit: {
        mutate: async (input: unknown) => {
          sent.push(input)
          return {
            outcome: 'applied',
            result: { ok: true },
            receipt: { feedId: 'feed', epoch: 'e1', seq: 1 },
            replayed: false,
          }
        },
      },
    },
  } as unknown as PodiumClientApi
  return { api, sent }
}

const notices = { error: () => {}, info: () => {} } as unknown as NoticeSink
const opened: KernelAssembly[] = []

beforeEach(() => localStorage.clear())
afterEach(async () => {
  for (const assembly of opened.splice(0)) await assembly.dispose()
  localStorage.clear()
})

async function signIn(
  factory: IDBFactory,
  syncBoundaryId: string,
  api: PodiumClientApi = {} as PodiumClientApi,
) {
  const principal = principalOf(syncBoundaryId)
  const assembly = await openKernelAssembly({
    trpc: api as never,
    principal,
    factory: factory as never,
    evidence: { kind: 'single-account', principal },
    broadcastChannelFactory: () => ({ onmessage: null, postMessage() {}, close() {} }),
    transcripts: webTranscriptDatabases(factory as never, IDBKeyRange as never),
  })
  opened.push(assembly)
  const replica = assembly.createReplicaFn(assembly.principal)
  const transcripts = (assembly as KernelAssembly & { transcripts?: TranscriptStore }).transcripts
  if (!transcripts) throw new Error('the web assembly opened no chat history')
  return { principal, assembly, replica, transcripts }
}

async function signOut(session: Awaited<ReturnType<typeof signIn>>) {
  await session.assembly.store.settled()
  await session.transcripts.settled()
  opened.splice(opened.indexOf(session.assembly), 1)
  await session.assembly.dispose()
}

describe('web: signing in to workspace A, then B, on one browser', () => {
  it.each([
    'writes',
    'drafts',
    'writes and drafts',
  ] as const)('keeps %s in five workspaces and sends them on return', async (work) => {
    const device = new IDBFactory()
    const workspaces = Array.from({ length: 5 }, (_, index) => ({
      boundary: `ws-${index}`,
      sessionId: asSessionId(`session-${index}`),
      mutationId: asMutationId(`write-${index}`),
      server: recordingApi(),
    }))
    for (const workspace of workspaces) {
      const session = await signIn(device, workspace.boundary, workspace.server.api)
      session.assembly.store.viewFor(session.principal).cache.applyAtomic({
        operations: [
          {
            kind: 'upsert',
            entity: 'issueProjection',
            entityId: workspace.boundary,
            value: { id: workspace.boundary, title: workspace.boundary, status: 'open' },
            provenance: { seq: 1, originId: 'o', causationId: 'c', mutationId: asMutationId('m') },
          },
        ],
        cursor: { feedId: 'feed', epoch: 'e1', seq: 1 },
      })
      if (work.includes('drafts')) {
        const drafts = new DraftStore({
          storage: openLegacyDeviceKeys(session.replica.deviceStorage()),
          hub: { on: () => () => {}, sendDraftEdit: () => false },
        })
        drafts.set(workspace.sessionId, `Unsent draft in ${workspace.boundary}`)
        drafts.dispose()
      }
      if (work.includes('writes')) {
        const queue = session.assembly.createOutboxFn({
          api: workspace.server.api,
          replica: session.replica,
          notices,
          isOnline: () => false,
        })
        await queue.enqueue(
          'dismissOffer',
          { sessionId: workspace.sessionId, offerCreatedAt: '2026-11-23T00:00:00.000Z' },
          { mutationId: workspace.mutationId },
        )
        queue.dispose()
      }
      await signOut(session)
      expect(workspace.server.sent).toEqual([])
    }
    for (const workspace of workspaces) {
      const session = await signIn(device, workspace.boundary, workspace.server.api)
      expect(session.replica.rows('issueProjections').map((row) => row.id)).toEqual([
        workspace.boundary,
      ])
      if (work.includes('drafts')) {
        const sentDrafts: unknown[] = []
        const drafts = new DraftStore({
          storage: openLegacyDeviceKeys(session.replica.deviceStorage()),
          hub: {
            on: () => () => {},
            sendDraftEdit: (...args) => {
              sentDrafts.push(args)
              return true
            },
          },
        })
        expect(drafts.get(workspace.sessionId)).toBe(`Unsent draft in ${workspace.boundary}`)
        drafts.flushDirty()
        expect(sentDrafts).toEqual([
          [workspace.sessionId, 0, `Unsent draft in ${workspace.boundary}`],
        ])
        drafts.dispose()
      }
      if (work.includes('writes')) {
        const queue = session.assembly.createOutboxFn({
          api: workspace.server.api,
          replica: session.replica,
          notices,
          isOnline: () => true,
        })
        expect(queue.pending().map((entry) => entry.mutationId)).toEqual([workspace.mutationId])
        await queue.drain()
        await vi.waitFor(async () =>
          expect(await session.assembly.store.viewFor(session.principal).outbox.read()).toEqual([]),
        )
        expect(workspace.server.sent).toEqual([
          expect.objectContaining({
            mutationId: workspace.mutationId,
            command: 'sessions.dismissOffer',
            input: expect.objectContaining({ sessionId: workspace.sessionId }),
          }),
        ])
        queue.dispose()
      }
      await signOut(session)
    }
  })

  it('shows and sends nothing of A in B, and finds all of A again on the way back', async () => {
    const device = new IDBFactory()

    // WORKSPACE A: a record, a draft, an unsent write, a chat history.
    const a = await signIn(device, 'ws-a')
    a.assembly.store.viewFor(a.principal).cache.applyAtomic({
      operations: [
        {
          kind: 'upsert',
          entity: 'issueProjection',
          entityId: 'issue-a',
          value: { id: 'issue-a', title: 'A private work', status: 'open' },
          provenance: { seq: 1, originId: 'o', causationId: 'c', mutationId: asMutationId('m') },
        },
      ],
      cursor: { feedId: 'feed-a', epoch: 'e1', seq: 1 },
    })
    openLegacyDeviceKeys(a.replica.deviceStorage()).set(DRAFT_KEY, '{"s1":"A draft"}')
    const queueA = a.assembly.createOutboxFn({
      api: recordingApi().api,
      replica: a.replica,
      notices,
      isOnline: () => false,
    })
    await queueA.enqueue('dismissOffer', {
      sessionId: asSessionId('s1'),
      offerCreatedAt: '2026-11-23T00:00:00.000Z',
    })
    queueA.dispose()
    await a.transcripts.put('s1', {
      upsert: [{ id: 'a1', seq: 0, json: '{"id":"a1","role":"user","text":"A chat"}' }],
    })
    expect(a.replica.rows('issueProjections').map((row) => row.id)).toEqual(['issue-a'])
    await signOut(a)

    // WORKSPACE B, same member id, same browser.
    const b = await signIn(device, 'ws-b')
    expect(b.principal).not.toBe(a.principal)
    expect(b.replica.rows('issueProjections')).toEqual([])
    expect(b.replica.getCursor()).toBeNull()
    expect((await b.replica.hydrate()).issueProjections).toEqual([])
    expect(openLegacyDeviceKeys(b.replica.deviceStorage()).get(DRAFT_KEY)).toBeNull()
    expect((await b.transcripts.readNewest('s1', 50)).messages).toEqual([])
    // B's queue, online, holds nothing of A's and sends nothing.
    const sentInB = recordingApi()
    const queueB = b.assembly.createOutboxFn({
      api: sentInB.api,
      replica: b.replica,
      notices,
      isOnline: () => true,
    })
    queueB.attach()
    expect(queueB.pending()).toEqual([])
    expect(queueB.deadLetters()).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sentInB.sent).toEqual([])
    queueB.dispose()
    // No key of A's root is readable under B's root.
    const rootB = b.replica.deviceStorage().keyPrefix
    const rootA = a.replica.deviceStorage().keyPrefix
    expect(rootB).not.toBe(rootA)
    await signOut(b)

    // THE COUNTERFACTUAL: back in A, everything is where A left it.
    const again = await signIn(device, 'ws-a')
    expect(again.replica.rows('issueProjections').map((row) => row.id)).toEqual(['issue-a'])
    expect(again.replica.getCursor()).toBe(1)
    expect(openLegacyDeviceKeys(again.replica.deviceStorage()).get(DRAFT_KEY)).toBe(
      '{"s1":"A draft"}',
    )
    expect((await again.transcripts.readNewest('s1', 50)).messages).toHaveLength(1)
    const queueAgain = again.assembly.createOutboxFn({
      api: recordingApi().api,
      replica: again.replica,
      notices,
      isOnline: () => false,
    })
    expect(queueAgain.pending()).toHaveLength(1)
    queueAgain.dispose()
  })
})

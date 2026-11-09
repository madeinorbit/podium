import { MobileConversation } from '../lib/mobile-conversation'
import { here } from '@podium/client-graph/lookup'
import { MobileChatViewModel } from '../lib/chat-view-model'
import { superagentWrites } from '../lib/superagent-writes'
import { hubConnection, PHONE_WARM_CONVERSATIONS } from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import { transcriptCacheFor } from '@podium/client-core/transcript-store'
import { useConversation, useStoreHandle } from '@podium/client-core/react'
import { superagentState } from '@podium/client-graph/superagent'
import { asSessionId, asThreadId, type SessionId } from '@podium/model'
import { action, observable, reaction } from 'mobx'
import { useEffect, useMemo } from 'react'
import { AppState } from 'react-native'
import { humanizeSendFailure } from '../lib/send-failure'
import { superagentTurnChoice, resolveSuperagentBackend } from '../lib/superagent-backend'
import { useMobilePool } from './mobile-pool'
import type { MobileTrpc } from './trpc'

const THREAD_ID = asThreadId('global')
const CONVERSATION_ID = asSessionId('superagent:global')
class ThreadBinding {
  @observable accessor acked: SessionId | undefined = undefined
  @observable accessor cleared: SessionId | undefined = undefined
}
// Runtime service identity; only acknowledged routing facts live here.
const bindings = new WeakMap<object, ThreadBinding>()

/** Thread identity stays stable when its first send learns the headless session. */
export function useThreadConversation() {
  const owner = useStoreHandle<MobileTrpc>()
  const pool = useMobilePool()
  let binding = bindings.get(owner)
  if (!binding) { binding = new ThreadBinding(); bindings.set(owner, binding) }
  const thread = binding
  const readSid = () => {
    const published = pool ? superagentState(pool).activeSessionId : undefined
    return thread.acked ?? (published === thread.cleared ? undefined : published)
  }
  const conversation = useConversation(
    CONVERSATION_ID,
    (drafts) => new MobileConversation({
      sessionId: CONVERSATION_ID,
      drafts: { get: id => pool!.sessionObject(id).messageDraft, set: (id, text) => pool!.sessionObject(id).setMessageDraft(text) },
      headless: true,
      streamSessionId: readSid,
      readSession: () => (pool && readSid() ? here(pool.model('session', readSid()!)) : undefined),
      readTurnRunning: () => (pool ? superagentState(pool).active?.turnRunning : undefined),
      initialTurnRunning: pool ? superagentState(pool).active?.turnRunning : false,
      hub: owner.hub,
      connection: hubConnection(owner.hub),
      // The last failure is status on the thread's synced record (POD-6675).
      readTurnFailure: () =>
        pool && readSid() ? (superagentState(pool).active?.lastTurnFailure ?? null) : null,
      scheduler: {
        visible: () =>
          AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
        onVisibilityChange: (listener) => {
          const subscription = AppState.addEventListener('change', listener)
          return () => subscription.remove()
        },
      },
      transcript: {
        initialLimit: 80,
        pageLimit: 80,
        source: {
          read: (request) => {
            const sid = readSid()
            return sid
              ? owner.access.trpc.sessions.transcriptRead.query({ ...request, sessionId: sid })
              : Promise.resolve({ items: [], hasMore: false })
          },
          subscribe: (_id, since, listener) => {
            let off = () => {},
              generation = 0,
              first = true
            const stop = reaction(
              readSid,
              (sid) => {
                off()
                const current = ++generation
                if (!sid) {
                  listener([], { reset: true })
                  first = false
                  return
                }
                const transcript = owner.hub.subscribeTranscript(
                  sid,
                  first ? since : undefined,
                  listener,
                )
                off = transcript
                if (!first)
                  void owner.access.trpc.sessions.transcriptRead
                    .query({ sessionId: sid, direction: 'before', limit: 80 })
                    .then((page) => {
                      if (generation === current) listener(page.items, { reset: true })
                    })
                    .catch(() => {})
                first = false
              },
              { fireImmediately: true },
            )
            return () => {
              generation++
              stop()
              off()
            }
          },
        },
        ...(owner.replica.transcripts
          ? { cache: transcriptCacheFor(owner.replica.transcripts, readSid) }
          : {}),
      },
      sends: {
        reconcile: 'next-user-item',
        createDeliveryId: () => `msg_${randomUUID()}`,
        deliver: async (turn) => {
          try {
            const ack = await superagentWrites(owner.access.trpc).sendTurn.mutate({
              threadId: THREAD_ID,
              text: turn.wire,
              ...superagentTurnChoice(resolveSuperagentBackend(pool ? superagentState(pool).active : undefined, turn.backend ?? {})),
            })
            if (ack?.podiumSessionId)
              action(() => {
                thread.acked = ack.podiumSessionId
              })()
          } catch (error) {
            throw new Error(humanizeSendFailure(error))
          }
        },
        interrupt: () =>
          superagentWrites(owner.access.trpc)
            .interruptTurn.mutate({ threadId: THREAD_ID })
            .then(() => {}),
      },
    }, { collapseContext: true }),
    {
      warmLimit: PHONE_WARM_CONVERSATIONS,
      enabled: pool !== null && !superagentState(pool).loading,
    },
  )
  const view = useMemo(() => conversation && pool
    ? new MobileChatViewModel(conversation, pool, (choice) => {
        const thread = superagentState(pool).active
        if (thread) void owner.access.setSuperagentBackend(thread.id, choice).catch(() => {})
      })
    : undefined, [conversation, owner, pool])
  useEffect(() => view?.open(), [view])
  const podiumSid = readSid()
  return { conversation: view, podiumSid, binding: thread }
}

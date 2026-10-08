import { MobileConversation } from '../lib/mobile-conversation'
import { sessionPaneView } from '@podium/client-graph/session-pane'
import { hubConnection, PHONE_WARM_CONVERSATIONS } from '@podium/client-core/conversation'
import { randomUUID } from '@podium/client-core/id'
import { REPLICA_TRANSCRIPT_ITEM_CAP } from '@podium/client-core/replica'
import { useConversation, useStoreHandle } from '@podium/client-core/react'
import { superagentState } from '@podium/client-graph/superagent'
import { asSessionId, asThreadId, type SessionId } from '@podium/model'
import { action, observable, reaction } from 'mobx'
import { useEffect } from 'react'
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
export function useThreadConversation(
  history: { following: boolean; searching: boolean },
) {
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
      drafts,
      headless: true,
      streamSessionId: readSid,
      readSession: () => (pool ? sessionPaneView(pool).session(readSid()) : undefined),
      readTurnRunning: () => (pool ? superagentState(pool).active?.turnRunning : undefined),
      initialTurnRunning: pool ? superagentState(pool).active?.turnRunning : false,
      hub: owner.hub,
      connection: hubConnection(owner.hub),
      latestTurnFailure: () =>
        readSid()
          ? owner.access.trpc.superagent.latestTurnFailure.query({ threadId: THREAD_ID })
          : Promise.resolve(null),
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
        cache: {
          maxItems: REPLICA_TRANSCRIPT_ITEM_CAP,
          read: () => {
            const sid = readSid()
            return sid ? owner.replica.transcriptWindow(sid) : undefined
          },
          write: (_id, items) => {
            const sid = readSid()
            if (sid) owner.replica.putTranscriptWindow(sid, [...items])
          },
        },
      },
      sends: {
        reconcile: 'next-user-item',
        createDeliveryId: () => `msg_${randomUUID()}`,
        deliver: async (turn) => {
          try {
            const ack = await owner.access.trpc.superagent.sendTurn.mutate({
              threadId: THREAD_ID,
              text: turn.wire,
              ...(turn.backend ?? superagentTurnChoice(resolveSuperagentBackend(pool ? superagentState(pool).active : undefined, {}))),
            })
            if (ack?.podiumSessionId)
              action(() => {
                thread.acked = ack.podiumSessionId
              })()
            void owner.access.refreshSuperThreads().catch(() => {})
          } catch (error) {
            throw new Error(humanizeSendFailure(error))
          }
        },
        interrupt: () =>
          owner.access.trpc.superagent.interruptTurn.mutate({ threadId: THREAD_ID }).then(() => {}),
      },
    }, { collapseContext: true }),
    {
      warmLimit: PHONE_WARM_CONVERSATIONS,
      enabled: pool !== null && !superagentState(pool).loading,
    },
  )
  useEffect(() => conversation?.addReader(() => !history.following || history.searching), [conversation, history])
  const podiumSid = readSid()
  return { conversation, podiumSid, binding: thread }
}

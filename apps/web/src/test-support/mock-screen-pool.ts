import type { Store } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph'
import { createChatContextReader } from '@podium/client-graph/chat-context'
import { createSettingsViews } from '@podium/client-graph/settings-views'
import { settingsRepositoryId } from '@podium/client-graph/settings-schema'
import { compareStructural } from 'mobx'
import { useMemo, useRef, useSyncExternalStore } from 'react'
import { vi } from 'vitest'
import * as storeInputs from '@/app/store'

type Inputs = Partial<Store> & {
  issues?: Store['issueProjections']
  chatSendsFor?: Store['chatSendsFor']
}
const none = () => () => {}
let borrowed: { read(): Inputs; subscribe(wake: () => void): () => void } = {
  read: () => ({}),
  subscribe: none,
}
const useFixtureIssues = 'useReplicaIssues' in storeInputs ? storeInputs.useReplicaIssues : () => []

/** Provider-free component suites supply already-loaded, synthetic rows.
 * Production reader, batching and lifecycle coverage uses the real-provider
 * pool suites; this opt-in fixture never changes that provider contract. */
export function borrowPoolFixtureInputs(
  read: () => Inputs,
  subscribe: (wake: () => void) => () => void,
) {
  borrowed = { read, subscribe }
}

function useFixturePool(): MobxPool {
  const state = storeInputs.useStoreSelector((value) => value) as Inputs
  const issues = useFixtureIssues()
  const live = useRef({ state, issues })
  live.current = { state: { ...state, ...borrowed.read() }, issues }
  const notifications = useMemo(() => {
    let version = 0
    return {
      getSnapshot: () => version,
      subscribe(wake: () => void) {
        const update = () => {
          version++
          wake()
        }
        const stopBorrowed = borrowed.subscribe(update)
        const stopUi = state.uiState?.subscribe?.(update)
        return () => {
          stopBorrowed()
          stopUi?.()
        }
      },
    }
  }, [state.uiState])
  useSyncExternalStore(notifications.subscribe, notifications.getSnapshot)
  return useMemo(() => {
    const current = () => live.current.state
    const sessions = () => current().sessions ?? []
    const machines = () => current().machines ?? []
    const messages = () => current().messageRecords ?? []
    const interactions = () => current().pendingInteractions ?? []
    const threads = () => current().superThreads ?? []
    const repos = () => current().repos ?? []
    const pool = {
      row(entity: string, id: string): unknown {
        switch (entity) {
          case 'session':
            return sessions().find((row) => row.sessionId === id)
          case 'setupSession': {
            const setupOrder = sessions().findIndex((row) => row.sessionId === id)
            return setupOrder < 0 ? undefined : { ...sessions()[setupOrder], setupOrder }
          }
          case 'issue':
            return live.current.issues.find((row) => row.id === id)
          case 'repo':
            return repos().find((row) => row.repoId === id)
          case 'machine':
          case 'settingsMachine':
            return machines().find((row) => row.id === id)
          case 'repository':
            return repos().find((row) => row.path === id)
          case 'settingsRepository':
            return repos().find((row) => settingsRepositoryId(row) === id)
          case 'settingsCatalog':
            return {
              machines: machines().map((row) => row.id),
              repositories: repos().map(settingsRepositoryId),
            }
          case 'settingsWindow':
            return { settingsTab: current().settingsTab ?? 'sessions' }
          case 'preference':
            return { value: current().uiState?.get(id) ?? null }
          case 'sessionExit':
            return { kind: current().replica?.exitKind?.('session', id) }
          case 'chatContextReader':
            return reader
          case 'chatDraft':
            return { text: current().drafts?.[id] ?? '' }
          case 'chatHeld':
            return { sends: current().chatSendsFor?.(id as never) ?? [] }
          case 'chatWindow':
            return {
              attachedSessionId: current().attachedSessionId ?? null,
              transcriptReveal: current().transcriptReveal ?? null,
            }
          case 'chatRecordOrder':
            return { ids: messages().map((row) => row.id) }
          case 'chatIssueOrder':
            return { ids: live.current.issues.map((row) => row.id) }
          case 'chatSessionOrder':
            return { ids: sessions().map((row) => row.sessionId) }
          case 'messageRecord':
            return messages().find((row) => row.id === id)
          case 'pendingInteraction':
            return interactions().find((row) => row.id === id)
          case 'noticeSession':
            return {
              messages: messages()
                .filter((row) => row.sessionId === id)
                .map((row) => row.id),
              interactions: interactions()
                .filter((row) => row.sessionId === id)
                .map((row) => row.id),
            }
          case 'noticeCatalog':
            return {
              messages: messages().map((row) => row.id),
              interactions: interactions().map((row) => row.id),
              deadLetters: [],
            }
          case 'superThread':
            return threads().find((row) => row.id === id)
          case 'superThreadCatalog':
            return { ids: threads().map((row) => row.id) }
          case 'superagentLocal':
            return {
              superThreadId: current().superThreadId,
              paneA: current().paneA,
              selectedWorktree: current().selectedWorktree,
              booting: false,
            }
          case 'superagentQuestionOrder':
            return { ids: interactions().map((row) => row.id) }
          case 'superagentEvent':
            return current().issueEvents?.find((row) => row.id === id)
          case 'superagentEventTail':
            return {
              ids: [...(current().issueEvents ?? [])]
                .sort((a, b) => a.eventId - b.eventId)
                .slice(-40)
                .map((row) => row.id),
            }
          case 'superagentReadPosition':
            return current().readPosition?.get('issueEvents') ?? { lastEventId: 0, seenAt: null }
          default:
            throw new Error(`Undeclared component fixture row: ${entity}`)
        }
      },
      queries: {
        ids: ({ kind }: { kind: string }) =>
          kind === 'mentionIssues'
            ? live.current.issues.map((row) => row.id)
            : sessions().map((row) => row.sessionId),
      },
      relations: {
        one(entity: string, id: string, name: string) {
          if (entity === 'issue' && name === 'repo')
            return live.current.issues.find((row) => row.id === id)?.repoId
          if (entity === 'session' && name === 'pageIssue')
            return live.current.issues.find((row) => row.memberSessionIds?.includes(id as never))
              ?.id
          return undefined
        },
      },
      header: {
        get orders() {
          return new Map([
            ['machine', machines().map((row) => row.id)],
            ['repository', repos().map((row) => row.path)],
          ])
        },
      },
      sessionPanes: {
        session: (id: string) => sessions().find((row) => row.sessionId === id),
        machines,
      },
    } as unknown as MobxPool
    const reader = createChatContextReader(pool)
    Object.assign(pool, { settingsViews: createSettingsViews(pool) })
    return pool
  }, [])
}

vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: useFixturePool,
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T) {
    const next = read(useFixturePool())
    const previous = useRef<{ value: T } | null>(null)
    if (!previous.current || !compareStructural(previous.current.value, next))
      previous.current = { value: next }
    return previous.current.value
  },
}))

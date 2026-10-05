import { allIssueViewModels } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import type { IssueViewModel } from '@podium/client-graph/diagnostics/reference/issue-view-models'
import type { SliceSession } from '@podium/client-graph/shared/slice-types'
import type { SidebarSections } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { normalizedFixtureIssues } from './normalized-issues'
import { isDeepStrictEqual } from 'node:util'
import type { ReferenceState } from '@podium/client-graph/diagnostics/reference-state'
// Older provider-free fixtures carry saved documents as plain test data.
type Store = ReferenceState & { drafts?: Record<string, string> }
import type { MobxPool } from '@podium/client-graph'
import { createChatContextReader } from '@podium/client-graph/chat-context'
import { settingsRepositoryId } from '@podium/client-graph/settings-schema'
import { isMessageRecordAttention } from '@podium/model'
import { createRepositoryUsageSelector, isSessionWorking, resolveDefaultAgent } from '@podium/client-core/values'
import { createSettingsViews } from '@podium/client-graph/settings-views'
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { computed, observable, reaction, runInAction } from 'mobx'
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
const selectFixture = storeInputs.useRuntimeSelector as unknown as <T>(select: (state: Store) => T, equals?: (a: T, b: T) => boolean) => T
const useFixtureIssues = () => selectFixture(state => state.replica && state.issueProjections
  ? allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates ?? [])
  : normalizedFixtureIssues(state), isDeepStrictEqual)
const selectInputs = (state: Store): Inputs => ({
  sessions: state.sessions,
  machines: state.machines,
  repos: state.repos,
  drafts: state.drafts,
  attachedSessionId: state.attachedSessionId,
  transcriptReveal: state.transcriptReveal,
  messageRecords: state.messageRecords,
  pendingInteractions: state.pendingInteractions,
  superThreads: state.superThreads,
  superThreadId: state.superThreadId,
  paneA: state.paneA,
  selectedWorktree: state.selectedWorktree,
  issueEvents: state.issueEvents,
  readPosition: state.readPosition,
  uiState: state.uiState,
  replica: state.replica,
  chatSendsFor: state.chatSendsFor,
  settingsTab: state.settingsTab,
})

/** Provider-free component suites supply already-loaded, synthetic rows.
 * Production reader, batching and lifecycle coverage uses the real-provider
 * pool suites; this opt-in fixture never changes that provider contract. */
export function borrowPoolFixtureInputs(
  read: () => Inputs,
  subscribe: (wake: () => void) => () => void,
) {
  borrowed = { read, subscribe }
}

/**
 * The sidebar the pool component reads, over the fixture's normalized issue
 * view models (POD-5566). Open rows follow the pool's rank order (spec
 * R-ORDER: manual key first, then newest-created first); pinned rows move out
 * into the flat pinned section whatever their fold verdict. The fixture only
 * carries open rows: nothing here is snoozed or closed.
 */
function fixtureSidebarRow(
  model: IssueViewModel,
  members: readonly SliceSession[],
): SidebarRowValues {
  const record = model as unknown as Record<string, unknown>
  const sessions = [...members]
  return {
    idNumber: typeof record['seq'] === 'number' ? record['seq'] : 0,
    color: typeof record['color'] === 'string' ? record['color'] : null,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    timing: {
      phase: 'queued',
      sinceMs: Date.parse(
        typeof record['updatedAt'] === 'string'
          ? record['updatedAt']
          : typeof record['createdAt'] === 'string'
            ? record['createdAt']
            : '',
      ) || 0,
    },
    working: sessions.some((session) => {
      try {
        return isSessionWorking(session as never)
      } catch {
        return false
      }
    }),
    asking: false,
    originTick: null,
    decision: null,
    mergeCommits: 0,
    progress: { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
    fromChildren: false,
    statusFromChildren: false,
    gitState: record['gitState'] as SidebarRowValues['gitState'],
    unread: record['unread'] === true,
    errorClass: null,
    internal: record['audience'] === 'agent',
    unsnoozed: false,
    deferred: record['deferred'] === true,
    awaitsTuck: false,
    canBringBack: false,
    draftAgentOnly: false,
    firstSessionId: sessions[0]?.sessionId ?? null,
    continuation: null,
    fleet: { total: 0, parkedCount: 0, nativeCount: 0, tiles: [] },
    issue: model as unknown as SidebarRowValues['issue'],
    sessions,
    aggregateSessionIds: [],
    awaitingFirstPrompt: false,
  }
}

function compareFixtureSidebarOrder(a: IssueViewModel, b: IssueViewModel): number {
  const recordOf = (model: IssueViewModel) => model as unknown as Record<string, unknown>
  const keyOf = (model: IssueViewModel) => {
    const sortKey = recordOf(model)['sortKey']
    return typeof sortKey === 'string' && sortKey ? sortKey : null
  }
  const aKey = keyOf(a)
  const bKey = keyOf(b)
  if (aKey !== null || bKey !== null) {
    if (aKey === null) return 1
    if (bKey === null) return -1
    if (aKey !== bKey) return aKey < bKey ? -1 : 1
  }
  const createdOf = (model: IssueViewModel) => {
    const createdAt = recordOf(model)['createdAt']
    return typeof createdAt === 'string' ? Date.parse(createdAt) || 0 : 0
  }
  const created = createdOf(b) - createdOf(a)
  if (created !== 0) return created
  const seqOf = (model: IssueViewModel) => {
    const seq = recordOf(model)['seq']
    return typeof seq === 'number' ? seq : 0
  }
  const seq = seqOf(b) - seqOf(a)
  if (seq !== 0) return seq
  return a.id.localeCompare(b.id)
}

function fixtureSidebarSections(models: readonly IssueViewModel[]): SidebarSections {
  const pinnedIds = models.filter((model) => model.pinned).map((model) => model.id)
  const bands = new Map<string, { label: string; repoPath: string; rowIds: string[] }>()
  for (const model of [...models].filter((model) => !model.pinned).sort(compareFixtureSidebarOrder)) {
    const key = model.repoId ?? model.repoPath
    let band = bands.get(key)
    if (!band) {
      band = { label: model.repoPath.split('/').pop() || model.repoPath, repoPath: model.repoPath, rowIds: [] }
      bands.set(key, band)
    }
    band.rowIds.push(model.id)
  }
  return {
    pinnedIds,
    pinnedCollapsed: false,
    pinnedFoldKey: 'podium:sidebar:pinned-fold',
    bands: [...bands].map(([key, band]) => ({
      key,
      label: band.label,
      aliases: [key],
      repoPath: band.repoPath,
      rowIds: band.rowIds,
      worktreeIds: [],
      snoozedIds: [],
      closedIds: [],
      collapsed: false,
      snoozedCollapsed: true,
      closedCollapsed: true,
      foldKey: `podium:sidebar:project-fold:${key}`,
      snoozedFoldKey: `podium:sidebar:snoozed-fold:${key}`,
      closedFoldKey: `podium:sidebar:closed-fold:${key}`,
      startFirstTask: false,
    })),
  }
}

function useFixturePool(): MobxPool {
  const state = selectFixture(selectInputs, isDeepStrictEqual)
  const issues = useFixtureIssues()
  const live = useRef({ state, issues })
  const input = { state: { ...state, ...borrowed.read() }, issues }
  const signal = useMemo(() => observable.box(input, { deep: false }), [])
  live.current = input
  useLayoutEffect(() => {
    if (!isDeepStrictEqual(signal.get(), input)) runInAction(() => signal.set(input))
  })
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
    const current = () => signal.get().state
    const sessions = () => current().sessions ?? []
    const machines = () => current().machines ?? []
    const messages = () => current().messageRecords ?? []
    const interactions = () => current().pendingInteractions ?? []
    const threads = () => current().superThreads ?? []
    const repos = () => current().repos ?? []
    const pool = {
      notSaved: () => false,
      selection: {
        has: (_id: string) => false,
        keys: (): IterableIterator<string> => [][Symbol.iterator](),
        size: 0,
      },
      clock: {
        current: Date.now(),
        reached: (_at: number) => true,
        passed: (_at: number) => true,
      },
      sidebar: {
        sections: (): SidebarSections => fixtureSidebarSections(live.current.issues),
        row: (id: string): SidebarRowValues | undefined => {
          const model = live.current.issues.find((row) => row.id === id)
          if (!model) return undefined
          const members = (model.memberSessionIds ?? [])
            .map((sessionId) => sessions().find((row) => row.sessionId === sessionId))
            .filter((row) => row !== undefined) as unknown as SliceSession[]
          return fixtureSidebarRow(model, members)
        },
        selectionEvicted: () => false,
        worktree: (_path: string) => undefined,
      },
      row(entity: string, id: string): unknown {
        switch (entity) {
          case 'session':
            return sessions().find((row) => row.sessionId === id)
          case 'setupSession': {
            const setupOrder = sessions().findIndex((row) => row.sessionId === id)
            return setupOrder < 0 ? undefined : { ...sessions()[setupOrder], setupOrder }
          }
          case 'issue':
            return signal.get().issues.find((row) => row.id === id)
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
            return { ids: signal.get().issues.map((row) => row.id) }
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
          case 'noticeAttention': {
            const attention = messages().filter(row => isMessageRecordAttention(row.status))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
            return { count: attention.length, newest: attention[0]?.id }
          }
          case 'noticeMessageCatalog':
            return { messages: messages().filter(row => isMessageRecordAttention(row.status)).map(row => row.id) }
          case 'noticeRecoveryCatalog':
            return { deadLetters: [] }
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
        setupDefaultAgent: () => resolveDefaultAgent(undefined, sessions()),
        setupSessionCount: () => sessions().length,
        setupSessionPresent: (id: string) => sessions().some(row => row.sessionId === id),
        activity: (question: Parameters<MobxPool['queries']['activity']>[0]) => {
          const usage = createRepositoryUsageSelector()(sessions())
          return Math.max(0, ...question.roots.map(path => usage.get(path) ?? 0))
        },
        ids: ({ kind }: { kind: string }) =>
          kind === 'mentionIssues'
            ? signal.get().issues.map((row) => row.id)
            : sessions().map((row) => row.sessionId),
      },
      relations: {
        one(entity: string, id: string, name: string) {
          if (entity === 'issue' && name === 'repo')
            return signal.get().issues.find((row) => row.id === id)?.repoId
          if (entity === 'session' && name === 'pageIssue')
            return signal.get().issues.find((row) => row.memberSessionIds?.includes(id as never))
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
    const pool = useFixturePool()
    const selected = useMemo(() => computed(() => read(pool), { equals: isDeepStrictEqual }), [pool, read])
    const source = useMemo(() => {
      let current = selected.get()
      return {
        subscribe: (wake: () => void) => reaction(() => selected.get(), wake),
        getSnapshot: () => {
          const next = selected.get()
          if (!isDeepStrictEqual(current, next)) current = next
          return current
        },
      }
    }, [selected])
    return useSyncExternalStore(source.subscribe, source.getSnapshot)
  },
}))

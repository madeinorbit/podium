import { issuePages } from '@podium/client-graph/issue-page'
import { boardCards } from '@podium/client-graph/issue-board-cards'
import { ISSUE_BOARD_ENTITIES } from '@podium/client-graph/issue-board-schema'
import { syncPoolFixture } from './pool-fixture'
import { omitGone } from '@podium/client-graph/lookup'
import { allIssueViewModels } from '../../../../tests/worklist/diagnostics/reference/issue-view-models'
import type { IssueViewModel } from '../../../../tests/worklist/diagnostics/reference/issue-view-models'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { compareRank, type RowRank } from '@podium/client-graph/shared/row-view'
import { issueAbandoned } from '@podium/client-graph/shared/predicates'
import { bandOf, closedOf, displayTitleOf, foldAtOf, ownPartOfRow, rankOfPart } from '@podium/client-graph/views'
import { fleetOf, sidebarLifecycle } from '@podium/client-graph/worklist/sidebar-row'
import type { SidebarSections } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { poolFixtureIssues } from './pool-issue-fixture'
import { isDeepStrictEqual } from 'node:util'
import type { ReferenceState } from '../../../../tests/worklist/diagnostics/reference-state'
// Older provider-free fixtures carry saved documents as plain test data.
type Store = ReferenceState & { drafts?: Record<string, string> }
import type { MobxPool } from '@podium/client-graph'
import { createChatContextReader } from '@podium/client-graph/chat-context'
import { settingsRepositoryId } from '@podium/client-graph/settings-schema'
import { isExcluded, isFinished, isMessageRecordAttention } from '@podium/model'
import {
  createRepositoryUsageSelector,
  isSessionWorking,
  resolveDefaultAgent,
  rowMotionTiming,
  rowPendingDecision,
  type UnifiedIssueRow,
} from '@podium/client-core/values'
import { settingsView } from '@podium/client-graph/settings-views'
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { computed, observable, reaction, runInAction } from 'mobx'
import { afterEach, vi } from 'vitest'
import * as storeInputs from '@/app/store'

/** Every mounted hand-mock pool's waker: a mid-flight store mutation (an
 * evicted issue leaving) wakes them all, since the memo'd pool components
 * only re-read their fixture then. */
const screenPoolWakers = new Set<() => void>()

/** Wake every mounted hand-mock pool after the suite mutates its fake store
 * mid-flight (eviction removes the row, then this, then a rerender). */
export function publishScreenPoolFixture(): void {
  for (const wake of [...screenPoolWakers]) wake()
}

afterEach(() => {
  screenPoolWakers.clear()
})

type Inputs = Partial<Store> & {
  openIssueId?: string | null
  issues?: Store['issueProjections']
  chatSendsFor?: Store['chatSendsFor']
  /** The gesture context the suite declares for its selection (R-GROUP 5):
   * true when the row was folded when clicked, false/undefined otherwise. */
  selectedIssueWasFolded?: boolean | null
}
const none = () => () => {}
let borrowed: { read(): Inputs; subscribe(wake: () => void): () => void } = {
  read: () => ({}),
  subscribe: none,
}
const selectFixture = storeInputs.useRuntimeSelector as unknown as <T>(select: (state: Store) => T, equals?: (a: T, b: T) => boolean) => T
const useFixtureIssues = () => selectFixture(state => state.replica && state.issueProjections
  ? allIssueViewModels(state.replica, state.issueProjections, state.issueUserStates ?? [])
  : poolFixtureIssues(state), isDeepStrictEqual)
const selectInputs = (state: Store): Inputs => ({
  openIssueId: (state as Inputs).openIssueId,
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
  selectedIssueId: state.selectedIssueId,
  selectedIssueWasFolded: (state as unknown as Inputs).selectedIssueWasFolded,
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
 * One sidebar row over the fixture's normalized issue view models (POD-5566).
 * Open rows follow the pool's rank order (spec R-ORDER: manual key first,
 * then newest-created first); pinned rows move out into the flat pinned
 * section whatever their fold verdict. Row lifecycle (tuck/snooze), motion
 * timing, pending decisions and child-derived progress come from the real
 * verdicts, so the hand mock reads exactly what the pool reads.
 */
function fixtureSidebarRow(
  model: IssueViewModel,
  members: readonly SliceSession[],
  allModels: readonly IssueViewModel[],
  allSessions: readonly SliceSession[],
): SidebarRowValues {
  const record = model as unknown as Record<string, unknown>
  const issue = model as unknown as SliceIssue
  const sessions = [...members]
  // The tuck/snooze lifecycle comes from the real verdicts (sidebar-row
  // `sidebarLifecycle`), so the hand mock folds exactly what the pool folds.
  const now = Date.now()
  const reached = (at: number): boolean => now >= at
  const passed = (at: number): boolean => now > at
  const cycle = sidebarLifecycle(issue, false, passed, reached)
  // Descendant sessions bubble to the mission root: the column draws one flat
  // row per mission, and the fleet stack speaks for the whole branch.
  const descended = new Set<string>([model.id as string])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of allModels) {
      const parent = (row as unknown as Record<string, unknown>)['parentId']
      if (
        typeof parent === 'string' &&
        descended.has(parent) &&
        !descended.has(row.id as string)
      ) {
        descended.add(row.id as string)
        grew = true
      }
    }
  }
  const sessionIdOf = (session: SliceSession): string =>
    (session as unknown as Record<string, unknown>)['sessionId'] as string
  const aggregate = [...sessions]
  for (const session of allSessions) {
    const owner = (session as unknown as Record<string, unknown>)['issueId']
    if (
      typeof owner === 'string' &&
      descended.has(owner) &&
      !aggregate.some((member) => sessionIdOf(member) === sessionIdOf(session))
    )
      aggregate.push(session)
  }
  const legacy: UnifiedIssueRow = {
    kind: 'issue',
    issue: model as unknown as UnifiedIssueRow['issue'],
    sessions: sessions as unknown as UnifiedIssueRow['sessions'],
    aggregateSessions: aggregate as unknown as UnifiedIssueRow['aggregateSessions'],
    activityAt: Date.parse(typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '') || 0,
  }
  const working = aggregate.some((session) => {
    try {
      return isSessionWorking(session as never)
    } catch {
      return false
    }
  })
  // Formal children supply the child-derived task status and progress
  // buckets; the row is a container exactly when it has any. Descendants
  // count transitively (the mission's whole subtree below the row).
  const descendantModels = ((): IssueViewModel[] => {
    const ids = new Set<string>([model.id as string])
    const out: IssueViewModel[] = []
    for (let grew = true; grew; ) {
      grew = false
      for (const row of allModels) {
        const parent = (row as unknown as Record<string, unknown>)['parentId']
        if (typeof parent === 'string' && ids.has(parent) && !ids.has(row.id as string)) {
          ids.add(row.id as string)
          out.push(row)
          grew = true
        }
      }
    }
    return out
  })()
  const childSessionsOf = (id: string): SliceSession[] =>
    allSessions.filter(
      (session) => (session as unknown as Record<string, unknown>)['issueId'] === id,
    )
  // A started task with an agent on it runs; started with nobody on it it
  // stalls (POD-1314). Backlog and the rest wait.
  const bucketOf = (child: IssueViewModel): 'done' | 'review' | 'block' | 'run' | 'stall' | 'wait' => {
    const fields = child as unknown as Record<string, unknown>
    if (fields['stage'] === 'done' || fields['closedReason'] != null) return 'done'
    if (fields['stage'] === 'review') return 'review'
    if (fields['blocked'] === true) return 'block'
    if (fields['stage'] === 'in_progress')
      return childSessionsOf(child.id).length > 0 ? 'run' : 'stall'
    return 'wait'
  }
  const buckets = descendantModels.map(bucketOf)
  const countBucket = (bucket: string): number => buckets.filter((entry) => entry === bucket).length
  const fromChildren = descendantModels.length > 0
  // Spin-off provenance (POD-85): the outgoing discovered-from edge names the
  // origin, drawn as the quiet tick on line 2.
  const deps = (record['deps'] ?? []) as Array<{ id: string; type: string }>
  const originId = deps.find((dep) => dep?.type === 'discovered-from')?.id
  const origin =
    typeof originId === 'string' ? allModels.find((row) => row.id === originId) : undefined
  const originFields = origin as unknown as Record<string, unknown> | undefined
  const decision = rowPendingDecision(legacy)
  const gitState = record['gitState'] as { ahead?: unknown } | null | undefined
  return {
    idNumber: typeof record['seq'] === 'number' ? record['seq'] : 0,
    color: typeof record['color'] === 'string' ? record['color'] : null,
    title: displayTitleOf(issue, () => sessions[0]),
    timing: rowMotionTiming(legacy),
    working,
    asking: false,
    originTick: origin
      ? {
          id: origin.id,
          seq: typeof originFields?.['seq'] === 'number' ? (originFields['seq'] as number) : 0,
          title:
            typeof originFields?.['title'] === 'string' ? (originFields['title'] as string) : '',
          ref:
            typeof originFields?.['displayRef'] === 'string'
              ? (originFields['displayRef'] as string)
              : `#${typeof originFields?.['seq'] === 'number' ? (originFields['seq'] as number) : 0}`,
        }
      : null,
    decision,
    mergeCommits:
      decision === 'merge' && typeof gitState?.ahead === 'number' ? gitState.ahead : 0,
    progress: {
      total: descendantModels.length,
      done: countBucket('done'),
      run: countBucket('run'),
      review: countBucket('review'),
      stall: countBucket('stall'),
      block: countBucket('block'),
      wait: countBucket('wait'),
    },
    fromChildren,
    statusFromChildren: record['parentId'] == null && fromChildren,
    gitState: record['gitState'] as SidebarRowValues['gitState'],
    // A row with an agent computing is never "new unseen work" (models.ts
    // `sidebarValues`): working suppresses the unread emphasis outright.
    unread: !working && record['unread'] === true,
    errorClass: null,
    internal: record['audience'] === 'agent',
    unsnoozed: cycle.unsnoozed,
    deferred: cycle.deferred,
    awaitsTuck: cycle.awaitsTuck,
    canBringBack: cycle.canBringBack,
    draftAgentOnly: false,
    firstSessionId: sessions[0]?.sessionId ?? null,
    continuation: null,
    fleet: fleetOf(aggregate),
    issue: model as unknown as SidebarRowValues['issue'],
    sessions,
    aggregateSessionIds: aggregate.map((session) => sessionIdOf(session)),
    awaitingFirstPrompt: false,
  }
}

/**
 * The sidebar the pool component reads, over the fixture's normalized issue
 * view models (POD-5566). Open rows follow the pool's rank order (spec
 * R-ORDER: manual key first, then newest-created first); pinned rows move out
 * into the flat pinned section whatever their fold verdict (R-GROUP 1). Lanes
 * follow the real fold verdicts (views `closedOf`/`bandOf`): settled closures
 * file into each band's closed fold, suspended rows into its snoozed fold,
 * and a selected closed row that was open when clicked stays latched open
 * until focus moves (R-GROUP 5). Children nest under their roots and proposed
 * rows stay out entirely, so the column shows mission roots plus the two
 * folds, as the real sidebar does. Repos with nothing in them keep their
 * band with the quiet start-first-task door.
 */
function fixtureSidebarSections(
  models: readonly IssueViewModel[],
  repos: readonly { path: string; repoId?: string | null }[],
  selectedIssueId: string | null,
  selectedIssueWasFolded?: boolean | null,
): SidebarSections {
  const now = Date.now()
  const reached = (at: number): boolean => now >= at
  const passed = (at: number): boolean => now > at
  const pinnedIds: string[] = models
    .filter((model) => model.pinned)
    .map((model) => model.id as string)
  type Entry = { id: string; rank: RowRank; foldMs: number; dismissed: boolean }
  const bands = new Map<
    string,
    { label: string; repoPath: string; open: Entry[]; snoozed: Entry[]; closed: Entry[] }
  >()
  for (const model of models) {
    if (model.pinned) continue
    const fields = model as unknown as Record<string, unknown>
    // Proposed/shipping/archived/deleted rows never reach the worklist, and
    // child rows nest under their mission root instead of drawing their own.
    if (isExcluded(model as unknown as Parameters<typeof isExcluded>[0])) continue
    if (fields['parentId'] != null) continue
    const issue = model as unknown as SliceIssue
    const closed = closedOf(issue, false, { passed })
    const band = bandOf(issue, { reached })
    const rank = rankOfPart(model.id as string, ownPartOfRow(issue, { passed, reached }))
    const foldMs = Date.parse(foldAtOf(issue)) || 0
    const dismissed =
      closed &&
      (issueAbandoned(issue as { stage?: unknown; closedReason?: unknown }) ||
        (issue as unknown as Record<string, unknown>)['tuckedAt'] != null)
    const key = model.repoId ?? model.repoPath
    let bandRows = bands.get(key)
    if (!bandRows) {
      bandRows = {
        label: model.repoPath.split('/').pop() || model.repoPath,
        repoPath: model.repoPath,
        open: [],
        snoozed: [],
        closed: [],
      }
      bands.set(key, bandRows)
    }
    const entry: Entry = { id: model.id as string, rank, foldMs, dismissed }
    if (closed) bandRows.closed.push(entry)
    else if (band === 2) bandRows.snoozed.push(entry)
    else bandRows.open.push(entry)
  }
  // A project with nothing in it keeps its band and offers the one quiet door.
  for (const repo of repos) {
    const key = repo.repoId ?? repo.path
    if (!bands.has(key)) {
      bands.set(key, {
        label: repo.path.split('/').pop() || repo.path,
        repoPath: repo.path,
        open: [],
        snoozed: [],
        closed: [],
      })
    }
  }
  for (const bandRows of bands.values()) {
    bandRows.open.sort((a, b) => compareRank(a.rank, b.rank))
    bandRows.snoozed.sort((a, b) => compareRank(a.rank, b.rank))
    bandRows.closed.sort((a, b) => b.foldMs - a.foldMs || compareRank(a.rank, b.rank))
  }
  // R-GROUP 5: a selected closed row that was open when clicked (never a
  // dismissal, never clicked from inside the fold) stays latched open until
  // focus moves. The latch follows the selection, so moving focus unlatches.
  // Whether the row was folded when clicked arrives as the suite-declared
  // gesture context (the pool's selectedIssueWasFolded local): true keeps a
  // fold click folded, anything else latches.
  if (
    selectedIssueId != null &&
    selectedIssueWasFolded !== true &&
    !pinnedIds.includes(selectedIssueId)
  ) {
    for (const bandRows of bands.values()) {
      const at = bandRows.closed.findIndex(
        (entry) => entry.id === selectedIssueId && !entry.dismissed,
      )
      if (at >= 0) {
        const latched = bandRows.closed[at]
        if (latched !== undefined) {
          bandRows.closed.splice(at, 1)
          bandRows.open.push(latched)
          bandRows.open.sort((a, b) => compareRank(a.rank, b.rank))
        }
        break
      }
    }
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
      rowIds: band.open.map((entry) => entry.id),
      worktreeIds: [],
      snoozedIds: band.snoozed.map((entry) => entry.id),
      closedIds: band.closed.map((entry) => entry.id),
      collapsed: false,
      snoozedCollapsed: true,
      closedCollapsed: true,
      foldKey: `podium:sidebar:project-fold:${key}`,
      snoozedFoldKey: `podium:sidebar:snoozed-fold:${key}`,
      closedFoldKey: `podium:sidebar:closed-fold:${key}`,
      startFirstTask:
        band.open.length === 0 && band.snoozed.length === 0 && band.closed.length === 0,
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
  const seenSelected = useRef<string | null>(null)
  // Stable across renders (a per-render closure would reset the counter on
  // every render and flap the pool identity): publishes and fold toggles
  // bump the ref, and the pool below turns over with it.
  const versionRef = useRef(0)
  const subscribe = useCallback((wake: () => void) => {
    // Every notification turns the pool over (new identity defeats memo'd
    // pool components): publishes after mid-flight store mutations, and fold
    // toggles whose persisted state the pool projections read back.
    const update = () => {
      versionRef.current += 1
      wake()
    }
    screenPoolWakers.add(update)
    const stopBorrowed = borrowed.subscribe(update)
    const stopUi = live.current.state.uiState?.subscribe?.(update)
    return () => {
      screenPoolWakers.delete(update)
      stopBorrowed()
      stopUi?.()
    }
  }, [])
  const version = useSyncExternalStore(subscribe, () => versionRef.current)
  return useMemo(() => {
    const current = () => live.current.state
    // Board and detail readers use the real pool over these same synthetic
    // records, including shared models, relations and source-owned rows.
    const records = () => syncPoolFixture({
      ...current(), issues: live.current.issues,
    } as never, true)
    const sessions = () => current().sessions ?? []
    const machines = () => current().machines ?? []
    // Warm conversations keep their first pool. Publish message replacements
    // through the shared fixture signal so their observers see later receipts.
    const messages = () => signal.get().state.messageRecords ?? []
    const interactions = () => current().pendingInteractions ?? []
    const threads = () => current().superThreads ?? []
    const repos = () => current().repos ?? []
    // The eviction gate's memory (the real SidebarIndex `seenSelected`): a
    // selected id only counts as evicted once it was seen resident. A cold
    // client restoring its selection before the first payload keeps it.
    // (`seenSelected` survives pool turnovers: it is eviction memory, not data.)
    const seen = seenSelected
    const pool = {
      notSaved: () => false,
      issueObject: (id: string) => records().issueObject(id),
      // These provider-free fixtures already hand out their record objects.
      // Real-pool observation tests cover shared model identity and field demand.
      model: (entity: Parameters<MobxPool['row']>[0], id: string) => omitGone(pool.row(entity, id)),
      selection: {
        // The selected row the fixture store names (the real pool's
        // selection local): rows read it for their selected weight, and the
        // eviction gate reads it to move the selection on.
        has: (id: string) => live.current.state.selectedIssueId === id,
        keys: (): IterableIterator<string> => {
          const selected = live.current.state.selectedIssueId
          return (selected == null ? [] : [selected])[Symbol.iterator]()
        },
        get size(): number {
          return live.current.state.selectedIssueId == null ? 0 : 1
        },
      },
      clock: {
        current: Date.now(),
        trackedNow() { return this.current },
        reached: (_at: number) => true,
        passed: (_at: number) => true,
      },
      sidebar: {
        sections: (): SidebarSections =>
          fixtureSidebarSections(
            live.current.issues,
            live.current.state.repos ?? [],
            live.current.state.selectedIssueId ?? null,
            live.current.state.selectedIssueWasFolded ?? null,
          ),
        row: (id: string): SidebarRowValues | undefined => {
          const model = live.current.issues.find((row) => row.id === id)
          if (!model) return undefined
          const members = (model.memberSessionIds ?? [])
            .map((sessionId) => sessions().find((row) => row.sessionId === sessionId))
            .filter((row) => row !== undefined) as unknown as SliceSession[]
          return fixtureSidebarRow(model, members, live.current.issues, sessions())
        },
        selectionGone: (): boolean => {
          // The real gate answers true once a selected id is gone from the
          // resident rows (an evicted issue leaves without a deletion); the
          // caller clears the selection through its existing action. Like the
          // real SidebarIndex, an id never seen resident is not evicted, so a
          // cold client keeps the selection its route restored.
          const selected = live.current.state.selectedIssueId ?? null
          if (selected === null) {
            seen.current = null
            return false
          }
          if (live.current.issues.some((row) => row.id === selected)) {
            seen.current = selected
            return false
          }
          return seen.current === selected
        },
        worktree: (_path: string) => undefined,
      },
      // The collapsed rail reads its tile counts off the issue model, as the
      // real pool serves them; the hand mock answers from the same fixture.
      issue: (id: string): unknown => {
        const model = live.current.issues.find((row) => row.id === id)
        if (!model) return undefined
        const fields = model as unknown as Record<string, unknown>
        return {
          aggregate: {},
          ownFacts: {
            state: 'ready',
            finished:
              fields['stage'] === 'done' || fields['closedReason'] != null,
          },
        }
      },
      row(entity: string, id: string): unknown {
        if (entity === 'issueBoardWindow')
          return { openIssueId: current().openIssueId ?? null }
        if ((ISSUE_BOARD_ENTITIES as readonly string[]).includes(entity))
          return records().row(entity as (typeof ISSUE_BOARD_ENTITIES)[number], id)
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
        // The action seam (unified-work gestures, issue menus) reads the same
        // membership facts as the real pool: insertion order, child counts.
        residentInsertionOrder: (entity: string, id: string): number | undefined => {
          const at =
            entity === 'session'
              ? sessions().findIndex((row) => row.sessionId === id)
              : entity === 'issue'
                ? live.current.issues.findIndex((row) => row.id === id)
                : -1
          return at < 0 ? undefined : at
        },
        issueChildCounts: (id: string) => {
          const children = live.current.issues.filter(
            (row) => (row as unknown as Record<string, unknown>)['parentId'] === id,
          )
          return {
            childCount: children.length,
            childDoneCount: children.filter((row) =>
              isFinished(row as unknown as Parameters<typeof isFinished>[0]),
            ).length,
          }
        },
      },
      // The mission membership the gestures navigate (root + subtree): the
      // real missions view over the fixture's parent links.
      sources: {
        // Fixture preferences read the synchronous UI owner directly; there is
        // no separately attached PreferenceSource cache to refresh.
        peekView: (name: string): unknown => {
          if (name === 'preferences') return undefined
          if (name === 'worklist.view')
            return (pool as unknown as Record<string, unknown>)['worklistView'] ?? undefined
          throw new Error(`Undeclared component fixture source: ${name}`)
        },
        view: (name: string, _factory: unknown): unknown => {
          const fixture = pool as unknown as Record<string, unknown>
          if (name === 'issue-activity')
            return records().sources.view(name, _factory as () => unknown)
          if (name === 'issue-page') return issuePages(records())
          if (name === 'issueBoardCards') return boardCards(records())
          if (name === 'sidebar') return fixture.sidebar
          if (name === 'header.entities') return fixture.header
          if (name === 'header.views') return fixture.headerViews
          if (name === 'sessionPanes') return fixture.sessionPanes
          if (name === 'settings.views') return fixture.settingsViews ?? (_factory as () => unknown)()
          if (name === 'web.settings.machines') return (_factory as () => unknown)()
          if (name === 'worklist.view') {
            const cached = fixture['worklistView']
            if (cached) return cached
            const sidebar = () =>
              fixture.sidebar as {
                sections: () => SidebarSections
                row: (id: string) => SidebarRowValues | undefined
                selectionGone: () => boolean
              }
            const worklist = {
              setLayout: (_state: unknown): void => {},
              sections: (_state?: unknown): SidebarSections => sidebar().sections(),
              knownRow: (id: string): unknown => {
                const value = sidebar().row(id)
                if (value === undefined) return undefined
                const model = live.current.issues.find((row) => row.id === id)
                const fields = (model ?? {}) as unknown as Record<string, unknown>
                const finished =
                  fields['stage'] === 'done' || fields['closedReason'] != null
                return {
                  id,
                  get selected(): boolean {
                    return live.current.state.selectedIssueId === id
                  },
                  ready: 'ready', issue: model,
                  title: value.title, timing: value.timing, visibleWorking: value.working,
                  visibleAsking: value.asking, origin: value.originTick, decision: value.decision,
                  mergeCommits: value.mergeCommits, progress: value.progress,
                  hasChildProgress: value.fromChildren, showsChildProgress: value.statusFromChildren,
                  visibleUnread: value.unread, errorClass: value.errorClass,
                  returnedFromDefer: value.unsnoozed, canTuck: value.awaitsTuck,
                  canBringBack: value.canBringBack, sessionOnlyDraft: value.draftAgentOnly,
                  firstSessionId: value.firstSessionId, continuation: value.continuation,
                  visibleFleet: value.fleet, sessions: value.sessions,
                  visibleSessionIds: value.aggregateSessionIds, awaitingFirstPrompt: value.awaitingFirstPrompt,
                  foldAt: model
                    ? foldAtOf(model as unknown as SliceIssue)
                    : '',
                  aggregate: {},
                  ownFacts: { state: 'ready', finished },
                }
              },
              desktop: fixture.sidebar,
              get selectedId() { return live.current.state.selectedIssueId },
              get selectionGone(): boolean {
                return sidebar().selectionGone()
              },
              dispose: (): void => {},
            }
            fixture['worklistView'] = worklist
            return worklist
          }
          if (name !== 'missions') throw new Error(`Undeclared component fixture source: ${name}`)
          const byId = new Map<string, IssueViewModel>(
            live.current.issues.map((row) => [row.id as string, row]),
          )
          const rootFor = (id: string | null): string | undefined => {
            if (id == null || !byId.has(id as string)) return undefined
            let current = id
            const seen = new Set<string>()
            while (!seen.has(current)) {
              seen.add(current)
              const parent = (byId.get(current as string) as unknown as Record<
                string,
                unknown
              >)['parentId']
              if (typeof parent !== 'string' || !byId.has(parent as string)) break
              current = parent
            }
            return current
          }
          const members = (rootId: string): ReadonlySet<string> => {
            const ids = new Set<string>([rootId])
            let grew = true
            while (grew) {
              grew = false
              for (const row of live.current.issues) {
                const parent = (row as unknown as Record<string, unknown>)['parentId']
                if (typeof parent === 'string' && ids.has(parent) && !ids.has(row.id)) {
                  ids.add(row.id)
                  grew = true
                }
              }
            }
            return ids
          }
          return {
            rootFor,
            members,
            contains: (rootId: string, issueId: string) => members(rootId).has(issueId),
            stats: { roots: 0, members: 0 },
            dispose: () => {},
          }
        },
      },
      graph: {
        many: (entity: string, id: string, name: string): string[] => {
          if (entity === 'issue' && name === 'sessions')
            return sessions()
              .filter((row) => row.issueId === id)
              .map((row) => row.sessionId)
          if (entity === 'issue' && name === 'treeChildren')
            return live.current.issues
              .filter((row) => (row as unknown as Record<string, unknown>)['parentId'] === id)
              .map((row) => row.id)
          if (entity === 'worktree' && name === 'sessions')
            return sessions()
              .filter((row) => {
                const fields = row as unknown as Record<string, unknown>
                return fields['cwd'] === id || fields['worktreePath'] === id
              })
              .map((row) => row.sessionId)
          return []
        },
        one: (entity: string, id: string, name: string): string | undefined => {
          if (entity === 'issue' && (name === 'parent' || name === 'treeParent')) {
            const parent = (
              live.current.issues.find((row) => row.id === id) as unknown as Record<
                string,
                unknown
              >
            )?.['parentId']
            return typeof parent === 'string' ? parent : undefined
          }
          return undefined
        },
      },
      tables: {
        session: {
          has: (id: string) => sessions().some((row) => row.sessionId === id),
          keys: (): IterableIterator<string> =>
            sessions()
              .map((row) => row.sessionId)
              [Symbol.iterator](),
        },
        issue: {
          has: (id: string) => live.current.issues.some((row) => row.id === id),
          keys: (): IterableIterator<string> =>
            live.current.issues.map((row) => row.id)[Symbol.iterator](),
        },
        worktree: {
          has: (_id: string) => false,
          keys: (): IterableIterator<string> => [][Symbol.iterator](),
        },
      },
      headerViews: {
        ids: (kind: string): string[] => {
          if (kind === 'repository') return repos().map((row) => row.path)
          if (kind === 'machine') return machines().map((row) => row.id)
          return []
        },
        row: (kind: string, id: string): unknown => {
          if (kind === 'repository') return repos().find((row) => row.path === id)
          if (kind === 'machine') return machines().find((row) => row.id === id)
          return undefined
        },
        machines: (): string[] => machines().map((row) => row.id),
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
    Object.assign(pool, { settingsViews: settingsView(pool) })
    return pool
  }, [version])
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

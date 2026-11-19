import { runInAction } from 'mobx'
import { ISSUE_STUBS, oneRecordOf, treeOf } from './collections'
import { boardRefreshing, createBoardLayout } from './issue-board-layout'
import { createIssuePageViews } from './issue-page'
import { issueSearch } from './issue-search'
import { LOADING } from './loading'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { attachMobileScreens } from './mobile-screens'
import { MobileTasksBoard } from './mobile-tasks'
import { MobxPool } from './pool'
import type { CollectionLoaderPort, LoaderInstance } from './shared/source'
import { sidebarView } from './worklist/sidebar'
import { worklistView } from './worklist/view-model'

export const REFRESH_SCREENS = ['deck', 'board', 'issue', 'search', 'sidebar', 'mission'] as const
export type RefreshScreen = (typeof REFRESH_SCREENS)[number]

const stamp = '2026-11-01T12:00:00.000Z'
const key = (spec: LoaderInstance) =>
  JSON.stringify([
    spec.collection,
    spec.part,
    spec.via ?? '',
    Object.entries(spec.args ?? {}).sort(),
  ])

export const refreshIssue = (id: string, patch: object = {}) => ({
  id,
  seq: id === 'root' ? 1 : 2,
  title: `Cached ${id}`,
  stage: 'in_progress',
  priority: 2,
  type: 'task',
  audience: 'human',
  repoPath: '/fixture',
  parentId: null as string | null,
  labels: [],
  deps: [],
  createdAt: stamp,
  updatedAt: stamp,
  readAt: stamp,
  ...patch,
})

/** A chosen stale instance through the real pool and screen view models.
 * Only the authority's markers/connection are a seam; no global stale flag,
 * UI state or view answer is faked. Offline reads cannot make a server call. */
export async function refreshingScreenFixture() {
  const pool = new MobxPool({ selectedIssueId: 'root', coarseNow: Date.parse(stamp) })
  attachMissionTestPreferences(pool)
  const issues = new Map([
    ['root', refreshIssue('root')],
    ['child', refreshIssue('child', { parentId: 'root', stage: 'done', closedReason: 'done' })],
    ['other', refreshIssue('other', { title: 'Unrelated tree' })],
  ])
  pool.apply({
    type: 'replace',
    rows: [...issues].map(([id, value]) => ({ kind: 'issue', id, value })),
  })
  await attachMobileScreens(pool)
  const markerChanges = new Set<Parameters<CollectionLoaderPort['subscribe']>[0]>()
  const stale = new Set<string>()
  const missing = new Set<string>()
  const requested: LoaderInstance[] = []
  const port: CollectionLoaderPort = {
    online: false,
    firstDownload: false,
    request: (specs) => requested.push(...specs),
    show: () => () => {},
    status: (spec) => (missing.has(key(spec)) ? 'offline' : 'complete'),
    isComplete: (spec) => {
      if (missing.has(key(spec))) return undefined
      if (spec.collection === 'issueProjection.byStage')
        return {
          total: [...issues.values()].filter((row) => row.stage === spec.args?.stage).length,
          range: { end: true },
        }
      return {}
    },
    isStale: (spec) => stale.has(key(spec)),
    recordStale: (_entity, id) => stale.has(key(oneRecordOf('issue', id))),
    wasRefused: () => false,
    stubOf: (_entity, id) => issues.get(id),
    stubsByParent: (parent) =>
      [...issues].filter(([, row]) => row.parentId === parent).map(([id]) => id),
    stubRows: () => [...issues].map(([id, stub]) => ({ id, stub })),
    subscribe: (listener) => {
      markerChanges.add(listener)
      return () => markerChanges.delete(listener)
    },
  }
  pool.collections.attach(() => port)
  const deck = new MissionScreen(pool, 'root', { fullOnly: true })
  const pages = createIssuePageViews(pool)
  const board = createBoardLayout(pool)
  const mobileBoard = new MobileTasksBoard(pool, {
    showDone: true,
    expanded: ['root'],
    filter: {},
    ordering: 'priority',
    showAgentTasks: true,
  })
  const sidebar = sidebarView(pool)
  const phone = worklistView(pool).phone
  const column = {
    stage: 'in_progress' as const,
    filter: {},
    ordering: 'priority' as const,
    showAgentTasks: true,
  }
  const owned: Record<RefreshScreen, LoaderInstance> = {
    deck: treeOf('root'),
    mission: treeOf('root'),
    board: { collection: 'issueProjection.sidebar', part: 'main' },
    sidebar: { collection: 'issueProjection.sidebar', part: 'main' },
    issue: oneRecordOf('issue', 'root'),
    search: oneRecordOf('issue', 'root'),
  }
  const freshness = (screen: RefreshScreen, platform: 'web' | 'phone') => {
    switch (screen) {
      case 'deck':
      case 'mission':
        return deck.refreshing
      case 'board':
        return platform === 'phone'
          ? mobileBoard.refreshing
          : boardRefreshing(pool, ['in_progress'], {})
      case 'issue':
        return pages.row('root').refreshing
      case 'search':
        return issueSearch(pool).read('Cached', pool.queries.localTextIds('Cached')).refreshing
      case 'sidebar':
        return platform === 'phone' ? phone.refreshing : sidebar.refreshing
    }
  }
  const answer = (screen: RefreshScreen, platform: 'web' | 'phone'): unknown => {
    switch (screen) {
      case 'deck':
      case 'mission':
        return deck.ready
          ? {
              title: deck.root.title,
              progress: deck.deck.progress,
              crew: deck.crew.map((s) => s.sessionId),
            }
          : LOADING
      case 'board': {
        if (platform === 'phone')
          return { title: pool.issueObject('root').title, sections: mobileBoard.sections }
        const ids = board.columnIds(column)
        return ids === LOADING
          ? LOADING
          : {
              titles: ids?.map((id) => pool.issueObject(id).title),
              count: board.columnCount(column),
            }
      }
      case 'issue': {
        const issue = pages.issue('root')
        return !issue || issue === LOADING
          ? issue
          : { title: issue.title, children: pool.collections.childCounts('root') }
      }
      case 'search': {
        const found = issueSearch(pool).read('Cached', pool.queries.localTextIds('Cached'))
        return found.ids.map((id) => pool.issueObject(id).title)
      }
      case 'sidebar': {
        const row = sidebar.row('root')
        return !row || row === LOADING
          ? row
          : {
              title: row.title,
              progress: row.progress,
              ...(platform === 'phone' ? { count: phone.counts.open } : {}),
            }
      }
    }
  }
  const notify = () =>
    runInAction(() => {
      for (const listener of markerChanges) listener('markers')
    })
  return {
    pool,
    port,
    deck,
    mobileBoard,
    pages,
    board,
    owned,
    requested,
    refreshing: freshness,
    answer,
    mark(spec: LoaderInstance, value = true) {
      if (value) stale.add(key(spec))
      else stale.delete(key(spec))
      notify()
    },
    without(spec: LoaderInstance) {
      missing.add(key(spec))
      notify()
    },
    land() {
      runInAction(() => {
        const root = refreshIssue('root', { title: 'Cached root updated' })
        issues.set('root', root)
        pool.apply({ type: 'update', rows: [{ kind: 'issue', id: 'root', value: root }] })
        stale.clear()
        for (const listener of markerChanges) {
          listener('stubs')
          listener('markers')
        }
      })
    },
    dispose() {
      deck.close()
      pages.dispose()
      board.dispose()
      pool.dispose()
    },
  }
}

export { ISSUE_STUBS }
